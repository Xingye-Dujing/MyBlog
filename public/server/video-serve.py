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

import copy
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
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import parse_qs, quote, unquote, urlparse

HERE = Path(__file__).resolve().parent
_DESKTOP = HERE.parent / "desktop"
if _DESKTOP.is_dir() and str(_DESKTOP) not in sys.path:
    sys.path.insert(0, str(_DESKTOP))

try:  # Desktop shell only; absent on the public website.
    import omm_shared  # type: ignore
    import omm_share  # type: ignore
except Exception:  # pragma: no cover
    omm_shared = None  # type: ignore
    omm_share = None  # type: ignore

# 静态资源根目录就是本文件所在目录（public/ 或插件目录）；
# ffmpeg 与工作目录也相对它解析，保证插件自包含。
# Source tree keeps backends in server/; staged bundles keep them beside assets.
BUNDLE = HERE.parent if (HERE.parent / "video-runtime").is_dir() else HERE

ROOT = BUNDLE
MAX_UPLOAD = 2 * 1024 * 1024 * 1024
MAX_BODY = 2 * 1024 * 1024
MAX_NODES = 200
MAX_CONNECTIONS = 500
JOB_TTL = 60 * 60
MAX_JOBS = 100
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
HUB_ORIGINS = {
    "http://127.0.0.1:8300",
    "http://localhost:8300",
    "http://[::1]:8300",
}
SUPPORTED_FORMATS = ("mp4", "mkv", "webm", "mov", "gif", "mp3", "m4a", "wav")
NODE_PORTS = {
    "input": ("right",),
    "probe": ("left", "right"),
    "scene": ("left", "right"),
    "silence": ("left", "right"),
    "black": ("left", "right"),
    "thumbnail": ("left", "right"),
    "trim": ("left", "right"),
    "crop": ("left", "right"),
    "scale": ("left", "right"),
    "rotate": ("left", "right"),
    "speed": ("left", "right"),
    "volume": ("left", "right"),
    "mute": ("left", "right"),
    "fade": ("left", "right"),
    "drawtext": ("left", "right"),
    "audio": ("left", "right"),
    "concat": ("left", "right"),
    "format": ("left", "right"),
    "export": ("left",),
}
_FID_RE = re.compile(r"^[0-9a-f]{12}_.+$")
_JOB_ID_RE = re.compile(r"^[0-9a-f]{12}$")
_BLOCKED_STATIC_DIRS = {
    "server", "desktop", "tests", "agent_workspace", "table-runtime",
    "video-runtime", "node_modules", ".git", "sharepages",
}
_BLOCKED_STATIC_FILES = {"sessions.json", "shares.json", "tokens.json"}

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


def work_root(root: Optional[Path] = None) -> Path:
    if root is None:
        handler = globals().get("Handler")
        root = getattr(handler, "root", ROOT) if handler else ROOT
    return (Path(root) if root else ROOT) / "video-runtime" / "work"


def uploads_dir(root: Optional[Path] = None) -> Path:
    path = work_root(root) / "uploads"
    path.mkdir(parents=True, exist_ok=True)
    return path


def jobs_dir(root: Optional[Path] = None) -> Path:
    path = work_root(root) / "jobs"
    path.mkdir(parents=True, exist_ok=True)
    return path


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
    if not info["video"] and not info["audio"]:
        info["error"] = "未检测到视频或音频流"
    # 保留最后 40 行，便于前端查看警告
    info["raw"] = "\n".join(text.splitlines()[-40:])
    return info


def is_loopback_host(host: str) -> bool:
    try:
        parsed = urlparse("//" + str(host or ""))
        if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            return False
        if parsed.port is not None and not 0 <= parsed.port <= 65535:
            return False
        return (parsed.hostname or "").lower() in LOOPBACK
    except Exception:
        return False


def _canonical_origin(value: str) -> str:
    try:
        parsed = urlparse(str(value or ""))
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
            return ""
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            return ""
        host = (parsed.hostname or "").lower()
        if host not in LOOPBACK:
            return ""
        if ":" in host:
            host = "[" + host + "]"
        port = parsed.port
        if port is not None and not 0 <= port <= 65535:
            return ""
        default = 443 if parsed.scheme == "https" else 80
        return "%s://%s%s" % (parsed.scheme, host, "" if port in (None, default) else ":%d" % port)
    except Exception:
        return ""


def trusted_origin(origin: str, host: str) -> bool:
    """Only the page's own origin or the explicit desktop Hub may call the API."""
    candidate = _canonical_origin(origin)
    if not candidate or not is_loopback_host(host):
        return False
    try:
        parsed = urlparse("//" + host)
        request_origin = "http://%s%s" % (
            "[" + parsed.hostname + "]" if ":" in (parsed.hostname or "") else parsed.hostname,
            "" if parsed.port in (None, 80) else ":%d" % parsed.port,
        )
    except Exception:
        return False
    return candidate == request_origin or candidate in HUB_ORIGINS


def _static_allowed(relative: str) -> bool:
    parts = Path(relative.replace("\\", "/")).parts
    if any(part.lower() in _BLOCKED_STATIC_DIRS for part in parts):
        return False
    name = parts[-1].lower() if parts else ""
    return name not in _BLOCKED_STATIC_FILES and not name.endswith((".py", ".pyc", ".pyo"))


def _contained_file(base: Path, candidate: Path) -> Optional[Path]:
    try:
        base = base.resolve(strict=True)
        relative = candidate.relative_to(base)
        current = base
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                return None
        target = candidate.resolve(strict=True)
        target.relative_to(base)
        return target if target.is_file() else None
    except (FileNotFoundError, NotADirectoryError, ValueError, OSError):
        return None


