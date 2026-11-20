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

from app_updater import ShellHandler
import omm_shared
from product_registry import apps, window_titles

IS_WINDOWS = os.name == "nt"
IS_MACOS = sys.platform == "darwin"

# app id -> (html file, loopback port, backend)
# 全部由 plugin_specs.BUILTIN_PLUGINS 派生，新增产品只需改唯一真源一处；
# 这样也补上了旧硬编码表漏掉的 search（8322）。
APPS = apps()
WINDOW_TITLES = window_titles()

HUB_PORT = 8300
HUB_HTML = "omm-hub.html"


def resource_root() -> Path:
    """Folder holding the bundled html/assets (onefile temp dir when frozen)."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parent.parent


def app_data_base() -> Path:
    """Writable per-user application-data folder for the current platform."""
    if IS_MACOS:
        return Path.home() / "Library" / "Application Support"
    if IS_WINDOWS:
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


def data_root(app_id: str) -> Path:
    """Per-app persistent folder for the webview profile (cookies/localStorage)."""
    path = app_data_base() / "OMM-ZEN" / app_id
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
    handler = functools.partial(ShellHandler, directory=str(root))
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


def start_ai(port: int) -> int:
    """静书房 AI 工作区：在独立回环端口启动 agent-workspace 后端。"""
    root = resource_root()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    def run():
        try:
            import agent_workspace.omm_server as ai_server
            ai_server.create_app(root).run(
                host="127.0.0.1", port=port, debug=False, threaded=True, use_reloader=False
            )
        except Exception as exc:  # 启动失败要让 wait_ready 超时并给出提示
            print("AI workspace backend failed: %s" % exc, file=sys.stderr)

    threading.Thread(target=run, daemon=True).start()
    return port


def start_latex(port: int) -> int:
    script = resource_root() / "latex-serve.py"
    spec = importlib.util.spec_from_file_location("omm_latex_backend", str(script))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]

    def run():
        try:
            # 直接传端口，避免跨线程修改全局 sys.argv 造成竞态。
            try:
                mod.main(port)
            except TypeError:
                mod.main()
        except SystemExit:
            pass

    threading.Thread(target=run, daemon=True).start()
    return port


def _free_port() -> int:
    """Ask the OS for an unused loopback port (same small race as static apps)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def backend_port(wanted_port: int, html: str) -> int:
    """Pick a port for a thread-started backend server.

    ``start_*`` runs the real server in a daemon thread and a bind failure there
    is only printed, while ``wait_ready`` merely opens a TCP connection. If a
    foreign process holds the fixed port we would otherwise report "ready" and
    open the WebView on the wrong service. Fall back to an ephemeral port, just
    like the static-app path does.
    """
    if not port_open(wanted_port) or existing_server_ok(wanted_port, html):
        return wanted_port
    return _free_port()


def wait_ready(port: int, seconds: float = 20.0) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if port_open(port):
            return True
        time.sleep(0.15)
    return False


def _install_zoom(window, app_id: str) -> None:
    """Persist the native WebView2 zoom factor per product.

    Ctrl + mouse wheel is handled by WebView2 itself; subscribing to
    ``ZoomFactorChanged`` means the user's zoom choice is written to
    shared.json and restored the next time this product starts.
    """
    if not IS_WINDOWS:
        return
    try:
        import clr  # noqa: F401 - loads pythonnet
        from System import Action
    except Exception:
        return

    def setup():
        try:
            view = window.native.browser.webview
            saved = omm_shared.get_zoom(app_id)
            if saved and abs(float(saved) - 1.0) > 0.001:
                view.ZoomFactor = saved

            def changed(sender, _args):
                try:
                    omm_shared.set_zoom(app_id, float(sender.ZoomFactor))
                except Exception:
                    pass

            try:
                view.ZoomFactorChanged += changed
            except Exception:
                pass
            state["view"] = view
            state["last"] = float(view.ZoomFactor)
            state["ready"] = True
        except Exception:
            pass

    state = {"ready": False, "view": None, "last": 1.0, "current": 1.0}

    try:
        window.native.Invoke(Action(setup))
    except Exception:
        return

    def watch():
        # Ctrl + wheel is handled by WebView2; poll the factor so a change is
        # persisted even if the native ZoomFactorChanged event is not emitted.
        while state.get("ready"):
            time.sleep(0.8)
            view = state.get("view")
            if view is None:
                return

            def read():
                try:
                    state["current"] = float(view.ZoomFactor)
                except Exception:
                    pass

            try:
                window.native.Invoke(Action(read))
            except Exception:
                return
            value = float(state.get("current") or 1.0)
            if abs(value - float(state.get("last") or 1.0)) > 0.001:
                state["last"] = value
                try:
                    omm_shared.set_zoom(app_id, value)
                except Exception:
                    pass

    threading.Thread(target=watch, daemon=True).start()


def _present_maximized(window) -> None:
    try:
        window.maximize()
    except Exception:
        pass
    _install_zoom(window, (os.environ.get("OMM_APP_ID") or "app").strip() or "app")


