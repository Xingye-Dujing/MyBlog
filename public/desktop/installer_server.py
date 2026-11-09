# -*- coding: utf-8 -*-
"""Online installer backend for OMM-ZEN.

The installer ships no product pages. It reads catalog.json from the latest
GitHub Release, downloads the selected plugin bundles plus the platform
framework, and installs them into the per-user folders the hub reads.

Run the UI in a normal browser for development:
    .venv\\Scripts\\python.exe desktop\\installer_server.py --catalog <url-or-file>
"""
from __future__ import annotations

import argparse
import functools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from omm_launcher import QuietHandler, resource_root
from plugin_manager import (
    CATALOG_URL,
    PluginError,
    PluginRegistry,
    app_data_base,
    default_plugin_root,
    download_bytes,
    fetch_catalog,
    framework_platform,
    sha256_bytes,
)
from plugin_specs import VERSION

INSTALLER_PORT = 8302
INSTALLER_HTML = "installer.html"


class _QuietHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


def default_install_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Applications" / "OMM-ZEN"
    return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "Programs" / "OMM-ZEN"


class InstallerState:
    def __init__(self, root: Path):
        self.root = root
        self.catalog_url = os.environ.get("OMM_CATALOG_URL") or CATALOG_URL
        self.lock = threading.Lock()
        self.catalog = None
        self.catalog_at = 0.0
        self.install_dir = str(default_install_dir())
        self.plugin_dir = default_plugin_root()
        self.progress = {
            "running": False,
            "done": False,
            "percent": 0,
            "message": "准备就绪",
            "logs": [],
            "error": "",
            "install_dir": self.install_dir,
        }

    def reset(self, install_dir: str, message: str) -> None:
        self.install_dir = install_dir
        self.progress = {
            "running": True,
            "done": False,
            "percent": 0,
            "message": message,
            "logs": [],
            "error": "",
            "install_dir": install_dir,
        }

    def log(self, message: str, percent: int | None = None) -> None:
        with self.lock:
            self.progress["message"] = message
            if percent is not None:
                self.progress["percent"] = max(0, min(100, percent))
            self.progress["logs"].append(message)
            if len(self.progress["logs"]) > 200:
                del self.progress["logs"][:50]

    def get_catalog(self, refresh: bool = False) -> dict:
        with self.lock:
            if self.catalog is not None and not refresh and time.time() - self.catalog_at < 300:
                return self.catalog
        data = fetch_catalog(self.catalog_url)
        with self.lock:
            self.catalog = data
            self.catalog_at = time.time()
        return data


class InstallerApi:
    """pywebview js_api: native folder picker."""

    def choose_folder(self, current: str = "") -> str:
        try:
            import webview

            window = webview.windows[0] if webview.windows else None
            if window is None:
                return ""
            result = window.create_file_dialog(
                webview.FOLDER_DIALOG,
                directory=current or str(default_install_dir()),
            )
            if result:
                return result[0] if isinstance(result, (list, tuple)) else str(result)
        except Exception:
            pass
        return ""


def _extract_framework(zip_path: Path, install_dir: Path) -> Path:
    install_dir.mkdir(parents=True, exist_ok=True)
    if sys.platform == "darwin":
        temp = Path(tempfile.mkdtemp(prefix="omm-framework-"))
        try:
            subprocess.run(
                ["ditto", "-x", "-k", str(zip_path), str(temp)],
                check=True,
                capture_output=True,
            )
            apps = list(temp.glob("*.app"))
            if not apps:
                raise PluginError("框架包中没有 .app")
            target = install_dir / apps[0].name
            if target.exists():
                shutil.rmtree(target)
            subprocess.run(
                ["ditto", str(apps[0]), str(target)],
                check=True,
                capture_output=True,
            )
            return target
        finally:
            shutil.rmtree(temp, ignore_errors=True)
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or ".." in Path(name).parts:
                raise PluginError("框架包路径无效")
            zf.extract(info, install_dir)
    exe = install_dir / "OMM-ZEN.exe"
    if not exe.is_file():
        matches = list(install_dir.glob("OMM-ZEN*.exe"))
        if matches:
            exe = matches[0]
        else:
            raise PluginError("框架包中没有 OMM-ZEN.exe")
    return exe


