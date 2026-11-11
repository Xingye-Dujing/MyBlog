# -*- coding: utf-8 -*-
"""Loopback server for the OMM-ZEN hub.

The shell itself is plugin-agnostic. Every product is a plugin directory with a
plugin.json manifest; the hub asks /api/ensure?app=<id> when a tab is opened and
this module starts a static / mdforge / latex server on a stable local port.

Plugin management endpoints let the shell install, import and remove plugins at
runtime. The full offline build ships plugins under <root>/plugins; plugins
installed by the user live in %LOCALAPPDATA%\\OMM-ZEN\\plugins (or the macOS
equivalent) and override bundled plugins with the same id.

Run the shell in a normal browser for UI work:
    .venv\\Scripts\\python.exe desktop\\hub_server.py --plugins build\\plugin-dirs
"""
from __future__ import annotations

import argparse
import functools
import importlib.util
import json
import os
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from omm_launcher import (
    QuietHandler,
    ShellHandler,
    existing_server_ok,
    port_open,
    resource_root,
)
from plugin_manager import (
    PluginError,
    PluginRegistry,
    app_data_base,
    default_plugin_root,
    fetch_catalog,
    install_from_catalog,
    sha256_bytes,
)

HUB_PORT = 8300
HUB_HTML = "omm-hub.html"
MAX_IMPORT_BYTES = 220 * 1024 * 1024


class _QuietHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


def _serve(server: ThreadingHTTPServer) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return thread


def _stop_server(server) -> None:
    try:
        server.shutdown()
    except Exception:
        pass
    try:
        server.server_close()
    except Exception:
        pass


