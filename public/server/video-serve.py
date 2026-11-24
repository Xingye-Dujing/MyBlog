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
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import parse_qs, quote, unquote, urlparse

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

MAX_UPLOAD = 2 * 1024 * 1024 * 1024
MAX_BODY = 2 * 1024 * 1024
MAX_NODES = 200
MAX_CONNECTIONS = 500
LOOPBACK = ("127.0.0.1", "localhost", "::1")
SUPPORTED_FORMATS = ("mp4", "mkv", "webm", "mov", "gif", "mp3", "m4a", "wav")
_FID_RE = re.compile(r"^[0-9a-f]{12}_.+$")

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


def is_loopback_origin(origin: str) -> bool:
    try:
        parsed = urlparse(str(origin or ""))
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
            return False
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            return False
        return (parsed.hostname or "").lower() in LOOPBACK
    except Exception:
        return False


def _safe_name(name: str) -> str:
    name = str(name or "file").replace("\\", "/").rsplit("/", 1)[-1]
    return re.sub(r"[^\w.\-()（） ]", "_", name)[:160] or "file"


def resolve_upload(fid: str) -> Path:
    """只接受本服务生成的 fileId，并拒绝路径穿越与符号链接。"""
    fid = str(fid or "")
    if len(fid) > 160 or not _FID_RE.fullmatch(fid) or fid != _safe_name(fid):
        raise RuntimeError("非法 fileId")
    candidate = UPLOADS / fid
    if candidate.is_symlink():
        raise RuntimeError("上传文件不能是符号链接")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(UPLOADS.resolve())
    except FileNotFoundError:
        raise RuntimeError("找不到上传文件：%s" % fid)
    except ValueError:
        raise RuntimeError("上传文件路径越界")
    if not resolved.is_file():
        raise RuntimeError("上传文件不是普通文件")
    return resolved


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
    nodes = spec.get("nodes")
    connections = spec.get("connections")
    if not isinstance(nodes, list) or not isinstance(connections, list):
        raise ValueError("工作流缺少 nodes/connections 数组")
    if len(nodes) > MAX_NODES:
        raise ValueError("工作流节点过多（最多 %d）" % MAX_NODES)
    if len(connections) > MAX_CONNECTIONS:
        raise ValueError("工作流连线过多（最多 %d）" % MAX_CONNECTIONS)
    ids: Set[str] = set()
    allowed = {"input", "probe", "scene", "silence", "black", "thumbnail", "trim", "crop",
               "scale", "rotate", "speed", "volume", "mute", "fade", "drawtext", "audio",
               "concat", "format", "export"}
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise ValueError("nodes[%d] 必须是对象" % index)
        nid = str(node.get("id") or "")
        op = str(node.get("type") or node.get("op") or "")
        if not nid or len(nid) > 120 or re.search(r"[\x00-\x1f]", nid):
            raise ValueError("节点 id 为空或过长")
        if nid in ids:
            raise ValueError("节点 id 重复：%s" % nid)
        if op not in allowed:
            raise ValueError("未知节点类型：%s" % op)
        if node.get("data") is not None and not isinstance(node.get("data"), dict):
            raise ValueError("节点 data 必须是对象：%s" % nid)
        ids.add(nid)
    edge_keys: Set[str] = set()
    indegree = {nid: 0 for nid in ids}
    next_nodes: Dict[str, List[str]] = {nid: [] for nid in ids}
    for index, conn in enumerate(connections):
        if not isinstance(conn, dict):
            raise ValueError("connections[%d] 必须是对象" % index)
        source, target = str(conn.get("from") or ""), str(conn.get("to") or "")
        if source not in ids or target not in ids:
            raise ValueError("连线指向不存在的节点")
        if source == target:
            raise ValueError("节点不能连接自身")
        from_port, to_port = str(conn.get("fromPort") or "right"), str(conn.get("toPort") or "left")
        key = source + "\x00" + target + "\x00" + from_port + "\x00" + to_port
        if key in edge_keys:
            raise ValueError("重复连线")
        edge_keys.add(key)
        indegree[target] += 1
        next_nodes[source].append(target)
    queue = [nid for nid, degree in indegree.items() if degree == 0]
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


