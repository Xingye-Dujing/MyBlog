# -*- coding: utf-8 -*-
"""
ZENTEX 本地 LaTeX 编译服务

用本机 MiKTeX 真实编译 .tex，返回 PDF 与编译日志，同时静态托管 public/ 目录，
让页面与接口同源（避开 file:// 下 fetch 被禁的问题）。

启动:
    python latex-serve.py            # 默认 127.0.0.1:8123
    python latex-serve.py 9000

接口:
    GET  /api/env                 引擎可用性、MiKTeX 版本
    POST /api/compile             {tex, engine, passes, mainfile} -> {ok, key, log, errors, ms}
    GET  /pdf?key=<key>           取编译产物 PDF
"""

import os
import re
import io
import sys
import json
import time
import uuid
import shutil
import threading
import subprocess
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
MIKTEX_BIN = r"D:\MiKTeX\miktex\bin\x64"
# 编译在系统临时目录里进行，不污染项目目录
BUILD_DIR = os.path.join(tempfile.gettempdir(), "zentex-build")

ENGINE_FILES = {
    "xelatex": "xelatex.exe",
    "pdflatex": "pdflatex.exe",
    "lualatex": "lualatex.exe",
}

# 编译超时（秒）。首次编译时 MiKTeX 可能要联网装宏包，给足时间。
COMPILE_TIMEOUT = 300

# 串行化编译：MiKTeX 的包数据库不适合并发写
_compile_lock = threading.Lock()
_builds = {}          # key -> {"pdf": path, "ts": time, "tex": str}
_keep_builds = 24

# 当前正在运行的 MiKTeX 进程。单个服务只允许一个编译任务，取消接口可以从
# 另一个 HTTP 线程直接终止它，不必等待 /api/compile 自己释放编译锁。
_compile_state_lock = threading.Lock()
_active_job = None
_active_proc = None
_active_cancel = None


