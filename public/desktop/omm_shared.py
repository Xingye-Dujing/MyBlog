# -*- coding: utf-8 -*-
"""Shared desktop storage, snapshots and cross-product path registry.

Every desktop page talks to ``/__omm/fs/...`` on its own loopback origin.  The
handlers in this module are small and transport agnostic so the static server
(``ShellHandler``), the MdForge Flask app and the LaTeX server can all expose
the same API.

The configuration file is the single source of truth for "where do products
save" and "which files are available to other products"::

    %LOCALAPPDATA%/OMM-ZEN/shared.json

It is deliberately human readable and is updated atomically, so several OMM
programs can write to it at the same time.
"""
from __future__ import annotations

import base64
import ipaddress
import io
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple
from urllib.parse import parse_qs, urlsplit

import omm_fs

try:
    from plugin_specs import PLUGIN_BY_ID
except Exception:  # pragma: no cover - staged/minimal installs fail closed
    PLUGIN_BY_ID = {}

try:
    from plugin_manager import app_data_base
except Exception:  # pragma: no cover - keeps the module importable by itself

    def app_data_base() -> Path:  # type: ignore[misc]
        return Path.home() / ".omm-zen"


LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
CLOUD_METADATA_HOSTS = {"metadata.google.internal", "metadata", "instance-data"}


def _ip_literal(host: str):
    """把整数 / 八进制 / 十六进制写法的主机规范化为 ipaddress 对象。

    浏览器与 urllib 都会把 ``http://2130706433/`` 解析成 127.0.0.1。只检查字面的
    点分十进制会让这类写法绕过 SSRF 守卫。
    """
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    if re.fullmatch(r"\d{1,10}", host):
        try:
            return ipaddress.ip_address(int(host, 10))
        except ValueError:
            return None
    if re.fullmatch(r"0[xX][0-9a-fA-F]{1,8}", host):
        try:
            return ipaddress.ip_address(int(host, 16))
        except ValueError:
            return None
    # 单个八进制写法不能被上面的十进制分支（限定 10 位）或多段分支（要求至少
    # 两个点分段）覆盖。libc 的 inet_aton/getaddrinfo 会把这类写法按八进制解析，
    # 例如 17700000001 / 017700000001 都指向 127.0.0.1；若当作 DNS 名称放行就
    # 会绕过 SSRF 守卫。
    if re.fullmatch(r"0?[0-7]{1,11}", host):
        try:
            return ipaddress.ip_address(int(host, 8))
        except ValueError:
            return None
    parts = host.split(".")
    if 1 < len(parts) <= 4 and all(
        re.fullmatch(r"(?:0[xX][0-9a-fA-F]{1,8}|0[0-7]{1,11}|[0-9]{1,8})", p)
        for p in parts
    ):
        try:
            nums = []
            for part in parts:
                if part.lower().startswith("0x"):
                    nums.append(int(part, 16))
                elif len(part) > 1 and part.startswith("0"):
                    nums.append(int(part, 8))
                else:
                    nums.append(int(part, 10))
            # inet_aton 允许省略点分段：127.1 与 127.0.1 都解析为 127.0.0.1。
            # 不能把不足四段的数字重新拼成点分字符串交给 ipaddress（会被拒绝），
            # 必须按 inet_aton 语义合成 32 位整数，否则这类写法会被当成 DNS
            # 名称放行，绕过 SSRF 守卫。
            if len(nums) == 2:
                if nums[0] > 0xFF or nums[1] > 0xFFFFFF:
                    return None
                value = (nums[0] << 24) | nums[1]
            elif len(nums) == 3:
                if nums[0] > 0xFF or nums[1] > 0xFF or nums[2] > 0xFFFF:
                    return None
                value = (nums[0] << 24) | (nums[1] << 16) | nums[2]
            elif len(nums) == 4:
                if any(n > 0xFF for n in nums):
                    return None
                value = (nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]
            else:
                return None
            return ipaddress.ip_address(value)
        except ValueError:
            return None
    return None


class ValidatedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """WebDAV 重定向守卫：每一跳重新过 SSRF 校验，跨域时丢弃 Basic 凭据。

    urllib 默认跟随 3xx 并把原请求的 Authorization 头带到重定向目标。一个公网
    WebDAV 只要 302 到 127.0.0.1 或云元数据地址就能绕过只在初始 URL 做一次的
    校验，同时泄露凭据。构建 opener 时必须用这个类替换默认重定向处理器。
    """

    def __init__(self, allow_private: bool = False):
        self._allow_private = bool(allow_private)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not remote_url_is_public(newurl, self._allow_private):
            raise ValueError("WebDAV 重定向目标不被允许：%s" % newurl)
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is None:
            return None
        old = urlsplit(req.full_url)
        new = urlsplit(newurl)
        if (old.scheme, old.netloc) != (new.scheme, new.netloc):
            new_req.remove_header("Authorization")
        return new_req


def remote_url_is_public(url: str, allow_private: bool = False) -> bool:
    """Reject URLs that would let a local service reach loopback/private hosts.

    Used for the user-supplied WebDAV endpoint (SSRF guard). A hostname that is
    not a literal IP is accepted by default — resolving it here would be racy
    and a DNS-based bypass is still possible; literal loopback/private/metadata
    targets (the common attack) are blocked outright. Set
    ``OMM_CLOUD_ALLOW_PRIVATE=1`` for a legitimate LAN WebDAV server.
    """
    try:
        parsed = urlsplit(str(url or "").strip())
    except Exception:
        return False
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    if parsed.username or parsed.password:
        return False
    host = parsed.hostname.lower().rstrip(".")
    if host in CLOUD_METADATA_HOSTS or host.endswith(".internal") or host.endswith(".local"):
        return False
    if host in LOOPBACK_HOSTS or host.endswith(".localhost"):
        return False
    ip = _ip_literal(host)
    if ip is None:
        # 纯数字 / 0x 形态是 IP 的字面量写法，不是合法 DNS 主机名。无法明确
        # 解析时绝不能按“普通域名”放行，否则新增的进制写法会重新打开 SSRF。
        if re.fullmatch(r"(?:0[xX][0-9a-fA-F]+|[0-9]+)", host):
            return False
        return True  # DNS name; cannot be checked reliably without a lookup
    if allow_private:
        return True
    return ip.is_global


def headers_are_local(
    host_header: str, origin_header: str, sec_fetch_site: str = ""
) -> bool:
    """校验 Host + Origin + Sec-Fetch-Site 是否为本机 loopback（供各类 HTTP 服务复用）。

    同时校验 Host（阻断 DNS rebinding）与 Origin（阻断其他网站发来的跨站
    POST/CSRF）。同源页面与不带 Origin 的非浏览器客户端（脚本 / 桌面壳）
    均放行；沙箱 iframe / file:// 的 opaque origin ``null`` 一律拒绝。

    浏览器在简单跨站 GET（<img>/<link>/<script>）上不发 Origin，单靠 Origin
    无法区分。这类请求都带 ``Sec-Fetch-Site: cross-site``（该头浏览器强制设置、
    JS 无法伪造），据此补一道 CSRF 拦截。产品分散在多个 loopback 端口，
    彼此互调是 ``same-site``，因此只拒绝 ``cross-site``，保留同站跨端口调用。
    """
    try:
        host = (urlsplit("//" + (host_header or "").strip()).hostname or "").lower()
    except Exception:
        host = ""
    if host not in LOOPBACK_HOSTS:
        return False
    # 非浏览器客户端没有 Sec-Fetch-Site，保持放行；浏览器跨站导航一律拒绝。
    if (sec_fetch_site or "").strip().lower() == "cross-site":
        return False
    origin = (origin_header or "").strip()
    if not origin:
        return True
    if origin == "null":
        return False
    try:
        origin_host = (urlsplit(origin).hostname or "").lower()
    except Exception:
        return False
    return origin_host in LOOPBACK_HOSTS


def request_is_local(handler) -> bool:
    """桌面桥仅接受来自本机 loopback 的请求（标准库 handler 版本）。"""
    return headers_are_local(
        handler.headers.get("Host"),
        handler.headers.get("Origin"),
        handler.headers.get("Sec-Fetch-Site"),
    )


API_VERSION = 1
MAX_BODY = 256 * 1024 * 1024
SNAPSHOT_SUFFIX = ".omm-snapshot.json"
SNAPSHOT_DIRNAME = "snapshots"
MODE_OVERWRITE = "overwrite"
MODE_VERSIONED = "versioned"
MODES = (MODE_OVERWRITE, MODE_VERSIONED)
DEFAULT_MODE = MODE_VERSIONED

APP_NAMES = {
    "ai": "AI 工作区",
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
    "hub": "静书房",
}

# Desktop capabilities are granted by the server, never accepted from a page or
# plugin manifest. Imported/unknown static plugins get only the harmless status
# probe used to detect whether the desktop bridge exists.
IMPORTED_FS_CAPABILITIES = frozenset({"status"})
_PRODUCT_FS_CAPABILITIES = frozenset(
    {
        "status",
        "config",
        "save",
        "snapshot",
        "snapshots",
        "snapshot/rename",
        "snapshot/delete",
        "archive",
        "shared",
        "file",
        "ai-config:read",
        "appearance",
        "open",
    }
)
FS_CAPABILITIES_BY_APP: Dict[str, frozenset[str]] = {
    app: _PRODUCT_FS_CAPABILITIES for app in PLUGIN_BY_ID
}
FS_CAPABILITIES_BY_APP["redact"] = _PRODUCT_FS_CAPABILITIES | frozenset(
    {"docx2pdf", "docx2pdf/config", "pdf/tool"}
)
FS_CAPABILITIES_BY_APP["hub"] = frozenset(
    set(_PRODUCT_FS_CAPABILITIES)
    | {
        "ai-config:write",
        "docx2pdf",
        "docx2pdf/config",
        "pdf/tool",
    }
)


def capabilities_for_app(app: str, trusted_hub: bool = False) -> frozenset[str]:
    """Resolve an app's desktop capabilities from the trusted built-in registry."""
    app_id = clean_app_id(app)
    if app_id == "hub":
        return FS_CAPABILITIES_BY_APP["hub"] if trusted_hub else IMPORTED_FS_CAPABILITIES
    return FS_CAPABILITIES_BY_APP.get(app_id, IMPORTED_FS_CAPABILITIES)


_FS_ROUTE_CAPABILITIES = {
    "/__omm/fs/status": "status",
    "/__omm/fs/config": "config",
    "/__omm/fs/shared": "shared",
    "/__omm/fs/ai-config": "ai-config:read",
    "/__omm/fs/search": "archive",
    "/__omm/fs/archive": "archive",
    "/__omm/fs/snapshots": "snapshots",
    "/__omm/fs/snapshot": "snapshot",
    "/__omm/fs/appearance": "appearance",
    "/__omm/fs/docx2pdf": "docx2pdf",
    "/__omm/fs/pdf/tool": "pdf/tool",
    "/__omm/fs/file": "file",
    "/__omm/fs/save": "save",
    "/__omm/fs/snapshot/rename": "snapshot/rename",
    "/__omm/fs/snapshot/delete": "snapshot/delete",
    "/__omm/fs/docx2pdf/config": "docx2pdf/config",
    "/__omm/fs/open": "open",
}