def saved_geometry(app_id: str) -> dict | None:
    """Window geometry persisted in shared.json (ui.window.<app>)."""
    try:
        cfg = omm_shared.load_config()
        geo = ((cfg.get("ui") or {}).get("window") or {}).get(app_id)
        if isinstance(geo, dict) and int(geo.get("width") or 0) > 0:
            return geo
    except Exception:
        pass
    return None


def remember_geometry(window, app_id: str) -> None:
    """Write the window rect back to shared.json when the window closes.

    Best effort and Windows-only for now: WinForms exposes both the maximized
    state and the restore bounds, which is everything we need.  Any failure
    simply means the next launch uses the built-in default.
    """
    if not IS_WINDOWS:
        return

    def save():
        try:
            native = getattr(window, "native", None)
            if native is None:
                return
            maximized = int(native.WindowState) == 2  # FormWindowState.Maximized
            bounds = native.RestoreBounds if maximized else native.Bounds
            geometry = {
                "maximized": bool(maximized),
                "x": int(bounds.X),
                "y": int(bounds.Y),
                "width": int(bounds.Width),
                "height": int(bounds.Height),
            }
            if geometry["width"] < 200 or geometry["height"] < 200:
                return

            def apply(cfg):
                ui = cfg.setdefault("ui", {})
                win = ui.setdefault("window", {})
                win[app_id] = geometry

            omm_shared.mutate_config(apply)
        except Exception:
            pass

    try:
        window.events.closed += save
    except Exception:
        pass


def icon_file(root: Path) -> Path:
    """Window/tray icon: prefer the packaged app.ico, fall back to icon.ico."""
    app_icon = root / "app.ico"
    if app_icon.is_file():
        return app_icon
    return root / "icon.ico"


def prepared_icon(root: Path, app_id: str) -> Path | None:
    """A guaranteed-valid .ico for System.Drawing / the tray.

    The bundled ``icon.ico`` may be a PNG that was merely renamed (repo
    sources); WinForms loads it through System.Drawing and a bad file kills
    the whole CLR thread with an unhandled ArgumentException.  Re-encoding
    through Pillow produces a real multi-size ICO; if Pillow is missing or
    the source cannot be read we return None and the window keeps the
    default executable icon instead of crashing.
    """
    src = icon_file(root)
    if not src.is_file():
        return None
    target = data_root(app_id) / "window-icon.ico"
    try:
        from PIL import Image, ImageOps  # type: ignore

        img = Image.open(src).convert("RGBA")
        side = max(img.size)
        if side < 1:
            return None
        img = ImageOps.pad(img, (side, side), color=(0, 0, 0, 0))
        target.parent.mkdir(parents=True, exist_ok=True)
        img.save(
            target,
            format="ICO",
            sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
        )
        return target
    except Exception:
        return None


def optional_extras(window, app_id: str, icon_path: Path, enabled: bool = True) -> dict:
    """Tray icon + global hotkey when the optional dependencies exist.

    Neither pystray/Pillow nor keyboard ships with the app, so every step is
    guarded: without them the window simply behaves as before.  ``--plain``
    turns both off explicitly.  Returns what actually started, mainly so the
    tray can be stopped again in tests.
    """
    status = {"tray": None, "hotkey": False}
    if not enabled:
        return status

    def restore():
        try:
            window.show()
            window.restore()
        except Exception:
            pass

    try:
        import keyboard  # type: ignore

        keyboard.add_hotkey("ctrl+alt+space", restore)
        status["hotkey"] = True
    except Exception:
        pass

    try:
        import pystray  # type: ignore
        from PIL import Image  # type: ignore

        if not icon_path.is_file():
            return status
        image = Image.open(str(icon_path))
        menu = pystray.Menu(
            pystray.MenuItem(
                "静书房" if app_id == "hub" else "打开窗口",
                lambda *_: restore(),
                default=True,
            ),
            pystray.MenuItem("退出", lambda *_: window.destroy()),
        )
        tray = pystray.Icon("OMM-ZEN", image, "静书房", menu)
        threading.Thread(target=tray.run, daemon=True).start()
        status["tray"] = tray
    except Exception:
        pass
    return status


def _window_kwargs(app_id: str, title: str, url: str, default_size) -> dict:
    """create_window arguments that honour the saved geometry."""
    geometry = saved_geometry(app_id)
    kwargs = {
        "title": title,
        "url": url,
        "width": default_size[0],
        "height": default_size[1],
        "min_size": (880, 600) if app_id != "hub" else (1024, 680),
        "maximized": True,
        "text_select": True,
        "zoomable": True,
    }
    if geometry:
        kwargs["width"] = int(geometry.get("width") or default_size[0])
        kwargs["height"] = int(geometry.get("height") or default_size[1])
        if geometry.get("maximized"):
            kwargs["maximized"] = True
        else:
            kwargs["maximized"] = False
            if geometry.get("x") is not None:
                kwargs["x"] = int(geometry["x"])
                kwargs["y"] = int(geometry.get("y") or 0)
    return kwargs