class HubServer:
    """Owns the plugin registry and one loopback server per opened plugin."""

    def __init__(self, root: Path, port: int = HUB_PORT, plugin_root: Path | None = None):
        self.root = root
        self.port = port
        self.user_plugin_root = Path(plugin_root) if plugin_root else default_plugin_root()
        bundled = root / "plugins"
        self.registry = PluginRegistry(
            user_root=self.user_plugin_root,
            bundled_root=bundled if bundled.is_dir() else None,
        )
        self.lock = threading.RLock()
        self.servers: dict[str, dict] = {}
        self.ports_path = self.user_plugin_root / "ports.json"
        self.ports = self._load_ports()
        self._catalog = None
        self._catalog_url = ""
        self._catalog_at = 0.0

    # ------------------------------------------------------------- ports
    def _load_ports(self) -> dict:
        try:
            data = json.loads(self.ports_path.read_text(encoding="utf-8"))
            return {str(k): int(v) for k, v in data.items()} if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _save_ports(self) -> None:
        try:
            self.ports_path.parent.mkdir(parents=True, exist_ok=True)
            self.ports_path.write_text(
                json.dumps(self.ports, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except Exception:
            pass

    def _pick_port(self, plugin: dict) -> int:
        preferred = int(plugin.get("port") or 0)
        remembered = int(self.ports.get(plugin["id"], 0) or 0)
        candidates = []
        for candidate in (preferred, remembered):
            if candidate and candidate not in candidates:
                candidates.append(candidate)
        for candidate in range(8340, 8500):
            if candidate not in candidates:
                candidates.append(candidate)
        for candidate in candidates:
            if not port_open(candidate):
                return candidate
        return 0

    def _remember_port(self, plugin_id: str, port: int) -> None:
        if port and self.ports.get(plugin_id) != port:
            self.ports[plugin_id] = port
            self._save_ports()

    # ------------------------------------------------------------ servers
    def _start_static(self, port: int, directory: Path):
        handler = functools.partial(ShellHandler, directory=str(directory))
        server = _QuietHTTPServer(("127.0.0.1", port), handler)
        _serve(server)
        return server

    def _start_mdforge(self, port: int, plugin_dir: Path):
        os.environ["OMM_PLUGIN_ROOT"] = str(plugin_dir)
        if str(self.root) not in sys.path:
            sys.path.insert(0, str(self.root))
        from mdforge.server import app  # noqa: WPS433
        from werkzeug.serving import make_server

        server = make_server("127.0.0.1", port, app, threaded=True)
        _serve(server)
        return server

    def _start_latex(self, port: int, plugin_dir: Path):
        os.environ["OMM_PLUGIN_ROOT"] = str(plugin_dir)
        script = self.root / "latex-serve.py"
        if not script.is_file():
            raise RuntimeError("缺少 latex-serve.py")
        spec = importlib.util.spec_from_file_location("omm_latex_plugin_backend", str(script))
        if spec is None or spec.loader is None:
            raise RuntimeError("无法加载 LaTeX 后端")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        server = _QuietHTTPServer(("127.0.0.1", port), module.Handler)
        _serve(server)
        return server

    def _url(self, port: int, entry: str) -> str:
        return "http://127.0.0.1:%d/%s" % (port, entry)

    def ensure(self, plugin_id: str) -> dict:
        with self.lock:
            plugin = self.registry.get(plugin_id)
            if not plugin:
                raise KeyError("unknown plugin: %s" % plugin_id)
            record = self.servers.get(plugin_id)
            if record:
                return {
                    "app": plugin_id,
                    "url": record["url"],
                    "port": record["port"],
                    "backend": plugin["runtime"],
                    "reused": record["owned"] is False,
                }

            entry = plugin["entry"]
            wanted = self._pick_port(plugin)
            runtime = plugin["runtime"]
            plugin_dir = Path(plugin["path"])

            if wanted and existing_server_ok(wanted, entry):
                url = self._url(wanted, entry)
                self.servers[plugin_id] = {
                    "url": url,
                    "port": wanted,
                    "server": None,
                    "owned": False,
                }
                self._remember_port(plugin_id, wanted)
                return {"app": plugin_id, "url": url, "port": wanted, "backend": runtime}

            def start(port: int):
                if runtime == "mdforge":
                    return self._start_mdforge(port, plugin_dir)
                if runtime == "latex":
                    return self._start_latex(port, plugin_dir)
                return self._start_static(port, plugin_dir)

            try:
                server = start(wanted)
                port = wanted or server.server_address[1]
            except OSError:
                server = start(0)
                port = server.server_address[1]
            url = self._url(port, entry)
            self.servers[plugin_id] = {
                "url": url,
                "port": port,
                "server": server,
                "owned": True,
            }
            self._remember_port(plugin_id, port)
            return {
                "app": plugin_id,
                "url": url,
                "port": port,
                "backend": runtime,
                "reused": False,
            }

    def stop(self, plugin_id: str) -> None:
        record = self.servers.pop(plugin_id, None)
        if record and record.get("owned") and record.get("server") is not None:
            _stop_server(record["server"])

    def restart(self, plugin_id: str) -> dict:
        """Stop the plugin's local server and start it again on the new files.

        After an update the old server keeps running against the replaced
        files (and, for the mdforge/latex runtimes, against the already
        imported backend).  Restarting right away means the plugin is usable
        again without restarting the whole hub.
        """
        with self.lock:
            self.stop(plugin_id)
            try:
                return self.ensure(plugin_id)
            except KeyError:
                return {}

    # ------------------------------------------------------------ plugins
    def list_plugins(self) -> dict:
        with self.lock:
            plugins = []
            for item in self.registry.list():
                plugins.append(
                    {
                        key: item[key]
                        for key in (
                            "id", "name", "version", "description", "glyph",
                            "entry", "runtime", "port", "order", "author",
                            "source",
                        )
                    }
                )
            return {
                "api": 1,
                "framework": "OMM-ZEN",
                "plugin_dir": str(self.user_plugin_root),
                "plugins": plugins,
            }

    def catalog(self, url: str = "", refresh: bool = False) -> dict:
        from plugin_manager import CATALOG_URL

        url = url or os.environ.get("OMM_CATALOG_URL") or CATALOG_URL
        with self.lock:
            if (
                not refresh
                and self._catalog is not None
                and self._catalog_url == url
                and time.time() - self._catalog_at < 120
            ):
                data = json.loads(json.dumps(self._catalog))
            else:
                data = fetch_catalog(url)
                self._catalog = json.loads(json.dumps(data))
                self._catalog_url = url
                self._catalog_at = time.time()
            installed = {item["id"]: item for item in self.registry.list()}
            for item in data.get("plugins", []):
                local = installed.get(item.get("id"))
                item["installed"] = bool(local)
                item["installed_version"] = local["version"] if local else ""
                item["installed_source"] = local["source"] if local else ""
                item["update_available"] = bool(
                    local and str(item.get("version", "")) != str(local.get("version", ""))
                )
            return data

    def install_online(self, plugin_id: str) -> dict:
        data = self.catalog()
        # Download outside the registry lock, then stop the old server before
        # replacing its files.
        from plugin_manager import bundle_url, download_bytes

        item = next((p for p in data.get("plugins", []) if p.get("id") == plugin_id), None)
        if not item:
            raise PluginError("在线目录中没有插件 %s" % plugin_id)
        payload = download_bytes(
            bundle_url(data, item), expected_sha256=str(item.get("sha256") or "")
        )
        with self.lock:
            self.stop(plugin_id)
            plugin = self.registry.install_zip(payload, imported=False)
        # Restart on the new files right away: the user should be able to
        # click the plugin right after the update without restarting the hub.
        started = self.restart(plugin_id)
        return {
            "ok": True,
            "plugin": plugin,
            "sha256": sha256_bytes(payload),
            "url": started.get("url", ""),
            "port": started.get("port", 0),
        }

    def import_zip(self, payload: bytes) -> dict:
        with self.lock:
            plugin = self.registry.install_zip(payload, imported=True)
            self.stop(plugin["id"])
        started = self.restart(plugin["id"])
        return {
            "ok": True,
            "plugin": plugin,
            "url": started.get("url", ""),
            "port": started.get("port", 0),
        }

    def remove_plugin(self, plugin_id: str) -> dict:
        with self.lock:
            self.stop(plugin_id)
            fallback = self.registry.remove(plugin_id)
            return {"ok": True, "bundled_remains": fallback}


class HubHandler(ShellHandler):
    hub: HubServer

    def _reply(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self, limit: int = MAX_IMPORT_BYTES) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise PluginError("请求体为空")
        if length > limit:
            raise PluginError("请求体过大")
        return self.rfile.read(length)

    def _json_body(self) -> dict:
        try:
            return json.loads(self._body(1024 * 1024).decode("utf-8"))
        except Exception as exc:
            raise PluginError("请求格式无效") from exc

    def do_GET(self):  # noqa: N802
        parsed = urlsplit(self.path)
        try:
            if self.handle_update_get():
                return
            if parsed.path == "/api/ensure":
                query = parse_qs(parsed.query)
                plugin_id = (query.get("app") or query.get("id") or [""])[0]
                self._reply(200, self.hub.ensure(plugin_id))
                return
            if parsed.path == "/api/plugins":
                self._reply(200, self.hub.list_plugins())
                return
            if parsed.path == "/api/catalog":
                query = parse_qs(parsed.query)
                url = (query.get("url") or [""])[0]
                refresh = (query.get("refresh") or ["0"])[0] == "1"
                self._reply(200, self.hub.catalog(url=url, refresh=refresh))
                return
            if parsed.path == "/api/health":
                self._reply(
                    200,
                    {
                        "ok": True,
                        "apps": sorted(self.hub.servers),
                        "plugins": [p["id"] for p in self.hub.registry.list()],
                        "plugin_dir": str(self.hub.user_plugin_root),
                    },
                )
                return
        except KeyError:
            self._reply(404, {"ok": False, "error": "unknown plugin"})
            return
        except PluginError as exc:
            self._reply(400, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            self._reply(500, {"ok": False, "error": str(exc)})
            return
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        parsed = urlsplit(self.path)
        try:
            if self.handle_desktop_post():
                return
            if self.handle_update_post():
                return
            if parsed.path == "/api/plugins/install":
                payload = self._json_body()
                plugin_id = str(payload.get("id") or "")
                if not plugin_id:
                    raise PluginError("缺少插件 id")
                self._reply(200, self.hub.install_online(plugin_id))
                return
            if parsed.path == "/api/plugins/import":
                payload = self._body()
                self._reply(200, self.hub.import_zip(payload))
                return
            if parsed.path == "/api/plugins/remove":
                payload = self._json_body()
                plugin_id = str(payload.get("id") or "")
                if not plugin_id:
                    raise PluginError("缺少插件 id")
                self._reply(200, self.hub.remove_plugin(plugin_id))
                return
        except PluginError as exc:
            self._reply(400, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            self._reply(500, {"ok": False, "error": str(exc)})
            return
        self._reply(404, {"ok": False, "error": "not found"})


def start_hub_server(root: Path, port: int = HUB_PORT, plugin_root: Path | None = None):
    """Start (or reuse) the hub shell server; return its actual port."""
    if existing_server_ok(port, HUB_HTML):
        return port
    hub = HubServer(root, port, plugin_root=plugin_root)
    HubHandler.hub = hub
    handler = functools.partial(HubHandler, directory=str(root))
    try:
        server = _QuietHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        server = _QuietHTTPServer(("127.0.0.1", 0), handler)
        hub.port = server.server_address[1]
    _serve(server)
    return server.server_address[1]


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the OMM-ZEN hub shell")
    parser.add_argument("--port", type=int, default=HUB_PORT)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--plugins", type=Path, default=None)
    args = parser.parse_args()
    plugin_root = args.plugins.resolve() if args.plugins else None
    port = start_hub_server(args.root.resolve(), args.port, plugin_root=plugin_root)
    print("OMM-ZEN hub  http://127.0.0.1:%d/%s" % (port, HUB_HTML))
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