# ----------------------------------------------------------------- 工具
def log_line(msg):
    try:
        with open(os.path.join(ROOT, "latex-serve.log"), "a", encoding="utf-8") as f:
            f.write("%s  %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


def engine_path(name):
    f = ENGINE_FILES.get(name)
    if not f:
        return None
    p = os.path.join(MIKTEX_BIN, f)
    return p if os.path.isfile(p) else None


def miktex_version():
    exe = engine_path("xelatex")
    if not exe:
        return ""
    try:
        r = subprocess.run(
            [exe, "--version"],
            capture_output=True,
            timeout=25,
            creationflags=0x08000000,
        )
        txt = (r.stdout or b"").decode("utf-8", "replace")
        m = re.search(r"MiKTeX\s+([0-9.]+)", txt)
        if m:
            return m.group(1)
        return txt.splitlines()[0].strip() if txt else ""
    except Exception:
        return ""


def _level(msg):
    low = str(msg or '').lower()
    return 'warning' if 'warning' in low else 'error'


def _source_line_for_macro(tex, macro, around_line=0):
    """回溯结构性 TeX 错误对应的命令起始行。"""
    if not tex or not macro:
        return 0
    lines = str(tex).splitlines()
    try:
        pattern = re.compile(r'(?<![A-Za-z@])' + re.escape(macro) + r'(?![A-Za-z@])')
    except re.error:
        return 0
    limit = len(lines) if not around_line else min(len(lines), max(1, int(around_line)))
    for idx in range(limit - 1, -1, -1):
        if pattern.search(lines[idx]):
            return idx + 1
    return 0


def _infer_structural_error_line(msg, tex, reported_line):
    """将 TeX 的发现位置修正为更适合编辑器定位的实际问题起始行。"""
    msg = str(msg or '')
    line_no = int(reported_line or 0)

    # 典型：Paragraph ended before \\author was complete.
    # TeX 是在空段落处发现参数未闭合，真正需要修改的是 \\author{...} 的起始行。
    m = re.search(r'Paragraph ended before\s+(\\[A-Za-z@]+)\s+was complete', msg, re.I)
    if m:
        inferred = _source_line_for_macro(tex, m.group(1), line_no)
        if inferred:
            return inferred

    # 典型：Runaway argument? / while scanning use of \\foo
    m = re.search(r'while scanning use of\s*(\\[A-Za-z@]+)', msg, re.I)
    if m:
        inferred = _source_line_for_macro(tex, m.group(1), line_no)
        if inferred:
            return inferred

    # 没有宏名时，对“缺少右大括号/Runaway argument”做轻量向前回溯。
    if re.search(r'Missing\s+}\s+inserted|forgotten\s+a\s+[`\"]}\'|Runaway argument', msg, re.I):
        lines = str(tex or '').splitlines()
        end = min(len(lines), line_no if line_no > 0 else len(lines))
        balance = 0
        candidate = 0
        for idx in range(end - 1, -1, -1):
            code = lines[idx].split('%', 1)[0]
            balance += code.count('}') - code.count('{')
            if '{' in code:
                candidate = idx + 1
            if balance < 0:
                break
        if candidate:
            return candidate

    return line_no


def extract_errors(log, mainfile, tex=''):
    """从 MiKTeX 日志提取错误/警告，并定位到真正需要修改的源码行。"""
    out = []
    seen = set()
    pending = None
    lines = str(log or '').splitlines()

    def push(file_name, line_no, msg, level='error'):
        msg = str(msg or '').strip()
        if not msg:
            return None
        line_no = _infer_structural_error_line(msg, tex, line_no)
        key = (str(file_name or mainfile), line_no, msg, level)
        if key in seen:
            return None
        seen.add(key)
        item = {
            'file': str(file_name or mainfile),
            'line': line_no,
            'msg': msg,
            'level': level,
        }
        out.append(item)
        return item

    for raw in lines:
        s = raw.strip()

        # 典型 -file-line-error：./main.tex:23: Undefined control sequence.
        m = re.match(r'^\.?/?([^:\s]+\.(?:tex|sty|cls|def|cfg|clo)):(\d+):\s*(.+)$', s)
        if m:
            pending = push(m.group(1), int(m.group(2)), m.group(3), _level(m.group(3)))
            continue

        # Package / Class warning：... on input line 42.
        wm = re.match(
            r'^(?:Package|Class)\s+.*?Warning:\s*(.+?)\s+on input line\s+(\d+)\.?\s*$',
            s,
            re.I,
        )
        if wm:
            pending = push(mainfile, int(wm.group(2)), wm.group(1), 'warning')
            continue

        # TeX 错误正文。
        if s.startswith('!'):
            msg = s[1:].strip()
            if msg:
                pending = push(mainfile, 0, msg, _level(msg))
            continue

        # TeX 常在 ! 之后另起一行给出 l.N 诊断位置。
        lm = re.match(r'^l\.(\d+)\s*(.*)$', s, re.I)
        if lm and pending is not None:
            reported = int(lm.group(1))
            pending['line'] = _infer_structural_error_line(
                pending.get('msg', ''), tex, reported
            )
            continue

        # 其他常见位置提示。
        pm = re.search(r'\b(?:on input line|at line)\s+(\d+)\b', s, re.I)
        if pm and pending is not None:
            reported = int(pm.group(1))
            pending['line'] = _infer_structural_error_line(
                pending.get('msg', ''), tex, reported
            )

    return out[:40]

def prune_builds():
    """清掉超出保留数的旧构建，顺带清掉上次运行遗留的孤儿目录（每次只清少量）。"""
    for k in sorted(_builds, key=lambda x: _builds[x]["ts"])[: max(0, len(_builds) - _keep_builds)]:
        rec = _builds.pop(k, None)
        if not rec:
            continue
        d = os.path.dirname(rec["pdf"])
        if d.startswith(BUILD_DIR):
            shutil.rmtree(d, ignore_errors=True)
    # 孤儿目录：不在内存索引里的一律是上次运行留下的
    try:
        live = set(rec["dir"] for rec in _builds.values())
        stale = []
        for n in os.listdir(BUILD_DIR):
            p = os.path.join(BUILD_DIR, n)
            if p in live or not os.path.isdir(p):
                continue
            try:
                stale.append((os.path.getmtime(p), p))
            except OSError:
                pass
        stale.sort()
        for _, p in stale[:2]:
            shutil.rmtree(p, ignore_errors=True)
    except Exception:
        pass


# ----------------------------------------------------------------- 编译
def _window_flags():
    return 0x08000000 if os.name == "nt" else 0


def _terminate_process(proc):
    if not proc:
        return
    try:
        if proc.poll() is not None:
            return
        if os.name == "nt":
            # MiKTeX 偶尔会再启动子进程；/T 确保整棵进程树一起结束。
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                creationflags=_window_flags(),
            )
        else:
            proc.kill()
    except Exception as e:
        log_line("CANCEL-KILL %r" % (e,))


