# -*- coding: utf-8 -*-
"""table-serve.py — OMM-ZEN 表格自动化工作台后端。

依赖：Python 3.9+ 与 openpyxl。启动：
    python table-serve.py --port 8331
也可由 desktop/hub_server.py 作为模块加载（暴露 Handler）。

只监听 127.0.0.1；上传与产物都落在当前插件根的 table-runtime/work/ 下。
"""
from __future__ import annotations

import argparse
import copy
import json
import mimetypes
import re
import shutil
import sys
import threading
import time
import uuid
from datetime import date, datetime, time as dtime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, quote, unquote, urlparse

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import openpyxl  # noqa: E402
import table_engine  # noqa: E402  (needs sys.path from HERE)

try:  # Desktop shell only; absent on the public website.
    import omm_shared  # type: ignore
    import omm_share  # type: ignore
except Exception:  # pragma: no cover
    omm_shared = None  # type: ignore
    omm_share = None  # type: ignore

# Source tree keeps backends in server/; staged bundles keep them beside assets.
BUNDLE = HERE.parent if (HERE.parent / "table-runtime").is_dir() else HERE

ROOT = BUNDLE
MAX_UPLOAD = 120 * 1024 * 1024
SAFE_EXT = (".xlsx", ".xlsm")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
HUB_ORIGINS = {
    "http://127.0.0.1:8300",
    "http://localhost:8300",
    "http://[::1]:8300",
}
JOB_TTL = 60 * 60
MAX_JOBS = 100
_JOB_ID_RE = re.compile(r"^[0-9a-f]{12}$")
_FILE_ID_RE = re.compile(r"^[0-9a-f]{12}_.+\.(?:xlsx|xlsm)$", re.I)
_BLOCKED_STATIC_DIRS = {
    "server", "desktop", "tests", "agent_workspace", "table-runtime",
    "video-runtime", "node_modules", ".git", "sharepages",
}
_BLOCKED_STATIC_FILES = {"sessions.json", "shares.json", "tokens.json"}

_jobs: Dict[str, Dict[str, Any]] = {}
_lock = threading.Lock()