_KIND_BY_EXT = {
    ".csv": "table",
    ".tsv": "table",
    ".xlsx": "table",
    ".xls": "table",
    ".db": "table",
    ".sqlite": "table",
    ".json": "json",
    ".jsonl": "json",
    ".ndjson": "json",
    ".md": "markdown",
    ".markdown": "markdown",
    ".tex": "latex",
    ".txt": "text",
    ".pdf": "pdf",
    ".docx": "document",
    ".pptx": "document",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".svg": "image",
    ".zip": "archive",
    ".zc": "writer-canvas",
    ".zwlib": "writer-library",
}


# --------------------------------------------------------------------- basics


def desktop_enabled() -> bool:
    return os.environ.get("OMM_DESKTOP") == "1"


def shared_root() -> Path:
    override = (os.environ.get("OMM_SHARED_DIR") or "").strip()
    path = Path(override) if override else app_data_base() / "OMM-ZEN"
    path.mkdir(parents=True, exist_ok=True)
    return path


def config_path() -> Path:
    return shared_root() / "shared.json"


def lock_path() -> Path:
    return shared_root() / ".shared.lock"


def default_save_path() -> Path:
    home = Path.home()
    docs = home / "Documents"
    return (docs if docs.is_dir() else home) / "OMM-ZEN"


_SECRET_WORDS = (
    "apikey", "token", "secret", "password", "passwd", "pwd",
    "credential", "authorization", "supabase", "privatekey",
)


def _is_secret_key(key: Any) -> bool:
    norm = re.sub(r"[^a-z0-9]", "", str(key).lower())
    return any(word in norm for word in _SECRET_WORDS)


