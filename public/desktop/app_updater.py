# -*- coding: utf-8 -*-
"""Version checks and self-update for the OMM-ZEN desktop programs.

The desktop artifacts are one-file executables (Windows) or .app bundles
(macOS).  Updates are published as release assets next to catalog.json.  This
module compares the embedded version with the catalog, downloads and verifies
the matching asset, and then hands the replacement to a small detached helper
that waits for this process to exit before swapping the file and restarting.

macOS bundles are not replaced automatically here: Gatekeeper trusts the
downloaded DMG, not an in-place swap, so the UI offers the download instead.
"""
from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import sys
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlsplit

import omm_shared

try:  # Older installs may be updated before omm_share.py arrives.
    import omm_share  # type: ignore
except Exception:  # pragma: no cover
    omm_share = None  # type: ignore

from plugin_specs import DESKTOP_EXE_NAMES, VERSION, is_newer, version_key

try:
    from plugin_manager import (
        CATALOG_URL,
        PluginError,
        app_data_base,
        download_bytes,
        fetch_catalog,
    )
except Exception:  # pragma: no cover - keeps the module importable in isolation
    CATALOG_URL = ""
    PluginError = RuntimeError
    download_bytes = None
    fetch_catalog = None

    def app_data_base() -> Path:  # type: ignore[misc]
        return Path.home() / ".omm-zen"


USER_AGENT = "OMM-ZEN/" + VERSION
UPDATE_JS_PATH = "/__omm/update.js"


# ------------------------------------------------------------------ versioning

# ``version_key`` / ``is_newer`` now live in plugin_specs so every layer
# (updater, hub, frontend payload) compares versions the same way.  Re-export
# them here for callers that import from this module.

_VERSION_PATH_RE = re.compile(r"^\d+(?:\.\d+){0,3}$")


def safe_version_path_token(value: Any) -> str:
    """Return a strict ``1.2.3`` token safe to embed in an update filename.

    ``info['latest']`` comes from the remote catalog.  ``version_key`` only
    extracts digits for *comparison*, so a value like ``1.0.24/../../evil``
    still compares as newer but would become a path separator when
    interpolated into the download path.  Anything that is not a plain dotted
    version collapses to a neutral token; the version displayed to users is
    left untouched.
    """
    text = str(value or "").strip()
    return text if _VERSION_PATH_RE.fullmatch(text) else "unknown-version"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def platform_key() -> str:
    if sys.platform == "darwin":
        machine = platform.machine().lower()
        return "macos-arm64" if machine in ("arm64", "aarch64") else "macos-x86_64"
    return "win64"


def app_id() -> str:
    return (os.environ.get("OMM_APP_ID") or "").strip()


def mac_asset_name(app: str) -> str:
    arch = "arm64" if platform_key() == "macos-arm64" else "x86_64"
    if app == "hub":
        return "OMM-ZEN-macOS-%s.dmg" % arch
    return "%s-macOS-%s.dmg" % (DESKTOP_EXE_NAMES.get(app, "OMM-" + app), arch)


def asset_url(catalog: Dict[str, Any], item: Dict[str, Any]) -> str:
    if item.get("url"):
        return str(item["url"])
    base = str(catalog.get("base_url") or "").rstrip("/")
    bundle = str(item.get("bundle") or "")
    if not base or not bundle:
        return ""
    return base + "/" + bundle.lstrip("/")


def bundled_plugins() -> int:
    """Number of built-in plugins shipped inside this executable."""
    try:
        from omm_launcher import resource_root

        root = resource_root() / "plugins"
        if not root.is_dir():
            return 0
        return len([p for p in root.iterdir() if (p / "plugin.json").is_file()])
    except Exception:
        return 0