def execute_job(job_id: str) -> None:
    job = _jobs[job_id]
    nodes = job["spec"].get("nodes") or []
    edges = job["spec"].get("connections") or []
    by_id = {str(n.get("id")): n for n in nodes}
    order = _toposort(nodes, edges)
    outputs: Dict[str, str] = {}
    media_outputs: Dict[str, Dict[str, Any]] = {}
    jobdir = JOBS / job_id
    outdir = jobdir / "out"
    outdir.mkdir(parents=True, exist_ok=True)
    results: Dict[str, Any] = {}
    failed = False

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
            job["error"] = "节点 %s：%s" % (nid, message)

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
                state.update({"status": "running", "error": None})
            job["current"] = nid
            job["progress"] = round(idx / max(1, len(order)), 3)

            ins = _inputs_for(nid, edges, outputs)
            medias = input_media(nid)
            src_info = medias[0] if medias else None

            if op == "input":
                fid = str(params.get("fileId") or "")
                upload = resolve_upload(fid)
                info = probe(str(upload))
                if info.get("error"):
                    raise RuntimeError("节点 %s：%s" % (nid, info["error"]))
                outputs[nid] = str(upload)
                media_outputs[nid] = info
                results[nid] = {"probe": info}
                job["duration"] = info.get("duration", 0)
                with _lock:
                    state.update({"status": "done", "progress": 1, "result": results[nid]})
                continue

            src = ins[0] if ins else None
            if not src:
                fail(nid, state, "没有上游输入")
                break

            default_fmt = "mp3" if op == "audio" else "mp4"
            fmt = _ext(params.get("format") or default_fmt, default_fmt)
            out_name = "%s_%d.%s" % (re.sub(r"[^a-zA-Z0-9_-]", "_", nid), idx, fmt)
            out_path = str(outdir / out_name)

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
                if job.get("cancelled"):
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
            if job.get("cancelled"):
                with _lock:
                    state.update({"status": "cancelled", "progress": state.get("progress", 0)})
                break
            if code != 0:
                fail(nid, state, "ffmpeg 退出码 %d" % code, log)
                break

            produced = out_path
            if op == "thumbnail":
                made = sorted(str(path) for path in outdir.glob(out_name.split(".")[0] + "_*.jpg"))
                if not made:
                    fail(nid, state, "未生成缩略图", log)
                    break
                results[nid] = {"images": ["/api/file/%s/%s" % (job_id, quote(Path(path).name))
                                           for path in made]}
                produced = src
            elif not Path(produced).is_file():
                fail(nid, state, "ffmpeg 未生成输出文件", log)
                break
            if op == "export":
                filename = _output_filename(params.get("filename") or out_name, fmt)
                final = outdir / filename
                if final != Path(produced):
                    shutil.copy2(produced, final)
                produced = str(final)
            out_info = src_info if op == "thumbnail" else probe(produced)
            if out_info.get("error"):
                fail(nid, state, out_info["error"], out_info.get("raw", ""))
                break
            outputs[nid] = produced
            media_outputs[nid] = out_info
            if out_info.get("duration"):
                job["duration"] = out_info["duration"]
            with _lock:
                state.update({
                    "status": "done", "progress": 1,
                    "output": "/api/file/%s/%s" % (job_id, quote(Path(produced).name)),
                    "result": results.get(nid), "log": log[-3000:], "error": None,
                })
        with _lock:
            if failed:
                job["status"] = "error"
                for state in job["nodes"].values():
                    if state.get("status") == "pending":
                        state["status"] = "skipped"
            else:
                job["status"] = "cancelled" if job.get("cancelled") else "done"
    except Exception as exc:
        with _lock:
            job["status"] = "cancelled" if job.get("cancelled") else "error"
            job["error"] = None if job.get("cancelled") else str(exc)
            for state in job["nodes"].values():
                if state.get("status") == "running":
                    state.update({"status": "cancelled" if job.get("cancelled") else "error",
                                  "error": None if job.get("cancelled") else str(exc)})
                elif state.get("status") == "pending" and not job.get("cancelled"):
                    state["status"] = "skipped"
    finally:
        with _lock:
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

    def _trusted(self) -> bool:
        if not is_loopback_host(self.headers.get("Host", "")):
            return False
        origin = self.headers.get("Origin", "")
        if origin and not is_loopback_origin(origin):
            return False
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        return site in ("", "none", "same-origin", "same-site")

    def _reject(self) -> bool:
        if self._trusted():
            return False
        self._json({"ok": False, "error": "仅允许本机回环地址访问"}, 403)
        return True

    def _send(self, code: int, body: bytes, ctype: str, extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if origin and is_loopback_origin(origin) and is_loopback_host(self.headers.get("Host", "")):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
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
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = 0
        if size > MAX_BODY:
            raise OverflowError("payload too large")
        return self.rfile.read(size) if size > 0 else b""

    def _json_body(self) -> Dict[str, Any]:
        try:
            data = json.loads(self._body().decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def do_OPTIONS(self) -> None:  # noqa: N802
        if self._reject():
            return
        self._send(204, b"", "text/plain", {
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        })

    def do_GET(self) -> None:  # noqa: N802
        if self._reject():
            return
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
            try:
                upload = resolve_upload(fid)
            except RuntimeError as exc:
                self._json({"ok": False, "error": str(exc)}, 404 if str(exc).startswith("找不到") else 400)
                return
            self._json({"ok": True, "info": probe(str(upload))})
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
                    "error": job.get("error"), "cancelled": job["status"] == "cancelled",
                }
            self._json(snap)
            return
        if path.startswith("/api/file/"):
            parts = path.split("/")
            if len(parts) != 5 or not re.fullmatch(r"[0-9a-f]{12}", parts[3]):
                self._json({"ok": False, "error": "bad path"}, 400)
                return
            jid, name = parts[3], parts[4]
            if name != _safe_name(name):
                self._json({"ok": False, "error": "bad path"}, 400)
                return
            candidate = JOBS / jid / "out" / name
            if candidate.is_symlink():
                self._json({"ok": False, "error": "forbidden"}, 403)
                return
            try:
                target = candidate.resolve(strict=True)
                target.relative_to((JOBS / jid / "out").resolve())
            except (FileNotFoundError, ValueError):
                self._json({"ok": False, "error": "文件不存在"}, 404)
                return
            if not target.is_file():
                self._json({"ok": False, "error": "文件不存在"}, 404)
                return
            self._serve_file(target)
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

    def _write_upload(self, name: str) -> Tuple[Optional[Path], int]:
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = 0
        if size <= 0:
            return None, 400
        if size > MAX_UPLOAD:
            return None, 413
        UPLOADS.mkdir(parents=True, exist_ok=True)
        fid = uuid.uuid4().hex[:12]
        dest = UPLOADS / (fid + "_" + name)
        try:
            with dest.open("xb") as handle:
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise IOError("上传内容不完整")
                    handle.write(chunk)
                    remaining -= len(chunk)
        except FileExistsError:
            return None, 409
        except Exception:
            try:
                dest.unlink()
            except OSError:
                pass
            return None, 400
        return dest, 200

    def do_POST(self) -> None:  # noqa: N802
        if self._reject():
            return
        u = urlparse(self.path)
        path = u.path
        if path != "/api/upload":
            try:
                size = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                size = 0
            if size > MAX_BODY:
                self._json({"ok": False, "error": "payload too large"}, 413)
                return
        if path == "/api/upload":
            name = _safe_name((parse_qs(u.query).get("name") or ["video.mp4"])[0])
            dest, status = self._write_upload(name)
            if dest is None:
                self._json({"ok": False, "error": "文件为空、不完整或超过大小限制"}, status)
                return
            self._json({"ok": True, "fileId": dest.name, "name": name, "size": dest.stat().st_size})
            return
        if path == "/api/run":
            spec = self._json_body()
            try:
                spec = _validate_spec(spec)
            except ValueError as exc:
                self._json({"ok": False, "error": str(exc)}, 400)
                return
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
            with _lock:
                _jobs[jid] = job
            th = threading.Thread(target=execute_job, args=(jid,), daemon=True)
            th.start()
            self._json({"ok": True, "jobId": jid})
            return
        if path.startswith("/api/cancel/"):
            jid = path.split("/")[-1]
            with _lock:
                job = _jobs.get(jid)
                if job:
                    job["cancelled"] = True
            self._json({"ok": bool(job)}, 200 if job else 404)
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
