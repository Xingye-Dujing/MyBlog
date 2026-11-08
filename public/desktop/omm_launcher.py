# -*- coding: utf-8 -*-
"""OMM-ZEN desktop launcher.

Serves one of the omm-*.html apps (or a backed app) on loopback at a stable
port, then shows it in a native WebView2 window.

Run from source:
    .venv/Scripts/python.exe desktop/omm_launcher.py --app planner
"""
from __future__ import annotations

import argparse
import functools
import http.server
import importlib.util
import os
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

# app id -> (html file, loopback port, backend)
APPS = {
    "annotate":      ("omm-annotate.html",      8311, None),
    "corpus":        ("omm-corpus.html",        8312, None),
    "data":          ("omm-data.html",          8313, None),
    "english":       ("omm-english.html",       8314, None),
    "latex":         ("omm-latex.html",         8123, "latex"),
    "mdforge":       ("omm-mdforge.html",       8316, "mdforge"),
    "message":       ("omm-message.html",       8317, None),
    "planner":       ("omm-planner.html",       8318, None),
    "redact":        ("omm-redact.html",        8319, None),
    "visualization": ("omm-visualization.html", 8320, None),
    "writer":        ("omm-writer.html",        8321, None),
}

WINDOW_TITLES = {
    "annotate": "文本标注",
    "corpus": "英语语料库",
    "data": "数据工作台",
    "english": "六级备考",
    "latex": "LaTeX 编译工作台",
    "mdforge": "Markdown 铸造台",
    "message": "消息同步",
    "planner": "日程安排",
    "redact": "文档脱敏工具",
    "visualization": "可视化图表",
    "writer": "所思所想",
}


def resource_root() -> Path:
    """Folder holding the bundled html/assets (onefile temp dir when frozen)."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parent.parent


def data_root(app_id: str) -> Path:
    """Per-app persistent folder for the WebView2 profile (cookies/localStorage)."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    path = Path(base) / "OMM-ZEN" / app_id
    path.mkdir(parents=True, exist_ok=True)
    return path


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: D401 - silence stderr
        pass


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def existing_server_ok(port: int, html: str) -> bool:
    """True when the port already serves our app (second launch)."""
    if not port_open(port):
        return False
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:%d/%s" % (port, html), timeout=1.5
        ) as resp:
            return resp.status == 200
    except Exception:
        return False


def start_static(root: Path, port: int) -> int:
    handler = functools.partial(QuietHandler, directory=str(root))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def start_mdforge(port: int) -> int:
    sys.path.insert(0, str(resource_root()))
    from mdforge.server import app  # noqa: WPS433 - late import, bundle friendly

    def run():
        app.run(host="127.0.0.1", port=port, debug=False, threaded=True, use_reloader=False)

    threading.Thread(target=run, daemon=True).start()
    return port


def start_latex(port: int) -> int:
    script = resource_root() / "latex-serve.py"
    spec = importlib.util.spec_from_file_location("omm_latex_backend", str(script))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]

    def run():
        try:
            mod.main()
        except SystemExit:
            pass

    old_argv = sys.argv
    sys.argv = [str(script), str(port)]
    try:
        threading.Thread(target=run, daemon=True).start()
    finally:
        sys.argv = old_argv
    return port


def wait_ready(port: int, seconds: float = 20.0) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if port_open(port):
            return True
        time.sleep(0.15)
    return False


def run(app_id: str, debug: bool = False) -> None:
    if app_id not in APPS:
        raise SystemExit("unknown app: %s (choose from %s)" % (app_id, ", ".join(APPS)))
    html, wanted_port, backend = APPS[app_id]
    root = resource_root()

    shared = Path(
        os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    ) / "OMM-ZEN"
    shared.mkdir(parents=True, exist_ok=True)
    os.environ["OMM_SHARED_DIR"] = str(shared)
    os.environ["OMM_DATA_DIR"] = str(data_root(app_id))

    if not (root / html).is_file():
        raise SystemExit("missing %s next to the launcher" % html)

    window_title = WINDOW_TITLES[app_id]

    if existing_server_ok(wanted_port, html):
        port = wanted_port
    elif backend == "mdforge":
        port = start_mdforge(wanted_port)
        if not wait_ready(wanted_port):
            raise SystemExit("mdforge backend did not start on port %d" % wanted_port)
    elif backend == "latex":
        port = start_latex(wanted_port)
        if not wait_ready(wanted_port, seconds=30):
            raise SystemExit("latex backend did not start on port %d" % wanted_port)
    else:
        try:
            port = start_static(root, wanted_port)
        except OSError:
            # Fixed port taken by something else: fall back to an ephemeral one.
            # (localStorage lives under a different origin, but the app still runs.)
            port = start_static(root, 0)

    import webview

    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    os.environ.setdefault("WEBVIEW2_USER_DATA_FOLDER", str(data_root(app_id)))

    url = "http://127.0.0.1:%d/%s" % (port, html)
    webview.create_window(
        window_title,
        url,
        width=1280,
        height=860,
        min_size=(880, 600),
        text_select=True,
        zoomable=True,
    )
    # A real .ico is generated by the build; the files in the repo root are PNGs
    # only renamed to .ico, which System.Drawing refuses to load.
    icon = root / "app.ico"
    webview.start(
        debug=debug,
        private_mode=False,
        storage_path=str(data_root(app_id)),
        icon=str(icon) if icon.is_file() else None,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run an OMM-ZEN app in a desktop window")
    parser.add_argument("--app", required=True, choices=sorted(APPS))
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    run(args.app, debug=args.debug)


if __name__ == "__main__":
    main()