def _prune_jobs_locked(now: Optional[float] = None) -> List[str]:
    stamp = time.time() if now is None else now
    removed: List[str] = []
    expired = [jid for jid, job in _jobs.items()
               if job.get("status") != "running" and
               stamp - float(job.get("finishedAt") or job.get("createdAt") or stamp) >= JOB_TTL]
    for jid in expired:
        removed.append(jid)
        _jobs.pop(jid, None)
    terminal = sorted(
        ((float(job.get("finishedAt") or job.get("createdAt") or 0), jid)
         for jid, job in _jobs.items() if job.get("status") != "running"),
        reverse=True,
    )
    for _stamp, jid in terminal:
        if len(_jobs) < MAX_JOBS:
            break
        removed.append(jid)
        _jobs.pop(jid, None)
    return removed


def _remove_job_dirs(root: Path, job_ids: List[str]) -> None:
    for jid in job_ids:
        if _JOB_ID_RE.fullmatch(jid):
            shutil.rmtree(jobs_dir(root) / jid, ignore_errors=True)


def _safe_name(name: str) -> str:
    name = str(name or "file").replace("\\", "/").rsplit("/", 1)[-1]
    return re.sub(r"[^\w.\-()（） ]", "_", name)[:160] or "file"


def resolve_upload(fid: str, root: Optional[Path] = None) -> Path:
    """只接受本服务生成的 fileId，并拒绝路径穿越与符号链接。"""
    fid = str(fid or "")
    base = uploads_dir(root)
    if len(fid) > 160 or not _FID_RE.fullmatch(fid) or fid != _safe_name(fid) or "\\" in fid:
        raise RuntimeError("非法 fileId")
    candidate = base / fid
    if candidate.is_symlink():
        raise RuntimeError("上传文件不能是符号链接")
    target = _contained_file(base, candidate)
    if target is None:
        if not candidate.exists():
            raise RuntimeError("找不到上传文件：%s" % fid)
        raise RuntimeError("上传文件路径越界或不是普通文件")
    return target


def _output_filename(name: str, fmt: str) -> str:
    safe = _safe_name(name)
    if safe in (".", ".."):
        safe = "output"
    suffix = Path(safe).suffix
    if suffix.lower() != "." + fmt:
        safe = (safe[:-len(suffix)] if suffix else safe) + "." + fmt
    return safe


