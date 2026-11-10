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

from plugin_specs import DESKTOP_EXE_NAMES, VERSION

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


def version_key(value: Any) -> tuple:
    parts = re.findall(r"\d+", str(value or ""))
    return tuple(int(part) for part in parts[:4]) or (0,)


def is_newer(latest: Any, current: Any = VERSION) -> bool:
    return version_key(latest) > version_key(current)


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
    latest = str(catalog.get("version") or "")
    info["latest"] = latest or current
    if not latest or not is_newer(latest, current):
        return info
    info["available"] = True
    info["kind"] = "direct"
    entry: Optional[Dict[str, Any]] = None

    if platform_key() == "win64":
        if app == "hub" and bundled_plugins() == 0:
            framework = (catalog.get("frameworks") or {}).get("win64") or {}
            if framework:
                entry = dict(framework)
                info["kind"] = "framework"
        else:
            entry = (catalog.get("apps") or {}).get(app)
        if entry:
            info["url"] = asset_url(catalog, entry)
            info["size"] = int(entry.get("size") or 0)
            info["sha256"] = str(entry.get("sha256") or "")
            info["can_self_update"] = bool(is_frozen() and info["url"])
            if not is_frozen():
                info["note"] = "源码运行模式，下载后请手动替换程序。"
    else:
        info["url"] = asset_url(
            catalog,
            {"bundle": mac_asset_name(app)},
        )
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
    source = update_dir / ("%s-%s%s" % (app_id() or "hub", info.get("latest"), suffix))
    source.write_bytes(payload)
    if info.get("kind") == "framework":
        member = update_dir / ("OMM-ZEN-%s.exe" % info.get("latest"))
        _extract_member(source, "OMM-ZEN.exe", member)
        source.unlink(missing_ok=True)
        source = member

    target = Path(sys.executable)
    if not target.is_file():
        raise PluginError("找不到当前程序文件")
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

    def handle_update_get(self) -> bool:
        path = urllib.parse.urlsplit(self.path).path
        if path == UPDATE_JS_PATH:
            body = UPDATE_JS.encode("utf-8")
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
        if self.handle_update_get():
            return
        if self.send_injected_html():
            return
        return super().do_GET()

    def do_POST(self):  # noqa: N802
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
      'font-family:"Literata","SimSun",serif', 'font-size:13px', 'line-height:1.55'
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
        primary ? 'background:#26231f;color:#fff' : 'background:#fff;color:#26231f'
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
