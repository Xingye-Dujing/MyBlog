# -*- coding: utf-8 -*-
"""table-serve.py — OMM-ZEN 表格自动化工作台后端。

依赖：Python 3.9+ 与 openpyxl。启动：
    python table-serve.py --port 8331
也可由 desktop/hub_server.py 作为模块加载（暴露 Handler）。

只监听 127.0.0.1；上传与产物都落在 table-runtime/work/ 下。
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import threading
import time
import uuid
from datetime import date, datetime, time as dtime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
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
DEFAULT_WORK = ROOT / "table-runtime" / "work"
MAX_UPLOAD = 120 * 1024 * 1024
SAFE_EXT = (".xlsx", ".xlsm")
LOOPBACK = ("127.0.0.1", "localhost", "::1", "[::1]")

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
    return str(host or "").split(":")[0].strip("[]").lower() in LOOPBACK


def is_loopback_origin(origin: str) -> bool:
    try:
        u = urlparse(str(origin or ""))
        if u.scheme not in ("http", "https", "ws", "wss"):
            return False
        return (u.hostname or "").lower() in ("127.0.0.1", "localhost", "::1")
    except Exception:
        return False


# ---------------------------------------------------------------------------
# 任务执行
# ---------------------------------------------------------------------------


def execute_job(job_id: str, root: Path) -> None:
    job = _jobs[job_id]
    job_dir = jobs_dir(root) / job_id
    out_dir = job_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    def resolver(fid: str) -> str:
        name = table_engine.safe_filename(fid, "")
        for candidate in (uploads_dir(root) / name, uploads_dir(root) / (name + ".xlsx")):
            if candidate.is_file():
                return str(candidate)
        matches = list(uploads_dir(root).glob(name + ".*"))
        if matches:
            return str(matches[0])
        raise table_engine.WorkflowError("找不到上传文件：%s，请在工作台重新导入" % fid)

    def on_event(name: str, payload: Dict[str, Any]) -> None:
        with _lock:
            if name == "node_start":
                job["nodes"][payload["id"]] = {
                    "status": "running", "progress": 0,
                    "message": payload.get("message", ""),
                }
                job["current"] = payload["id"]
            elif name == "node_done":
                node = job["nodes"].setdefault(payload["id"], {"status": "done"})
                node.update({"status": "done", "progress": 1, "result": payload.get("result", {})})
            elif name == "node_error":
                node = job["nodes"].setdefault(payload["id"], {"status": "error"})
                node.update({"status": "error", "error": payload.get("error", {})})
            elif name == "node_cancelled":
                node = job["nodes"].setdefault(payload["id"], {"status": "cancelled"})
                node.update({"status": "cancelled", "progress": 0})
            elif name == "progress":
                node = job["nodes"].setdefault(payload["id"], {"status": "running"})
                node["progress"] = payload.get("progress", 0)
                if payload.get("message"):
                    node["message"] = payload["message"]

    try:
        result = table_engine.run_workflow(
            job["spec"],
            options={
                "dryRun": bool(job.get("dryRun")),
                "previewNode": job.get("previewNode") or "",
                "outDir": str(out_dir),
            },
            resolver=resolver,
            on_event=on_event,
            cancelled=lambda: bool(job.get("cancelled")),
        )
        for output in result.get("outputs", []):
            name = table_engine.safe_filename(output.get("name") or "output.xlsx")
            output["url"] = "/api/file/%s/%s" % (job_id, name)
        with _lock:
            job["result"] = json_safe(result)
            job["outputs"] = json_safe(result.get("outputs", []))
            job["conflicts"] = json_safe(result.get("conflicts", []))
            job["warnings"] = json_safe(result.get("warnings", []))
            job["status"] = ("cancelled" if result.get("cancelled")
                             else "done" if result.get("ok") else "error")
            if not result.get("ok") and not result.get("cancelled"):
                job["error"] = result.get("error") or (result.get("errors") or [{}])[0]
    except Exception as exc:
        with _lock:
            job["status"] = "error"
            job["error"] = {"message": str(exc)}
    finally:
        with _lock:
            job["progress"] = 1
            job["finishedAt"] = time.time()


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "OMMTable/1.0"
    root = ROOT

    def log_message(self, fmt: str, *args: Any) -> None:
        pass

    def _trusted(self) -> bool:
        if not is_loopback_host(self.headers.get("Host", "")):
            return False
        origin = self.headers.get("Origin", "")
        return not origin or is_loopback_origin(origin)

    def _send(self, code: int, body: bytes, ctype: str, extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if origin and is_loopback_origin(origin):
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
            size = 0
        if size <= 0 or size > MAX_UPLOAD:
            return b""
        return self.rfile.read(size)

    def _json_body(self) -> Dict[str, Any]:
        try:
            data = json.loads(self._body().decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

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
        self._json({"ok": False, "error": "仅允许本机回环地址访问"}, 403)
        return True

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, b"", "text/plain", {
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        })

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
                job = _jobs.get(jid)
                if not job:
                    self._json({"ok": False, "error": "任务不存在"}, 404)
                    return
                snap = {
                    "ok": True, "jobId": jid, "status": job["status"],
                    "progress": job["progress"], "current": job.get("current"),
                    "nodes": job["nodes"], "outputs": job.get("outputs", []),
                    "conflicts": job.get("conflicts", []), "warnings": job.get("warnings", []),
                    "error": job.get("error"), "dryRun": bool(job.get("dryRun")),
                    "cancelled": job["status"] == "cancelled", "result": job.get("result"),
                }
            self._json(snap)
            return
        if path.startswith("/api/file/"):
            parts = [p for p in path.split("/") if p]
            if len(parts) < 4:
                self._json({"ok": False, "error": "路径无效"}, 400)
                return
            jid, name = parts[2], table_engine.safe_filename(parts[-1])
            target = jobs_dir(self.root) / jid / "out" / name
            if not target.is_file():
                self._json({"ok": False, "error": "文件不存在"}, 404)
                return
            ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            self._send(200, target.read_bytes(), ctype, {
                "Content-Disposition": "attachment; filename*=UTF-8''%s" % quote(name),
                "Accept-Ranges": "bytes",
            })
            return

        # 静态页面
        rel = path.lstrip("/") or "omm-table.html"
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
        self._send(200, target.read_bytes(), ctype)

    def do_POST(self) -> None:  # noqa: N802
        if self._reject():
            return
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
            data = self._body()  # 先读完请求体，避免拒绝时连接被残留数据打断
            if not name.lower().endswith(SAFE_EXT):
                self._json({"ok": False, "error": "只支持 .xlsx / .xlsm 文件"}, 400)
                return
            if not data:
                self._json({"ok": False, "error": "文件为空或超过大小限制"}, 400)
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
            jid = uuid.uuid4().hex[:12]
            nodes = spec.get("nodes") if isinstance(spec.get("nodes"), list) else []
            job = {
                "id": jid, "spec": spec, "status": "running", "progress": 0,
                "current": None, "nodes": {str(n.get("id")): {"status": "pending", "progress": 0}
                                           for n in nodes if isinstance(n, dict)},
                "outputs": [], "conflicts": [], "warnings": [], "error": None,
                "cancelled": False, "dryRun": bool(body.get("dryRun")),
                "previewNode": body.get("previewNode") or "",
                "createdAt": time.time(),
            }
            with _lock:
                _jobs[jid] = job
            threading.Thread(target=execute_job, args=(jid, Path(self.root)), daemon=True).start()
            self._json({"ok": True, "jobId": jid})
            return
        if path.startswith("/api/cancel/"):
            jid = path.split("/")[-1]
            with _lock:
                job = _jobs.get(jid)
                if job:
                    job["cancelled"] = True
            self._json({"ok": bool(job)})
            return
        self._json({"ok": False, "error": "not found"}, 404)


def _find_upload(root: Path, fid: str) -> Optional[Path]:
    if not fid:
        return None
    name = table_engine.safe_filename(fid, "")
    direct = uploads_dir(root) / name
    if direct.is_file():
        return direct
    matches = sorted(uploads_dir(root).glob(name + ".*"))
    return matches[0] if matches else None


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
