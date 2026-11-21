# -*- coding: utf-8 -*-
"""video-serve.py — OMM-ZEN 视频分析与处理工作台后端

纯标准库实现，零 pip 依赖。所有节点编译为 ffmpeg 命令执行；ffmpeg 优先使用
随插件内置的 video-runtime/bin/ffmpeg.exe（轻量完整版，约 30MB 压缩包），
没有时回落到系统 PATH。前端只跟这里的 JSON API 打交道。

用法：
    python video-serve.py --port 8329
也可被 desktop/hub_server.py 作为模块加载（暴露 Handler）。
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
# 静态资源根目录就是本文件所在目录（public/ 或插件目录）；
# ffmpeg 与工作目录也相对它解析，保证插件自包含。
# Source tree keeps backends in server/; staged bundles keep them beside assets.
BUNDLE = HERE.parent if (HERE.parent / "video-runtime").is_dir() else HERE

ROOT = BUNDLE
WORK = ROOT / "video-runtime" / "work"
UPLOADS = WORK / "uploads"
JOBS = WORK / "jobs"
for _d in (WORK, UPLOADS, JOBS):
    _d.mkdir(parents=True, exist_ok=True)

_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_TIME_RE = re.compile(r"time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_VIDEO_RE = re.compile(r"Video:\s*([^,\n]+).*?(\d{2,5})x(\d{2,5})")
_FPS_RE = re.compile(r"([\d.]+)\s*fps")
_AUDIO_RE = re.compile(r"Audio:\s*([^,\n]+)")
_SCENE_RE = re.compile(r"pts_time:([\d.]+)")
_SILENCE_RE = re.compile(r"silence_(start|end):\s*([\d.]+)")
_BLACK_RE = re.compile(r"black_(start|end):\s*([\d.]+)")

_jobs: Dict[str, Dict[str, Any]] = {}
_lock = threading.Lock()
_ffmpeg_cache: Optional[str] = None


# ---------------------------------------------------------------------------
# ffmpeg 解析
# ---------------------------------------------------------------------------
def ffmpeg_path() -> str:
    global _ffmpeg_cache
    if _ffmpeg_cache:
        return _ffmpeg_cache
    candidates = [
        HERE / "video-runtime" / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"),
        ROOT / "video-runtime" / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"),
        Path(os.environ.get("OMM_FFMPEG", "")) if os.environ.get("OMM_FFMPEG") else None,
    ]
    for c in candidates:
        if c and Path(c).is_file():
            _ffmpeg_cache = str(c)
            return _ffmpeg_cache
    found = shutil.which("ffmpeg")
    if found:
        _ffmpeg_cache = found
        return found
    raise RuntimeError("未找到 ffmpeg：请把轻量版放到 video-runtime/bin/ 或加入 PATH")


def bundled_ffmpeg() -> bool:
    try:
        return "video-runtime" in ffmpeg_path().replace("\\", "/")
    except RuntimeError:
        return False


def ffmpeg_version() -> str:
    try:
        out = subprocess.run(
            [ffmpeg_path(), "-version"], capture_output=True, text=True, timeout=8
        ).stdout.splitlines()
        return out[0] if out else ""
    except Exception as exc:
        return str(exc)


def _ts(value: Optional[re.Match]) -> float:
    if not value:
        return 0.0
    try:
        h, m, s = value.group(1), value.group(2), value.group(3)
        return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception:
        return 0.0


def probe(path: str) -> Dict[str, Any]:
    """用 ffmpeg -i 解析媒体信息（不依赖 ffprobe，内置包更轻）。"""
    try:
        proc = subprocess.run(
            [ffmpeg_path(), "-hide_banner", "-nostdin", "-i", path],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=20,
        )
        text = proc.stderr or ""
    except Exception as exc:
        return {"error": str(exc)}
    info: Dict[str, Any] = {
        "duration": _ts(_DURATION_RE.search(text)),
        "video": None,
        "audio": None,
        "raw": "",
    }
    vm = _VIDEO_RE.search(text)
    if vm:
        vline = next((ln for ln in text.splitlines() if "Video:" in ln), "")
        fm = _FPS_RE.search(vline)
        info["video"] = {
            "codec": vm.group(1).strip(),
            "width": int(vm.group(2)),
            "height": int(vm.group(3)),
            "fps": float(fm.group(1)) if fm else None,
        }
    am = _AUDIO_RE.search(text)
    if am:
        info["audio"] = am.group(1).strip()
    # 保留最后 40 行，便于前端查看警告
    info["raw"] = "\n".join(text.splitlines()[-40:])
    return info


def _safe_name(name: str) -> str:
    name = os.path.basename(name or "file")
    return re.sub(r"[^\w.\-()（） ]", "_", name)[:120]


def run_ffmpeg(job: Dict[str, Any], node_id: str, args: List[str], duration: float = 0.0) -> Tuple[int, str]:
    """执行一条 ffmpeg 命令，实时把 time= 进度写回 job 状态。"""
    proc = subprocess.Popen(
        [ffmpeg_path(), "-hide_banner", "-nostdin", "-y"] + args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
    )
    lines: List[str] = []
    assert proc.stderr is not None
    for line in proc.stderr:
        line = line.rstrip()
        if not line:
            continue
        lines.append(line)
        if len(lines) > 400:
            lines.pop(0)
        tm = _TIME_RE.search(line)
        if tm and duration > 0:
            p = min(0.99, _ts(tm) / duration)
            with _lock:
                node = job["nodes"].get(node_id, {})
                node["progress"] = round(p, 3)
        if job.get("cancelled"):
            proc.terminate()
            break
    proc.wait(timeout=10)
    with _lock:
        node = job["nodes"].get(node_id, {})
        node["progress"] = 1 if proc.returncode == 0 else node.get("progress", 0)
        node["log"] = "\n".join(lines[-60:])
    return proc.returncode, "\n".join(lines[-60:])


# ---------------------------------------------------------------------------
# 图执行
# ---------------------------------------------------------------------------
def _ext(fmt: str, fallback: str = "mp4") -> str:
    fmt = (fmt or fallback).lower()
    return {"video": "mp4", "mp4": "mp4", "mkv": "mkv", "webm": "webm", "mov": "mov",
            "gif": "gif", "mp3": "mp3", "m4a": "m4a", "wav": "wav"}.get(fmt, fmt)


def _toposort(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> List[str]:
    ids = [str(n.get("id")) for n in nodes]
    known = set(ids)
    indeg = {i: 0 for i in ids}
    nxt: Dict[str, List[str]] = {i: [] for i in ids}
    for e in edges:
        a, b = str(e.get("from", "")), str(e.get("to", ""))
        if a in known and b in known and a != b:
            indeg[b] += 1
            nxt[a].append(b)
    queue = [i for i in ids if indeg[i] == 0]
    out: List[str] = []
    while queue:
        cur = queue.pop(0)
        out.append(cur)
        for n in nxt[cur]:
            indeg[n] -= 1
            if indeg[n] == 0:
                queue.append(n)
    # 有环时把剩余节点按原顺序追加，保证不静默丢节点
    for i in ids:
        if i not in out:
            out.append(i)
    return out


def _inputs_for(node_id: str, edges: List[Dict[str, Any]], outputs: Dict[str, str]) -> List[str]:
    ordered = sorted(
        [e for e in edges if str(e.get("to")) == node_id],
        key=lambda e: str(e.get("toPort") or ""),
    )
    result = []
    for e in ordered:
        p = outputs.get(str(e.get("from")))
        if p:
            result.append(p)
    return result


def _fmt_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds or 0))
    return "%02d:%02d:%06.3f" % (int(seconds // 3600), int((seconds % 3600) // 60), seconds % 60)


def build_args(op: str, p: Dict[str, Any], src: Optional[str], extra: List[str], out: str) -> Tuple[List[str], bool]:
    """返回 (args, passthrough)。passthrough=True 表示分析结果节点把输入原样透传。"""
    p = p or {}
    common = ["-i", src] if src else []
    if op == "input":
        return [], True
    if op == "probe":
        return [], True
    if op == "trim":
        start = _fmt_time(p.get("start", 0))
        args = common[:]
        if p.get("start"):
            args += ["-ss", start]
        if p.get("duration"):
            args += ["-t", str(p["duration"])]
        elif p.get("end"):
            args += ["-to", _fmt_time(p["end"])]
        return args + ["-c", "copy", out], False
    if op == "crop":
        w = int(p.get("w") or 0)
        h = int(p.get("h") or 0)
        x = int(p.get("x") or 0)
        y = int(p.get("y") or 0)
        return common + ["-vf", "crop=%d:%d:%d:%d" % (w or "iw", h or "ih", x, y), "-c:a", "copy", out], False
    if op == "scale":
        w = int(p.get("w") or 0)
        h = int(p.get("h") or 0)
        if p.get("fit") == "stretch":
            vf = "scale=%d:%d" % (w or -1, h or -1)
        else:
            vf = "scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2" % (
                w or -1, h or -1, w or "iw", h or "ih")
        return common + ["-vf", vf, "-c:a", "copy", out], False
    if op == "rotate":
        deg = int(p.get("degrees") or 0)
        vf = []
        if p.get("hflip"):
            vf.append("hflip")
        if p.get("vflip"):
            vf.append("vflip")
        if deg in (90, 180, 270):
            t = {90: "transpose=1", 180: "transpose=1,transpose=1", 270: "transpose=2"}[deg]
            vf.append(t)
        if not vf:
            return common + ["-c", "copy", out], False
        return common + ["-vf", ",".join(vf), "-c:a", "copy", out], False
    if op == "speed":
        factor = max(0.25, min(4.0, float(p.get("factor") or 1)))
        vf = "setpts=PTS/%.4f" % factor
        af = "atempo=%.4f" % factor
        if factor > 2:
            af = "atempo=2,atempo=%.4f" % (factor / 2)
        return common + ["-vf", vf, "-af", af, out], False
    if op == "volume":
        factor = max(0.0, float(p.get("factor") or 1))
        return common + ["-c:v", "copy", "-af", "volume=%.3f" % factor, out], False
    if op == "mute":
        return common + ["-an", "-c:v", "copy", out], False
    if op == "fade":
        kind = p.get("type") or "in"
        st = float(p.get("start") or 0)
        dur = float(p.get("duration") or 1)
        vf = "fade=t=%s:st=%.3f:d=%.3f" % (kind, st, dur)
        return common + ["-vf", vf, "-c:a", "copy", out], False
    if op == "drawtext":
        text = str(p.get("text") or "OMM-ZEN").replace("'", "\\'").replace(":", "\\:")
        x = p.get("x") or "(w-text_w)/2"
        y = p.get("y") or "(h-text_h)/2"
        size = int(p.get("fontsize") or 28)
        color = p.get("color") or "white"
        vf = "drawtext=text='%s':x=%s:y=%s:fontsize=%d:fontcolor=%s" % (text, x, y, size, color)
        if p.get("start"):
            vf += ":enable='between(t,%s,%s)'" % (p["start"], p.get("end") or 99999)
        return common + ["-vf", vf, "-c:a", "copy", out], False
    if op == "thumbnail":
        interval = max(0.1, float(p.get("interval") or 5))
        count = max(1, min(30, int(p.get("count") or 8)))
        root = out.rsplit(".", 1)[0]
        vf = "fps=1/%.3f,scale=320:-1" % interval
        return common + ["-vf", vf, "-frames:v", str(count), root + "_%02d.jpg"], False
    if op == "scene":
        th = float(p.get("threshold") or 0.3)
        return common + ["-vf", "select='gt(scene,%.3f)',showinfo" % th, "-an", "-f", "null", "-"], False
    if op == "silence":
        noise = p.get("noise") or "-40dB"
        dur = float(p.get("duration") or 0.5)
        return common + ["-af", "silencedetect=noise=%s:d=%.2f" % (noise, dur), "-f", "null", "-"], False
    if op == "black":
        dur = float(p.get("duration") or 0.5)
        return common + ["-vf", "blackdetect=d=%.2f:pix_th=0.10" % dur, "-an", "-f", "null", "-"], False
    if op == "audio":
        fmt = _ext(p.get("format") or "mp3", "mp3")
        return common + ["-vn", "-c:a", "libmp3lame" if fmt == "mp3" else "aac", "-q:a", "2", out], False
    if op == "format":
        fmt = _ext(p.get("format") or "mp4")
        crf = int(p.get("crf") or 23)
        preset = p.get("preset") or "medium"
        if fmt in ("gif",):
            return common + ["-vf", "fps=12,scale=480:-1", out], False
        return common + ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-c:a", "aac", out], False
    if op == "concat":
        ins = []
        for f in extra:
            ins += ["-i", f]
        n = len(extra)
        vfilter = "".join("[%d:v:0][%d:a:0]" % (i, i) for i in range(n)) + "concat=n=%d:v=1:a=1[v][a]" % n
        return ins + ["-filter_complex", vfilter, "-map", "[v]", "-map", "[a]", out], False
    if op == "export":
        fmt = _ext(p.get("format") or "mp4")
        if fmt == "mp3":
            return common + ["-vn", "-c:a", "libmp3lame", out], False
        return common + ["-c:v", "libx264", "-crf", "20", "-c:a", "aac", out], False
    # 未知操作：原样透传，不让整条流程崩掉
    return [], True


def execute_job(job_id: str) -> None:
    job = _jobs[job_id]
    nodes = job["spec"].get("nodes") or []
    edges = job["spec"].get("connections") or []
    by_id = {str(n.get("id")): n for n in nodes}
    order = _toposort(nodes, edges)
    outputs: Dict[str, str] = {}
    jobdir = JOBS / job_id
    outdir = jobdir / "out"
    outdir.mkdir(parents=True, exist_ok=True)
    results: Dict[str, Any] = {}

    try:
        for idx, nid in enumerate(order):
            if job.get("cancelled"):
                break
            node = by_id[nid]
            op = str(node.get("op") or node.get("type") or "probe")
            params = node.get("data") if isinstance(node.get("data"), dict) else (node.get("params") or {})
            params = dict(params or {})
            with _lock:
                state = job["nodes"].setdefault(nid, {"status": "running", "progress": 0, "log": ""})
                state["status"] = "running"
            job["current"] = nid
            job["progress"] = round(idx / max(1, len(order)), 3)

            ins = _inputs_for(nid, edges, outputs)

            # 输入节点：从已上传文件取路径
            if op == "input":
                fid = str(params.get("fileId") or "")
                upload = UPLOADS / (fid if fid.endswith((".mp4", ".mov", ".mkv", ".webm", ".mp3", ".wav", ".m4a")) else fid + ".mp4")
                if not upload.is_file():
                    candidates = list(UPLOADS.glob(fid + ".*"))
                    upload = candidates[0] if candidates else upload
                if not upload.is_file():
                    raise RuntimeError("节点 %s：找不到上传文件 %s" % (nid, fid))
                outputs[nid] = str(upload)
                info = probe(str(upload))
                results[nid] = {"probe": info}
                job["duration"] = info.get("duration", 0)
                with _lock:
                    state.update({"status": "done", "progress": 1, "result": info})
                continue

            src = ins[0] if ins else None
            if not src and op not in ("probe",):
                with _lock:
                    state.update({"status": "error", "error": "没有上游输入"})
                continue

            fmt = _ext(params.get("format") or "mp4", "mp4")
            out_name = "%s_%02d.%s" % (re.sub(r"[^a-zA-Z0-9_-]", "_", nid), idx, fmt)
            out_path = str(outdir / out_name)

            if op in ("probe", "scene", "silence", "black"):
                if op == "probe":
                    info = probe(src or "")
                    results[nid] = {"probe": info}
                    log = info.get("raw", "")
                    code = 0
                else:
                    args, _ = build_args(op, params, src, ins[1:], out_path)
                    code, log = run_ffmpeg(job, nid, args, job.get("duration", 0))
                    if op == "scene":
                        stamps = sorted(set(float(x) for x in _SCENE_RE.findall(log)))
                        results[nid] = {"scenes": stamps, "count": len(stamps)}
                    elif op == "silence":
                        starts = [float(x) for _, x in _SILENCE_RE.findall(log) if _ == "start"]
                        ends = [float(x) for _, x in _SILENCE_RE.findall(log) if _ == "end"]
                        results[nid] = {"silences": [{"start": s, "end": ends[i] if i < len(ends) else None}
                                                    for i, s in enumerate(starts)]}
                    else:
                        starts = [float(x) for _, x in _BLACK_RE.findall(log) if _ == "start"]
                        ends = [float(x) for _, x in _BLACK_RE.findall(log) if _ == "end"]
                        results[nid] = {"black": [{"start": s, "end": ends[i] if i < len(ends) else None}
                                                 for i, s in enumerate(starts)]}
                outputs[nid] = src or ""  # 分析节点透传， downstream 继续使用原视频
                with _lock:
                    state.update({
                        "status": "done" if code == 0 else "error",
                        "progress": 1 if code == 0 else 0,
                        "result": results.get(nid),
                        "log": log[-3000:],
                        "error": None if code == 0 else "ffmpeg 分析失败",
                    })
                continue

            args, passthrough = build_args(op, params, src, ins[1:], out_path)
            if passthrough:
                outputs[nid] = src or ""
                with _lock:
                    state.update({"status": "done", "progress": 1})
                continue
            if not args:
                with _lock:
                    state.update({"status": "error", "error": "节点参数不足"})
                continue
            code, log = run_ffmpeg(job, nid, args, job.get("duration", 0))
            if code == 0:
                produced = out_path
                if op == "thumbnail":
                    made = sorted(str(p) for p in outdir.glob(out_name.split(".")[0] + "_*.jpg"))
                    results[nid] = {"images": ["/api/file/%s/%s" % (job_id, Path(x).name) for x in made]}
                    produced = made[0] if made else src
                if op == "export":
                    final = str(outdir / _safe_name(params.get("filename") or out_name))
                    if Path(produced).is_file() and final != produced:
                        shutil.copy2(produced, final)
                    produced = final
                outputs[nid] = produced
                with _lock:
                    state.update({
                        "status": "done", "progress": 1,
                        "output": "/api/file/%s/%s" % (job_id, Path(produced).name),
                        "result": results.get(nid),
                        "log": log[-3000:],
                    })
            else:
                with _lock:
                    state.update({"status": "error", "error": "ffmpeg 退出码 %d" % code, "log": log[-3000:]})
        job["status"] = "cancelled" if job.get("cancelled") else "done"
    except Exception as exc:
        job["status"] = "error"
        job["error"] = str(exc)
        with _lock:
            for n in job["nodes"].values():
                if n.get("status") == "running":
                    n["status"] = "error"
                    n["error"] = str(exc)
    finally:
        job["progress"] = 1
        job["finishedAt"] = time.time()


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "OMMVideo/1.0"
    root = ROOT

    def log_message(self, fmt: str, *args: Any) -> None:
        pass  # hub 里保持安静

    def _send(self, code: int, body: bytes, ctype: str, extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, obj: Any, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _body(self) -> bytes:
        size = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(size) if size else b""

    def _json_body(self) -> Dict[str, Any]:
        try:
            return json.loads(self._body().decode("utf-8"))
        except Exception:
            return {}

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, b"", "text/plain", {
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        })

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        path = unquote(u.path)
        query = parse_qs(u.query)

        if path == "/api/status":
            try:
                info = {"ffmpeg": ffmpeg_path(), "bundled": bundled_ffmpeg(), "version": ffmpeg_version()}
            except RuntimeError as exc:
                info = {"ffmpeg": "", "bundled": False, "version": str(exc)}
            self._json({"ok": True, "runtime": info, "workdir": str(WORK)})
            return
        if path == "/api/probe":
            fid = (query.get("file") or [""])[0]
            files = list(UPLOADS.glob(_safe_name(fid) + ".*"))
            if not files:
                self._json({"ok": False, "error": "文件不存在"}, 404)
                return
            self._json({"ok": True, "info": probe(str(files[0]))})
            return
        if path.startswith("/api/job/"):
            jid = path.split("/")[-1]
            job = _jobs.get(jid)
            if not job:
                self._json({"ok": False, "error": "任务不存在"}, 404)
                return
            with _lock:
                snap = {
                    "ok": True,
                    "jobId": jid,
                    "status": job["status"],
                    "progress": job["progress"],
                    "current": job.get("current"),
                    "duration": job.get("duration", 0),
                    "nodes": job["nodes"],
                    "error": job.get("error"),
                }
            self._json(snap)
            return
        if path.startswith("/api/file/"):
            parts = path.split("/")
            if len(parts) < 5:
                self._json({"ok": False, "error": "bad path"}, 400)
                return
            jid, name = parts[3], _safe_name(parts[4])
            f = JOBS / jid / "out" / name
            if not f.is_file():
                self._json({"ok": False, "error": "文件不存在"}, 404)
                return
            self._serve_file(f)
            return

        # 静态文件
        rel = path.lstrip("/") or "omm-video.html"
        target = (self.root / rel).resolve()
        try:
            target.relative_to(self.root.resolve())
        except ValueError:
            self._json({"ok": False, "error": "forbidden"}, 403)
            return
        if target.is_dir():
            target = target / "omm-video.html"
        if not target.is_file():
            self._json({"ok": False, "error": "not found"}, 404)
            return
        self._serve_file(target)

    def _serve_file(self, f: Path) -> None:
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        size = f.stat().st_size
        extra = {"Accept-Ranges": "bytes"}
        start = 0
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            try:
                start = int(rng.split("=")[1].split("-")[0])
            except ValueError:
                start = 0
        if rng and start > 0 and start < size:
            data = f.read_bytes()[start:]
            self._send(206, data, ctype, dict(extra, **{"Content-Range": "bytes %d-%d/%d" % (start, size - 1, size)}))
            return
        self._send(200, f.read_bytes(), ctype, extra)

    def do_POST(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        path = u.path
        if path == "/api/upload":
            name = _safe_name((parse_qs(u.query).get("name") or ["video.mp4"])[0])
            fid = uuid.uuid4().hex[:12]
            dest = UPLOADS / (fid + "_" + name)
            dest.write_bytes(self._body())
            self._json({"ok": True, "fileId": dest.name, "name": name, "size": dest.stat().st_size})
            return
        if path == "/api/run":
            spec = self._json_body()
            jid = uuid.uuid4().hex[:12]
            job = {
                "id": jid,
                "spec": spec,
                "status": "running",
                "progress": 0,
                "current": None,
                "duration": 0,
                "nodes": {str(n.get("id")): {"status": "pending", "progress": 0, "log": ""}
                          for n in (spec.get("nodes") or [])},
                "error": None,
                "cancelled": False,
                "createdAt": time.time(),
            }
            _jobs[jid] = job
            th = threading.Thread(target=execute_job, args=(jid,), daemon=True)
            th.start()
            self._json({"ok": True, "jobId": jid})
            return
        if path.startswith("/api/cancel/"):
            jid = path.split("/")[-1]
            job = _jobs.get(jid)
            if job:
                job["cancelled"] = True
                self._json({"ok": True})
            else:
                self._json({"ok": False}, 404)
            return
        self._json({"ok": False, "error": "not found"}, 404)


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(description="OMM-ZEN 视频工作台后端")
    ap.add_argument("--port", type=int, default=8329)
    ap.add_argument("--root", default=str(ROOT))
    args = ap.parse_args()
    Handler.root = Path(args.root)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("OMM-ZEN Video serving on http://127.0.0.1:%d" % args.port)
    print("ffmpeg: %s" % ffmpeg_path())
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
