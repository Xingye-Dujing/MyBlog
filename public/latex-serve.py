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
def run_pass(exe, work, mainfile, timeout=COMPILE_TIMEOUT):
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
    try:
        r = subprocess.run(
            args,
            cwd=work,
            capture_output=True,
            timeout=timeout,
            env=env,
            creationflags=0x08000000,
        )
        out = (r.stdout or b"").decode("utf-8", "replace")
        err = (r.stderr or b"").decode("utf-8", "replace")
        return r.returncode, out + ("\n" + err if err.strip() else ""), time.time() - t0
    except subprocess.TimeoutExpired:
        return 124, "! 编译超时（%d 秒）\n" % timeout, time.time() - t0
    except Exception as e:
        return 125, "! 无法启动编译器：%r\n" % (e,), time.time() - t0


def _level(msg):
    low = msg.lower()
    if "warning" in low:
        return "warning"
    return "error"


def extract_errors(log, mainfile):
    """从日志里抽出可定位的错误与警告，供编辑器标行。"""
    out = []
    seen = set()
    for line in log.splitlines():
        s = line.strip()
        # file:line: message   （-file-line-error 的输出）
        m = re.match(r"^\.?/?([^:\s]+\.(?:tex|sty|cls|def|cfg|clo)):(\d+):\s*(.+)$", s)
        if m:
            msg = m.group(3).strip()
            key = (m.group(1), m.group(2), msg)
            if key not in seen:
                seen.add(key)
                out.append(
                    {
                        "file": m.group(1),
                        "line": int(m.group(2)),
                        "msg": msg,
                        "level": _level(msg),
                    }
                )
            continue
        # ! message
        if s.startswith("!"):
            msg = s[1:].strip()
            if msg and msg not in seen:
                seen.add(msg)
                out.append(
                    {"file": mainfile, "line": 0, "msg": msg, "level": _level(msg)}
                )
    return out[:40]


def compile_tex(tex, engine="xelatex", passes=2, mainfile="main.tex"):
    exe = engine_path(engine)
    if not exe:
        return {"ok": False, "error": "找不到 %s，请确认 MiKTeX 安装路径" % engine}

    os.makedirs(BUILD_DIR, exist_ok=True)
    key = uuid.uuid4().hex[:12]
    work = os.path.join(BUILD_DIR, key)
    os.makedirs(work, exist_ok=True)

    try:
        with open(os.path.join(work, mainfile), "w", encoding="utf-8") as f:
            f.write(tex)

        logs = []
        codes = []
        t0 = time.time()
        n = max(1, min(4, int(passes or 1)))
        for i in range(n):
            code, out, _ = run_pass(exe, work, mainfile)
            codes.append(code)
            logs.append("===== 第 %d 遍 (%s) =====\n%s" % (i + 1, engine, out))
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

        if not os.path.isfile(pdf_src):
            shutil.rmtree(work, ignore_errors=True)
            return {
                "ok": False,
                "ms": elapsed,
                "log": logtxt[-60000:],
                "errors": extract_errors(logtxt, mainfile),
                "error": "编译未产出 PDF",
            }

        with open(pdf_src, "rb") as f:
            head = f.read(5)
        if not head.startswith(b"%PDF"):
            shutil.rmtree(work, ignore_errors=True)
            return {
                "ok": False,
                "ms": elapsed,
                "log": logtxt[-60000:],
                "errors": extract_errors(logtxt, mainfile),
                "error": "输出不是有效的 PDF",
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
            "errors": extract_errors(logtxt, mainfile),
        }
    except Exception as e:
        shutil.rmtree(work, ignore_errors=True)
        log_line("FAIL %s %r" % (key, e))
        return {"ok": False, "error": "编译异常：%r" % (e,)}


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
        if u.path != "/api/compile":
            return self.send_json({"ok": False, "error": "unknown endpoint"}, 404)

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

        with _compile_lock:
            res = compile_tex(tex, engine, passes, mainfile)
        return self.send_json(res)


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