def _register_compile_job(job_id, cancel_event):
    global _active_job, _active_proc, _active_cancel
    with _compile_state_lock:
        _active_job = job_id
        _active_proc = None
        _active_cancel = cancel_event


def _set_active_process(job_id, proc):
    global _active_proc
    terminate = False
    with _compile_state_lock:
        if _active_job != job_id:
            return
        _active_proc = proc
        if _active_cancel is None or _active_cancel.is_set():
            terminate = True
    if terminate:
        _terminate_process(proc)


def _clear_active_process(job_id, proc=None):
    global _active_proc
    with _compile_state_lock:
        if _active_job == job_id and (proc is None or _active_proc is proc):
            _active_proc = None


def _clear_compile_job(job_id):
    global _active_job, _active_proc, _active_cancel
    with _compile_state_lock:
        if _active_job == job_id:
            _active_job = None
            _active_proc = None
            _active_cancel = None


def cancel_active_compile(wait=True, timeout=15.0):
    with _compile_state_lock:
        job_id = _active_job
        proc = _active_proc
        cancel_event = _active_cancel
        if not job_id or cancel_event is None:
            return False
        cancel_event.set()

    # 先同步终止当前 MiKTeX 进程；compile_tex 会随后从 run_pass 返回并清理工作目录。
    if proc is not None:
        _terminate_process(proc)
    log_line("CANCEL %s" % job_id)

    # 关键：/api/cancel 不能在旧编译线程尚未彻底退出时立即返回。
    # 否则前端收到“取消成功”后马上发起新 /api/compile，新请求会撞上编译锁并得到 409。
    if wait:
        deadline = time.time() + max(0.0, float(timeout))
        while time.time() < deadline:
            if not is_compile_active():
                break
            time.sleep(0.03)
    return True


def is_compile_active():
    with _compile_state_lock:
        return bool(_active_job)


def run_pass(exe, work, mainfile, timeout=COMPILE_TIMEOUT, job_id=None, cancel_event=None):
    args = [
        exe,
        "-interaction=nonstopmode",
        "-file-line-error",
        mainfile,
    ]
    env = dict(os.environ)
    env["MIKTEX_AUTOINSTALL"] = "1"     # 缺宏包时自动安装
    env["max_print_line"] = "1000"
    t0 = time.time()
    proc = None
    try:
        if cancel_event is not None and cancel_event.is_set():
            return 130, "! 编译已中止\n", time.time() - t0, True

        proc = subprocess.Popen(
            args,
            cwd=work,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            creationflags=_window_flags(),
        )
        if job_id is not None:
            _set_active_process(job_id, proc)

        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _terminate_process(proc)
            stdout, stderr = proc.communicate(timeout=10)
            out = (stdout or b"").decode("utf-8", "replace")
            err = (stderr or b"").decode("utf-8", "replace")
            return 124, out + ("\n" + err if err.strip() else "") + "\n! 编译超时（%d 秒）\n" % timeout, time.time() - t0, False

        out = (stdout or b"").decode("utf-8", "replace")
        err = (stderr or b"").decode("utf-8", "replace")
        cancelled = bool(cancel_event is not None and cancel_event.is_set())
        if cancelled:
            return 130, out + ("\n" + err if err.strip() else "") + "\n! 编译已中止\n", time.time() - t0, True
        return proc.returncode, out + ("\n" + err if err.strip() else ""), time.time() - t0, False
    except Exception as e:
        if cancel_event is not None and cancel_event.is_set():
            return 130, "! 编译已中止\n", time.time() - t0, True
        return 125, "! 无法启动编译器：%r\n" % (e,), time.time() - t0, False
    finally:
        _clear_active_process(job_id, proc)


