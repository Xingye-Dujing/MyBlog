# -*- coding: utf-8 -*-
"""Loopback server for the OMM-ZEN hub.

The hub shell is served on its own port. Products are not started up front:
the shell asks /api/ensure?app=<id> the first time an app is opened, and this
module starts (or reuses) the same static / Flask / LaTeX server the standalone
build would use. Each product therefore keeps its own origin and storage.

Run the shell in a normal browser for UI work:
    .venv\\Scripts\\python.exe desktop\\hub_server.py
"""
from __future__ import annotations

import argparse
import functools
import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from omm_launcher import (
    APPS,
    QuietHandler,
    existing_server_ok,
    start_latex,
    start_mdforge,
    start_static,
    wait_ready,
)

HUB_PORT = 8300
HUB_HTML = "omm-hub.html"


class HubServer:
    """Lazily owns one loopback server per product."""

    def __init__(self, root: Path, port: int = HUB_PORT):
        self.root = root
        self.port = port
        self.urls: dict[str, str] = {}
        self.lock = threading.Lock()

    def ensure(self, app_id: str) -> dict:
        if app_id not in APPS:
            raise KeyError("unknown app: %s" % app_id)
        with self.lock:
            cached = self.urls.get(app_id)
            if cached:
                return {"app": app_id, "url": cached}

            html, wanted_port, backend = APPS[app_id]
            if existing_server_ok(wanted_port, html):
                port = wanted_port
            elif backend == "mdforge":
                port = start_mdforge(wanted_port)
                if not wait_ready(wanted_port):
                    raise RuntimeError("MdForge 后端未能在端口 %d 启动" % wanted_port)
            elif backend == "latex":
                port = start_latex(wanted_port)
                if not wait_ready(wanted_port, seconds=30):
                    raise RuntimeError("LaTeX 后端未能在端口 %d 启动" % wanted_port)
            else:
                try:
                    port = start_static(self.root, wanted_port)
                except OSError:
                    # Fixed port occupied by an unrelated process; keep the
                    # app usable on an ephemeral port.
                    port = start_static(self.root, 0)

            url = "http://127.0.0.1:%d/%s" % (port, html)
            self.urls[app_id] = url
            return {"app": app_id, "url": url, "port": port, "backend": backend}


class HubHandler(QuietHandler):
    hub: HubServer

    def _reply(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlsplit(self.path)
        if parsed.path == "/api/ensure":
            app_id = parse_qs(parsed.query).get("app", [""])[0]
            try:
                self._reply(200, self.hub.ensure(app_id))
            except KeyError:
                self._reply(404, {"error": "unknown app"})
            except Exception as exc:  # noqa: BLE001 - surfaced to the shell
                self._reply(500, {"error": str(exc)})
            return
        if parsed.path == "/api/health":
            self._reply(200, {"ok": True, "apps": sorted(self.hub.urls)})
            return
        return super().do_GET()


def start_hub_server(root: Path, port: int = HUB_PORT):
    """Start (or reuse) the hub shell server; return its actual port."""
    if existing_server_ok(port, HUB_HTML):
        return port
    hub = HubServer(root, port)
    HubHandler.hub = hub
    handler = functools.partial(HubHandler, directory=str(root))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        hub.port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the OMM-ZEN hub shell")
    parser.add_argument("--port", type=int, default=HUB_PORT)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    port = start_hub_server(args.root.resolve(), args.port)
    print("OMM-ZEN hub  http://127.0.0.1:%d/%s" % (port, HUB_HTML))
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