def redact_config_secrets(value: Any) -> Any:
    """深拷贝配置并清空所有凭据字段。

    设置备份（/api/backup）会下载为 JSON 文件，界面明确承诺密钥不会随它导出；
    全量备份 ZIP 则有意保留完整配置，因此只对前者调用本函数。字段名按“词”识别，
    覆盖 ai.apiKey、cloud.password、supabase 等写法。
    """
    if isinstance(value, dict):
        return {
            key: ("" if _is_secret_key(key) else redact_config_secrets(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_config_secrets(item) for item in value]
    return value


def now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def clean_app_id(value: Any) -> str:
    text = re.sub(r"[^a-zA-Z0-9_-]+", "", str(value or "").strip())
    return text[:40] or "app"


def app_name(app: str) -> str:
    return APP_NAMES.get(app, app)


def kind_for(name: str) -> str:
    return _KIND_BY_EXT.get(Path(name).suffix.lower(), "file")


def mime_for(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def _empty_ai() -> Dict[str, Any]:
    """全产品共用的 AI 配置（密钥由用户自愿填写，默认留空）。"""
    return {
        "provider": "deepseek",
        "apiBase": "https://api.deepseek.com",
        "apiModel": "deepseek-flash",
        "apiKey": "",
        "system": "",
    }


def _normalize_ai(raw: Any) -> Dict[str, Any]:
    cfg = _empty_ai()
    if not isinstance(raw, dict):
        return cfg
    for key in ("provider", "apiBase", "apiModel", "apiKey", "system"):
        if key in raw:
            cfg[key] = str(raw.get(key) or "").strip()
    if not cfg["apiBase"]:
        cfg["apiBase"] = _empty_ai()["apiBase"]
    if not cfg["apiModel"]:
        cfg["apiModel"] = _empty_ai()["apiModel"]
    return cfg


def _public_ai(ai: Dict[str, Any]) -> Dict[str, Any]:
    """Desktop pages may edit AI settings but can never read the stored key."""
    public = {key: value for key, value in ai.items() if key != "apiKey"}
    has_key = bool(ai.get("apiKey"))
    public["configured"] = has_key
    public["hasStoredKey"] = has_key
    return public


def _empty_config() -> Dict[str, Any]:
    return {
        "version": API_VERSION,
        "updated": "",
        "save": {
            "path": str(default_save_path()),
            "mode": DEFAULT_MODE,
            "auto_snapshot": True,
            "auto_share": False,
        },
        "ui": {"zoom": {}, "window": {}},
        "share": {"path": ""},
        "docx_pdf": {"soffice": "", "abiword": "", "gs": ""},
        "ai": _empty_ai(),
        "apps": {},
    }


def _normalize_config(raw: Any) -> Dict[str, Any]:
    cfg = _empty_config()
    if not isinstance(raw, dict):
        return cfg
    save = raw.get("save") if isinstance(raw.get("save"), dict) else {}
    path = str(save.get("path") or "").strip()
    mode = str(save.get("mode") or "").strip().lower()
    cfg["save"] = {
        "path": path or str(default_save_path()),
        "mode": mode if mode in MODES else DEFAULT_MODE,
        "auto_snapshot": bool(save.get("auto_snapshot", True)),
        "auto_share": bool(save.get("auto_share", False)),
    }
    cfg["updated"] = str(raw.get("updated") or "")
    share = raw.get("share") if isinstance(raw.get("share"), dict) else {}
    cfg["share"] = {"path": str(share.get("path") or "").strip()}
    docx_pdf = raw.get("docx_pdf") if isinstance(raw.get("docx_pdf"), dict) else {}
    cfg["docx_pdf"] = {
        "soffice": str(docx_pdf.get("soffice") or "").strip(),
        "abiword": str(docx_pdf.get("abiword") or "").strip(),
        "gs": str(docx_pdf.get("gs") or "").strip(),
    }
    apps = raw.get("apps") if isinstance(raw.get("apps"), dict) else {}
    clean_apps: Dict[str, Any] = {}
    for key, value in apps.items():
        app = clean_app_id(key)
        if not isinstance(value, dict):
            continue
        resources = value.get("resources")
        if not isinstance(resources, dict):
            resources = {}
        clean_resources: Dict[str, Any] = {}
        for rkey, rval in resources.items():
            if not isinstance(rval, dict):
                continue
            item = dict(rval)
            item["app"] = app
            item["app_name"] = app_name(app)
            item["name"] = str(item.get("name") or rkey)
            item["path"] = str(item.get("path") or "")
            item["kind"] = str(item.get("kind") or kind_for(item["name"]))
            clean_resources[str(rkey)] = item
        clean_apps[app] = {
            "name": app_name(app),
            "save_path": str(value.get("save_path") or "").strip(),
            "mode": (
                str(value.get("mode") or "").lower()
                if str(value.get("mode") or "").lower() in MODES
                else ""
            ),
            "auto_snapshot": bool(value.get("auto_snapshot", True)),
            "updated": str(value.get("updated") or ""),
            "last_snapshot": str(value.get("last_snapshot") or ""),
            "resources": clean_resources,
        }
    cfg["apps"] = clean_apps
    ui = raw.get("ui") if isinstance(raw.get("ui"), dict) else {}
    zoom_raw = ui.get("zoom") if isinstance(ui.get("zoom"), dict) else {}
    zoom: Dict[str, float] = {}
    for key, value in zoom_raw.items():
        try:
            factor = float(value)
        except (TypeError, ValueError):
            continue
        zoom[clean_app_id(key)] = max(0.3, min(3.0, factor))
    appearance_raw = ui.get("appearance") if isinstance(ui.get("appearance"), dict) else {}
    # Window geometry is written by omm_launcher.remember_geometry() and read back by
    # saved_geometry(). Dropping it here made geometry persistence impossible: every
    # load wiped it, and every save discarded the other apps' entries too.
    window_raw = ui.get("window") if isinstance(ui.get("window"), dict) else {}
    window: Dict[str, Dict[str, Any]] = {}
    for key, value in window_raw.items():
        if not isinstance(value, dict):
            continue
        box: Dict[str, Any] = {}
        for field in ("x", "y", "width", "height"):
            try:
                box[field] = int(value[field])
            except (KeyError, TypeError, ValueError):
                continue
        box["maximized"] = bool(value.get("maximized"))
        window[clean_app_id(key)] = box
    cfg["ui"] = {"zoom": zoom, "appearance": _clean_appearance(appearance_raw), "window": window}
    cfg["ai"] = _normalize_ai(raw.get("ai"))
    return cfg


APPEARANCE_RADII = (0, 4, 8, 12, 16)
APPEARANCE_THEMES = ("light", "dark", "system")


def _clean_appearance(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only the appearance fields the desktop shell understands."""
    clean: Dict[str, Any] = {}
    try:
        radius = int(raw.get("radius"))
    except (TypeError, ValueError):
        radius = 0
    clean["radius"] = radius if radius in APPEARANCE_RADII else 0
    theme = str(raw.get("theme") or "").strip().lower()
    if theme in APPEARANCE_THEMES:
        clean["theme"] = theme
    return clean


def get_appearance() -> Dict[str, Any]:
    cfg = load_config()
    raw = (cfg.get("ui") or {}).get("appearance")
    return dict(raw) if isinstance(raw, dict) else {"radius": 0}


def set_appearance(values: Dict[str, Any]) -> Dict[str, Any]:
    incoming = values if isinstance(values, dict) else {}

    def update(cfg: Dict[str, Any]) -> None:
        ui = cfg.setdefault("ui", {})
        current = ui.get("appearance") if isinstance(ui.get("appearance"), dict) else {}
        merged = dict(current)
        for key in ("radius", "theme"):
            if key in incoming:
                merged[key] = incoming[key]
        ui["appearance"] = _clean_appearance(merged)

    mutate_config(update)
    return get_appearance()


class FileLock:
    """Tiny cross-process lock around the shared config file."""

    def __init__(self, path: Path):
        self.path = path
        self.file = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.file = open(self.path, "a+b")
        if self.file.seek(0, os.SEEK_END) == 0:
            self.file.write(b"\0")
            self.file.flush()
        self.file.seek(0)
        if os.name == "nt":
            import msvcrt

            while True:
                try:
                    msvcrt.locking(self.file.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    time.sleep(0.05)
        else:
            import fcntl

            fcntl.flock(self.file.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        try:
            if os.name == "nt":
                import msvcrt

                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
        finally:
            self.file.close()


# Backwards-compatible alias for internal callers.
_FileLock = FileLock


def load_config() -> Dict[str, Any]:
    try:
        # utf-8-sig 同时兼容带/不带 BOM 的文件，避免用户手工编辑后设置被清空。
        data = json.loads(config_path().read_text(encoding="utf-8-sig"))
    except Exception:
        data = None
    return _normalize_config(data)


def backup_config() -> str:
    """Copy shared.json next to itself before an update swaps the program.

    The configuration deliberately lives in the user data folder, never in the
    installation directory, so an update cannot overwrite it.  The extra copy
    is a safety net for a damaged or partially written file.
    """
    source = config_path()
    if not source.is_file():
        return ""
    target = shared_root() / ("shared.backup-%s.json" % stamp())
    try:
        target.write_bytes(source.read_bytes())
        return str(target)
    except Exception:
        return ""


def _write_config(cfg: Dict[str, Any]) -> None:
    target = config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    cfg["version"] = API_VERSION
    cfg["updated"] = now_iso()
    tmp = target.with_name(target.name + ".tmp-" + uuid.uuid4().hex[:8])
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, target)


def mutate_config(mutator) -> Dict[str, Any]:
    with FileLock(lock_path()):
        cfg = load_config()
        mutator(cfg)
        _write_config(cfg)
        return cfg


def get_zoom(app: str, default: float = 1.0) -> float:
    cfg = load_config()
    value = ((cfg.get("ui") or {}).get("zoom") or {}).get(clean_app_id(app))
    try:
        return max(0.3, min(3.0, float(value))) if value is not None else default
    except (TypeError, ValueError):
        return default


def set_zoom(app: str, factor: float) -> float:
    app = clean_app_id(app)
    try:
        value = max(0.3, min(3.0, float(factor)))
    except (TypeError, ValueError):
        return get_zoom(app)

    def update(cfg: Dict[str, Any]) -> None:
        ui = cfg.setdefault("ui", {})
        if not isinstance(ui, dict):
            ui = {}
            cfg["ui"] = ui
        zoom = ui.setdefault("zoom", {})
        if not isinstance(zoom, dict):
            zoom = {}
            ui["zoom"] = zoom
        zoom[app] = round(value, 4)

    mutate_config(update)
    return value


def app_entry(cfg: Dict[str, Any], app: str) -> Dict[str, Any]:
    app = clean_app_id(app)
    apps = cfg.setdefault("apps", {})
    entry = apps.get(app)
    if not isinstance(entry, dict):
        entry = {
            "name": app_name(app),
            "save_path": "",
            "mode": "",
            "auto_snapshot": True,
            "updated": "",
            "last_snapshot": "",
            "resources": {},
        }
        apps[app] = entry
    entry.setdefault("resources", {})
    entry["name"] = app_name(app)
    return entry


def resolve_save_dir(app: str, cfg: Optional[Dict[str, Any]] = None) -> Path:
    cfg = cfg or load_config()
    entry = (cfg.get("apps") or {}).get(clean_app_id(app)) or {}
    raw = str(entry.get("save_path") or "").strip() or str(
        (cfg.get("save") or {}).get("path") or ""
    )
    path = Path(os.path.expandvars(os.path.expanduser(raw or str(default_save_path()))))
    return path


def resolve_share_dir(cfg: Optional[Dict[str, Any]] = None) -> Path:
    """Where the cross-product share space lives.

    Empty means the default next to ``shared.json``; a custom path is stored so
    the hub and every product resolve the same directory.
    """
    cfg = cfg or load_config()
    raw = str((cfg.get("share") or {}).get("path") or "").strip()
    path = Path(os.path.expandvars(os.path.expanduser(raw))) if raw else shared_root() / "share"
    return path


def _path_within(path: Path, root: Path) -> bool:
    """path 是否位于 root 之内（含其自身）。大小写与符号链接按系统语义归一。"""
    try:
        child = Path(os.path.normcase(str(path.resolve())))
        parent = Path(os.path.normcase(str(root.resolve())))
        return child == parent or parent in child.parents
    except OSError:
        return False


def config_roots(cfg: Optional[Dict[str, Any]] = None) -> list:
    """当前配置里所有合法的存储根目录。

    恢复备份时只接受落在这些目录之内的路径：这样本机已有的自定义保存目录可以
    原样恢复，而一份被篡改的备份无法把文件写到启动目录、系统目录等任意位置。
    """
    cfg = cfg or load_config()
    roots = [shared_root(), default_save_path()]

    def add(raw: Any) -> None:
        text = str(raw or "").strip()
        if not text:
            return
        roots.append(Path(os.path.expandvars(os.path.expanduser(text))))

    add((cfg.get("save") or {}).get("path"))
    add((cfg.get("share") or {}).get("path"))
    for entry in (cfg.get("apps") or {}).values():
        if not isinstance(entry, dict):
            continue
        add(entry.get("save_path"))
        for item in (entry.get("resources") or {}).values():
            if isinstance(item, dict):
                add(item.get("path"))
    return roots


def sanitize_restored_config(cfg: Dict[str, Any], allowed_roots=None) -> Dict[str, Any]:
    """恢复备份前校验所有路径边界。

    备份文件可能来自他人或被篡改；_normalize_config 只做格式化，不做边界检查。
    若直接写回，save.path / save_path / resources.path 可把 fs API 的允许根目录
    改到 C:\\ 或用户主目录，甚至借 full_restore 把文件复制进开机启动目录，形成
    任意文件读写。除了原有的系统根目录拒绝表，还要求每个路径落在“当前配置已
    在使用”的根目录之内（未提供时从磁盘上的当前配置推导），堵住任意目录写入。
    """
    if not isinstance(cfg, dict):
        raise ValueError("配置格式无效")
    if allowed_roots is None:
        try:
            allowed_roots = config_roots(load_config())
        except Exception:  # noqa: BLE001 -  reading current config must not block a restore
            allowed_roots = [shared_root(), default_save_path()]

    def check(raw: Any, label: str) -> None:
        text = str(raw or "").strip()
        if not text:
            return
        path = Path(os.path.expandvars(os.path.expanduser(text)))
        if omm_fs.unsafe_bulk_root(path):
            raise ValueError("备份中的%s是系统或用户根目录，已拒绝恢复" % label)
        if not any(_path_within(path, root) for root in allowed_roots):
            raise ValueError("备份中的%s不在本机已有的目录范围内，已拒绝恢复" % label)

    check((cfg.get("save") or {}).get("path"), "保存目录")
    check((cfg.get("share") or {}).get("path"), "共享目录")
    for entry in (cfg.get("apps") or {}).values():
        if not isinstance(entry, dict):
            continue
        check(entry.get("save_path"), "应用保存目录")
        for item in (entry.get("resources") or {}).values():
            if isinstance(item, dict):
                check(item.get("path"), "资源目录")
    return cfg


def resolve_mode(app: str, cfg: Optional[Dict[str, Any]] = None) -> str:
    cfg = cfg or load_config()
    entry = (cfg.get("apps") or {}).get(clean_app_id(app)) or {}
    mode = str(entry.get("mode") or "").strip().lower()
    if mode in MODES:
        return mode
    mode = str((cfg.get("save") or {}).get("mode") or "").strip().lower()
    return mode if mode in MODES else DEFAULT_MODE


def resolve_auto_snapshot(app: str, cfg: Optional[Dict[str, Any]] = None) -> bool:
    cfg = cfg or load_config()
    entry = (cfg.get("apps") or {}).get(clean_app_id(app)) or {}
    if "auto_snapshot" in entry:
        return bool(entry.get("auto_snapshot"))
    return bool((cfg.get("save") or {}).get("auto_snapshot", True))


def resolve_auto_share(app: str, cfg: Optional[Dict[str, Any]] = None) -> bool:
    cfg = cfg or load_config()
    entry = (cfg.get("apps") or {}).get(clean_app_id(app)) or {}
    if "auto_share" in entry:
        return bool(entry.get("auto_share"))
    return bool((cfg.get("save") or {}).get("auto_share", False))


def _safe_name(name: str, fallback: str = "export") -> str:
    base = str(name or "").replace("\\", "/").split("/")[-1].strip()
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", base)
    base = base.strip(" .")
    if not base:
        base = fallback
    stem, ext = os.path.splitext(base)
    stem = stem[:120].strip(" .") or fallback
    ext = ext[:24]
    return stem + ext


def _unique_versioned(directory: Path, name: str) -> Path:
    stem, ext = os.path.splitext(name)
    first = directory / ("%s-%s%s" % (stem, stamp(), ext))
    if not first.exists():
        return first
    for index in range(2, 1000):
        candidate = directory / ("%s-%s-%d%s" % (stem, stamp(), index, ext))
        if not candidate.exists():
            return candidate
    return directory / ("%s-%s-%s%s" % (stem, stamp(), uuid.uuid4().hex[:6], ext))


def _atomic_write(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp-" + uuid.uuid4().hex[:8])
    tmp.write_bytes(data)
    os.replace(tmp, target)


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False


def _resource_paths(cfg: Optional[Dict[str, Any]] = None) -> Tuple[list[Path], list[Path]]:
    """Return (exact resource files, resource directories) from the config.

    A registered resource file must be readable *only* at its exact path —
    granting its whole parent directory would expose every unrelated sibling
    file through /__omm/fs/file. Directories, on the other hand, are roots by
    design and are returned separately.
    """
    cfg = cfg or load_config()
    files: list[Path] = []
    directories: list[Path] = []
    for entry in (cfg.get("apps") or {}).values():
        for item in ((entry or {}).get("resources") or {}).values():
            if not isinstance(item, dict):
                continue
            raw = str(item.get("path") or "").strip()
            if not raw:
                continue
            path = Path(os.path.expandvars(os.path.expanduser(raw))).resolve()
            (directories if path.is_dir() else files).append(path)
    return files, directories


def _allowed_roots(cfg: Optional[Dict[str, Any]] = None) -> list[Path]:
    cfg = cfg or load_config()
    roots: list[Path] = [shared_root() / "updates"]
    roots.append(Path(str((cfg.get("save") or {}).get("path") or default_save_path())))
    for app, entry in (cfg.get("apps") or {}).items():
        raw = str((entry or {}).get("save_path") or "").strip()
        if raw:
            roots.append(Path(os.path.expandvars(os.path.expanduser(raw))))
    _files, resource_dirs = _resource_paths(cfg)
    roots.extend(resource_dirs)
    snapshots = shared_root() / SNAPSHOT_DIRNAME
    roots.append(snapshots)
    return roots


def _inside_any(path: Path, roots: Iterable[Path]) -> bool:
    return any(_inside(path, root) for root in roots)


# --------------------------------------------------------------------- saving


def save_file(
    app: str,
    filename: str,
    data: bytes,
    mime: str = "",
    mode: str = "",
    state: Optional[Dict[str, Any]] = None,
    label: str = "",
) -> Dict[str, Any]:
    app = clean_app_id(app)
    if not data:
        raise ValueError("文件内容为空")
    cfg = load_config()
    directory = resolve_save_dir(app, cfg)
    directory.mkdir(parents=True, exist_ok=True)
    name = _safe_name(filename)
    mode = (mode or resolve_mode(app, cfg)).lower()
    if mode not in MODES:
        mode = DEFAULT_MODE
    target = _unique_versioned(directory, name) if mode == MODE_VERSIONED else directory / name
    _atomic_write(target, data)
    kind = kind_for(name)
    entry = {
        "name": name,
        "file": target.name,
        "path": str(target),
        "kind": kind,
        "mime": mime or mime_for(name),
        "size": len(data),
        "updated": now_iso(),
        "mode": mode,
        "app": app,
        "app_name": app_name(app),
    }

    def update(cfg_in: Dict[str, Any]) -> None:
        app_item = app_entry(cfg_in, app)
        app_item["save_path"] = str(directory)
        app_item["updated"] = entry["updated"]
        app_item["resources"][name.lower()] = entry

    cfg = mutate_config(update)
    result: Dict[str, Any] = {
        "ok": True,
        "app": app,
        "filename": target.name,
        "path": str(target),
        "mode": mode,
        "resource": entry,
        "snapshot": None,
    }
    if state and resolve_auto_snapshot(app, cfg):
        try:
            result["snapshot"] = write_snapshot(app, state, label=label or ("保存 " + name))
        except Exception as exc:  # noqa: BLE001 - a snapshot must not break saving
            result["snapshot_error"] = str(exc)
    return result


def _snapshot_dir(app: str, cfg: Optional[Dict[str, Any]] = None) -> Path:
    return resolve_save_dir(app, cfg) / SNAPSHOT_DIRNAME / clean_app_id(app)


def _snapshot_label(label: str) -> str:
    text = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff _.-]+", "_", str(label or "").strip())
    return text[:28].strip(" ._-") or "snapshot"


def write_snapshot(
    app: str, state: Dict[str, Any], label: str = ""
) -> Dict[str, Any]:
    app = clean_app_id(app)
    if not isinstance(state, dict):
        raise ValueError("快照内容无效")
    cfg = load_config()
    folder = _snapshot_dir(app, cfg)
    folder.mkdir(parents=True, exist_ok=True)
    payload = dict(state)
    payload.setdefault("version", 1)
    payload["app"] = app
    payload.setdefault("taken_at", now_iso())
    # The explicit label wins over whatever the page embedded in its state:
    # the file name is derived from it, and both must agree.
    resolved_label = str(label or payload.get("label") or "manual")
    payload["label"] = resolved_label
    payload["saved_at"] = now_iso()
    name = "%s-%s.omm-snapshot.json" % (
        datetime.now().strftime("%Y%m%d-%H%M%S"),
        _snapshot_label(resolved_label),
    )
    target = folder / name
    if target.exists():
        target = folder / ("%s-%s.omm-snapshot.json" % (
            datetime.now().strftime("%Y%m%d-%H%M%S"), uuid.uuid4().hex[:6]
        ))
    _atomic_write(target, json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def update(cfg_in: Dict[str, Any]) -> None:
        app_item = app_entry(cfg_in, app)
        app_item["save_path"] = str(resolve_save_dir(app, cfg_in))
        app_item["last_snapshot"] = str(target)
        app_item["updated"] = now_iso()

    mutate_config(update)
    return {
        "ok": True,
        "app": app,
        "path": str(target),
        "name": target.name,
        "size": target.stat().st_size,
        "label": payload.get("label") or "",
        "taken_at": payload.get("taken_at") or "",
    }


def _snapshot_meta(path: Path) -> Dict[str, Any]:
    app = path.parent.name
    name = path.name
    label = ""
    try:
        match = re.match(r"^\d{8}-\d{6}-?(.*)\.omm-snapshot\.json$", name)
        if match:
            label = match.group(1).replace("_", " ").strip()
    except Exception:
        pass
    if not label:
        label = "快照"
    try:
        stat = path.stat()
    except OSError:
        return {}
    return {
        "app": app,
        "app_name": app_name(app),
        "name": name,
        "path": str(path),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "time": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "label": label,
    }


def list_snapshots(app: str, all_apps: bool = False, limit: int = 500) -> list[Dict[str, Any]]:
    cfg = load_config()
    if all_apps:
        folders = []
        for key in sorted(set(list(APP_NAMES) + list((cfg.get("apps") or {}).keys()))):
            folder = resolve_save_dir(key, cfg) / SNAPSHOT_DIRNAME / clean_app_id(key)
            if folder.is_dir():
                folders.append(folder)
    else:
        folder = resolve_save_dir(app, cfg) / SNAPSHOT_DIRNAME / clean_app_id(app)
        folders = [folder] if folder.is_dir() else []
    items: list[Dict[str, Any]] = []
    for folder in folders:
        if not folder.is_dir():
            continue
        for path in folder.glob("*" + SNAPSHOT_SUFFIX):
            meta = _snapshot_meta(path)
            if meta:
                items.append(meta)
    items.sort(key=lambda item: item.get("mtime") or 0, reverse=True)
    return items[: max(1, min(int(limit or 500), 2000))]


def _snapshot_path(raw: str) -> Path:
    path = Path(os.path.expandvars(os.path.expanduser(str(raw or "")))).resolve()
    if not _inside_any(path, [shared_root() / SNAPSHOT_DIRNAME, *[
        Path(str((entry or {}).get("save_path") or "")) for entry in (load_config().get("apps") or {}).values()
        if str((entry or {}).get("save_path") or "").strip()
    ]]):
        # Also allow snapshots that live in the global save directory.
        if not _inside(path, Path(str((load_config().get("save") or {}).get("path") or default_save_path()))):
            raise ValueError("快照路径不在允许的保存目录中")
    return path


def read_snapshot(raw: str) -> Dict[str, Any]:
    path = _snapshot_path(raw)
    if not path.is_file() or not path.name.endswith(SNAPSHOT_SUFFIX):
        raise ValueError("快照文件不存在")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def rename_snapshot(raw: str, label: str) -> Dict[str, Any]:
    """Give a snapshot a new name.

    The label is stored twice: inside the payload and inside the file name, so
    both have to be rewritten.  The file is rewritten atomically and the old
    one is removed afterwards.
    """
    path = _snapshot_path(raw)
    if not path.is_file() or not path.name.endswith(SNAPSHOT_SUFFIX):
        raise ValueError("快照文件不存在")
    clean = _snapshot_label(label)
    if not clean:
        raise ValueError("名称无效")
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:  # noqa: BLE001 - a broken snapshot still deserves a rename
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    payload["label"] = clean
    payload["renamed_at"] = now_iso()
    stamp_text = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = path.parent / ("%s-%s%s" % (stamp_text, clean, SNAPSHOT_SUFFIX))
    if target.exists():
        target = path.parent / (
            "%s-%s-%s%s" % (stamp_text, clean, uuid.uuid4().hex[:6], SNAPSHOT_SUFFIX)
        )
    _atomic_write(target, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    try:
        if target != path:
            path.unlink()
    except OSError:
        pass
    meta = _snapshot_meta(target)
    return {"ok": True, "path": str(target), "name": target.name, "label": clean, "meta": meta}


def delete_snapshot(raw: str) -> Dict[str, Any]:
    path = _snapshot_path(raw)
    if not path.is_file() or not path.name.endswith(SNAPSHOT_SUFFIX):
        raise ValueError("快照文件不存在")
    path.unlink()
    return {"ok": True, "path": str(path)}


def _sort_stamp(value: str) -> float:
    """Turn an ISO timestamp into a comparable number (0 when unparsable)."""
    text = str(value or "").strip()
    if not text:
        return 0.0
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return 0.0


TEXT_EXTS = {
    ".md", ".markdown", ".txt", ".csv", ".tsv", ".tex", ".json", ".log",
    ".html", ".css", ".js", ".ts", ".yml", ".yaml", ".xml", ".srt", ".vtt",
}
MAX_SEARCH_BYTES = 2 * 1024 * 1024


def _snippet(text: str, lower_text: str, needle: str, around: int = 60) -> str:
    """One line of context around the first match, trimmed to ~2*around chars."""
    pos = lower_text.find(needle)
    if pos < 0:
        return ""
    line_start = text.rfind("\n", 0, pos) + 1
    line_end = text.find("\n", pos)
    if line_end < 0:
        line_end = len(text)
    line = text[line_start:line_end].strip()
    if len(line) <= around * 2:
        return line
    offset = pos - line_start
    left = max(0, offset - around)
    right = min(len(line), offset + len(needle) + around)
    return ("…" if left > 0 else "") + line[left:right].strip() + ("…" if right < len(line) else "")


def search_file_contents(
    app: str, query: str, all_apps: bool = True, limit: int = 30
) -> Dict[str, Any]:
    """Search inside saved text files (not just their names).

    Only reasonably small text files are opened, and the scan stops as soon as
    ``limit`` matches are found, so a huge archive cannot stall the request.
    """
    needle = query.strip().lower()
    if not needle:
        return {"ok": True, "query": "", "matches": [], "scanned": 0, "truncated": False}
    archive = list_archive(app, all_apps=all_apps, limit=500)
    matches: list[Dict[str, Any]] = []
    scanned = 0
    truncated = False
    for entry in archive.get("entries", []):
        if len(matches) >= limit:
            truncated = True
            break
        if entry.get("kind") != "file" or not entry.get("exists"):
            continue
        path = Path(str(entry.get("path") or ""))
        if path.suffix.lower() not in TEXT_EXTS:
            continue
        try:
            if path.stat().st_size > MAX_SEARCH_BYTES:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        scanned += 1
        lower_text = text.lower()
        count = lower_text.count(needle)
        if not count:
            continue
        matches.append(
            {
                "app": entry.get("app"),
                "app_name": entry.get("app_name"),
                "name": entry.get("name") or path.name,
                "title": entry.get("title") or entry.get("name") or path.name,
                "path": str(path),
                "mime": entry.get("mime") or "",
                "count": count,
                "snippet": _snippet(text, lower_text, needle),
            }
        )
    return {
        "ok": True,
        "query": needle,
        "matches": matches,
        "scanned": scanned,
        "truncated": truncated,
    }


def list_archive(app: str, all_apps: bool = True, limit: int = 500) -> Dict[str, Any]:
    """One list of everything that was archived.

    Two kinds of entry live in the same save area:

    ``file``     a document a product wrote (the "shared data" of old builds)
    ``snapshot`` a captured application state that can be restored

    They used to live in two separate panels with two nearly identical lists.
    Now both are entries of a single timeline, distinguished by ``kind``.
    """
    cfg = load_config()
    items: list[Dict[str, Any]] = []
    apps = set(APP_NAMES) | set((cfg.get("apps") or {}).keys())
    if not all_apps:
        apps = {app}
    for key in apps:
        entry = (cfg.get("apps") or {}).get(key) or {}
        for item in (entry.get("resources") or {}).values():
            if not isinstance(item, dict):
                continue
            path = Path(str(item.get("path") or ""))
            record = dict(item)
            record["kind"] = "file"
            record["exists"] = path.is_file()
            if record["exists"]:
                try:
                    record["size"] = path.stat().st_size
                except OSError:
                    pass
            record["app"] = key
            record["app_name"] = app_name(key)
            record["time"] = str(item.get("updated") or "")
            record["sort"] = _sort_stamp(record["time"])
            items.append(record)
    for meta in list_snapshots(app, all_apps=all_apps, limit=limit):
        record = dict(meta)
        record["kind"] = "snapshot"
        record["label"] = str(meta.get("label") or meta.get("name") or "")
        record["sort"] = float(meta.get("mtime") or 0)
        items.append(record)
    items.sort(key=lambda item: item.get("sort") or 0, reverse=True)
    return {
        "ok": True,
        "app": app,
        "entries": items[: max(1, min(int(limit or 500), 2000))],
        "apps": [
            {
                "app": key,
                "name": app_name(key),
                "save_path": str(resolve_save_dir(key, cfg)),
                "mode": resolve_mode(key, cfg),
                "auto_snapshot": resolve_auto_snapshot(key, cfg),
            }
            for key in sorted(set(list(APP_NAMES) + list((cfg.get("apps") or {}).keys())))
        ],
    }


def list_shared() -> Dict[str, Any]:
    cfg = load_config()
    resources: list[Dict[str, Any]] = []
    for app, entry in (cfg.get("apps") or {}).items():
        entry = entry or {}
        for item in (entry.get("resources") or {}).values():
            if not isinstance(item, dict):
                continue
            path = Path(str(item.get("path") or ""))
            record = dict(item)
            record["exists"] = path.is_file()
            if record["exists"]:
                try:
                    record["size"] = path.stat().st_size
                except OSError:
                    pass
            resources.append(record)
    resources.sort(key=lambda item: str(item.get("updated") or ""), reverse=True)
    return {
        "ok": True,
        "config": redact_config_secrets(cfg),
        "resources": resources,
        "apps": [
            {
                "app": app,
                "name": app_name(app),
                "save_path": str(resolve_save_dir(app, cfg)),
                "mode": resolve_mode(app, cfg),
                "auto_snapshot": resolve_auto_snapshot(app, cfg),
            }
            for app in sorted(set(list(APP_NAMES) + list((cfg.get("apps") or {}).keys())))
        ],
    }


def read_shared_file(raw: str) -> Tuple[bytes, str]:
    path = Path(os.path.expandvars(os.path.expanduser(str(raw or "")))).resolve()
    allowed_files, _dirs = _resource_paths()
    # 注册过的单个资源文件按精确路径放行；其他文件必须位于允许的目录根下。
    exact_match = any(path == allowed for allowed in allowed_files)
    if not exact_match and not _inside_any(path, _allowed_roots()):
        raise ValueError("文件不在共享目录中")
    if not path.is_file():
        raise ValueError("文件不存在")
    return path.read_bytes(), mime_for(path.name)


def open_folder(app: str) -> Dict[str, Any]:
    folder = resolve_save_dir(clean_app_id(app))
    folder.mkdir(parents=True, exist_ok=True)
    try:
        if os.name == "nt":
            os.startfile(str(folder))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(folder)])
        else:
            subprocess.Popen(["xdg-open", str(folder)])
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "path": str(folder)}
    return {"ok": True, "path": str(folder)}


# ------------------------------------------------------- docx -> pdf bridge

DOCX_PDF_TIMEOUT = 180
_DOCX_ENGINE_NAMES = {"soffice": "LibreOffice", "abiword": "AbiWord"}


def _safe_docx_name(name: str) -> str:
    base = Path(str(name or "document.docx")).name
    base = re.sub(r"[^0-9A-Za-z._\-\u4e00-\u9fff]+", "_", base) or "document.docx"
    if not base.lower().endswith(".docx"):
        base += ".docx"
    return base


_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _probe_version(path: str, timeout: int = 4) -> str:
    """Run ``<path> --version`` but never block the caller.

    Some binaries (e.g. the windowed Ghostscript build, or a LibreOffice
    launcher that spawns a background service) ignore ``--version`` and never
    exit, which used to stall every status check and config save for the full
    timeout. We cap the wait with a daemon thread so the worst case is a short,
    bounded delay instead of an 8s hang.
    """
    captured: list[str] = []

    def _run() -> None:
        try:
            result = subprocess.run(
                [path, "--version"],
                timeout=timeout,
                capture_output=True,
                text=True,
                check=False,
                creationflags=_NO_WINDOW,
            )
            captured.append((result.stdout or result.stderr or "").strip())
        except Exception:  # noqa: BLE001
            captured.append("")

    worker = threading.Thread(target=_run, daemon=True)
    worker.start()
    worker.join(timeout + 1)
    if not captured:
        return ""
    lines = captured[0].splitlines()
    return lines[0][:140] if lines else ""


def _soffice_candidates(configured: str) -> list[str]:
    found: list[str] = []
    if configured:
        found.append(str(Path(os.path.expandvars(configured.strip('"'))).expanduser()))
    for cmd in ("soffice", "libreoffice", "soffice.exe"):
        hit = shutil.which(cmd)
        if hit:
            found.append(hit)
    if os.name == "nt":
        for env in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
            base = os.environ.get(env)
            if base:
                found.append(str(Path(base) / "LibreOffice" / "program" / "soffice.exe"))
        try:
            import winreg

            for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                for exe in ("soffice.exe", "libreoffice.exe"):
                    try:
                        key = winreg.OpenKey(
                            hive,
                            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths" + "\\" + exe,
                        )
                        value, _ = winreg.QueryValueEx(key, "")
                        winreg.CloseKey(key)
                        if value:
                            found.append(str(value).strip('"'))
                    except OSError:
                        continue
        except Exception:  # noqa: BLE001
            pass
    elif sys.platform == "darwin":
        found.extend(
            [
                "/Applications/LibreOffice.app/Contents/MacOS/soffice",
                str(Path.home() / "Applications/LibreOffice.app/Contents/MacOS/soffice"),
            ]
        )
    else:
        found.extend(
            [
                "/usr/bin/soffice",
                "/usr/bin/libreoffice",
                "/usr/lib/libreoffice/program/soffice",
                "/snap/bin/libreoffice",
                "/opt/libreoffice/program/soffice",
            ]
        )
    seen, unique = set(), []
    for item in found:
        key = os.path.normcase(os.path.abspath(item)) if item else ""
        if key and key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def _abiword_candidates(configured: str) -> list[str]:
    found: list[str] = []
    if configured:
        found.append(str(Path(os.path.expandvars(configured.strip('"'))).expanduser()))
    for cmd in ("abiword", "abiword.exe"):
        hit = shutil.which(cmd)
        if hit:
            found.append(hit)
    if os.name == "nt":
        for env in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
            base = os.environ.get(env)
            if base:
                found.append(str(Path(base) / "AbiWord" / "bin" / "abiword.exe"))
    elif sys.platform == "darwin":
        found.append("/Applications/AbiWord.app/Contents/MacOS/AbiWord")
    else:
        found.extend(["/usr/bin/abiword", "/usr/local/bin/abiword"])
    seen, unique = set(), []
    for item in found:
        key = os.path.normcase(os.path.abspath(item)) if item else ""
        if key and key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def _describe_engine(engine_id: str, name: str, candidates: list[str]) -> Dict[str, Any]:
    seen, checked = set(), []
    for candidate in candidates:
        path = Path(candidate)
        try:
            exists = path.is_file()
        except OSError:
            exists = False
        key = os.path.normcase(str(path))
        if key in seen:
            continue
        seen.add(key)
        checked.append(str(path))
        if exists:
            return {
                "id": engine_id,
                "name": name,
                "path": str(path),
                "available": True,
                "version": _probe_version(str(path)),
            }
    return {
        "id": engine_id,
        "name": name,
        "path": "",
        "available": False,
        "version": "",
        "checked": checked[:6],
    }


def _gs_candidates(configured: str) -> list[str]:
    found: list[str] = []
    if configured:
        found.append(str(Path(os.path.expandvars(configured.strip('"'))).expanduser()))
    for cmd in ("gswin64c", "gswin64", "gswin32c", "gs"):
        hit = shutil.which(cmd)
        if hit:
            found.append(hit)
    if os.name == "nt":
        roots: list[Path] = []
        for env in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
            base = os.environ.get(env)
            if base:
                roots.append(Path(base) / "gs")
        # Common manual installs: C://gs10.06.0, D://gs10.06.0, ...
        for drive in ("C:", "D:", "E:", "F:"):
            try:
                for candidate in Path(drive + "/").glob("gs*"):
                    if candidate.is_dir():
                        roots.append(candidate)
            except OSError:
                continue
        for root in roots:
            for pattern in ("*/bin/gswin64c.exe", "*/bin/gswin64.exe", "*/bin/gswin32c.exe"):
                try:
                    for exe in sorted(root.glob(pattern), reverse=True):
                        found.append(str(exe))
                except OSError:
                    pass
    elif sys.platform == "darwin":
        found.extend(["/usr/local/bin/gs", "/opt/homebrew/bin/gs"])
    else:
        found.extend(["/usr/bin/gs", "/usr/local/bin/gs"])
    seen, unique = set(), []
    for item in found:
        key = os.path.normcase(os.path.abspath(item)) if item else ""
        if key and key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def docx_pdf_status() -> Dict[str, Any]:
    cfg = load_config().get("docx_pdf") or {}
    soffice_cfg = str(cfg.get("soffice") or "").strip()
    abiword_cfg = str(cfg.get("abiword") or "").strip()
    gs_cfg = str(cfg.get("gs") or "").strip()
    engines = [
        _describe_engine("soffice", "LibreOffice", _soffice_candidates(soffice_cfg)),
        _describe_engine("abiword", "AbiWord", _abiword_candidates(abiword_cfg)),
    ]
    tools = []
    # Always probe the *console* Ghostscript build (gswin64c.exe). The windowed
    # build (gswin64.exe) ignores --version and hangs until the 8s timeout,
    # which made every status check and config save stall.
    gs_candidates = [_gs_console_path(c) for c in _gs_candidates(gs_cfg)]
    gs = _describe_engine("ghostscript", "Ghostscript", gs_candidates)
    if gs["available"]:
        tools.append(
            {
                "id": "ghostscript",
                "name": "Ghostscript",
                "path": gs["path"],
                "version": gs["version"],
                "available": True,
                "role": "pdf",
                "note": "仅用于 PDF 压缩 / 转图，不能解析 DOCX",
            }
        )
    return {
        "ok": True,
        "available": any(e["available"] for e in engines),
        "engines": engines,
        "tools": tools,
        "config": {"soffice": soffice_cfg, "abiword": abiword_cfg, "gs": gs_cfg},
    }


def _run_soffice(path: str, src: Path, folder: Path) -> Path:
    profile = folder / "lo-profile"
    produced = folder / (src.stem + ".pdf")
    if produced.exists():
        produced.unlink()
    cmd = [
        path,
        "--headless",
        "--norestore",
        "--invisible",
        "--nodefault",
        "--nolockcheck",
        "-env:UserInstallation=" + profile.resolve().as_uri(),
        "--convert-to",
        "pdf",
        "--outdir",
        str(folder),
        str(src),
    ]
    subprocess.run(cmd, timeout=DOCX_PDF_TIMEOUT, capture_output=True, check=False)
    return produced


def _run_abiword(path: str, src: Path, folder: Path) -> Path:
    produced = folder / "abiword-output.pdf"
    if produced.exists():
        produced.unlink()
    cmd = [path, "--to=pdf", "--to-name", str(produced), str(src)]
    subprocess.run(
        cmd,
        timeout=DOCX_PDF_TIMEOUT,
        capture_output=True,
        check=False,
        cwd=str(folder),
    )
    return produced


def _gs_console_path(path: str) -> str:
    """Prefer the console build (gswin64c.exe) so no window is opened."""
    candidate = Path(path)
    if candidate.name.lower() in ("gswin64.exe", "gswin32.exe"):
        console = candidate.with_name(
            candidate.stem + "c" + candidate.suffix
        )
        if console.is_file():
            return str(console)
    return path


def _gs_binary() -> Optional[str]:
    cfg = load_config().get("docx_pdf") or {}
    gs = _describe_engine("ghostscript", "Ghostscript", _gs_candidates(str(cfg.get("gs") or "")))
    return _gs_console_path(gs["path"]) if gs["available"] else None


def _run_gs(args: list[str], inputs: list[str], output: str, timeout: int = 180) -> str:
    binary = _gs_binary()
    if not binary:
        raise ValueError("未检测到 Ghostscript，请先在“PDF 转换引擎”中设置路径")
    cmd = [binary] + args + ["-sOutputFile=" + output] + inputs
    result = subprocess.run(cmd, timeout=timeout, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        raise ValueError("Ghostscript 处理失败：" + (" | ".join(detail[-3:]) if detail else str(result.returncode)))
    return binary


def _zip_folder(folder: Path, prefix: str) -> tuple[bytes, list[str]]:
    import zipfile

    files = sorted(p for p in folder.iterdir() if p.is_file() and p.name != "out.pdf")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in files:
            zf.write(item, item.name)
    return buffer.getvalue(), [p.name for p in files]


def pdf_tool(payload: Dict[str, Any]) -> Dict[str, Any]:
    op = str(payload.get("op") or "").strip().lower()
    name = str(payload.get("name") or "document.pdf")
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}

    def read_bytes(raw: Any) -> bytes:
        try:
            return base64.b64decode(str(raw or ""), validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError("PDF 内容不是有效的 base64") from exc

    stem = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", Path(name).stem) or "document"

    with tempfile.TemporaryDirectory(prefix="omm-pdf-") as tmp:
        folder = Path(tmp)
        if op == "merge":
            items = payload.get("files")
            if not isinstance(items, list) or len(items) < 2:
                raise ValueError("合并至少需要 2 个 PDF")
            inputs = []
            for index, item in enumerate(items):
                data = read_bytes(item.get("data") if isinstance(item, dict) else item)
                path = folder / ("merge-%03d.pdf" % index)
                path.write_bytes(data)
                inputs.append(str(path))
            output = folder / "out.pdf"
            binary = _run_gs(
                ["-sDEVICE=pdfwrite", "-dNOPAUSE", "-dQUIET", "-dBATCH"],
                inputs,
                str(output),
            )
            return {
                "ok": True,
                "engine": "Ghostscript",
                "path": binary,
                "name": stem + "_合并.pdf",
                "pdf": base64.b64encode(output.read_bytes()).decode("ascii"),
                "bytes": output.stat().st_size,
            }

        data = read_bytes(payload.get("data"))
        src = folder / "input.pdf"
        src.write_bytes(data)
        output = folder / "out.pdf"
        base = ["-dNOPAUSE", "-dQUIET", "-dBATCH", "-dCompatibilityLevel=1.7"]

        if op == "compress":
            quality = str(options.get("quality") or "ebook").lower()
            if quality not in ("screen", "ebook", "printer", "prepress", "default"):
                quality = "ebook"
            args = ["-sDEVICE=pdfwrite", "-dPDFSETTINGS=/" + quality] + base
            args += ["-dDetectDuplicateImages=true", "-dCompressFonts=true", "-dSubsetFonts=true"]
            binary = _run_gs(args, [str(src)], str(output))
            return {
                "ok": True,
                "engine": "Ghostscript",
                "path": binary,
                "name": stem + "_压缩.pdf",
                "pdf": base64.b64encode(output.read_bytes()).decode("ascii"),
                "bytes": output.stat().st_size,
                "originalBytes": len(data),
            }

        if op == "repair":
            args = ["-sDEVICE=pdfwrite", "-dPDFSTOPONERROR=false"] + base
            binary = _run_gs(args, [str(src)], str(output))
            return {
                "ok": True,
                "engine": "Ghostscript",
                "path": binary,
                "name": stem + "_修复.pdf",
                "pdf": base64.b64encode(output.read_bytes()).decode("ascii"),
                "bytes": output.stat().st_size,
                "originalBytes": len(data),
            }

        if op == "pdfa":
            args = [
                "-sDEVICE=pdfwrite",
                "-dPDFA=2",
                "-dPDFACompatibilityPolicy=1",
                "-sColorConversionStrategy=RGB",
            ] + base
            binary = _run_gs(args, [str(src)], str(output))
            return {
                "ok": True,
                "engine": "Ghostscript",
                "path": binary,
                "name": stem + "_PDFA.pdf",
                "pdf": base64.b64encode(output.read_bytes()).decode("ascii"),
                "bytes": output.stat().st_size,
                "originalBytes": len(data),
            }

        if op == "pages":
            try:
                first = int(options.get("first") or 1)
                last = int(options.get("last") or first)
            except (TypeError, ValueError):
                raise ValueError("页码范围无效")
            if first < 1 or last < first:
                raise ValueError("页码范围无效")
            args = [
                "-sDEVICE=pdfwrite",
                "-dFirstPage=%d" % first,
                "-dLastPage=%d" % last,
            ] + base
            binary = _run_gs(args, [str(src)], str(output))
            return {
                "ok": True,
                "engine": "Ghostscript",
                "path": binary,
                "name": "%s_第%d-%d页.pdf" % (stem, first, last),
                "pdf": base64.b64encode(output.read_bytes()).decode("ascii"),
                "bytes": output.stat().st_size,
                "originalBytes": len(data),
            }

        if op == "render":
            try:
                dpi = int(options.get("dpi") or 150)
            except (TypeError, ValueError):
                dpi = 150
            dpi = max(72, min(dpi, 600))
            fmt = str(options.get("format") or "png").lower()
            ext = "jpg" if fmt in ("jpg", "jpeg") else "png"
            device = "jpeg" if ext == "jpg" else "png16m"
            args = ["-sDEVICE=" + device, "-r%d" % dpi]
            if ext == "jpg":
                args += ["-dJPEGQ=92"]
            try:
                first = int(options.get("first") or 1)
                last = int(options.get("last") or 0)
            except (TypeError, ValueError):
                first, last = 1, 0
            if first > 1:
                args.append("-dFirstPage=%d" % first)
            if last >= first:
                args.append("-dLastPage=%d" % last)
            pattern = str(folder / ("page-%03d." + ext))
            binary = _run_gs(args + base, [str(src)], pattern)
            # -sOutputFile with %03d is written by Ghostscript itself.
            files = sorted(folder.glob("page-*." + ext))
            if not files:
                raise ValueError("Ghostscript 没有生成图片")
            import zipfile

            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                for item in files:
                    zf.write(item, item.name)
            return {
                "ok": True,
                "engine": "Ghostscript",
                "path": binary,
                "name": stem + "_图片.zip",
                "zip": base64.b64encode(buffer.getvalue()).decode("ascii"),
                "bytes": buffer.tell(),
                "files": [p.name for p in files],
            }

        raise ValueError("未知的 PDF 操作：" + op)


def convert_docx_to_pdf(
    data: bytes, name: str, engine: str = ""
) -> Dict[str, Any]:
    """Convert a DOCX buffer to PDF with a local open-source converter."""
    status = docx_pdf_status()
    if not status["available"]:
        return {
            "ok": False,
            "error": "未检测到 LibreOffice / AbiWord，请先在“PDF 转换引擎”中设置路径",
            "engines": status["engines"],
        }

    wanted = str(engine or "").strip().lower()
    attempts: list[tuple[str, str, str]] = []
    for item in status["engines"]:
        if not item["available"]:
            continue
        if wanted and item["id"] not in wanted and item["name"].lower() not in wanted:
            continue
        attempts.append((item["id"], item["name"], item["path"]))
    if not attempts:
        attempts = [
            (item["id"], item["name"], item["path"])
            for item in status["engines"]
            if item["available"]
        ]

    errors: list[Dict[str, str]] = []
    with tempfile.TemporaryDirectory(prefix="omm-docx2pdf-") as tmp:
        folder = Path(tmp)
        src = folder / _safe_docx_name(name)
        src.write_bytes(data)
        for engine_id, engine_name, path in attempts:
            try:
                if engine_id == "soffice":
                    produced = _run_soffice(path, src, folder)
                else:
                    produced = _run_abiword(path, src, folder)
                if produced.exists() and produced.stat().st_size > 0:
                    return {
                        "ok": True,
                        "engine": engine_name,
                        "engine_path": path,
                        "pdf": produced.read_bytes(),
                    }
                errors.append({"engine": engine_name, "path": path, "error": "未生成 PDF"})
            except Exception as exc:  # noqa: BLE001
                errors.append({"engine": engine_name, "path": path, "error": str(exc)})
    return {
        "ok": False,
        "error": "转换失败，请检查转换器路径或文件是否损坏",
        "engines": status["engines"],
        "attempts": errors,
    }


# --------------------------------------------------------------------- routes


def _json(status: int, payload: Dict[str, Any]) -> Tuple[int, str, bytes]:
    return status, "application/json; charset=utf-8", json.dumps(
        payload, ensure_ascii=False
    ).encode("utf-8")


def _error(status: int, message: str) -> Tuple[int, str, bytes]:
    return _json(status, {"ok": False, "error": message})


def _client_app(
    default_app: str,
    query: Dict[str, list[str]],
    trusted_hub: bool = False,
) -> str:
    """Resolve caller identity, allowing only a trusted Hub to scope a product."""
    app = clean_app_id(default_app or "app")
    if trusted_hub and app == "hub":
        return clean_app_id((query.get("app") or [""])[0] or app)
    return app


def _route_capability(path: str, method: str) -> str:
    capability = _FS_ROUTE_CAPABILITIES.get(path, "")
    if path == "/__omm/fs/ai-config" and method == "POST":
        return "ai-config:write"
    return capability


def _resolve_capabilities(
    default_app: str, capabilities: Optional[Iterable[str]]
) -> frozenset[str]:
    if capabilities is not None:
        return frozenset(str(item) for item in capabilities)
    return capabilities_for_app(default_app)


def handle_get(
    path: str,
    query: Dict[str, list[str]],
    default_app: str = "app",
    capabilities: Optional[Iterable[str]] = None,
    trusted_hub: bool = False,
) -> Tuple[int, str, bytes]:
    if not desktop_enabled():
        return _error(404, "desktop API is not enabled")
    app = _client_app(default_app, query, trusted_hub=trusted_hub)
    granted = _resolve_capabilities(app, capabilities)
    required = _route_capability(path, "GET")
    if required and required not in granted:
        return _error(403, "当前插件没有此桌面能力")
    if path == "/__omm/fs/status":
        cfg = load_config()
        return _json(
            200,
            {
                "ok": True,
                "desktop": True,
                "api": API_VERSION,
                "app": app,
                "capabilities": sorted(granted),
                "save_path": str(resolve_save_dir(app, cfg)),
                "mode": resolve_mode(app, cfg),
                "auto_snapshot": resolve_auto_snapshot(app, cfg),
                "auto_share": resolve_auto_share(app, cfg),
                "share_path": str(resolve_share_dir(cfg)),
            },
        )
    if path == "/__omm/fs/config":
        cfg = load_config()
        return _json(
            200,
            {
                "ok": True,
                "app": app,
                "config": redact_config_secrets(cfg),
                "save_path": str(resolve_save_dir(app, cfg)),
                "mode": resolve_mode(app, cfg),
                "auto_snapshot": resolve_auto_snapshot(app, cfg),
                "auto_share": resolve_auto_share(app, cfg),
                "share_path": str(resolve_share_dir(cfg)),
                "default_path": str(default_save_path()),
            },
        )
    if path == "/__omm/fs/shared":
        return _json(200, list_shared())
    if path == "/__omm/fs/ai-config":
        ai = _normalize_ai(load_config().get("ai"))
        return _json(200, {"ok": True, "ai": _public_ai(ai), "configured": bool(ai.get("apiKey")),
                           "hasStoredKey": bool(ai.get("apiKey"))})
    if path == "/__omm/fs/search":
        all_apps = (query.get("all") or ["1"])[0] != "0"
        raw_query = (query.get("q") or [""])[0].strip()
        try:
            limit = int((query.get("limit") or ["30"])[0])
        except ValueError:
            limit = 30
        limit = max(1, min(limit, 60))
        return _json(
            200, search_file_contents(app, raw_query, all_apps=all_apps, limit=limit)
        )
    if path == "/__omm/fs/archive":
        all_apps = (query.get("all") or ["1"])[0] != "0"
        try:
            limit = int((query.get("limit") or ["500"])[0])
        except ValueError:
            limit = 500
        return _json(200, list_archive(app, all_apps=all_apps, limit=limit))
    if path == "/__omm/fs/snapshots":
        all_apps = (query.get("all") or ["0"])[0] == "1"
        try:
            limit = int((query.get("limit") or ["500"])[0])
        except ValueError:
            limit = 500
        return _json(
            200,
            {
                "ok": True,
                "app": app,
                "snapshots": list_snapshots(app, all_apps=all_apps, limit=limit),
            },
        )
    if path == "/__omm/fs/snapshot":
        raw = (query.get("path") or [""])[0]
        try:
            snapshot = read_snapshot(raw)
        except Exception as exc:  # noqa: BLE001
            return _error(400, str(exc))
        return _json(200, {"ok": True, "snapshot": snapshot})
    if path == "/__omm/fs/appearance":
        return _json(200, {"ok": True, "appearance": get_appearance()})
    if path == "/__omm/fs/docx2pdf":
        return _json(200, docx_pdf_status())
    if path == "/__omm/fs/pdf/tool":
        binary = _gs_binary()
        return _json(
            200,
            {
                "ok": True,
                "available": bool(binary),
                "path": binary or "",
                "version": _probe_version(binary) if binary else "",
            },
        )
    if path == "/__omm/fs/file":
        raw = (query.get("path") or [""])[0]
        try:
            data, mime = read_shared_file(raw)
        except Exception as exc:  # noqa: BLE001
            return _error(400, str(exc))
        return 200, mime, data
    return _error(404, "unknown endpoint")


def handle_post(
    path: str,
    query: Dict[str, list[str]],
    body: bytes,
    default_app: str = "app",
    capabilities: Optional[Iterable[str]] = None,
    trusted_hub: bool = False,
) -> Tuple[int, str, bytes]:
    if not desktop_enabled():
        return _error(404, "desktop API is not enabled")
    app = _client_app(default_app, query, trusted_hub=trusted_hub)
    granted = _resolve_capabilities(app, capabilities)
    required = _route_capability(path, "POST")
    if required and required not in granted:
        return _error(403, "当前插件没有此桌面能力")
    try:
        if len(body) > MAX_BODY:
            return _error(413, "请求体过大")
        payload = json.loads(body.decode("utf-8")) if body else {}
        if not isinstance(payload, dict):
            raise ValueError("请求格式无效")
        caller_app = clean_app_id(default_app or "app")
        payload_app = (
            clean_app_id(payload.get("app") or app)
            if trusted_hub and caller_app == "hub"
            else app
        )
        if path == "/__omm/fs/config":
            if caller_app != "hub" and str(payload.get("scope") or "app").lower() == "all":
                return _error(403, "只有工作台可以修改全部产品的保存设置")
            result = _update_config(payload_app, payload)
            result["config"] = redact_config_secrets(result.get("config") or {})
            return _json(200, result)
        if path == "/__omm/fs/ai-config":
            ai_raw = payload.get("ai") if isinstance(payload.get("ai"), dict) else payload
            incoming = ai_raw if isinstance(ai_raw, dict) else {}
            ai = _normalize_ai(incoming)
            with FileLock(lock_path()):
                cfg = load_config()
                if "apiKey" not in incoming:
                    ai["apiKey"] = _normalize_ai(cfg.get("ai")).get("apiKey", "")
                cfg["ai"] = ai
                cfg["updated"] = now_iso()
                _write_config(cfg)
            public = _public_ai(ai)
            return _json(200, {"ok": True, "ai": public, "configured": public["configured"],
                               "hasStoredKey": public["hasStoredKey"]})
        if path == "/__omm/fs/save":
            raw = str(payload.get("data") or "")
            if not raw:
                raise ValueError("缺少文件内容")
            data = base64.b64decode(raw, validate=True)
            result = save_file(
                payload_app,
                str(payload.get("name") or "export.bin"),
                data,
                mime=str(payload.get("mime") or ""),
                mode=str(payload.get("mode") or ""),
                state=payload.get("state") if isinstance(payload.get("state"), dict) else None,
                label=str(payload.get("label") or ""),
            )
            return _json(200, result)
        if path == "/__omm/fs/snapshot":
            state = payload.get("state")
            if not isinstance(state, dict):
                raise ValueError("快照内容无效")
            result = write_snapshot(
                payload_app, state, label=str(payload.get("label") or "")
            )
            return _json(200, result)
        if path == "/__omm/fs/snapshot/rename":
            return _json(
                200,
                rename_snapshot(
                    str(payload.get("path") or ""), str(payload.get("label") or "")
                ),
            )
        if path == "/__omm/fs/snapshot/delete":
            return _json(200, delete_snapshot(str(payload.get("path") or "")))
        if path == "/__omm/fs/pdf/tool":
            try:
                result = pdf_tool(payload)
            except ValueError as exc:
                return _error(400, str(exc))
            return _json(200, result)
        if path == "/__omm/fs/docx2pdf":
            raw = str(payload.get("data") or "")
            if not raw:
                raise ValueError("缺少 DOCX 内容")
            try:
                data = base64.b64decode(raw, validate=True)
            except Exception as exc:  # noqa: BLE001
                raise ValueError("DOCX 内容不是有效的 base64") from exc
            if len(data) > MAX_BODY:
                raise ValueError("DOCX 文件过大")
            result = convert_docx_to_pdf(
                data,
                str(payload.get("name") or "document.docx"),
                str(payload.get("engine") or ""),
            )
            if not result.get("ok"):
                return _json(400, result)
            return _json(
                200,
                {
                    "ok": True,
                    "engine": result.get("engine") or "",
                    "pdf": base64.b64encode(result["pdf"]).decode("ascii"),
                },
            )
        if path == "/__omm/fs/docx2pdf/config":
            soffice = str(payload.get("soffice") or "").strip()
            abiword = str(payload.get("abiword") or "").strip()
            gs = str(payload.get("gs") or "").strip()
            soffice = os.path.expandvars(soffice.strip('"')).strip()
            abiword = os.path.expandvars(abiword.strip('"')).strip()
            gs = os.path.expandvars(gs.strip('"')).strip()

            def _resolve_exe(label, value):
                # Strip a trailing path separator and surround-quotes that
                # File Explorer / copy-paste sometimes adds.
                value = value.strip().strip('"').rstrip("\\/").strip()
                p = Path(value).expanduser()
                if not p.exists():
                    return None, "%s 路径不存在：%s" % (label, value)
                if p.is_dir():
                    # A directory was pasted; try to find the binary inside it.
                    guesses = {
                        "LibreOffice": "soffice.exe",
                        "AbiWord": "abiword.exe",
                        "Ghostscript": "gswin64c.exe",
                    }.get(label)
                    if guesses:
                        cand = p / guesses
                        if cand.is_file():
                            return str(cand), ""
                    return None, "%s 路径是一个目录而非可执行文件：%s" % (label, value)
                if not p.is_file():
                    return None, "%s 路径无法访问：%s" % (label, value)
                return str(p), ""

            for label, value in (
                ("LibreOffice", soffice),
                ("AbiWord", abiword),
                ("Ghostscript", gs),
            ):
                if not value:
                    continue
                resolved, err = _resolve_exe(label, value)
                if err:
                    return _error(400, err)
                if label == "Ghostscript":
                    # Store the console build so later probes never hang on the
                    # windowed binary.
                    gs = _gs_console_path(resolved)
                elif label == "LibreOffice":
                    soffice = resolved
                else:
                    abiword = resolved
            mutate_config(
                lambda cfg: cfg.__setitem__(
                    "docx_pdf", {"soffice": soffice, "abiword": abiword, "gs": gs}
                )
            )
            return _json(200, docx_pdf_status())
        if path == "/__omm/fs/open":
            return _json(200, open_folder(payload_app))
        if path == "/__omm/fs/appearance":
            return _json(200, {"ok": True, "appearance": set_appearance(payload)})
        return _error(404, "unknown endpoint")
    except ValueError as exc:
        return _error(400, str(exc))
    except Exception as exc:  # noqa: BLE001
        return _error(500, str(exc))


def _all_app_ids(cfg: Dict[str, Any]) -> list[str]:
    return sorted(set(list(APP_NAMES) + list((cfg.get("apps") or {}).keys())))


def _move_registered_files(
    app: str,
    old_dir: Path,
    target: Path,
    cfg: Dict[str, Any],
    mapping: Dict[str, str],
) -> None:
    """Move only the files this app registered (used for shared/unsafe dirs)."""
    entry = (cfg.get("apps") or {}).get(app) or {}
    for item in (entry.get("resources") or {}).values():
        if not isinstance(item, dict):
            continue
        raw = str(item.get("path") or "").strip()
        if not raw:
            continue
        path = Path(raw)
        if not path.is_file() or not omm_fs.is_inside(path, old_dir):
            continue
        final = omm_fs.unique_target(target, path.name)
        shutil.move(str(path), str(final))
        mapping[str(path.resolve())] = str(final)


def migrate_save_paths(
    apps: list[str],
    target: Path,
    cfg: Dict[str, Any],
    whole_tree: bool = False,
) -> Dict[str, Any]:
    """Move save data to a new directory and report what happened.

    ``whole_tree`` is used when every product is being redirected (scope=all):
    the complete old folder is merged into the new one, including files that
    were never registered in ``shared.json``.  A per-product change moves only
    that product's registered files and its ``snapshots/<app>`` folder, so a
    directory shared with another product is never emptied under its feet.
    """
    target = omm_fs.resolve(target)
    old_dirs: list[Path] = []
    for app in apps:
        old = omm_fs.resolve(resolve_save_dir(app, cfg))
        if old != target and old not in old_dirs:
            old_dirs.append(old)
    for old in old_dirs:
        if old.is_dir() and omm_fs.is_inside(target, old):
            raise ValueError("新目录不能位于旧目录内部：%s" % old)
    target.mkdir(parents=True, exist_ok=True)

    mapping: Dict[str, str] = {}
    leftovers: list[str] = []
    deleted: list[str] = []
    try:
        for old in old_dirs:
            existed = old.is_dir()
            if not existed:
                continue
            users = [
                app
                for app in apps
                if omm_fs.resolve(resolve_save_dir(app, cfg)) == old
            ]
            all_users = [
                item
                for item in _all_app_ids(cfg)
                if omm_fs.resolve(resolve_save_dir(item, cfg)) == old
            ]
            shared = any(item not in apps for item in all_users)
            # If the folder is exclusive to the products being moved, take
            # everything (including unregistered files) and delete the folder.
            bulk = (whole_tree or not shared) and not omm_fs.unsafe_bulk_root(old)
            if bulk:
                omm_fs.merge_tree(old, target, mapping)
            else:
                for app in users:
                    _move_registered_files(app, old, target, cfg, mapping)
                    snap = old / SNAPSHOT_DIRNAME / app
                    if snap.is_dir():
                        omm_fs.merge_tree(snap, target / SNAPSHOT_DIRNAME / app, mapping)
            # Remove the source completely, including every empty folder.
            if not omm_fs.remove_empty_tree(old) and bulk:
                leftovers.append(str(old))
            elif existed and not old.is_dir():
                deleted.append(str(old))
    except Exception:
        omm_fs.rollback(mapping)
        raise

    updates: Dict[str, Any] = {}
    for app_id, entry in (cfg.get("apps") or {}).items():
        if not isinstance(entry, dict):
            continue
        # Keep the original records (including resources outside the migrated
        # folders and their kind/mime/size/title metadata); only rewrite the
        # path for entries whose location actually moved.
        resources: Dict[str, Any] = dict(entry.get("resources") or {})
        for key, item in list(resources.items()):
            if not isinstance(item, dict):
                continue
            raw = str(item.get("path") or "").strip()
            if not raw:
                continue
            old_key = str(Path(raw).resolve())
            if old_key in mapping:
                new_path = mapping[old_key]
                resources[key] = {
                    **item,
                    "path": new_path,
                    "file": Path(new_path).name,
                }
        patch: Dict[str, Any] = {}
        if resources:
            patch["resources"] = resources
        raw_last = str(entry.get("last_snapshot") or "").strip()
        if raw_last:
            old_key = str(Path(raw_last).resolve())
            if old_key in mapping:
                patch["last_snapshot"] = mapping[old_key]
        if patch:
            updates[app_id] = patch

    return {
        "moved": len(mapping),
        "old": deleted,
        "leftover": leftovers,
        "partial": any(item.is_dir() for item in old_dirs),
        "updates": updates,
    }


def migrate_share_path(old: Path, new: Path) -> Dict[str, Any]:
    """Move the entire share space (index, files, records, inbox, policy)."""
    old = omm_fs.resolve(old)
    new = omm_fs.resolve(new)
    if old == new or not old.is_dir():
        return {"moved": 0, "old": "", "new": str(new), "leftover": []}
    if omm_fs.is_inside(new, old):
        raise ValueError("新共享目录不能位于旧目录内部")
    mapping: Dict[str, str] = {}
    try:
        new.mkdir(parents=True, exist_ok=True)
        omm_fs.merge_tree(old, new, mapping)
    except Exception:
        omm_fs.rollback(mapping)
        raise
    leftover = [] if omm_fs.remove_empty_tree(old) else [str(old)]
    return {
        "moved": len(mapping),
        "old": str(old),
        "new": str(new),
        "leftover": leftover,
    }


def _update_config(app: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    scope = str(payload.get("scope") or "app").lower()
    path_raw = payload.get("path")
    share_raw = payload.get("share_path")
    mode = str(payload.get("mode") or "").strip().lower()
    auto = payload.get("auto_snapshot")
    share = payload.get("auto_share")
    cfg = load_config()
    target_path: Optional[Path] = None
    if path_raw is not None:
        text = str(path_raw).strip()
        target_path = Path(
            os.path.expandvars(os.path.expanduser(text or str(default_save_path())))
        )
        if target_path.exists() and not target_path.is_dir():
            raise ValueError("目标路径已存在而且是文件：%s" % target_path)
        # 与 share_path 分支保持一致：禁止把保存目录设为 C:\、用户主目录等
        # 大范围根目录，否则 _allowed_roots() 会把整棵目录加入 fs API 白名单。
        if omm_fs.unsafe_bulk_root(target_path):
            raise ValueError("请选择一个专用文件夹作为保存目录，不要使用系统或用户根目录")

    migration: Optional[Dict[str, Any]] = None
    if target_path is not None:
        affected = _all_app_ids(cfg) if scope == "all" else [app]
        olds = {omm_fs.resolve(resolve_save_dir(item, cfg)) for item in affected}
        if any(old != omm_fs.resolve(target_path) for old in olds):
            migration = migrate_save_paths(
                affected, target_path, cfg, whole_tree=(scope == "all")
            )

    share_target: Optional[Path] = None
    share_migration: Optional[Dict[str, Any]] = None
    if share_raw is not None:
        text = str(share_raw).strip()
        share_target = (
            Path(os.path.expandvars(os.path.expanduser(text)))
            if text
            else shared_root() / "share"
        )
        if share_target.exists() and not share_target.is_dir():
            raise ValueError("共享目录已存在而且是文件：%s" % share_target)
        if omm_fs.unsafe_bulk_root(share_target):
            raise ValueError("请选择一个专用文件夹作为共享目录，不要使用系统或用户根目录")
        save_dirs = {omm_fs.resolve(resolve_save_dir(item, cfg)) for item in _all_app_ids(cfg)}
        if target_path is not None:
            save_dirs.add(omm_fs.resolve(target_path))
        for save_dir in save_dirs:
            if omm_fs.is_nested(share_target, save_dir):
                raise ValueError("共享目录不能与保存目录重叠：%s" % save_dir)
        share_target.mkdir(parents=True, exist_ok=True)
        old_share = resolve_share_dir(cfg)
        if omm_fs.resolve(old_share) != omm_fs.resolve(share_target):
            share_migration = migrate_share_path(old_share, share_target)

    def update(cfg_in: Dict[str, Any]) -> None:
        if target_path is not None:
            if scope == "all":
                cfg_in.setdefault("save", {})["path"] = str(target_path)
                for item in (cfg_in.get("apps") or {}).values():
                    if isinstance(item, dict):
                        item["save_path"] = ""
            else:
                app_entry(cfg_in, app)["save_path"] = str(target_path)
        if mode in MODES:
            if scope == "all":
                cfg_in.setdefault("save", {})["mode"] = mode
                for item in (cfg_in.get("apps") or {}).values():
                    if isinstance(item, dict):
                        item["mode"] = ""
            else:
                app_entry(cfg_in, app)["mode"] = mode
        if auto is not None:
            if scope == "all":
                cfg_in.setdefault("save", {})["auto_snapshot"] = bool(auto)
                for item in (cfg_in.get("apps") or {}).values():
                    if isinstance(item, dict):
                        item["auto_snapshot"] = bool(auto)
            else:
                app_entry(cfg_in, app)["auto_snapshot"] = bool(auto)
        if share is not None:
            if scope == "all":
                cfg_in.setdefault("save", {})["auto_share"] = bool(share)
                for item in (cfg_in.get("apps") or {}).values():
                    if isinstance(item, dict):
                        item["auto_share"] = bool(share)
            else:
                app_entry(cfg_in, app)["auto_share"] = bool(share)
        if share_target is not None:
            cfg_in.setdefault("share", {})["path"] = (
                "" if omm_fs.resolve(share_target) == omm_fs.resolve(shared_root() / "share") else str(share_target)
            )
        if migration:
            for app_id, patch in (migration.get("updates") or {}).items():
                entry = app_entry(cfg_in, app_id)
                for key, value in (patch.get("resources") or {}).items():
                    if key in entry["resources"]:
                        entry["resources"][key].update(value)
                if patch.get("last_snapshot"):
                    entry["last_snapshot"] = patch["last_snapshot"]
            cfg_in["last_migration"] = {
                "at": now_iso(),
                "save": {
                    "moved": migration.get("moved", 0),
                    "old": migration.get("old", []),
                    "leftover": migration.get("leftover", []),
                },
            }
        app_entry(cfg_in, app)["updated"] = now_iso()

    cfg = mutate_config(update)
    result = {
        "ok": True,
        "app": app,
        "config": cfg,
        "save_path": str(resolve_save_dir(app, cfg)),
        "mode": resolve_mode(app, cfg),
        "auto_snapshot": resolve_auto_snapshot(app, cfg),
        "auto_share": resolve_auto_share(app, cfg),
        "share_path": str(resolve_share_dir(cfg)),
    }
    if migration:
        result["migrated_save"] = {
            "moved": migration.get("moved", 0),
            "old": migration.get("old", []),
            "leftover": migration.get("leftover", []),
            "partial": migration.get("partial", False),
        }
    if share_migration:
        result["migrated_share"] = share_migration
    return result