def json_safe(value: Any) -> Any:
    if isinstance(value, (datetime, dtime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
    return value


def work_root(root: Optional[Path] = None) -> Path:
    if root is None:
        handler = globals().get("Handler")
        root = getattr(handler, "root", ROOT) if handler else ROOT
    base = Path(root) if root else ROOT
    return base / "table-runtime" / "work"


def uploads_dir(root: Optional[Path] = None) -> Path:
    path = work_root(root) / "uploads"
    path.mkdir(parents=True, exist_ok=True)
    return path


def jobs_dir(root: Optional[Path] = None) -> Path:
    path = work_root(root) / "jobs"
    path.mkdir(parents=True, exist_ok=True)
    return path


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
    if name in _BLOCKED_STATIC_FILES or name.endswith((".py", ".pyc", ".pyo")):
        return False
    return True


def _contained_file(base: Path, candidate: Path) -> Optional[Path]:
    """Resolve a generated file without allowing symlinked path components."""
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
    """Drop expired jobs, then oldest terminal jobs until a new slot is free."""
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


# ---------------------------------------------------------------------------
# 任务执行
# ---------------------------------------------------------------------------


def execute_job(job_id: str, root: Path) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        spec = copy.deepcopy(job["spec"])
    root = Path(root)
    job_dir = jobs_dir(root) / job_id
    out_dir = job_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    def resolver(fid: str) -> str:
        path = _find_upload(root, fid)
        if path is None:
            raise table_engine.WorkflowError("找不到上传文件：%s，请在工作台重新导入" % fid)
        return str(path)

    def cancelled() -> bool:
        with _lock:
            current = _jobs.get(job_id)
            return current is None or bool(current.get("cancelled"))

    def on_event(name: str, payload: Dict[str, Any]) -> None:
        with _lock:
            current = _jobs.get(job_id)
            if current is None:
                return
            if name == "node_start":
                current["nodes"][payload["id"]] = {
                    "status": "running", "progress": 0,
                    "message": payload.get("message", ""),
                }
                current["current"] = payload["id"]
            elif name == "node_done":
                node = current["nodes"].setdefault(payload["id"], {"status": "done"})
                node.update({"status": "done", "progress": 1, "result": payload.get("result", {})})
            elif name == "node_error":
                node = current["nodes"].setdefault(payload["id"], {"status": "error"})
                node.update({"status": "error", "error": payload.get("error", {})})
            elif name == "node_cancelled":
                node = current["nodes"].setdefault(payload["id"], {"status": "cancelled"})
                node.update({"status": "cancelled", "progress": 0})
            elif name == "progress":
                node = current["nodes"].setdefault(payload["id"], {"status": "running"})
                node["progress"] = payload.get("progress", 0)
                if payload.get("message"):
                    node["message"] = payload["message"]

    try:
        result = table_engine.run_workflow(
            spec,
            options={
                "dryRun": bool(job.get("dryRun")),
                "previewNode": job.get("previewNode") or "",
                "outDir": str(out_dir),
            },
            resolver=resolver,
            on_event=on_event,
            cancelled=cancelled,
        )
        for output in result.get("outputs", []):
            name = table_engine.safe_filename(output.get("name") or "output.xlsx")
            output["url"] = "/api/file/%s/%s" % (job_id, quote(name))
        with _lock:
            current = _jobs.get(job_id)
            if current is None:
                return
            is_cancelled = bool(current.get("cancelled")) or bool(result.get("cancelled"))
            current["result"] = json_safe(result)
            current["outputs"] = json_safe(result.get("outputs", []))
            current["conflicts"] = json_safe(result.get("conflicts", []))
            current["warnings"] = json_safe(result.get("warnings", []))
            current["status"] = "cancelled" if is_cancelled else "done" if result.get("ok") else "error"
            if not result.get("ok") and not is_cancelled:
                current["error"] = result.get("error") or (result.get("errors") or [{}])[0]
            if is_cancelled:
                current["outputs"] = []
    except Exception as exc:
        with _lock:
            current = _jobs.get(job_id)
            if current is not None:
                current["status"] = "cancelled" if current.get("cancelled") else "error"
                current["error"] = None if current.get("cancelled") else {"message": str(exc)}
                if current.get("cancelled"):
                    current["outputs"] = []
    finally:
        with _lock:
            current = _jobs.get(job_id)
            if current is not None:
                pending_state = "cancelled" if current.get("status") == "cancelled" else "skipped"
                for state in current["nodes"].values():
                    if state.get("status") == "pending":
                        state["status"] = pending_state
                current["progress"] = 1
                current["finishedAt"] = time.time()
                keep = current.get("status") == "done"
            else:
                keep = False
        if not keep:
            shutil.rmtree(job_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "OMMTable/1.1"
    root = ROOT

    def log_message(self, fmt: str, *args: Any) -> None:
        pass

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

    def _send(self, code: int, body: bytes, ctype: str,
              extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, obj: Any, code: int = 200) -> None:
        body = json.dumps(json_safe(obj), ensure_ascii=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _body(self) -> bytes:
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("Content-Length 无效")
        if size < 0:
            raise ValueError("Content-Length 无效")
        if size > MAX_UPLOAD:
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
        """Read a desktop-bridge POST body with the shared size limit."""
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = 0
        limit = getattr(omm_shared, "MAX_BODY", MAX_UPLOAD) if omm_shared else MAX_UPLOAD
        if size > limit:
            self._json({"ok": False, "error": "payload too large"}, 413)
            return None
        return self.rfile.read(size) if size > 0 else b""

    def _reject(self) -> bool:
        if self._trusted():
            return False
        if self.command in ("POST", "PUT", "PATCH"):
            try:
                size = int(self.headers.get("Content-Length") or 0)
                if 0 < size <= MAX_UPLOAD:
                    self.rfile.read(size)
                elif size > MAX_UPLOAD:
                    self.close_connection = True
            except (OSError, ValueError):
                self.close_connection = True
        self._json({"ok": False, "error": "仅允许同源页面或静书房 Hub 访问"}, 403)
        return True

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

        # 桌面桥：与其它带后端的插件保持同一份 /__omm 契约。
        if path.startswith("/__omm/share/"):
            if omm_share is None:
                self._json({"ok": False, "error": "not found"}, 404)
                return
            status, ctype, body = omm_share.handle_get(path, query, "table")
            self._send(status, body, ctype)
            return
        if path.startswith("/__omm/fs/"):
            if omm_shared is None:
                self._json({"ok": False, "error": "not found"}, 404)
                return
            status, ctype, body = omm_shared.handle_get(path, query, "table")
            self._send(status, body, ctype)
            return

        if path == "/api/status":
            version = getattr(openpyxl, "__version__", "?")
            self._json({"ok": True, "runtime": "python", "openpyxl": version,
                        "workdir": str(work_root(self.root))})
            return
        if path == "/api/book":
            fid = (query.get("file") or [""])[0]
            path_file = _find_upload(self.root, fid)
            if not path_file:
                self._json({"ok": False, "error": "文件不存在，请重新导入"}, 404)
                return
            try:
                self._json(table_engine.describe_workbook(str(path_file)))
            except table_engine.WorkflowError as exc:
                self._json({"ok": False, "error": exc.message}, 400)
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, 500)
            return
        if path.startswith("/api/job/"):
            jid = path.split("/")[-1]
            with _lock:
                removed = _prune_jobs_locked()
                job = _jobs.get(jid)
                snap = copy.deepcopy({
                    "ok": True, "jobId": jid, "status": job["status"],
                    "progress": job["progress"], "current": job.get("current"),
                    "nodes": job["nodes"], "outputs": job.get("outputs", []),
                    "conflicts": job.get("conflicts", []), "warnings": job.get("warnings", []),
                    "error": job.get("error"), "dryRun": bool(job.get("dryRun")),
                    "cancelled": bool(job.get("cancelled")) or job["status"] == "cancelled",
                    "result": job.get("result"),
                }) if job else None
            _remove_job_dirs(Path(self.root), removed)
            if snap is None:
                self._json({"ok": False, "error": "任务不存在或已回收"}, 404)
                return
            self._json(snap)
            return
        if path.startswith("/api/file/"):
            parts = [p for p in path.split("/") if p]
            if len(parts) != 4 or not _JOB_ID_RE.fullmatch(parts[2]):
                self._json({"ok": False, "error": "路径无效"}, 400)
                return
            jid, raw_name = parts[2], parts[3]
            name = table_engine.safe_filename(raw_name, "")
            if not name or "\\" in raw_name or "/" in raw_name or name != raw_name:
                self._json({"ok": False, "error": "路径无效"}, 400)
                return
            target = _contained_file(jobs_dir(self.root) / jid / "out",
                                     jobs_dir(self.root) / jid / "out" / name)
            if target is None:
                self._json({"ok": False, "error": "文件不存在"}, 404)
                return
            ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            self._send(200, target.read_bytes(), ctype, {
                "Content-Disposition": "attachment; filename*=UTF-8''%s" % quote(name),
                "X-Content-Type-Options": "nosniff",
            })
            return

        # 静态页面：只暴露产品运行所需资产，不暴露后端源码或运行时状态。
        rel = path.lstrip("/") or "omm-table.html"
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
            target = target / "omm-table.html"
        if not target.is_file():
            self._json({"ok": False, "error": "not found"}, 404)
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype, {"X-Content-Type-Options": "nosniff"})

    def do_POST(self) -> None:  # noqa: N802
        if self._reject():
            return
        try:
            self._handle_post()
        except OverflowError:
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
            status, ctype, payload = handler.handle_post(path, parse_qs(parsed.query), body, "table")
            self._send(status, payload, ctype)
            return
        if path == "/api/upload":
            provided = (parse_qs(parsed.query).get("name") or ["upload.xlsx"])[0]
            name = table_engine.safe_filename(provided, "upload.xlsx")
            data = self._body()
            if not name.lower().endswith(SAFE_EXT):
                self._json({"ok": False, "error": "只支持 .xlsx / .xlsm 文件"}, 400)
                return
            if not data:
                self._json({"ok": False, "error": "文件为空"}, 400)
                return
            fid = uuid.uuid4().hex[:12]
            dest = uploads_dir(self.root) / (fid + "_" + name)
            try:
                dest.write_bytes(data)
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, 500)
                return
            self._json({"ok": True, "fileId": dest.name, "name": name, "size": len(data)})
            return
        if path == "/api/expr/check":
            data = self._json_body()
            error = table_engine.check_expression(data.get("expression") or "")
            self._json({"ok": error is None, "error": error})
            return
        if path == "/api/run":
            body = self._json_body()
            spec = body.get("spec") if isinstance(body.get("spec"), dict) else body
            errors = table_engine.validate_workflow(spec)
            if errors:
                self._json({"ok": False, "error": errors[0].get("message") or "工作流无效",
                            "errors": errors}, 400)
                return
            jid = uuid.uuid4().hex[:12]
            nodes = spec.get("nodes") or []
            root = Path(self.root).resolve()
            job = {
                "id": jid, "spec": copy.deepcopy(spec), "status": "running", "progress": 0,
                "current": None,
                "nodes": {str(n.get("id")): {"status": "pending", "progress": 0}
                          for n in nodes if isinstance(n, dict)},
                "outputs": [], "conflicts": [], "warnings": [], "error": None,
                "cancelled": False, "dryRun": bool(body.get("dryRun")),
                "previewNode": body.get("previewNode") or "",
                "createdAt": time.time(), "root": str(root),
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


def _find_upload(root: Path, fid: str) -> Optional[Path]:
    fid = str(fid or "")
    if not _FILE_ID_RE.fullmatch(fid) or "\\" in fid or "/" in fid:
        return None
    return _contained_file(uploads_dir(root), uploads_dir(root) / fid)


def main() -> None:
    ap = argparse.ArgumentParser(description="OMM-ZEN 表格自动化后端")
    ap.add_argument("--port", type=int, default=8331)
    ap.add_argument("--root", default=str(ROOT))
    args = ap.parse_args()
    Handler.root = Path(args.root)
    work_root(Handler.root)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("OMM-ZEN Table serving on http://127.0.0.1:%d" % args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