def _validate_spec(spec: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(spec, dict):
        raise ValueError("工作流必须是对象")
    if spec.get("format") != "omm-video-workflow":
        raise ValueError("工作流 format 必须是 omm-video-workflow")
    version = spec.get("version")
    if isinstance(version, bool) or not isinstance(version, (int, float)) or version != 1:
        raise ValueError("工作流 version 必须是数字 1")
    nodes = spec.get("nodes")
    connections = spec.get("connections")
    if not isinstance(nodes, list) or not isinstance(connections, list):
        raise ValueError("工作流缺少 nodes/connections 数组")
    if len(nodes) > MAX_NODES:
        raise ValueError("工作流节点过多（最多 %d）" % MAX_NODES)
    if len(connections) > MAX_CONNECTIONS:
        raise ValueError("工作流连线过多（最多 %d）" % MAX_CONNECTIONS)
    ids: Set[str] = set()
    by_id: Dict[str, Dict[str, Any]] = {}
    allowed = set(NODE_PORTS)
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise ValueError("nodes[%d] 必须是对象" % index)
        nid = str(node.get("id") or "")
        op = str(node.get("type") or "")
        if not nid or len(nid) > 120 or re.search(r"[\x00-\x1f]", nid):
            raise ValueError("节点 id 为空或过长")
        if nid in ids:
            raise ValueError("节点 id 重复：%s" % nid)
        if op not in allowed:
            raise ValueError("未知节点类型：%s" % op)
        if node.get("data") is not None and not isinstance(node.get("data"), dict):
            raise ValueError("节点 data 必须是对象：%s" % nid)
        ids.add(nid)
        by_id[nid] = node
    edge_keys: Set[Tuple[str, str, str, str]] = set()
    indegree = {nid: 0 for nid in ids}
    next_nodes: Dict[str, List[str]] = {nid: [] for nid in ids}
    incoming: Dict[str, List[Tuple[str, str, str]]] = {nid: [] for nid in ids}
    for index, conn in enumerate(connections):
        if not isinstance(conn, dict):
            raise ValueError("connections[%d] 必须是对象" % index)
        source, target = str(conn.get("from") or ""), str(conn.get("to") or "")
        if source not in ids or target not in ids:
            raise ValueError("连线指向不存在的节点")
        if source == target:
            raise ValueError("节点不能连接自身")
        from_port, to_port = str(conn.get("fromPort") or "right"), str(conn.get("toPort") or "left")
        if from_port not in NODE_PORTS[str(by_id[source].get("type"))]:
            raise ValueError("连线输出端口不合法：%s.%s" % (source, from_port))
        if to_port not in NODE_PORTS[str(by_id[target].get("type"))]:
            raise ValueError("连线输入端口不合法：%s.%s" % (target, to_port))
        key = (source, target, from_port, to_port)
        if key in edge_keys:
            raise ValueError("重复连线")
        edge_keys.add(key)
        indegree[target] += 1
        next_nodes[source].append(target)
        incoming[target].append((source, from_port, to_port))
    queue = [nid for nid in by_id if indegree[nid] == 0]
    visited = 0
    while queue:
        current = queue.pop(0)
        visited += 1
        for target in next_nodes[current]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if visited != len(ids):
        raise ValueError("工作流存在循环连线")
    for nid, node in by_id.items():
        op = str(node.get("type"))
        count = len(incoming[nid])
        if op == "input":
            if count:
                raise ValueError("input 节点不能有上游输入")
        elif op == "probe":
            if count > 1:
                raise ValueError("probe 节点最多接受一个上游输入")
        elif op == "concat":
            if count < 2:
                raise ValueError("concat 节点至少需要 2 个上游输入")
        elif count != 1:
            raise ValueError("节点 %s 必须且只能有一个上游输入" % nid)
    return spec


def _new_analysis() -> Dict[str, Any]:
    return {"scenes": [], "silences": [], "black": [],
            "silence_start": None, "black_start": None}


def _analysis_result(analysis: Dict[str, Any], op: str) -> Dict[str, Any]:
    if op == "scene":
        stamps = sorted(set(analysis["scenes"]))
        return {"scenes": stamps, "count": len(stamps)}
    if op == "silence":
        return {"silences": list(analysis["silences"])}
    if op == "black":
        return {"black": list(analysis["black"])}
    return {}


def _consume_analysis_line(analysis: Dict[str, Any], op: str, line: str) -> bool:
    changed = False
    if op == "scene":
        match = _SCENE_RE.search(line)
        if match:
            stamp = float(match.group(1))
            if stamp not in analysis["scenes"]:
                analysis["scenes"].append(stamp)
                changed = True
    elif op == "silence":
        match = _SILENCE_RE.search(line)
        if match:
            kind, value = match.group(1), float(match.group(2))
            if kind == "start":
                analysis["silence_start"] = value
                changed = True
            elif analysis["silence_start"] is not None:
                analysis["silences"].append({"start": analysis["silence_start"], "end": value})
                analysis["silence_start"] = None
                changed = True
    elif op == "black":
        match = _BLACK_RE.search(line)
        if match:
            kind, value = match.group(1), float(match.group(2))
            if kind == "start":
                analysis["black_start"] = value
                changed = True
            elif analysis["black_start"] is not None:
                analysis["black"].append({"start": analysis["black_start"], "end": value})
                analysis["black_start"] = None
                changed = True
    return changed


def run_ffmpeg(job: Dict[str, Any], node_id: str, args: List[str], duration: float = 0.0,
               op: str = "", analysis: Optional[Dict[str, Any]] = None) -> Tuple[int, str]:
    """执行 ffmpeg，实时累计进度与检测事件，不依赖最终日志尾部。"""
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
        if analysis is not None and _consume_analysis_line(analysis, op, line):
            with _lock:
                job["nodes"].setdefault(node_id, {})["result"] = _analysis_result(analysis, op)
        if job.get("cancelled"):
            proc.terminate()
            break
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
    if analysis is not None:
        if analysis.get("silence_start") is not None:
            analysis["silences"].append({"start": analysis["silence_start"], "end": None})
            analysis["silence_start"] = None
        if analysis.get("black_start") is not None:
            analysis["black"].append({"start": analysis["black_start"], "end": None})
            analysis["black_start"] = None
    with _lock:
        node = job["nodes"].get(node_id, {})
        node["progress"] = 1 if proc.returncode == 0 else node.get("progress", 0)
        node["log"] = "\n".join(lines[-60:])
        if analysis is not None:
            node["result"] = _analysis_result(analysis, op)
    return proc.returncode, "\n".join(lines[-60:])


# ---------------------------------------------------------------------------
# 图执行
# ---------------------------------------------------------------------------
def _ext(fmt: str, fallback: str = "mp4") -> str:
    value = str(fmt or fallback).lower().lstrip(".")
    if value == "video":
        value = "mp4"
    if value not in SUPPORTED_FORMATS:
        raise RuntimeError("不支持的容器格式：%s" % value)
    return value


def _streams(media: Optional[Dict[str, Any]]) -> Tuple[bool, bool]:
    if media is None:
        return True, True
    return bool(media.get("video")), bool(media.get("audio"))


def _encoding_args(fmt: str, media: Optional[Dict[str, Any]], crf: int = 20,
                   preset: str = "medium") -> List[str]:
    has_video, has_audio = _streams(media)
    if not has_video and not has_audio:
        raise RuntimeError("输入没有可编码的视频或音频流")
    if fmt == "gif":
        if not has_video:
            raise RuntimeError("GIF 输出需要视频流")
        return ["-an", "-loop", "0"]
    if fmt == "mp3":
        if not has_audio:
            raise RuntimeError("MP3 输出需要音频流")
        return ["-vn", "-c:a", "libmp3lame", "-q:a", "2"]
    if fmt in ("m4a", "wav"):
        if not has_audio:
            raise RuntimeError("%s 输出需要音频流" % fmt.upper())
        if fmt == "wav":
            return ["-vn", "-c:a", "pcm_s16le"]
        return ["-vn", "-c:a", "aac", "-b:a", "192k"]
    args: List[str] = []
    if has_video:
        if fmt == "webm":
            args += ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(crf),
                     "-deadline", "good", "-cpu-used", "2"]
        else:
            args += ["-c:v", "libx264", "-preset", str(preset), "-crf", str(crf),
                     "-pix_fmt", "yuv420p"]
        if fmt in ("mp4", "mov"):
            args += ["-movflags", "+faststart"]
    if has_audio:
        if fmt == "webm":
            args += ["-c:a", "libopus", "-b:a", "128k"]
        else:
            args += ["-c:a", "aac", "-b:a", "192k"]
    return args


def _gif_filter() -> str:
    return ("[0:v:0]fps=12,scale=480:-1:flags=lanczos,split[v0][v1];"
            "[v0]palettegen=max_colors=256[p];[v1][p]paletteuse=dither=bayer")


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