def compile_tex(tex, engine="xelatex", passes=2, mainfile="main.tex"):
    exe = engine_path(engine)
    if not exe:
        return {"ok": False, "error": "找不到 %s，请确认 MiKTeX 安装路径" % engine}

    os.makedirs(BUILD_DIR, exist_ok=True)
    key = uuid.uuid4().hex[:12]
    work = os.path.join(BUILD_DIR, key)
    os.makedirs(work, exist_ok=True)
    cancel_event = threading.Event()
    _register_compile_job(key, cancel_event)

    try:
        with open(os.path.join(work, mainfile), "w", encoding="utf-8") as f:
            f.write(tex)

        logs = []
        codes = []
        t0 = time.time()
        n = max(1, min(4, int(passes or 1)))
        for i in range(n):
            if cancel_event.is_set():
                elapsed = int((time.time() - t0) * 1000)
                log_line("CANCEL %s before-pass=%d" % (key, i + 1))
                return {
                    "ok": False,
                    "cancelled": True,
                    "ms": elapsed,
                    "log": "\n".join(logs)[-60000:],
                    "errors": [],
                    "error": "编译已中止",
                }
            code, out, _, cancelled = run_pass(
                exe, work, mainfile, job_id=key, cancel_event=cancel_event
            )
            codes.append(code)
            logs.append("===== 第 %d 遍 (%s) =====\n%s" % (i + 1, engine, out))
            if cancelled or cancel_event.is_set():
                elapsed = int((time.time() - t0) * 1000)
                log_line("CANCEL %s pass=%d" % (key, i + 1))
                return {
                    "ok": False,
                    "cancelled": True,
                    "ms": elapsed,
                    "log": "\n".join(logs)[-60000:],
                    "errors": [],
                    "error": "编译已中止",
                }
            # 已经产出 PDF 且没有致命的 format 问题，就不必再跑
            if not os.path.isfile(os.path.join(work, "main.pdf")) and i == 0:
                # 第一遍没出 PDF 也允许再试一遍（有些宏包需要两遍）
                pass
        elapsed = int((time.time() - t0) * 1000)

        pdf_src = os.path.join(work, "main.pdf")
        logtxt = "\n".join(logs)

        # 若 main.log 更完整，附上
        mainlog = os.path.join(work, "main.log")
        if os.path.isfile(mainlog):
            try:
                with open(mainlog, "r", encoding="utf-8", errors="replace") as f:
                    ml = f.read()
                if len(ml.strip()) > len(logtxt.strip()):
                    logtxt = ml
            except Exception:
                pass

        if cancel_event.is_set():
            log_line("CANCEL %s after-passes" % key)
            return {
                "ok": False,
                "cancelled": True,
                "ms": elapsed,
                "log": logtxt[-60000:],
                "errors": [],
                "error": "编译已中止",
            }

        if not os.path.isfile(pdf_src):
            errs = extract_errors(logtxt, mainfile, tex)
            if not errs:
                errs = [{
                    "file": mainfile,
                    "line": 0,
                    "msg": "编译器没有生成 main.pdf；请查看完整日志。",
                    "level": "error",
                }]
            log_line("FAIL %s no-pdf codes=%s" % (key, codes))
            return {
                "ok": False,
                "ms": elapsed,
                "log": logtxt[-60000:],
                "errors": errs,
                "error": "编译未产出 PDF（退出码：%s）" % (codes[-1] if codes else "未知"),
                "engine": engine,
                "miktex": miktex_version(),
                "exitCode": codes[-1] if codes else None,
            }

        with open(pdf_src, "rb") as f:
            head = f.read(5)
        if not head.startswith(b"%PDF"):
            return {
                "ok": False,
                "ms": elapsed,
                "log": logtxt[-60000:],
                "errors": extract_errors(logtxt, mainfile, tex),
                "error": "输出不是有效的 PDF",
                "engine": engine,
                "miktex": miktex_version(),
                "exitCode": codes[-1] if codes else None,
            }

        size = os.path.getsize(pdf_src)
        pages = 0
        m = re.search(r"Output written on [^\n]*?\((\d+) pages?", logtxt)
        if m:
            pages = int(m.group(1))

        _builds[key] = {"pdf": pdf_src, "ts": time.time(), "tex": tex, "dir": work}
        prune_builds()
        log_line("OK   %s %s passes=%d %dms %dB %sp" % (key, engine, n, elapsed, size, pages))
        return {
            "ok": True,
            "key": key,
            "ms": elapsed,
            "size": size,
            "pages": pages,
            "log": logtxt[-60000:],
            "errors": extract_errors(logtxt, mainfile, tex),
        }
    except Exception as e:
        elapsed = int((time.time() - t0) * 1000) if 't0' in locals() else 0
        # 异常也要把日志/错误结构完整返回给前端，避免前端只能显示“0 个错误”。
        detail = "编译异常：%s" % (e,)
        log_line("FAIL %s %r" % (key, e))
        return {
            "ok": False,
            "ms": elapsed,
            "log": "\n".join(logs)[-60000:] if 'logs' in locals() else '',
            "errors": [{
                "file": mainfile,
                "line": 0,
                "msg": detail,
                "level": "error",
            }],
            "error": detail,
        }
    finally:
        if cancel_event.is_set() and key not in _builds:
            shutil.rmtree(work, ignore_errors=True)
        _clear_compile_job(key)


