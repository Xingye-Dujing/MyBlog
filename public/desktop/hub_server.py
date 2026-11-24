# -*- coding: utf-8 -*-
"""Loopback server for the OMM-ZEN hub.

The shell itself is plugin-agnostic. Every product is a plugin directory with a
plugin.json manifest; the hub asks /api/ensure?app=<id> when a tab is opened and
this module starts a static / mdforge / latex server on a stable local port.

Plugin management endpoints let the shell install, import and remove plugins at
runtime. The full offline build ships plugins under <root>/plugins; plugins
installed by the user live in %LOCALAPPDATA%\\OMM-ZEN\\plugins (or the macOS
equivalent) and override bundled plugins with the same id.

Run the shell in a normal browser for UI work. The desktop bridge is enabled
by default so /__omm/fs/* behaves like the packaged EXE:
    .venv\\Scripts\\python.exe desktop\\hub_server.py --plugins build\\plugin-dirs

Pass --web-preview to exercise the public-website fallback instead.
"""
from __future__ import annotations

import argparse
import functools
import importlib.util
import json
import os
import re
import secrets
import sys
import threading
import time
import webbrowser
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
from plugin_specs import VERSION, is_newer
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
# 全量备份包含文档、快照与共享文件，体积远大于设置备份。
MAX_FULL_BACKUP_BYTES = 800 * 1024 * 1024
HUB_CREDENTIAL_HEADER = "X-OMM-Hub-Capability"
HUB_CREDENTIAL_GET = frozenset(
    {
        "/api/backup",
        "/api/full-backup",
        "/api/storage/open",
        "/api/window",
        "/api/detach",
    }
)
HUB_CREDENTIAL_POST = frozenset(
    {
        "/api/restore",
        "/api/full-restore",
        "/api/plugins/install",
        "/api/plugins/import",
        "/api/settings/plugin-dir",
        "/api/plugins/remove",
        "/api/cloud/upload",
        "/api/cloud/download",
        "/api/plugins/rollback",
        "/__omm/update/apply",
    }
)


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
        self.capability_token = secrets.token_urlsafe(32)
        self._capability_registry_path = self.user_plugin_root / "capabilities.json"
        self._trusted_plugins = self._load_trusted_plugins()
        self._catalog = None
        self._catalog_url = ""
        self._catalog_at = 0.0
        self._storage_cache = (0.0, None)
        self._sync_share()

    def _load_trusted_plugins(self) -> set[str]:
        try:
            raw = json.loads(self._capability_registry_path.read_text(encoding="utf-8-sig"))
            values = raw.get("trusted") if isinstance(raw, dict) else []
            return {
                str(item)
                for item in values or []
                if isinstance(item, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,40}", item)
            }
        except Exception:
            return set()

    def _save_trusted_plugins(self) -> None:
        try:
            self._capability_registry_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._capability_registry_path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps({"trusted": sorted(self._trusted_plugins)}, indent=2),
                encoding="utf-8",
            )
            os.replace(tmp, self._capability_registry_path)
        except Exception:
            pass

    def _set_plugin_trust(self, plugin_id: str, trusted: bool) -> None:
        if trusted:
            self._trusted_plugins.add(plugin_id)
        else:
            self._trusted_plugins.discard(plugin_id)
        self._save_trusted_plugins()

    def _plugin_capabilities(self, plugin: dict):
        import omm_shared

        if plugin.get("source") == "bundled" or plugin.get("id") in self._trusted_plugins:
            return omm_shared.capabilities_for_app(plugin.get("id") or "")
        return omm_shared.IMPORTED_FS_CAPABILITIES

    def _sync_share(self) -> None:
        """Seed the share policy from the installed plugin manifests.

        The merge is additive and never re-enables a channel the user turned
        off, so it is safe to run after every install / update / removal.
        """
        try:
            from omm_share import sync_policy

            sync_policy(self.registry.list())
        except Exception:
            pass

    # ------------------------------------------------------------- ports
    def _load_ports(self) -> dict:
        try:
            data = json.loads(self.ports_path.read_text(encoding="utf-8-sig"))
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
    def _start_static(
        self, port: int, directory: Path, default_app: str = "", capabilities=None
    ):
        handler = functools.partial(
            ShellHandler,
            directory=str(directory),
            default_app=default_app,
            capabilities=capabilities,
        )
        server = _QuietHTTPServer(("127.0.0.1", port), handler)
        _serve(server)
        return server

    def _start_mdforge(self, port: int, plugin_dir: Path):
        os.environ["OMM_PLUGIN_ROOT"] = str(plugin_dir)
        if str(self.root) not in sys.path:
            sys.path.insert(0, str(self.root))
        import mdforge.server as mdforge_server  # noqa: WPS433
        from werkzeug.serving import make_server

        # 每个 mdforge 插件实例创建独立的 Flask app，把静态根目录绑定在各自的
        # config 里。mdforge.server 的路由通过 _public_root() 读取当前 app 的配置，
        # 不再依赖进程级 PUBLIC_ROOT 全局变量（多插件并存时会互相串目录）。
        app = mdforge_server.create_app(plugin_dir.resolve(), app_id="mdforge")
        server = make_server("127.0.0.1", port, app, threaded=True)
        _serve(server)
        return server

    def _start_ai(self, port: int, plugin_dir: Path):
        """AI 工作区：内置 Python 后端（agent-workspace + OMM-ZEN 知识）。"""
        os.environ["OMM_PLUGIN_ROOT"] = str(plugin_dir)
        if str(self.root) not in sys.path:
            sys.path.insert(0, str(self.root))
        import agent_workspace.omm_server as ai_server  # noqa: WPS433
        from werkzeug.serving import make_server

        app = ai_server.create_app(plugin_dir.resolve(), app_id="ai")
        server = make_server("127.0.0.1", port, app, threaded=True)
        _serve(server)
        return server

    def _start_latex(self, port: int, plugin_dir: Path):
        os.environ["OMM_PLUGIN_ROOT"] = str(plugin_dir)
        script = self.root / "server" / "latex-serve.py"
        if not script.is_file():
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

    def _start_video(self, port: int, plugin_dir: Path):
        """视频工作台：内置 ffmpeg 的 Python 后端，零 pip 依赖。"""
        os.environ["OMM_PLUGIN_ROOT"] = str(plugin_dir)
        bundled = plugin_dir / "video-runtime" / "bin" / (
            "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        )
        if bundled.is_file():
            os.environ["OMM_FFMPEG"] = str(bundled)
        script = self.root / "server" / "video-serve.py"
        if not script.is_file():
            script = self.root / "video-serve.py"
        if not script.is_file():
            script = plugin_dir / "video-serve.py"
        if not script.is_file():
            raise RuntimeError("缺少 video-serve.py")
        spec = importlib.util.spec_from_file_location("omm_video_plugin_backend", str(script))
        if spec is None or spec.loader is None:
            raise RuntimeError("无法加载视频工作台后端")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        module.Handler.root = plugin_dir.resolve()
        server = _QuietHTTPServer(("127.0.0.1", port), module.Handler)
        _serve(server)
        return server

    def _start_table(self, port: int, plugin_dir: Path):
        """表格自动化：openpyxl 本地后端，只服务回环地址。"""
        os.environ["OMM_PLUGIN_ROOT"] = str(plugin_dir)
        script = plugin_dir / "table-serve.py"
        if not script.is_file():
            script = self.root / "server" / "table-serve.py"
        if not script.is_file():
            script = self.root / "table-serve.py"
        if not script.is_file():
            raise RuntimeError("缺少 table-serve.py")
        spec = importlib.util.spec_from_file_location("omm_table_plugin_backend", str(script))
        if spec is None or spec.loader is None:
            raise RuntimeError("无法加载表格自动化后端")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        module.Handler.root = plugin_dir.resolve()
        server = _QuietHTTPServer(("127.0.0.1", port), module.Handler)
        _serve(server)
        return server

    def _start_lambda(self, port: int, plugin_dir: Path):
        """Lambda 演算计算器：Flask 后端（public/server/lambda-app.py + 内置 extension 二进制）。"""
        from werkzeug.serving import make_server

        os.environ["OMM_PLUGIN_ROOT"] = str(plugin_dir)
        os.environ.setdefault("LAMBDA_DATA_DIR", str(app_data_base() / "OMM-ZEN" / "lambda"))
        if str(plugin_dir) not in sys.path:
            sys.path.insert(0, str(plugin_dir))
        script = self.root / "server" / "lambda-app.py"
        if not script.is_file():
            script = self.root / "lambda-app.py"
        if not script.is_file():
            script = plugin_dir / "lambda-app.py"
        if not script.is_file():
            raise RuntimeError("缺少 lambda-app.py")
        for name in ("extension.exe", "extension"):
            candidate = plugin_dir / name
            if candidate.is_file():
                os.environ["LAMBDA_INTERP_BIN"] = str(candidate)
                break
        spec = importlib.util.spec_from_file_location("omm_lambda_plugin_backend", str(script))
        if spec is None or spec.loader is None:
            raise RuntimeError("无法加载 Lambda 演算计算器后端")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        server = make_server("127.0.0.1", port, module.app, threaded=True)
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

            if wanted and existing_server_ok(wanted, entry, self.root):
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
                if runtime == "ai":
                    return self._start_ai(port, plugin_dir)
                if runtime == "latex":
                    return self._start_latex(port, plugin_dir)
                if runtime == "video":
                    return self._start_video(port, plugin_dir)
                if runtime == "table":
                    return self._start_table(port, plugin_dir)
                if runtime == "lambda":
                    return self._start_lambda(port, plugin_dir)
                return self._start_static(
                    port,
                    plugin_dir,
                    default_app=plugin_id,
                    capabilities=self._plugin_capabilities(plugin),
                )

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

    def stop_all(self) -> None:
        for plugin_id in list(self.servers):
            self.stop(plugin_id)

    # ------------------------------------------------------------ settings
    def settings(self) -> dict:
        from plugin_manager import app_data_base

        return {
            "plugin_dir": str(self.user_plugin_root),
            "default_plugin_dir": str(app_data_base() / "OMM-ZEN" / "plugins"),
        }

    def set_plugin_dir(self, raw_path: str) -> dict:
        """Point the plugin root at a new directory and move what is there.

        The per-plugin servers keep serving from the current paths, so they are
        stopped before the move and started again on demand afterwards.
        """
        from plugin_manager import migrate_plugin_root, normalize_plugin_root

        with self.lock:
            new_root = normalize_plugin_root(raw_path)
            old_root = self.user_plugin_root
            try:
                same = new_root.resolve() == old_root.resolve()
            except OSError:
                same = False
            if same:
                return {
                    "ok": True,
                    "unchanged": True,
                    "plugin_dir": str(self.user_plugin_root),
                    "moved": 0,
                    "plugins": self.list_plugins()["plugins"],
                }
            self.stop_all()
            result = migrate_plugin_root(new_root, old_root)
            self.user_plugin_root = new_root
            self.registry.user_root = new_root
            self.registry.reload()
            self._sync_share()
            self.ports_path = new_root / "ports.json"
            self.ports = self._load_ports()
            self._capability_registry_path = new_root / "capabilities.json"
            self._trusted_plugins = self._load_trusted_plugins()
            return {
                "ok": True,
                "unchanged": False,
                "plugin_dir": str(new_root),
                "old_plugin_dir": result.get("old", str(old_root)),
                "moved": result.get("moved", 0),
                "leftover": bool(result.get("leftover")),
                "plugins": self.list_plugins()["plugins"],
            }

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
                info = {
                    key: item.get(key)
                    for key in (
                        "id", "name", "version", "description", "glyph",
                        "entry", "runtime", "port", "order", "author",
                        "source", "share", "homepage",
                    )
                }
                info["rollback"] = (
                    self.user_plugin_root / (".rollback-" + str(item.get("id")))
                ).is_dir()
                plugins.append(info)
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
                # Strict numeric comparison, shared with the updater: a lower
                # or equal remote version must never be flagged as an update
                # (otherwise a built-in 1.0.15 would be "updatable" to 1.0.9).
                item["update_available"] = bool(
                    local and is_newer(item.get("version", ""), local.get("version", ""))
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
            self._set_plugin_trust(plugin["id"], True)
        # Restart on the new files right away: the user should be able to
        # click the plugin right after the update without restarting the hub.
        started = self.restart(plugin_id)
        self._sync_share()
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
            self._set_plugin_trust(plugin["id"], False)
            self.stop(plugin["id"])
        started = self.restart(plugin["id"])
        self._sync_share()
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
            self._set_plugin_trust(plugin_id, False)
            self._sync_share()
            return {"ok": True, "bundled_remains": fallback}

    # ------------------------------------------------------------------
    # 可选的 WebDAV 云备份：默认关闭，凭据只由页面临时传入，不写入 shared.json。
    # ------------------------------------------------------------------
    @staticmethod
    def _webdav_request(url: str, user: str, password: str, method: str,
                        data: bytes | None = None, timeout: float = 90.0):
        import base64
        import urllib.error
        import urllib.request
        import omm_shared

        if not url.startswith(("http://", "https://")):
            raise ValueError("WebDAV 地址必须以 http:// 或 https:// 开头")
        allow_private = os.environ.get("OMM_CLOUD_ALLOW_PRIVATE") == "1"
        if not omm_shared.remote_url_is_public(url, allow_private):
            raise ValueError(
                "WebDAV 地址不被允许：请使用公网地址；"
                "若为内网服务，请设置 OMM_CLOUD_ALLOW_PRIVATE=1 后重试"
            )
        request = urllib.request.Request(url, data=data, method=method)
        if user:
            token = base64.b64encode(("%s:%s" % (user, password)).encode("utf-8")).decode("ascii")
            request.add_header("Authorization", "Basic " + token)
        # 默认 urlopen 会跟随 3xx 并把 Authorization 带到重定向目标。初始 URL 的
        # SSRF 校验必须覆盖每一跳，且跨域跳转要丢弃 Basic 凭据。
        opener = urllib.request.build_opener(
            omm_shared.ValidatedRedirectHandler(allow_private)
        )
        try:
            with opener.open(request, timeout=timeout) as response:
                # 无限读取慢速响应会一直拖住连接并吃满内存；按本地全量备份的上限
                # 封顶，超出即视为错误响应。
                data = response.read(MAX_FULL_BACKUP_BYTES + 1)
                if len(data) > MAX_FULL_BACKUP_BYTES:
                    raise ValueError("云端响应过大")
                return response.status, data
        except urllib.error.HTTPError as exc:
            if exc.code == 405:  # MKCOL 已存在时视为成功
                return exc.code, b""
            raise

    def cloud_upload(self, payload: dict) -> dict:
        import base64
        from urllib.parse import urlsplit, urlunsplit

        url = str(payload.get("url") or "").strip()
        user = str(payload.get("user") or "")
        password = str(payload.get("password") or "")
        result = self.full_backup()
        raw = base64.b64decode(result["zip"])

        # 尽量创建远端父目录（失败则以 PUT 的结果为准）。
        try:
            parsed = urlsplit(url)
            segments = [s for s in parsed.path.split("/") if s][:-1]
            current = ""
            for segment in segments:
                current += "/" + segment
                self._webdav_request(
                    urlunsplit((parsed.scheme, parsed.netloc, current, "", "")),
                    user, password, "MKCOL", timeout=15.0,
                )
        except Exception:  # noqa: BLE001
            pass

        self._webdav_request(url, user, password, "PUT", data=raw)
        return {"ok": True, "url": url, "stats": result["stats"], "bytes": len(raw)}

    def cloud_download(self, payload: dict) -> dict:
        import base64

        url = str(payload.get("url") or "").strip()
        user = str(payload.get("user") or "")
        password = str(payload.get("password") or "")
        _status, body = self._webdav_request(url, user, password, "GET")
        return {"ok": True, "zip": base64.b64encode(body).decode("ascii"), "bytes": len(body)}

    def detach_pane(self, app_id: str) -> dict:
        """在工作台新窗口中单独打开某个产品（脱离当前分屏）。"""
        self.ensure(app_id)
        from urllib.parse import quote

        url = "http://127.0.0.1:%d/%s?detach=%s" % (
            self.port, HUB_HTML, quote(str(app_id))
        )
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
        return {"ok": True, "url": url}

    def rollback_plugin(self, plugin_id: str) -> dict:
        with self.lock:
            self.stop(plugin_id)
            plugin = self.registry.rollback(plugin_id)
            self._sync_share()
            return {"ok": True, "plugin": plugin}


    # ------------------------------------------------------------- storage
    def _dir_usage(self, path: Path, skip=()) -> dict:
        """Recursive size with a file cap, so a corrupt folder cannot hang the UI."""
        total = 0
        files = 0
        if not path.is_dir():
            return {"bytes": 0, "files": 0}
        for root, dirs, names in os.walk(str(path), followlinks=False):
            if Path(root) == path and skip:
                dirs[:] = [name for name in dirs if name not in skip]
            for name in names:
                try:
                    total += os.path.getsize(os.path.join(root, name))
                    files += 1
                except OSError:
                    pass
                if files >= 200000:
                    return {"bytes": total, "files": files, "truncated": True}
        return {"bytes": total, "files": files}

    def storage(self) -> dict:
        import omm_shared

        now = time.time()
        cached_at, cached = self._storage_cache
        if cached and now - cached_at < 5:
            return cached
        cfg = omm_shared.load_config()
        save_dirs = []
        for app in sorted(set(list(omm_shared.APP_NAMES) + list((cfg.get("apps") or {}).keys()))):
            path = omm_shared.resolve_save_dir(app, cfg).resolve()
            if path not in save_dirs:
                save_dirs.append(path)
        save_bytes = 0
        save_files = 0
        snap_bytes = 0
        snap_files = 0
        for path in save_dirs:
            usage = self._dir_usage(path, skip={omm_shared.SNAPSHOT_DIRNAME})
            save_bytes += usage.get("bytes", 0)
            save_files += usage.get("files", 0)
            snap = self._dir_usage(path / omm_shared.SNAPSHOT_DIRNAME)
            snap_bytes += snap.get("bytes", 0)
            snap_files += snap.get("files", 0)
        share = self._dir_usage(omm_shared.resolve_share_dir(cfg))
        plugins = self._dir_usage(self.user_plugin_root)
        payload = {
            "ok": True,
            "version": VERSION,
            "save": {"bytes": save_bytes, "files": save_files},
            "snapshots": {"bytes": snap_bytes, "files": snap_files},
            "share": share,
            "plugins": plugins,
            "total": {"bytes": save_bytes + snap_bytes + share["bytes"] + plugins["bytes"]},
            "paths": {
                "save": str(save_dirs[0]) if save_dirs else "",
                "share": str(omm_shared.resolve_share_dir(cfg)),
                "plugins": str(self.user_plugin_root),
            },
        }
        self._storage_cache = (now, payload)
        return payload

    def open_storage(self, kind: str) -> dict:
        import subprocess

        import omm_shared

        cfg = omm_shared.load_config()
        if kind == "share":
            path = omm_shared.resolve_share_dir(cfg)
        elif kind == "plugins":
            path = self.user_plugin_root
        else:
            path = Path(str((cfg.get("save") or {}).get("path") or omm_shared.default_save_path()))
        path.mkdir(parents=True, exist_ok=True)
        try:
            if os.name == "nt":
                os.startfile(str(path))
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(path)])
            else:
                subprocess.Popen(["xdg-open", str(path)])
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc), "path": str(path)}
        return {"ok": True, "path": str(path)}

    def backup(self) -> dict:
        import omm_shared
        import omm_share

        return {
            "ok": True,
            "schema": 1,
            "version": VERSION,
            "created": omm_shared.now_iso(),
            # 设置备份会作为文件下载；界面承诺密钥不随它导出。全量备份 ZIP 才
            # 有意携带完整配置，二者不要混用。
            "shared": omm_shared.redact_config_secrets(omm_shared.load_config()),
            "policy": omm_share.load_policy(),
        }

    def restore(self, payload: dict) -> dict:
        """Restore settings + share policy.

        Deliberately does not touch files, plugins or the share index: a settings
        backup must never delete a user's data.  The current config is copied to
        ``shared.backup-*.json`` before it is replaced.
        """
        import omm_shared
        import omm_share

        shared = payload.get("shared")
        policy = payload.get("policy")
        if not isinstance(shared, dict):
            raise ValueError("备份里没有 shared 配置")
        cfg = omm_shared._normalize_config(shared)
        cfg = omm_shared.sanitize_restored_config(cfg)
        saved = omm_shared.backup_config()
        with omm_shared.FileLock(omm_shared.lock_path()):
            omm_shared._write_config(cfg)
        policy_restored = False
        if isinstance(policy, dict):
            omm_share.save_policy(omm_share._normalize_policy(policy))
            policy_restored = True
        return {
            "ok": True,
            "backup": saved,
            "shared": True,
            "policy": policy_restored,
            "share_path": str(omm_shared.resolve_share_dir(cfg)),
        }

    def open_window(self, app_id: str) -> dict:
        info = self.ensure(app_id)
        url = info.get("url") or ""
        if not url:
            raise KeyError("unknown plugin")
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
        return {"ok": True, "url": url}

    # ------------------------------------------------------------------
    # 全量备份 / 恢复：配置 + 共享空间 + 快照 + 已保存文档，打包成单个 zip。
    # 与 settings-only 的 backup()/restore() 并存，互不干扰。
    # ------------------------------------------------------------------
    def full_backup(self) -> dict:
        import base64
        import io
        import zipfile

        import omm_shared
        import omm_share

        cfg = omm_shared.load_config()
        buffer = io.BytesIO()
        stats = {"files": 0, "snapshots": 0, "share": 0, "bytes": 0}

        def add_path(zf: "zipfile.ZipFile", path: Path, arcname: str) -> None:
            try:
                zf.write(path, arcname)
                stats["files"] += 1
            except Exception:  # noqa: BLE001 - 单个文件失败不应中断整个备份
                pass

        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            manifest = {
                "schema": 2,
                "kind": "omm-zen-full-backup",
                "version": VERSION,
                "created": omm_shared.now_iso(),
                "note": "静书房全量备份：设置 + 共享空间 + 快照 + 已保存文档",
            }
            zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            zf.writestr("data/shared.json", json.dumps(cfg, ensure_ascii=False, indent=2))
            zf.writestr(
                "data/policy.json",
                json.dumps(omm_share.load_policy(), ensure_ascii=False, indent=2),
            )

            # 插件清单（仅记录，不含插件包二进制）
            try:
                import plugin_manager

                plugin_root = plugin_manager.default_plugin_root()
                installed = []
                if Path(plugin_root).is_dir():
                    for child in sorted(Path(plugin_root).iterdir()):
                        manifest_file = child / "plugin.json"
                        if not manifest_file.is_file():
                            continue
                        try:
                            meta = json.loads(manifest_file.read_text(encoding="utf-8"))
                        except Exception:  # noqa: BLE001
                            continue
                        installed.append(
                            {
                                "id": meta.get("id", child.name),
                                "name": meta.get("name", ""),
                                "version": meta.get("version", ""),
                            }
                        )
                zf.writestr("data/plugins.json", json.dumps(installed, ensure_ascii=False, indent=2))
            except Exception:  # noqa: BLE001
                pass

            # 跨产品共享空间（文件、记录、收件箱）
            share_dir = omm_shared.resolve_share_dir(cfg)
            if share_dir.is_dir():
                for path in sorted(share_dir.rglob("*")):
                    if path.is_file():
                        add_path(zf, path, "share/" + path.relative_to(share_dir).as_posix())
                        stats["share"] += 1

            # 每个产品的快照与已注册保存文件
            app_ids = set((cfg.get("apps") or {}).keys())
            try:
                app_ids.update(omm_shared.APP_NAMES.keys())
            except Exception:  # noqa: BLE001
                pass
            for app in sorted(app_ids):
                safe_app = str(app).replace("/", "_").replace("\\", "_")
                save_dir = omm_shared.resolve_save_dir(app, cfg)
                snap_dir = save_dir / "snapshots" / safe_app
                if snap_dir.is_dir():
                    for path in sorted(snap_dir.rglob("*")):
                        if path.is_file():
                            add_path(
                                zf,
                                path,
                                "snapshots/%s/%s" % (safe_app, path.relative_to(snap_dir).as_posix()),
                            )
                            stats["snapshots"] += 1
                entry = (cfg.get("apps") or {}).get(app) or {}
                # resources 是 {文件名: 记录} 字典，不是列表。
                for res in (entry.get("resources") or {}).values():
                    raw = str((res or {}).get("path") or "")
                    if not raw:
                        continue
                    path = Path(os.path.expandvars(os.path.expanduser(raw)))
                    if path.is_file():
                        add_path(zf, path, "files/%s/%s" % (safe_app, path.name))

        raw = buffer.getvalue()
        stats["bytes"] = len(raw)
        return {
            "ok": True,
            "schema": 2,
            "version": VERSION,
            "created": manifest["created"],
            "zip": base64.b64encode(raw).decode("ascii"),
            "stats": stats,
        }

    def full_restore(self, payload: dict) -> dict:
        """从全量备份恢复：先备份当前配置，再覆盖配置并还原共享/快照/文档。"""
        import base64
        import io
        import shutil
        import tempfile
        import zipfile
        from pathlib import PurePosixPath

        import omm_shared
        import omm_share

        raw = payload.get("zip")
        if not isinstance(raw, str) or not raw:
            raise ValueError("备份内容为空")
        try:
            data = base64.b64decode(raw, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError("备份文件已损坏或不是有效的归档") from exc
        if len(data) > MAX_FULL_BACKUP_BYTES:
            raise ValueError("备份文件超过允许大小")

        with tempfile.TemporaryDirectory(prefix="omm-restore-") as tmp:
            root = Path(tmp) / "unzip"
            root.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for name in zf.namelist():
                    posix = name.replace("\\", "/")
                    parts = PurePosixPath(posix).parts
                    if not parts or posix.startswith("/") or ":" in parts[0] or ".." in parts:
                        raise ValueError("备份包含不安全的路径，已拒绝恢复")
                zf.extractall(root)

            manifest_file = root / "manifest.json"
            shared_file = root / "data" / "shared.json"
            if not manifest_file.is_file() or not shared_file.is_file():
                raise ValueError("不是静书房全量备份")
            try:
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                manifest = {}
            if manifest.get("kind") not in (None, "omm-zen-full-backup"):
                raise ValueError("备份类型不匹配")

            cfg_raw = json.loads(shared_file.read_text(encoding="utf-8-sig"))
            cfg = omm_shared._normalize_config(cfg_raw)
            cfg = omm_shared.sanitize_restored_config(cfg)

            # 安全网：覆盖配置前先备份当前 shared.json。
            saved = omm_shared.backup_config()
            with omm_shared.FileLock(omm_shared.lock_path()):
                omm_shared._write_config(cfg)

            policy_restored = False
            policy_file = root / "data" / "policy.json"
            if policy_file.is_file():
                try:
                    policy = json.loads(policy_file.read_text(encoding="utf-8-sig"))
                    omm_share.save_policy(omm_share._normalize_policy(policy))
                    policy_restored = True
                except Exception:  # noqa: BLE001
                    pass

            restored = {"share": 0, "snapshots": 0, "files": 0}

            share_src = root / "share"
            if share_src.is_dir():
                share_dir = omm_shared.resolve_share_dir(cfg)
                share_dir.mkdir(parents=True, exist_ok=True)
                shutil.copytree(share_src, share_dir, dirs_exist_ok=True)
                restored["share"] = sum(1 for p in share_src.rglob("*") if p.is_file())

            snap_root = root / "snapshots"
            if snap_root.is_dir():
                for app_dir in sorted(p for p in snap_root.iterdir() if p.is_dir()):
                    app = app_dir.name
                    dest = omm_shared.resolve_save_dir(app, cfg) / "snapshots" / app
                    dest.mkdir(parents=True, exist_ok=True)
                    shutil.copytree(app_dir, dest, dirs_exist_ok=True)
                    restored["snapshots"] += sum(1 for p in app_dir.rglob("*") if p.is_file())

            files_root = root / "files"
            if files_root.is_dir():
                for app_dir in sorted(p for p in files_root.iterdir() if p.is_dir()):
                    app = app_dir.name
                    dest = omm_shared.resolve_save_dir(app, cfg)
                    dest.mkdir(parents=True, exist_ok=True)
                    for item in app_dir.iterdir():
                        if item.is_file():
                            shutil.copy2(item, dest / item.name)
                            restored["files"] += 1

        return {
            "ok": True,
            "backup": saved,
            "restored": restored,
            "policy": policy_restored,
            "created": manifest.get("created"),
        }


class HubHandler(ShellHandler):
    hub: HubServer

    def page_capability_script(self) -> str:
        token = json.dumps(self.hub.capability_token)
        return '<script>window.__ommHubCapabilityToken=%s;</script>' % token

    def _expected_origin(self) -> str:
        try:
            parsed = urlsplit("//" + (self.headers.get("Host") or ""))
            return "http://" + parsed.netloc
        except Exception:
            return ""

    def _hub_authorized(self) -> bool:
        supplied = self.headers.get(HUB_CREDENTIAL_HEADER) or ""
        if not secrets.compare_digest(supplied, self.hub.capability_token):
            return False
        origin = (self.headers.get("Origin") or "").strip()
        return not origin or origin == self._expected_origin()

    def _requires_hub_credential(self, path: str) -> bool:
        return (
            path in HUB_CREDENTIAL_GET
            or path in HUB_CREDENTIAL_POST
            or path.startswith("/__omm/fs/")
            or path.startswith("/__omm/share/")
        )

    def _authorize_hub_request(self, path: str) -> bool:
        if not self._requires_hub_credential(path):
            return True
        if not self._hub_authorized():
            self._reply(403, {"ok": False, "error": "缺少可信工作台能力凭证"})
            return False
        if self.command == "POST":
            content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
            if path == "/api/plugins/import":
                allowed = content_type in ("application/zip", "application/octet-stream")
            elif path == "/__omm/update/apply":
                allowed = content_type in ("", "application/json")
            else:
                allowed = content_type == "application/json"
            if not allowed:
                self._reply(403, {"ok": False, "error": "拒绝跨 Origin 简单请求"})
                return False
        return True

    def _reply(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self, limit: int = MAX_IMPORT_BYTES) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            raise PluginError("请求体长度无效")
        if length <= 0:
            raise PluginError("请求体为空")
        if length > limit:
            raise PluginError("请求体过大")
        return self.rfile.read(length)

    def _json_body(self, limit: int = 1024 * 1024) -> dict:
        try:
            return json.loads(self._body(limit).decode("utf-8"))
        except Exception as exc:
            raise PluginError("请求格式无效") from exc

    def do_GET(self):  # noqa: N802
        import omm_shared
        if not omm_shared.request_is_local(self):
            self._reply(403, {"ok": False, "error": "仅允许本机访问"})
            return
        parsed = urlsplit(self.path)
        if not self._authorize_hub_request(parsed.path):
            return
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
            if parsed.path == "/api/settings":
                self._reply(200, self.hub.settings())
                return
            if parsed.path == "/api/catalog":
                query = parse_qs(parsed.query)
                url = (query.get("url") or [""])[0]
                refresh = (query.get("refresh") or ["0"])[0] == "1"
                self._reply(200, self.hub.catalog(url=url, refresh=refresh))
                return
            if parsed.path == "/api/storage":
                self._reply(200, self.hub.storage())
                return
            if parsed.path == "/api/storage/open":
                query = parse_qs(parsed.query)
                kind = (query.get("kind") or ["save"])[0]
                self._reply(200, self.hub.open_storage(kind))
                return
            if parsed.path == "/api/backup":
                self._reply(200, self.hub.backup())
                return
            if parsed.path == "/api/full-backup":
                self._reply(200, self.hub.full_backup())
                return
            if parsed.path == "/api/window":
                query = parse_qs(parsed.query)
                app_id = (query.get("app") or [""])[0]
                self._reply(200, self.hub.open_window(app_id))
                return
            if parsed.path == "/api/detach":
                query = parse_qs(parsed.query)
                app_id = (query.get("app") or [""])[0]
                self._reply(200, self.hub.detach_pane(app_id))
                return
            if parsed.path == "/api/health":
                self._reply(
                    200,
                    {
                        "ok": True,
                        "version": VERSION,
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
        import omm_shared
        if not omm_shared.request_is_local(self):
            self._reply(403, {"ok": False, "error": "仅允许本机访问"})
            return
        parsed = urlsplit(self.path)
        if not self._authorize_hub_request(parsed.path):
            return
        try:
            if self.handle_desktop_post():
                return
            if self.handle_update_post():
                return
            if parsed.path == "/api/restore":
                payload = self._json_body(8 * 1024 * 1024)
                self._reply(200, self.hub.restore(payload))
                return
            if parsed.path == "/api/full-restore":
                # The zip travels as base64 inside JSON (~4/3 expansion), so cap the
                # request body at the expanded size or legitimately produced backups
                # become unrestorable. The decoded size is capped in full_restore().
                payload = self._json_body(MAX_FULL_BACKUP_BYTES * 4 // 3 + 1024 * 1024)
                self._reply(200, self.hub.full_restore(payload))
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
            if parsed.path == "/api/settings/plugin-dir":
                payload = self._json_body()
                self._reply(200, self.hub.set_plugin_dir(str(payload.get("path") or "")))
                return
            if parsed.path == "/api/plugins/remove":
                payload = self._json_body()
                plugin_id = str(payload.get("id") or "")
                if not plugin_id:
                    raise PluginError("缺少插件 id")
                self._reply(200, self.hub.remove_plugin(plugin_id))
                return
            if parsed.path == "/api/cloud/upload":
                payload = self._json_body(MAX_FULL_BACKUP_BYTES)
                self._reply(200, self.hub.cloud_upload(payload))
                return
            if parsed.path == "/api/cloud/download":
                payload = self._json_body(4 * 1024 * 1024)
                self._reply(200, self.hub.cloud_download(payload))
                return
            if parsed.path == "/api/plugins/rollback":
                payload = self._json_body()
                plugin_id = str(payload.get("id") or "")
                if not plugin_id:
                    raise PluginError("缺少插件 id")
                self._reply(200, self.hub.rollback_plugin(plugin_id))
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
    if existing_server_ok(port, HUB_HTML, root):
        return port
    hub = HubServer(root, port, plugin_root=plugin_root)
    HubHandler.hub = hub
    handler = functools.partial(
        HubHandler, directory=str(root), default_app="hub", trusted_hub=True
    )
    try:
        server = _QuietHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        server = _QuietHTTPServer(("127.0.0.1", 0), handler)
        hub.port = server.server_address[1]
    _serve(server)
    return server.server_address[1]


def configure_desktop_env(web_preview: bool = False) -> None:
    """Set the desktop-bridge switch for a CLI-launched hub.

    The packaged launcher sets OMM_DESKTOP itself; a bare ``python hub_server.py``
    otherwise leaves every /__omm/fs/* route at 404 and the UI silently falls
    back to localStorage. Enable the bridge for the dev shell by default, with
    --web-preview keeping the public-website behaviour available.
    """
    if web_preview:
        os.environ["OMM_DESKTOP"] = "0"
    else:
        os.environ.setdefault("OMM_DESKTOP", "1")
    os.environ.setdefault("OMM_APP_ID", "hub")


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the OMM-ZEN hub shell")
    parser.add_argument("--port", type=int, default=HUB_PORT)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--plugins", type=Path, default=None)
    parser.add_argument(
        "--web-preview",
        action="store_true",
        help="disable the /__omm/fs/* desktop bridge (public-website behaviour)",
    )
    args = parser.parse_args()
    configure_desktop_env(web_preview=args.web_preview)
    plugin_root = args.plugins.resolve() if args.plugins else None
    port = start_hub_server(args.root.resolve(), args.port, plugin_root=plugin_root)
    print("OMM-ZEN hub  http://127.0.0.1:%d/%s" % (port, HUB_HTML))
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