def update_info(catalog: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return the full check result consumed by the update banner."""
    app = app_id() or "hub"
    current = VERSION
    info: Dict[str, Any] = {
        "app": app,
        "current": current,
        "latest": current,
        "available": False,
        "platform": platform_key(),
        "can_self_update": False,
        "url": "",
        "size": 0,
        "sha256": "",
        "kind": "",
        "note": "",
    }
    if catalog is None:
        if fetch_catalog is None:
            return info
        catalog = fetch_catalog(os.environ.get("OMM_CATALOG_URL") or CATALOG_URL)
    # Resolve the exact artifact that would be installed first, then compare
    # ITS version with the built-in one.  Comparing the catalog's top-level tag
    # version is what let stale / cross-product fields produce an "update"
    # prompt that would actually downgrade the running program.
    entry: Optional[Dict[str, Any]] = None
    plat = platform_key()
    if plat == "win64":
        if app == "hub" and bundled_plugins() == 0:
            # The framework build ships no plugins: it updates itself by
            # downloading the framework archive and taking the new exe out
            # of it.  The full build (with plugins) replaces its own exe.
            framework = (catalog.get("frameworks") or {}).get("win64") or {}
            if framework:
                entry = dict(framework)
                info["kind"] = "framework"
        else:
            entry = (catalog.get("apps") or {}).get(app)
    else:
        entry = {"bundle": mac_asset_name(app)}

    # Prefer the concrete artifact's own version; fall back to the catalog's
    # top-level tag version only when that artifact carries no version.
    artifact_version = str((entry or {}).get("version") or "")
    catalog_version = str(catalog.get("version") or "")
    latest = artifact_version or catalog_version
    info["latest"] = latest or current

    # Strict numeric comparison.  Never offer an update when the remote build
    # is not genuinely newer than the one already installed - that is how a
    # high built-in version ended up being told to install a lower artifact.
    if not latest or not is_newer(latest, current):
        return info
    info["available"] = True
    if not info["kind"]:
        info["kind"] = "direct"

    if plat == "win64":
        if entry:
            info["url"] = asset_url(catalog, entry)
            info["size"] = int(entry.get("size") or 0)
            info["sha256"] = str(entry.get("sha256") or "")
            info["can_self_update"] = bool(is_frozen() and info["url"])
            if not is_frozen():
                info["note"] = "源码运行模式，下载后请手动替换程序。"
    else:
        info["url"] = asset_url(catalog, entry or {})
        info["note"] = "macOS 版本请下载 DMG 后覆盖安装。"
    return info


# ------------------------------------------------------------------- replacing


def _extract_member(zip_path: Path, member: str, target: Path) -> None:
    import zipfile

    with zipfile.ZipFile(zip_path) as zf:
        try:
            data = zf.read(member)
        except KeyError as exc:
            raise PluginError("更新包中缺少 %s" % member) from exc
    target.write_bytes(data)


def _windows_helper(source: Path, folder: Path) -> Path:
    script = folder / (".omm-update-%s.ps1" % str(os.getpid()))
    ps = r"""param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Target
)
$ErrorActionPreference = 'Stop'
# Never let the new build reuse the old PyInstaller extraction directory.
Remove-Item Env:_MEIPASS2 -ErrorAction SilentlyContinue
Remove-Item Env:_PYI_APPLICATION_HOME_DIR -ErrorAction SilentlyContinue
Remove-Item Env:_PYI_ARCHIVE_FILE -ErrorAction SilentlyContinue
Remove-Item Env:_PYI_PARENT_PROCESS_LEVEL -ErrorAction SilentlyContinue
Remove-Item Env:_PYI_SPLASH_IPC -ErrorAction SilentlyContinue
while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
  Start-Sleep -Milliseconds 400
}
# PyInstaller's bootloader parent may keep the exe open after the app process
# exits; retry the swap until Windows releases the file.
$backup = $Target + '.old'
$moved = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    Move-Item -LiteralPath $Target -Destination $backup -Force -ErrorAction Stop
    $moved = $true
    break
  } catch {
    Start-Sleep -Milliseconds 300
  }
}
if (-not $moved) {
  Start-Process -FilePath $Target -WindowStyle Normal
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
  return
}
try {
  Copy-Item -LiteralPath $Source -Destination $Target -Force
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
} catch {
  if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $Target)) {
    Move-Item -LiteralPath $backup -Destination $Target -Force
  }
}
Start-Sleep -Milliseconds 500
Start-Process -FilePath $Target -WindowStyle Normal
Start-Sleep -Milliseconds 500
if (Test-Path -LiteralPath $Source) { Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
"""
    script.write_text(ps, encoding="utf-8")
    return script


def apply_update(info: Dict[str, Any]) -> Dict[str, Any]:
    """Download the new build, verify it and start the detached replacer."""
    if not info.get("can_self_update"):
        raise PluginError("当前平台不支持自动替换，请下载后手动安装")
    url = str(info.get("url") or "")
    if not url:
        raise PluginError("没有可用的下载地址")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise PluginError("更新地址无效")
    if download_bytes is None:
        raise PluginError("更新模块不可用")

    payload = download_bytes(url, expected_sha256=str(info.get("sha256") or ""))
    expected = int(info.get("size") or 0)
    if expected and len(payload) != expected:
        raise PluginError("更新包大小不一致")

    update_dir = app_data_base() / "OMM-ZEN" / "updates"
    update_dir.mkdir(parents=True, exist_ok=True)
    suffix = ".exe" if os.name == "nt" else ".bin"
    version_token = safe_version_path_token(info.get("latest"))
    source = update_dir / ("%s-%s%s" % (app_id() or "hub", version_token, suffix))
    source.write_bytes(payload)
    if info.get("kind") == "framework":
        member = update_dir / ("OMM-ZEN-%s.exe" % version_token)
        _extract_member(source, "OMM-ZEN.exe", member)
        source.unlink(missing_ok=True)
        source = member

    target = Path(sys.executable)
    if not target.is_file():
        raise PluginError("找不到当前程序文件")
    # Keep the user's save paths, shared registry and snapshots untouched by the
    # swap; the config lives in %LOCALAPPDATA%/OMM-ZEN, not beside the exe.
    try:
        omm_shared.backup_config()
    except Exception:
        pass
    helper = _windows_helper(source, update_dir)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    # PyInstaller exports its extraction folder through the environment. The
    # helper is spawned by the old build, so a restarted exe would inherit the
    # old (already deleted) _MEIxxxx folder and fail with "Failed to load
    # Python DLL". Strip those variables before handing over.
    pyi_env = {
        "_MEIPASS2",
        "_PYI_APPLICATION_HOME_DIR",
        "_PYI_ARCHIVE_FILE",
        "_PYI_PARENT_PROCESS_LEVEL",
        "_PYI_SPLASH_IPC",
    }
    child_env = {key: value for key, value in os.environ.items() if key not in pyi_env}
    subprocess.Popen(
        [
            "powershell.exe",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(helper),
            "-ProcessId",
            str(os.getpid()),
            "-Source",
            str(source),
            "-Target",
            str(target),
        ],
        creationflags=flags,
        close_fds=True,
        env=child_env,
    )
    return {"ok": True, "version": info.get("latest"), "source": str(source)}


def exit_soon(delay: float = 0.8) -> None:
    def _shutdown() -> None:
        # Give WebView2 a chance to release its user-data folder before the
        # helper starts the new build; an abrupt os._exit leaves profile locks
        # behind and makes the restarted window fail to initialise.
        try:
            import webview

            for win in list(getattr(webview, "windows", []) or []):
                try:
                    win.destroy()
                except Exception:
                    pass
        except Exception:
            pass
        threading.Timer(4.0, lambda: os._exit(0)).start()

    threading.Timer(delay, _shutdown).start()


# ---------------------------------------------------------------- HTTP support


def _json_bytes(payload: Dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


class ShellHandler(SimpleHTTPRequestHandler):
    """Static file handler with the shared update routes and banner injection."""

    server_version = "OMM-ZEN"
    sys_version = ""

    def __init__(self, *args, default_app: str = "", **kwargs):
        # Trusted identity must be per-handler. In the integrated hub the process-wide
        # OMM_APP_ID is "hub", so a handler that falls back to it grants every plugin
        # the hub's all-seeing share identity. Plugin servers pass their own id here.
        self._default_app = default_app
        super().__init__(*args, **kwargs)

    def log_message(self, fmt, *args):  # noqa: D401 - keep desktop logs quiet
        pass

    def reply_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = _json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def reply_raw(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _default_app_id(self) -> str:
        return (self._default_app or os.environ.get("OMM_APP_ID") or "app").strip() or "app"

    def handle_desktop_get(self) -> bool:
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/__omm/share/"):
            if omm_share is None:
                self.reply_json(404, {"ok": False, "error": "share API is not available"})
                return True
            status, content_type, body = omm_share.handle_get(
                parsed.path, parse_qs(parsed.query), self._default_app_id()
            )
            self.reply_raw(status, content_type, body)
            return True
        if not parsed.path.startswith("/__omm/fs/"):
            return False
        status, content_type, body = omm_shared.handle_get(
            parsed.path, parse_qs(parsed.query), self._default_app_id()
        )
        self.reply_raw(status, content_type, body)
        return True

    def handle_desktop_post(self) -> bool:
        parsed = urlsplit(self.path)
        if not (
            parsed.path.startswith("/__omm/fs/")
            or parsed.path.startswith("/__omm/share/")
        ):
            return False
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        # 先校验长度再读：否则声明一个超大 Content-Length 就能在返回 413 之前
        # 把整个请求体缓冲进内存（本地页面也能利用这一点做内存 DoS）。
        if length > omm_shared.MAX_BODY:
            self.reply_json(413, {"ok": False, "error": "payload too large"})
            return True
        body = self.rfile.read(length) if length > 0 else b""
        if parsed.path.startswith("/__omm/share/"):
            if omm_share is None:
                self.reply_json(404, {"ok": False, "error": "share API is not available"})
                return True
            status, content_type, payload = omm_share.handle_post(
                parsed.path, parse_qs(parsed.query), body, self._default_app_id()
            )
        else:
            status, content_type, payload = omm_shared.handle_post(
                parsed.path, parse_qs(parsed.query), body, self._default_app_id()
            )
        self.reply_raw(status, content_type, payload)
        return True

    def handle_update_get(self) -> bool:
        path = urllib.parse.urlsplit(self.path).path
        if path == UPDATE_JS_PATH:
            body = rendered_update_js().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return True
        if path == "/__omm/update/check":
            try:
                self.reply_json(200, update_info())
            except Exception as exc:  # noqa: BLE001
                self.reply_json(200, {"available": False, "error": str(exc)})
            return True
        return False

    def handle_update_post(self) -> bool:
        path = urllib.parse.urlsplit(self.path).path
        if path != "/__omm/update/apply":
            return False
        try:
            info = update_info()
            if not info.get("available"):
                self.reply_json(200, {"ok": False, "error": "已经是最新版本"})
                return True
            result = apply_update(info)
            self.reply_json(200, result)
            exit_soon()
        except Exception as exc:  # noqa: BLE001
            self.reply_json(400, {"ok": False, "error": str(exc)})
        return True

    def send_injected_html(self) -> bool:
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if not path.lower().endswith((".html", ".htm")) or not os.path.isfile(path):
            return False
        try:
            raw = Path(path).read_bytes()
            text = raw.decode("utf-8")
        except Exception:
            return False
        tag = '<script src="%s"></script>' % UPDATE_JS_PATH
        lower = text.lower()
        index = lower.rfind("</body>")
        if index >= 0:
            text = text[:index] + tag + text[index:]
        else:
            text += tag
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
        return True

    def do_GET(self):  # noqa: N802
        if not omm_shared.request_is_local(self):
            self.send_error(403, "Forbidden")
            return
        if self.handle_desktop_get():
            return
        if self.handle_update_get():
            return
        if self.send_injected_html():
            return
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        if not omm_shared.request_is_local(self):
            self.send_error(403, "Forbidden")
            return
        if self.handle_desktop_post():
            return
        if self.handle_update_post():
            return
        self.send_error(404)


UPDATE_JS = r"""
(function () {
  'use strict';
  if (window.__ommUpdate || window.top !== window) return;
  window.__ommUpdate = true;

  function fmtSize(bytes) {
    if (!bytes) return '';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function dismissKey(version) {
    return 'omm.update.skip.' + version;
  }

  function show(info) {
    if (!info || !info.available) return;
    if (document.getElementById('omm-update-box')) return;
    if (sessionStorage.getItem(dismissKey(info.latest))) return;

    var box = document.createElement('div');
    box.id = 'omm-update-box';
    box.setAttribute('role', 'status');
    box.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483000',
      'max-width:330px', 'padding:14px 16px',
      'background:rgba(255,255,255,.97)', 'color:#26231f',
      'border:1px solid #26231f', 'box-shadow:0 10px 30px rgba(38,35,31,.18)',
      'font-family:"Literata","SimSun",serif', 'font-size:13px', 'line-height:1.55',
      'border-radius:__OMM_RADIUS__px'
    ].join(';');

    var title = document.createElement('div');
    title.style.cssText = 'font-weight:700;font-size:14px;margin-bottom:4px';
    title.textContent = '发现新版本 ' + info.latest;

    var body = document.createElement('div');
    body.style.cssText = 'color:rgba(38,35,31,.72);margin-bottom:10px';
    body.textContent = '当前 ' + info.current +
      (info.size ? ' · ' + fmtSize(info.size) : '') +
      (info.note ? ' · ' + info.note : '');

    var status = document.createElement('div');
    status.style.cssText = 'color:#8a5a00;margin-bottom:8px;display:none';

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

    function button(label, primary) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = [
        'padding:4px 12px', 'font:inherit', 'cursor:pointer',
        'border:1px solid #26231f',
        'border-radius:__OMM_BTN_RADIUS__px',
        primary ? 'background:#f2eee7;color:#26231f' : 'background:#fff;color:#26231f'
      ].join(';');
      return b;
    }

    var later = button('稍后', false);
    later.onclick = function () {
      sessionStorage.setItem(dismissKey(info.latest), '1');
      box.remove();
    };

    var action = button(info.can_self_update ? '立即更新' : '下载', true);
    action.onclick = function () {
      if (!info.can_self_update) {
        if (info.url) window.open(info.url, '_blank', 'noopener');
        later.onclick();
        return;
      }
      action.disabled = true;
      later.disabled = true;
      status.style.display = 'block';
      status.textContent = '正在下载并校验更新…';
      fetch('/__omm/update/apply', { method: 'POST', cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.ok) throw new Error((data && data.error) || '更新失败');
          status.textContent = '更新完成，应用即将重启…';
        })
        .catch(function (err) {
          action.disabled = false;
          later.disabled = false;
          status.textContent = '更新失败：' + (err && err.message ? err.message : err);
        });
    };

    row.appendChild(later);
    row.appendChild(action);
    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(status);
    box.appendChild(row);
    document.body.appendChild(box);
  }

  function check() {
    fetch('/__omm/update/check', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(show)
      .catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      window.setTimeout(check, 900);
    });
  } else {
    window.setTimeout(check, 900);
  }
  window.setInterval(check, 4 * 60 * 60 * 1000);
})();
"""


def rendered_update_js() -> str:
    """UPDATE_JS with the hub corner-radius setting applied (defaults to 0)."""
    try:
        radius = int(omm_shared.get_appearance().get("radius") or 0)
    except Exception:  # noqa: BLE001 - never break the update banner on this
        radius = 0
    return UPDATE_JS.replace("__OMM_RADIUS__", str(radius)).replace(
        "__OMM_BTN_RADIUS__", str(min(radius, 6))
    )