# ----------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    server_version = "ZentexServe/1.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        pass

    # ---------- 响应助手 ----------
    def _cors(self):
        """允许被云端页面（其它源）调用；兼容跨源请求；Chrome/Edge 的 Local Network Access 权限由浏览器负责处理。"""
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        # 浏览器本地网络访问（LNA）：公网页面访问 loopback 服务时可能经过权限检查
        if (self.headers.get("Access-Control-Request-Private-Network") or "").lower() == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def send_bytes(self, data, ctype, code=200, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    # ---------- 路由 ----------
    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/api/env":
            eng = {}
            for k in ENGINE_FILES:
                eng[k] = bool(engine_path(k))
            return self.send_json(
                {
                    "ok": True,
                    "engines": eng,
                    "miktex": miktex_version(),
                    "bin": MIKTEX_BIN,
                }
            )
        if p == "/api/status":
            return self.send_json({"ok": True, "busy": is_compile_active()})
        if p == "/pdf":
            key = (parse_qs(u.query).get("key") or [""])[0]
            rec = _builds.get(key)
            if not rec or not os.path.isfile(rec["pdf"]):
                return self.send_bytes(b"not found", "text/plain", 404)
            try:
                with open(rec["pdf"], "rb") as f:
                    data = f.read()
            except Exception:
                return self.send_bytes(b"read error", "text/plain", 500)
            return self.send_bytes(
                data,
                "application/pdf",
                200,
                {"Content-Disposition": 'inline; filename="zentex-%s.pdf"' % key},
            )
        if p == "/api/log":
            lp = os.path.join(ROOT, "latex-serve.log")
            if os.path.isfile(lp):
                with open(lp, "rb") as f:
                    return self.send_bytes(f.read()[-20000:], "text/plain; charset=utf-8")
            return self.send_bytes(b"", "text/plain; charset=utf-8")
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/cancel":
            cancelled = cancel_active_compile(wait=True, timeout=15.0)
            # 正常情况下这里已经彻底空闲；若极端情况下超时，明确告诉前端，
            # 前端会继续轮询 /api/status，而不是贸然提交下一次编译。
            return self.send_json(
                {
                    "ok": True,
                    "cancelled": cancelled,
                    "busy": is_compile_active(),
                }
            )
        if u.path != "/api/compile":
            return self.send_json({"ok": False, "error": "unknown endpoint"}, 404)

        # 不让多个前端请求在锁上排队。第二个请求直接得到 409，
        # 从根上避免“旧任务结束后又突然冒出一个过期编译”的情况。
        if not _compile_lock.acquire(blocking=False):
            return self.send_json(
                {"ok": False, "busy": True, "error": "已有编译任务正在进行"},
                409,
            )
        try:
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n <= 0 or n > 4 * 1024 * 1024:
                return self.send_json({"ok": False, "error": "请求体过大或为空"}, 400)

            try:
                payload = json.loads(self.rfile.read(n).decode("utf-8"))
            except Exception as e:
                return self.send_json({"ok": False, "error": "JSON 解析失败：%r" % (e,)}, 400)

            tex = payload.get("tex") or ""
            engine = payload.get("engine") or "xelatex"
            passes = payload.get("passes") or 2
            mainfile = payload.get("mainfile") or "main.tex"
            if engine not in ENGINE_FILES:
                engine = "xelatex"
            if not tex.strip():
                return self.send_json({"ok": False, "error": "源码为空"}, 400)

            res = compile_tex(tex, engine, passes, mainfile)
            return self.send_json(res)
        finally:
            _compile_lock.release()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    os.makedirs(BUILD_DIR, exist_ok=True)
    avail = [k for k in ENGINE_FILES if engine_path(k)]
    print("ZENTEX 本地编译服务  http://127.0.0.1:%d/" % port)
    print("  MiKTeX: %s" % (MIKTEX_BIN))
    print("  可用引擎: %s" % (", ".join(avail) if avail else "无（请检查 MiKTeX 路径）"))
    print("  本地打开: http://127.0.0.1:%d/omm-latex.html" % port)
    print("  云端页面: 在「编译 → 服务地址」填 http://127.0.0.1:%d" % port)
    print("  （已开启跨域；Chrome/Edge 的本地网络访问权限由浏览器负责检查）")
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