def _create_shortcut(exe: Path) -> None:
    if os.name != "nt":
        return
    try:
        script = (
            "$ws = New-Object -ComObject WScript.Shell; "
            "$paths = @("
            "[Environment]::GetFolderPath('Desktop') + '\\OMM-ZEN.lnk', "
            "$env:APPDATA + '\\Microsoft\\Windows\\Start Menu\\Programs\\OMM-ZEN.lnk'"
            "); "
            "foreach ($p in $paths) { "
            "$s = $ws.CreateShortcut($p); "
            "$s.TargetPath = $env:OMM_HUB_EXE; "
            "$s.WorkingDirectory = $env:OMM_HUB_DIR; "
            "$s.IconLocation = $env:OMM_HUB_EXE; "
            "$s.Description = 'OMM-ZEN 工作台'; "
            "$s.Save() }"
        )
        env = dict(os.environ)
        env["OMM_HUB_EXE"] = str(exe)
        env["OMM_HUB_DIR"] = str(exe.parent)
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            check=False,
            capture_output=True,
            env=env,
        )
    except Exception:
        pass


def install_task(state: InstallerState, selected: list[str], install_dir: str, shortcut: bool) -> None:
    try:
        state.log("读取在线目录…", 2)
        catalog = state.get_catalog()
        platform = framework_platform()
        frameworks = catalog.get("frameworks") or {}
        framework = frameworks.get(platform)
        if not framework:
            raise PluginError("在线目录没有当前平台的框架（%s）" % platform)
        url = framework.get("url")
        if not url:
            raise PluginError("框架下载地址缺失")

        state.log("下载工作台框架…", 6)
        last = {"value": 0}

        def frame_progress(received: int, total: int) -> None:
            if total:
                pct = 6 + int(received * 24 / total)
                if pct > last["value"]:
                    last["value"] = pct
                    state.log("下载工作台框架… %d%%" % int(received * 100 / total), pct)

        data = download_bytes(
            url,
            expected_sha256=str(framework.get("sha256") or ""),
            progress=frame_progress,
        )
        state.log("安装工作台…", 32)
        temp = Path(tempfile.mkdtemp(prefix="omm-install-"))
        try:
            zip_path = temp / "framework.zip"
            zip_path.write_bytes(data)
            target = Path(install_dir).expanduser()
            exe = _extract_framework(zip_path, target)
        finally:
            shutil.rmtree(temp, ignore_errors=True)

        plugins = {item.get("id"): item for item in catalog.get("plugins", [])}
        ids = [item for item in selected if item in plugins]
        total = max(1, len(ids))
        registry = PluginRegistry(user_root=default_plugin_root(), bundled_root=None)
        for index, plugin_id in enumerate(ids):
            item = plugins[plugin_id]
            name = item.get("name") or plugin_id
            base = 38 + int(index * 55 / total)
            state.log("下载插件 %s…" % name, base)
            bundle = download_bytes(
                _bundle_url(catalog, item),
                expected_sha256=str(item.get("sha256") or ""),
            )
            state.log("安装插件 %s…" % name, base + int(40 / total))
            registry.install_zip(bundle, imported=False)

        meta = {
            "version": catalog.get("version") or VERSION,
            "tag": catalog.get("tag") or "",
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "plugins": ids,
            "framework": platform,
        }
        try:
            (Path(install_dir) / "install.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except Exception:
            pass
        if shortcut:
            _create_shortcut(Path(exe))
        with state.lock:
            state.progress["done"] = True
            state.progress["running"] = False
            state.progress["percent"] = 100
            state.progress["message"] = "安装完成"
            state.progress["exe"] = str(exe)
            state.progress["logs"].append("安装完成")
    except Exception as exc:  # noqa: BLE001
        with state.lock:
            state.progress["running"] = False
            state.progress["done"] = False
            state.progress["error"] = str(exc)
            state.progress["message"] = "安装失败"
            state.progress["logs"].append("错误：" + str(exc))


def _bundle_url(catalog: dict, item: dict) -> str:
    if item.get("url"):
        return item["url"]
    base = catalog.get("base_url") or ""
    bundle = item.get("bundle") or ""
    if not base or not bundle:
        raise PluginError("插件下载地址缺失")
    return base.rstrip("/") + "/" + bundle.lstrip("/")


class InstallerHandler(QuietHandler):
    state: InstallerState

    def _reply(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 1024 * 1024:
            raise PluginError("请求体无效")
        return self.rfile.read(length)

    def do_GET(self):  # noqa: N802
        parsed = urlsplit(self.path)
        try:
            if parsed.path == "/api/config":
                self._reply(
                    200,
                    {
                        "version": VERSION,
                        "platform": framework_platform(),
                        "install_dir": str(default_install_dir()),
                        "plugin_dir": str(default_plugin_root()),
                        "catalog_url": self.state.catalog_url,
                    },
                )
                return
            if parsed.path == "/api/catalog":
                self._reply(200, self.state.get_catalog())
                return
            if parsed.path == "/api/progress":
                with self.state.lock:
                    self._reply(200, self.state.progress)
                return
            if parsed.path == "/api/health":
                self._reply(200, {"ok": True})
                return
        except Exception as exc:  # noqa: BLE001
            self._reply(502, {"ok": False, "error": str(exc)})
            return
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        parsed = urlsplit(self.path)
        try:
            if parsed.path == "/api/install":
                payload = json.loads(self._body().decode("utf-8"))
                selected = payload.get("plugins") or []
                if not isinstance(selected, list):
                    raise PluginError("插件列表无效")
                install_dir = str(payload.get("directory") or default_install_dir())
                shortcut = bool(payload.get("shortcut", True))
                with self.state.lock:
                    if self.state.progress.get("running"):
                        raise PluginError("安装正在进行")
                self.state.reset(install_dir, "开始安装…")
                thread = threading.Thread(
                    target=install_task,
                    args=(self.state, selected, install_dir, shortcut),
                    daemon=True,
                )
                thread.start()
                self._reply(200, {"ok": True})
                return
            if parsed.path == "/api/launch":
                target = Path(str(self.state.progress.get("exe") or ""))
                if not target.is_file():
                    target = Path(self.state.install_dir) / "OMM-ZEN.exe"
                if sys.platform == "darwin":
                    apps = list(Path(self.state.install_dir).glob("*.app"))
                    if not apps:
                        raise PluginError("找不到已安装的 OMM-ZEN.app")
                    subprocess.Popen(["open", str(apps[0])])
                else:
                    if not target.is_file():
                        raise PluginError("找不到已安装的 OMM-ZEN.exe")
                    subprocess.Popen([str(target)], cwd=str(target.parent))
                self._reply(200, {"ok": True})
                return
        except PluginError as exc:
            self._reply(400, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            self._reply(500, {"ok": False, "error": str(exc)})
            return
        self._reply(404, {"ok": False, "error": "not found"})


def start_installer_server(root: Path, port: int = INSTALLER_PORT, catalog: str = ""):
    state = InstallerState(root)
    if catalog:
        state.catalog_url = catalog
    InstallerHandler.state = state
    handler = functools.partial(InstallerHandler, directory=str(root))
    try:
        server = _QuietHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        server = _QuietHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1], state


def run_installer(debug: bool = False, catalog: str = "") -> None:
    from omm_launcher import app_data_base, data_root

    root = resource_root()
    if not (root / INSTALLER_HTML).is_file():
        raise SystemExit("missing %s next to the installer" % INSTALLER_HTML)

    port, state = start_installer_server(root, INSTALLER_PORT, catalog=catalog)

    import webview

    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    if os.name == "nt":
        os.environ.setdefault("WEBVIEW2_USER_DATA_FOLDER", str(data_root("installer")))

    api = InstallerApi()
    webview.create_window(
        "OMM-ZEN 安装器",
        "http://127.0.0.1:%d/%s" % (port, INSTALLER_HTML),
        width=1180,
        height=820,
        min_size=(920, 640),
        text_select=True,
        zoomable=True,
        js_api=api,
    )
    icon = root / ("app.icns" if sys.platform == "darwin" else "app.ico")
    options = {
        "debug": debug,
        "private_mode": False,
        "storage_path": str(data_root("installer")),
    }
    if sys.platform != "darwin" and icon.is_file():
        options["icon"] = str(icon)
    webview.start(**options)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the OMM-ZEN online installer")
    parser.add_argument("--port", type=int, default=INSTALLER_PORT)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--catalog", default="")
    args = parser.parse_args()
    port, _state = start_installer_server(
        args.root.resolve(), args.port, catalog=args.catalog
    )
    print("OMM-ZEN installer  http://127.0.0.1:%d/%s" % (port, INSTALLER_HTML))
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