def build_concat_args(inputs: List[str], out: str) -> List[str]:
    if len(inputs) < 2:
        raise RuntimeError("视频拼接至少需要 2 个输入")
    infos = [probe(path) for path in inputs]
    has_video = any(bool(info.get("video")) for info in infos)
    has_audio = any(bool(info.get("audio")) for info in infos)
    if not has_video and not has_audio:
        raise RuntimeError("拼接输入没有可用的视频或音频流")
    first_video = next((info["video"] for info in infos if info.get("video")), {})
    width = int(first_video.get("width") or 1280)
    height = int(first_video.get("height") or 720)
    fps = float(first_video.get("fps") or 30)
    filters: List[str] = []
    segment_labels: List[str] = []
    for index, info in enumerate(infos):
        duration = max(0.04, float(info.get("duration") or 0))
        if has_video:
            label = "v%d" % index
            if info.get("video"):
                filters.append(
                    "[%d:v:0]scale=%d:%d:force_original_aspect_ratio=decrease,"
                    "pad=%d:%d:(ow-iw)/2:(oh-ih)/2,fps=%.6f,setsar=1,format=yuv420p,"
                    "setpts=PTS-STARTPTS[%s]" % (index, width, height, width, height, fps, label)
                )
            else:
                filters.append("color=c=black:s=%dx%d:r=%.6f:d=%.3f,format=yuv420p[%s]" %
                               (width, height, fps, duration, label))
            segment_labels.append("[%s]" % label)
        if has_audio:
            label = "a%d" % index
            if info.get("audio"):
                filters.append("[%d:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                               "asetpts=PTS-STARTPTS[%s]" % (index, label))
            else:
                filters.append("anullsrc=r=48000:cl=stereo,atrim=duration=%.3f[%s]" % (duration, label))
            segment_labels.append("[%s]" % label)
    output_labels = ("[v]" if has_video else "") + ("[a]" if has_audio else "")
    filters.append("".join(segment_labels) + "concat=n=%d:v=%d:a=%d%s" %
                   (len(inputs), int(has_video), int(has_audio), output_labels))
    args: List[str] = []
    for path in inputs:
        args += ["-i", path]
    args += ["-filter_complex", ";".join(filters)]
    if has_video:
        args += ["-map", "[v]"]
    if has_audio:
        args += ["-map", "[a]"]
    media = {"video": first_video if has_video else None, "audio": "mixed" if has_audio else None}
    args += _encoding_args(_ext(Path(out).suffix, "mp4"), media)
    return args + [out]


def build_args(op: str, p: Dict[str, Any], src: Optional[str], extra: List[str], out: str,
               media: Optional[Dict[str, Any]] = None) -> Tuple[List[str], bool]:
    """返回 (args, passthrough)。passthrough=True 表示分析结果节点把输入原样透传。"""
    p = p or {}
    common = ["-i", src] if src else []
    has_video, has_audio = _streams(media)
    if op in ("input", "probe"):
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
        if not has_video:
            raise RuntimeError("画面裁切需要视频流")
        w = int(p.get("w") or 0)
        h = int(p.get("h") or 0)
        x = int(p.get("x") or 0)
        y = int(p.get("y") or 0)
        return common + ["-vf", "crop=%d:%d:%d:%d" % (w or "iw", h or "ih", x, y), "-c:a", "copy", out], False
    if op == "scale":
        if not has_video:
            raise RuntimeError("尺寸缩放需要视频流")
        w = int(p.get("w") or 0)
        h = int(p.get("h") or 0)
        if p.get("fit") == "stretch":
            vf = "scale=%d:%d" % (w or -1, h or -1)
        else:
            vf = "scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2" % (
                w or -1, h or -1, w or "iw", h or "ih")
        return common + ["-vf", vf, "-c:a", "copy", out], False
    if op == "rotate":
        if not has_video:
            raise RuntimeError("旋转需要视频流")
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
        if not has_video and not has_audio:
            raise RuntimeError("调速需要视频或音频流")
        factor = max(0.25, min(4.0, float(p.get("factor") if p.get("factor") is not None else 1)))
        args = common[:]
        if has_video:
            args += ["-vf", "setpts=PTS/%.4f" % factor]
        if has_audio:
            af = "atempo=%.4f" % factor
            if factor > 2:
                af = "atempo=2,atempo=%.4f" % (factor / 2)
            args += ["-af", af]
        return args + [out], False
    if op == "volume":
        if not has_audio:
            return common + ["-c", "copy", out], False
        value = p.get("factor")
        factor = max(0.0, float(1 if value in (None, "") else value))
        return common + ["-c:v", "copy", "-af", "volume=%.3f" % factor, out], False
    if op == "mute":
        if not has_video:
            raise RuntimeError("去除音轨需要视频流")
        return common + ["-an", "-c:v", "copy", out], False
    if op == "fade":
        if not has_video:
            raise RuntimeError("淡入淡出需要视频流")
        kind = p.get("type") or "in"
        st = float(p.get("start") or 0)
        dur = float(p.get("duration") or 1)
        vf = "fade=t=%s:st=%.3f:d=%.3f" % (kind, st, dur)
        return common + ["-vf", vf, "-c:a", "copy", out], False
    if op == "drawtext":
        if not has_video:
            raise RuntimeError("叠加文字需要视频流")
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
        if not has_video:
            raise RuntimeError("缩略图需要视频流")
        interval = max(0.1, float(p.get("interval") or 5))
        count = max(1, min(30, int(p.get("count") or 8)))
        root = out.rsplit(".", 1)[0]
        vf = "fps=1/%.3f,scale=320:-1" % interval
        return common + ["-vf", vf, "-frames:v", str(count), root + "_%02d.jpg"], False
    if op == "scene":
        if not has_video:
            raise RuntimeError("场景检测需要视频流")
        th = float(p.get("threshold") or 0.3)
        return common + ["-vf", "select='gt(scene,%.3f)',showinfo" % th, "-an", "-f", "null", "-"], False
    if op == "silence":
        if not has_audio:
            raise RuntimeError("静音检测需要音频流")
        noise = p.get("noise") or "-40dB"
        dur = float(p.get("duration") or 0.5)
        return common + ["-af", "silencedetect=noise=%s:d=%.2f" % (noise, dur), "-f", "null", "-"], False
    if op == "black":
        if not has_video:
            raise RuntimeError("黑场检测需要视频流")
        dur = float(p.get("duration") or 0.5)
        return common + ["-vf", "blackdetect=d=%.2f:pix_th=0.10" % dur, "-an", "-f", "null", "-"], False
    if op == "audio":
        if not has_audio:
            raise RuntimeError("提取音频需要音频流")
        fmt = _ext(p.get("format") or "mp3", "mp3")
        return common + _encoding_args(fmt, {"video": None, "audio": "audio"}) + [out], False
    if op in ("format", "export"):
        fmt = _ext(p.get("format") or "mp4")
        crf = int(p.get("crf") or (23 if op == "format" else 20))
        preset = p.get("preset") or "medium"
        args = common[:]
        if fmt == "gif":
            args += ["-filter_complex", _gif_filter()]
        return args + _encoding_args(fmt, media, crf, preset) + [out], False
    if op == "concat":
        return build_concat_args([src] + list(extra or []), out), False
    raise RuntimeError("未知节点类型：%s" % op)


def execute_job(job_id: str, root: Optional[Path] = None) -> None:
    root = Path(root) if root else Path(getattr(Handler, "root", ROOT))
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        spec = copy.deepcopy(job["spec"])
    nodes = spec.get("nodes") or []
    edges = spec.get("connections") or []
    by_id = {str(node.get("id")): node for node in nodes}
    order = _toposort(nodes, edges)
    outputs: Dict[str, str] = {}
    media_outputs: Dict[str, Dict[str, Any]] = {}
    jobdir = jobs_dir(root) / job_id
    outdir = jobdir / "out"
    staging = jobdir / ".staging"
    outdir.mkdir(parents=True, exist_ok=True)
    staging.mkdir(parents=True, exist_ok=True)
    results: Dict[str, Any] = {}
    failed = False

    def cancelled() -> bool:
        with _lock:
            current = _jobs.get(job_id)
            return current is None or bool(current.get("cancelled"))

    def input_media(nid: str) -> List[Dict[str, Any]]:
        ordered = sorted((edge for edge in edges if str(edge.get("to")) == nid),
                         key=lambda edge: str(edge.get("toPort") or ""))
        return [media_outputs[str(edge.get("from"))] for edge in ordered
                if str(edge.get("from")) in outputs and str(edge.get("from")) in media_outputs]

    def fail(nid: str, state: Dict[str, Any], message: str, log: str = "") -> None:
        nonlocal failed
        failed = True
        with _lock:
            state.update({"status": "error", "error": message, "log": log[-3000:]})
            current = _jobs.get(job_id)
            if current is not None:
                current["error"] = "节点 %s：%s" % (nid, message)

    def publish(path: Path, name: str, kind: str) -> str:
        destination = outdir / name
        os.replace(path, destination)
        url = "/api/file/%s/%s" % (job_id, quote(name))
        with _lock:
            current = _jobs.get(job_id)
            if current is not None and kind != "intermediate":
                current.setdefault("outputs", []).append({"name": name, "url": url, "kind": kind})
        return str(destination)

    try:
        for idx, nid in enumerate(order):
            if cancelled():
                break
            node = by_id[nid]
            op = str(node.get("type") or "")
            params = node.get("data") if isinstance(node.get("data"), dict) else {}
            params = dict(params)
            with _lock:
                current = _jobs.get(job_id)
                if current is None:
                    return
                state = current["nodes"].setdefault(nid, {"status": "running", "progress": 0, "log": ""})
                state.update({"status": "running", "error": None})
                current["current"] = nid
                current["progress"] = round(idx / max(1, len(order)), 3)

            ins = _inputs_for(nid, edges, outputs)
            medias = input_media(nid)
            src_info = medias[0] if medias else None

            if op == "input":
                fid = str(params.get("fileId") or "")
                upload = resolve_upload(fid, root)
                info = probe(str(upload))
                if info.get("error"):
                    raise RuntimeError("节点 %s：%s" % (nid, info["error"]))
                outputs[nid] = str(upload)
                media_outputs[nid] = info
                results[nid] = {"probe": info}
                with _lock:
                    current = _jobs.get(job_id)
                    if current is not None:
                        current["duration"] = info.get("duration", 0)
                    state.update({"status": "done", "progress": 1, "result": results[nid]})
                continue

            # probe 是只读分析节点：可接上游，也可直接使用自身 fileId；
            # 未填写时明确回落到工作流中唯一的带文件 input。
            if op == "probe" and not ins:
                fid = str(params.get("fileId") or "")
                if not fid:
                    candidates = [str(n.get("data", {}).get("fileId") or "")
                                  for n in nodes if str(n.get("type")) == "input"
                                  and isinstance(n.get("data"), dict)]
                    candidates = [value for value in candidates if value]
                    if len(candidates) == 1:
                        fid = candidates[0]
                if not fid:
                    fail(nid, state, "probe 未连接上游，且没有可用的 fileId")
                    break
                upload = resolve_upload(fid, root)
                info = probe(str(upload))
                if info.get("error"):
                    fail(nid, state, info["error"], info.get("raw", ""))
                    break
                outputs[nid] = str(upload)
                media_outputs[nid] = info
                results[nid] = {"probe": info}
                with _lock:
                    state.update({"status": "done", "progress": 1, "result": results[nid],
                                  "log": info.get("raw", "")[-3000:], "error": None})
                continue

            src = ins[0] if ins else None
            if not src:
                fail(nid, state, "没有上游输入")
                break

            default_fmt = "mp3" if op == "audio" else "mp4"
            fmt = _ext(params.get("format") or default_fmt, default_fmt)
            out_name = "%s_%d.%s" % (re.sub(r"[^a-zA-Z0-9_-]", "_", nid), idx, fmt)
            temporary = staging / (".omm-" + uuid.uuid4().hex + "." + fmt)
            out_path = str(temporary)

            if op in ("probe", "scene", "silence", "black"):
                if op == "probe":
                    info = probe(src)
                    if info.get("error"):
                        fail(nid, state, info["error"], info.get("raw", ""))
                        break
                    results[nid] = {"probe": info}
                    log = info.get("raw", "")
                    code = 0
                else:
                    analysis = _new_analysis()
                    args, _ = build_args(op, params, src, ins[1:], out_path, src_info)
                    code, log = run_ffmpeg(job, nid, args, job.get("duration", 0), op, analysis)
                    results[nid] = _analysis_result(analysis, op)
                if cancelled():
                    with _lock:
                        state.update({"status": "cancelled", "progress": state.get("progress", 0)})
                    break
                if code != 0:
                    fail(nid, state, "ffmpeg 分析失败（退出码 %d）" % code, log)
                    break
                outputs[nid] = src
                media_outputs[nid] = src_info or {}
                with _lock:
                    state.update({"status": "done", "progress": 1, "result": results[nid],
                                  "log": log[-3000:], "error": None})
                continue

            if op == "concat":
                args = build_concat_args(ins, out_path)
            else:
                args, passthrough = build_args(op, params, src, ins[1:], out_path, src_info)
                if passthrough:
                    outputs[nid] = src
                    media_outputs[nid] = src_info or {}
                    with _lock:
                        state.update({"status": "done", "progress": 1})
                    continue
            code, log = run_ffmpeg(job, nid, args, job.get("duration", 0))
            if cancelled():
                with _lock:
                    state.update({"status": "cancelled", "progress": state.get("progress", 0)})
                break
            if code != 0:
                fail(nid, state, "ffmpeg 退出码 %d" % code, log)
                break

            produced = temporary
            if op == "thumbnail":
                made = sorted(staging.glob(temporary.stem + "_*.jpg"))
                if not made:
                    fail(nid, state, "未生成缩略图", log)
                    break
                images = []
                base_name = "%s_%d" % (re.sub(r"[^a-zA-Z0-9_-]", "_", nid), idx)
                for index, path in enumerate(made, start=1):
                    name = "%s_%02d.jpg" % (base_name, index)
                    publish(path, name, "thumbnail")
                    images.append("/api/file/%s/%s" % (job_id, quote(name)))
                results[nid] = {"images": images}
                produced_path = src
                out_info = src_info or {}
            else:
                if not produced.is_file():
                    fail(nid, state, "ffmpeg 未生成输出文件", log)
                    break
                out_info = probe(str(produced))
                if out_info.get("error"):
                    fail(nid, state, out_info["error"], out_info.get("raw", ""))
                    break
                filename = (_output_filename(params.get("filename") or out_name, fmt)
                            if op == "export" else out_name)
                produced_path = publish(produced, filename, "video" if op == "export" else "intermediate")
            outputs[nid] = produced_path
            media_outputs[nid] = out_info
            if out_info.get("duration"):
                with _lock:
                    current = _jobs.get(job_id)
                    if current is not None:
                        current["duration"] = out_info["duration"]
            with _lock:
                state.update({
                    "status": "done", "progress": 1,
                    "output": "/api/file/%s/%s" % (job_id, quote(Path(produced_path).name)),
                    "result": results.get(nid), "log": log[-3000:], "error": None,
                })
        with _lock:
            current = _jobs.get(job_id)
            if current is None:
                return
            was_cancelled = bool(current.get("cancelled"))
            if failed:
                current["status"] = "error"
            else:
                current["status"] = "cancelled" if was_cancelled else "done"
            if current["status"] == "cancelled":
                current["outputs"] = []
                for state in current["nodes"].values():
                    if state.get("status") in ("running", "pending"):
                        state["status"] = "cancelled"
            elif failed:
                for state in current["nodes"].values():
                    if state.get("status") == "pending":
                        state["status"] = "skipped"
    except Exception as exc:
        was_cancelled = cancelled()
        with _lock:
            current = _jobs.get(job_id)
            if current is not None:
                current["status"] = "cancelled" if was_cancelled else "error"
                current["error"] = None if was_cancelled else str(exc)
                if was_cancelled:
                    current["outputs"] = []
                for state in current["nodes"].values():
                    if state.get("status") == "running":
                        state.update({"status": current["status"],
                                      "error": None if was_cancelled else str(exc)})
                    elif state.get("status") == "pending" and not was_cancelled:
                        state["status"] = "skipped"
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        with _lock:
            current = _jobs.get(job_id)
            if current is not None:
                current["progress"] = 1
                current["finishedAt"] = time.time()
                keep = current.get("status") == "done"
            else:
                keep = False
        if not keep:
            shutil.rmtree(jobdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "OMMVideo/1.1"
    root = ROOT
    app_id = "video"

    def log_message(self, fmt: str, *args: Any) -> None:
        pass  # hub 里保持安静

    def _trusted(self) -> bool:
        host = self.headers.get("Host", "")
        if not is_loopback_host(host):
            return False
        origin = self.headers.get("Origin", "")
        if origin and not trusted_origin(origin, host):
            return False
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        return site in ("", "none", "same-origin", "same-site")

    def _cors_origin(self) -> str:
        origin = self.headers.get("Origin", "")
        return origin if origin and trusted_origin(origin, self.headers.get("Host", "")) else ""

    def _reject(self) -> bool:
        if self._trusted():
            return False
        if self.command in ("POST", "PUT", "PATCH"):
            try:
                size = int(self.headers.get("Content-Length") or 0)
                if 0 < size <= MAX_BODY:
                    self.rfile.read(size)
                elif size > MAX_BODY:
                    self.close_connection = True
            except (OSError, ValueError):
                self.close_connection = True
        self._json({"ok": False, "error": "仅允许同源页面或静书房 Hub 访问"}, 403)
        return True

    def _headers(self, code: int, ctype: str, length: int,
                 extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def _send(self, code: int, body: bytes, ctype: str, extra: Optional[Dict[str, str]] = None) -> None:
        self._headers(code, ctype, len(body), extra)
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, obj: Any, code: int = 200, extra: Optional[Dict[str, str]] = None) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8", extra)

    def _body(self) -> bytes:
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError as exc:
            raise ValueError("Content-Length 无效") from exc
        if size < 0:
            raise ValueError("Content-Length 无效")
        if size > MAX_BODY:
            raise OverflowError("payload too large")
        return self.rfile.read(size) if size else b""

    def _json_body(self) -> Dict[str, Any]:
        try:
            data = json.loads(self._body().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("请求 JSON 无效") from exc
        if not isinstance(data, dict):
            raise ValueError("请求 JSON 必须是对象")
        return data

    def _bridge_body(self) -> Optional[bytes]:
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError as exc:
            raise ValueError("Content-Length 无效") from exc
        limit = getattr(omm_shared, "MAX_BODY", MAX_BODY) if omm_shared else MAX_BODY
        if size < 0:
            raise ValueError("Content-Length 无效")
        if size > limit:
            self.close_connection = True
            self._json({"ok": False, "error": "payload too large"}, 413)
            return None
        return self.rfile.read(size) if size else b""

    def do_OPTIONS(self) -> None:  # noqa: N802
        if self._reject():
            return
        self._send(204, b"", "text/plain", {
            "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        })

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        if self._reject():
            return
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)

        if path.startswith("/__omm/share/"):
            if omm_share is None:
                self._json({"ok": False, "error": "not found"}, 404)
                return
            status, ctype, body = omm_share.handle_get(path, query, self.app_id)
            self._send(status, body, ctype)
            return
        if path.startswith("/__omm/fs/"):
            if omm_shared is None:
                self._json({"ok": False, "error": "not found"}, 404)
                return
            status, ctype, body = omm_shared.handle_get(
                path, query, self.app_id,
                capabilities=omm_shared.capabilities_for_app(self.app_id),
            )
            self._send(status, body, ctype)
            return

        if path == "/api/status":
            try:
                info = {"ffmpeg": ffmpeg_path(), "bundled": bundled_ffmpeg(), "version": ffmpeg_version()}
            except RuntimeError as exc:
                info = {"ffmpeg": "", "bundled": False, "version": str(exc)}
            self._json({"ok": True, "runtime": info, "workdir": str(work_root(self.root))})
            return
        if path == "/api/probe":
            fid = (query.get("file") or [""])[0]
            try:
                upload = resolve_upload(fid, self.root)
            except RuntimeError as exc:
                self._json({"ok": False, "error": str(exc)}, 404 if str(exc).startswith("找不到") else 400)
                return
            self._json({"ok": True, "info": probe(str(upload))})
            return
        if path.startswith("/api/job/"):
            jid = path.split("/")[-1]
            with _lock:
                removed = _prune_jobs_locked()
                job = _jobs.get(jid)
                snap = copy.deepcopy({
                    "ok": True,
                    "jobId": jid,
                    "status": job["status"],
                    "progress": job["progress"],
                    "current": job.get("current"),
                    "duration": job.get("duration", 0),
                    "nodes": job["nodes"],
                    "outputs": job.get("outputs", []),
                    "error": job.get("error"),
                    "cancelled": bool(job.get("cancelled")) or job["status"] == "cancelled",
                }) if job else None
            _remove_job_dirs(Path(self.root), removed)
            if snap is None:
                self._json({"ok": False, "error": "任务不存在或已回收"}, 404)
                return
            self._json(snap)
            return
        if path.startswith("/api/file/"):
            parts = [part for part in path.split("/") if part]
            if len(parts) != 4 or not _JOB_ID_RE.fullmatch(parts[2]):
                self._json({"ok": False, "error": "路径无效"}, 400)
                return
            jid, name = parts[2], parts[3]
            if not name or "\\" in name or name != _safe_name(name):
                self._json({"ok": False, "error": "路径无效"}, 400)
                return
            base = jobs_dir(self.root) / jid / "out"
            target = _contained_file(base, base / name)
            if target is None:
                self._json({"ok": False, "error": "文件不存在"}, 404)
                return
            self._serve_file(target, download=(query.get("download") or [""])[0] == "1",
                             download_name=name)
            return

        # 静态文件：不暴露后端源码、运行时工作区或 Lambda 状态。
        rel = path.lstrip("/") or "omm-video.html"
        if not _static_allowed(rel):
            self._json({"ok": False, "error": "forbidden"}, 403)
            return
        root = Path(self.root).resolve()
        target = (root / rel).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            self._json({"ok": False, "error": "forbidden"}, 403)
            return
        if target.is_dir():
            target = target / "omm-video.html"
        if not target.is_file():
            self._json({"ok": False, "error": "not found"}, 404)
            return
        self._serve_file(target)

    @staticmethod
    def _byte_range(value: str, size: int) -> Tuple[int, int]:
        if size <= 0:
            raise ValueError("invalid range")
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", str(value or "").strip())
        if not match or (not match.group(1) and not match.group(2)):
            raise ValueError("invalid range")
        first, last = match.groups()
        if first:
            start = int(first)
            end = int(last) if last else size - 1
            if start >= size or start < 0 or end < start:
                raise ValueError("invalid range")
            end = min(end, size - 1)
        else:
            suffix = int(last)
            if suffix <= 0:
                raise ValueError("invalid range")
            start = max(0, size - suffix)
            end = size - 1
        return start, end

    def _serve_file(self, path: Path, download: bool = False,
                    download_name: Optional[str] = None) -> None:
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        try:
            size = path.stat().st_size
        except OSError:
            self._json({"ok": False, "error": "文件不存在"}, 404)
            return
        start, end = 0, size - 1
        code = 200
        extra: Dict[str, str] = {"Accept-Ranges": "bytes"}
        raw_range = self.headers.get("Range")
        if raw_range:
            try:
                start, end = self._byte_range(raw_range, size)
            except ValueError:
                self._json({"ok": False, "error": "请求的字节范围无效"},
                           416, {"Content-Range": "bytes */%d" % size, "Accept-Ranges": "bytes"})
                return
            code = 206
            extra["Content-Range"] = "bytes %d-%d/%d" % (start, end, size)
        if download:
            name = download_name or path.name
            extra["Content-Disposition"] = "%s; filename*=UTF-8''%s" % (
                "attachment" if download else "inline", quote(name))
        length = 0 if size == 0 else end - start + 1
        self._headers(code, ctype, length, extra)
        if self.command == "HEAD" or not length:
            return
        try:
            with path.open("rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining:
                    chunk = handle.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _write_upload(self, name: str, root: Path) -> Tuple[Optional[Path], int]:
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = 0
        if size <= 0:
            return None, 400
        if size > MAX_UPLOAD:
            self.close_connection = True
            return None, 413
        base = uploads_dir(root)
        fid = uuid.uuid4().hex[:12]
        dest = base / (fid + "_" + name)
        temporary = base / (".upload-" + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("xb") as handle:
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise IOError("上传内容不完整")
                    handle.write(chunk)
                    remaining -= len(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, dest)
        except FileExistsError:
            temporary.unlink(missing_ok=True)
            return None, 409
        except Exception:
            try:
                temporary.unlink()
            except OSError:
                pass
            return None, 400
        return dest, 200

    def do_POST(self) -> None:  # noqa: N802
        if self._reject():
            return
        try:
            self._handle_post()
        except OverflowError:
            self.close_connection = True
            self._json({"ok": False, "error": "请求内容超过大小限制"}, 413)
        except ValueError as exc:
            self._json({"ok": False, "error": str(exc)}, 400)
        except Exception as exc:
            self._json({"ok": False, "error": str(exc)}, 500)

    def _handle_post(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/__omm/share/") or path.startswith("/__omm/fs/"):
            handler = omm_share if path.startswith("/__omm/share/") else omm_shared
            if handler is None:
                self._json({"ok": False, "error": "not found"}, 404)
                return
            body = self._bridge_body()
            if body is None:
                return
            query = parse_qs(parsed.query)
            if path.startswith("/__omm/share/"):
                status, ctype, payload = handler.handle_post(path, query, body, self.app_id)
            else:
                status, ctype, payload = handler.handle_post(
                    path, query, body, self.app_id,
                    capabilities=omm_shared.capabilities_for_app(self.app_id),
                )
            self._send(status, payload, ctype)
            return
        if path != "/api/upload":
            try:
                size = int(self.headers.get("Content-Length") or 0)
            except ValueError as exc:
                raise ValueError("Content-Length 无效") from exc
            if size > MAX_BODY:
                raise OverflowError("payload too large")
        if path == "/api/upload":
            name = _safe_name((parse_qs(parsed.query).get("name") or ["video.mp4"])[0])
            dest, status = self._write_upload(name, Path(self.root))
            if dest is None:
                self._json({"ok": False, "error": "文件为空、不完整或超过大小限制"}, status)
                return
            self._json({"ok": True, "fileId": dest.name, "name": name, "size": dest.stat().st_size})
            return
        if path == "/api/run":
            spec = _validate_spec(self._json_body())
            jid = uuid.uuid4().hex[:12]
            root = Path(self.root).resolve()
            job = {
                "id": jid,
                "spec": copy.deepcopy(spec),
                "status": "running",
                "progress": 0,
                "current": None,
                "duration": 0,
                "nodes": {str(node.get("id")): {"status": "pending", "progress": 0, "log": ""}
                          for node in (spec.get("nodes") or [])},
                "outputs": [],
                "error": None,
                "cancelled": False,
                "createdAt": time.time(),
                "root": str(root),
            }
            with _lock:
                removed = _prune_jobs_locked()
                full = len(_jobs) >= MAX_JOBS
                if not full:
                    _jobs[jid] = job
            _remove_job_dirs(root, removed)
            if full:
                self._json({"ok": False, "error": "运行中的任务过多，请稍后重试"}, 503)
                return
            try:
                threading.Thread(target=execute_job, args=(jid, root), daemon=True).start()
            except Exception as exc:
                with _lock:
                    _jobs.pop(jid, None)
                shutil.rmtree(jobs_dir(root) / jid, ignore_errors=True)
                self._json({"ok": False, "error": str(exc)}, 500)
                return
            self._json({"ok": True, "jobId": jid})
            return
        if path.startswith("/api/cancel/"):
            jid = path.split("/")[-1]
            with _lock:
                job = _jobs.get(jid)
                if job is None:
                    code, payload = 404, {"ok": False, "error": "任务不存在或已回收"}
                elif job.get("status") != "running":
                    code = 409
                    payload = {"ok": False, "error": "任务已结束，无法取消", "status": job.get("status")}
                else:
                    job["cancelled"] = True
                    code = 200
                    payload = {"ok": True, "jobId": jid, "cancelled": True, "status": "running"}
            self._json(payload, code)
            return
        self._json({"ok": False, "error": "not found"}, 404)


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(description="OMM-ZEN 视频工作台后端")
    ap.add_argument("--port", type=int, default=8329)
    ap.add_argument("--root", default=str(ROOT))
    args = ap.parse_args()
    Handler.root = Path(args.root)
    work_root(Handler.root).mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("OMM-ZEN Video serving on http://127.0.0.1:%d" % args.port)
    print("ffmpeg: %s" % ffmpeg_path())
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