def run(app_id: str, debug: bool = False, extras: bool = True) -> None:
    if app_id not in APPS:
        raise SystemExit("unknown app: %s (choose from %s)" % (app_id, ", ".join(APPS)))
    html, wanted_port, backend = APPS[app_id]
    root = resource_root()

    shared = app_data_base() / "OMM-ZEN"
    shared.mkdir(parents=True, exist_ok=True)
    os.environ["OMM_SHARED_DIR"] = str(shared)
    os.environ["OMM_DATA_DIR"] = str(data_root(app_id))
    os.environ["OMM_APP_ID"] = app_id
    os.environ["OMM_DESKTOP"] = "1"

    if not (root / html).is_file():
        raise SystemExit("missing %s next to the launcher" % html)

    window_title = WINDOW_TITLES[app_id]

    if existing_server_ok(wanted_port, html):
        port = wanted_port
    elif backend == "mdforge":
        target = backend_port(wanted_port, html)
        port = start_mdforge(target)
        if not wait_ready(port):
            raise SystemExit("mdforge backend did not start on port %d" % port)
    elif backend == "ai":
        target = backend_port(wanted_port, html)
        port = start_ai(target)
        if not wait_ready(port, seconds=30):
            raise SystemExit("AI workspace backend did not start on port %d" % port)
    elif backend == "latex":
        target = backend_port(wanted_port, html)
        port = start_latex(target)
        if not wait_ready(port, seconds=30):
            raise SystemExit("latex backend did not start on port %d" % port)
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
    if IS_WINDOWS:
        os.environ.setdefault("WEBVIEW2_USER_DATA_FOLDER", str(data_root(app_id)))

    url = "http://127.0.0.1:%d/%s" % (port, html)
    window = webview.create_window(**_window_kwargs(app_id, window_title, url, (1280, 860)))
    # maxmized=True sets the WinForms state before the first Show(); the shown
    # handler is only a safety net and also restores the saved zoom factor.
    try:
        window.events.shown += _present_maximized
    except Exception:
        pass

    # Windows uses the re-encoded .ico (see prepared_icon); macOS takes its
    # icon from the .app bundle.
    remember_geometry(window, app_id)
    optional_extras(window, app_id, icon_file(root), enabled=extras)
    start_options = {
        "debug": debug,
        "private_mode": False,
        "storage_path": str(data_root(app_id)),
    }
    if IS_WINDOWS:
        icon = prepared_icon(root, app_id)
        if icon:
            start_options["icon"] = str(icon)
    webview.start(**start_options)


def run_hub(
    debug: bool = False, plugin_root: Path | None = None, extras: bool = True
) -> None:
    """Open the integrated OMM-ZEN workspace."""
    root = resource_root()
    if not (root / HUB_HTML).is_file():
        raise SystemExit("missing %s next to the launcher" % HUB_HTML)

    shared = app_data_base() / "OMM-ZEN"
    shared.mkdir(parents=True, exist_ok=True)
    os.environ["OMM_SHARED_DIR"] = str(shared)
    os.environ["OMM_DATA_DIR"] = str(data_root("hub"))
    os.environ["OMM_APP_ID"] = "hub"
    os.environ["OMM_DESKTOP"] = "1"

    from hub_server import start_hub_server  # noqa: WPS433 - bundled module

    port = start_hub_server(root, HUB_PORT, plugin_root=plugin_root)

    import webview

    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    if IS_WINDOWS:
        os.environ.setdefault("WEBVIEW2_USER_DATA_FOLDER", str(data_root("hub")))

    url = "http://127.0.0.1:%d/%s" % (port, HUB_HTML)
    window = webview.create_window(
        "静书房",
        url,
        width=1600,
        height=1000,
        min_size=(1024, 680),
        maximized=True,
        text_select=True,
        zoomable=True,
    )
    try:
        window.events.shown += _present_maximized
    except Exception:
        pass

    optional_extras(window, "hub", icon_file(root), enabled=extras)
    start_options = {
        "debug": debug,
        "private_mode": False,
        "storage_path": str(data_root("hub")),
    }
    if IS_WINDOWS:
        icon = prepared_icon(root, "hub")
        if icon:
            start_options["icon"] = str(icon)

    webview.start(**start_options)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run an OMM-ZEN app in a desktop window")
    parser.add_argument(
        "--app", required=True, choices=sorted(APPS) + ["hub", "installer"]
    )
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--plugins", type=Path, default=None, help="plugin root for the hub")
    parser.add_argument("--catalog", default="", help="catalog URL/file for the installer")
    parser.add_argument(
        "--plain",
        action="store_true",
        help="disable the optional tray icon and global hotkey",
    )
    args = parser.parse_args()
    if args.app == "hub":
        run_hub(debug=args.debug, plugin_root=args.plugins, extras=not args.plain)
    elif args.app == "installer":
        from installer_server import run_installer  # noqa: WPS433

        run_installer(debug=args.debug, catalog=args.catalog)
    else:
        run(args.app, debug=args.debug, extras=not args.plain)


if __name__ == "__main__":
    main()
