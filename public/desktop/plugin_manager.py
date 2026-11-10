# -*- coding: utf-8 -*-
"""Plugin packaging, validation and installation for OMM-ZEN.

A plugin is a directory with a plugin.json manifest, one HTML entry page and
its offline assets. Imported plugins are page-only (runtime == "static"); the
official built-in plugins may additionally use the framework's mdforge/latex
backends.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional

CATALOG_URL = (
    "https://gitee.com/Xingye-Dujing/my-blog/releases/download/v1.0.1/catalog.json"
)
MIRROR_PREFIX = "https://ghproxy.net/"
PLUGIN_API = 1
MAX_ZIP_BYTES = 220 * 1024 * 1024
MAX_UNPACKED_BYTES = 600 * 1024 * 1024
MAX_FILES = 6000
ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,40}$")
RUNTIMES = ("static", "mdforge", "latex")


class PluginError(RuntimeError):
    pass


def app_data_base() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


def default_plugin_root() -> Path:
    override = os.environ.get("OMM_PLUGIN_DIR")
    path = Path(override) if override else app_data_base() / "OMM-ZEN" / "plugins"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _clean_name(value: Any, field: str, maximum: int) -> str:
    text = str(value or "").strip()
    if not text:
        raise PluginError("插件清单缺少 %s" % field)
    if len(text) > maximum:
        raise PluginError("%s 过长" % field)
    return text


def validate_manifest(
    data: Dict[str, Any], plugin_dir: Optional[Path] = None, imported: bool = False
) -> Dict[str, Any]:
    if not isinstance(data, dict):
        raise PluginError("plugin.json 必须是对象")
    if data.get("schema") not in (None, PLUGIN_API):
        raise PluginError("不支持的插件规范版本：%s" % data.get("schema"))
    plugin_id = _clean_name(data.get("id"), "id", 41).lower()
    if not ID_RE.match(plugin_id):
        raise PluginError("id 只能使用小写字母、数字和连字符，且以字母开头")
    name = _clean_name(data.get("name"), "name", 80)
    glyph = str(data.get("glyph") or name[:1]).strip()[:4]
    if not glyph:
        glyph = "?"
    entry = str(data.get("entry") or "index.html").strip().replace("\\", "/")
    if (
        not entry
        or entry.startswith("/")
        or re.match(r"^[A-Za-z]:", entry)
        or ".." in Path(entry).parts
        or not entry.lower().endswith((".html", ".htm"))
    ):
        raise PluginError("entry 必须是插件目录内的 HTML 相对路径")
    runtime = str(data.get("runtime") or "static").strip().lower()
    if runtime not in RUNTIMES:
        raise PluginError("未知的 runtime：%s" % runtime)
    if imported and runtime != "static":
        raise PluginError("导入的自定义插件只能使用 static 运行时")
    try:
        port = int(data.get("port") or 0)
    except Exception as exc:
        raise PluginError("port 必须是整数") from exc
    if port and not (1024 <= port <= 65535):
        raise PluginError("port 必须在 1024–65535 之间")
    try:
        order = int(data.get("order") or 999)
    except Exception:
        order = 999
    manifest = {
        "schema": PLUGIN_API,
        "id": plugin_id,
        "name": name,
        "version": str(data.get("version") or "1.0.0")[:40],
        "description": str(data.get("description") or "")[:240],
        "glyph": glyph,
        "entry": entry,
        "runtime": runtime,
        "port": port,
        "order": order,
        "author": str(data.get("author") or "")[:80],
        "homepage": str(data.get("homepage") or "")[:300],
    }
    if plugin_dir is not None:
        target = (plugin_dir / entry).resolve()
        if plugin_dir.resolve() not in target.parents or not target.is_file():
            raise PluginError("找不到入口页面：%s" % entry)
    return manifest


def load_plugin_dir(plugin_dir: Path, source: str) -> Optional[Dict[str, Any]]:
    manifest_path = plugin_dir / "plugin.json"
    if not manifest_path.is_file():
        return None
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest = validate_manifest(raw, plugin_dir=plugin_dir, imported=False)
    except Exception:
        return None
    manifest["source"] = source
    manifest["path"] = str(plugin_dir)
    return manifest


def _zip_entries(zf: zipfile.ZipFile) -> List[zipfile.ZipInfo]:
    infos = zf.infolist()
    if len(infos) > MAX_FILES:
        raise PluginError("插件包文件数量过多")
    total = 0
    for info in infos:
        name = info.filename.replace("\\", "/")
        if "\x00" in name:
            raise PluginError("插件包包含非法文件名")
        if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
            raise PluginError("插件包包含绝对路径")
        parts = [part for part in name.split("/") if part not in ("", ".")]
        if any(part == ".." for part in parts):
            raise PluginError("插件包包含上级路径")
        mode = (info.external_attr >> 16) & 0o170000
        if mode == 0o120000:
            raise PluginError("插件包不能包含符号链接")
        total += max(0, info.file_size)
    if total > MAX_UNPACKED_BYTES:
        raise PluginError("插件解压后体积过大")
    return infos


def _extract(zip_bytes: bytes, target: Path) -> Path:
    if len(zip_bytes) > MAX_ZIP_BYTES:
        raise PluginError("插件包过大")
    target.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            _zip_entries(zf)
            for info in zf.infolist():
                name = info.filename.replace("\\", "/")
                if not name or name.endswith("/"):
                    continue
                dest = (target / name).resolve()
                if target.resolve() not in dest.parents:
                    raise PluginError("插件包路径越界")
                dest.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
    except zipfile.BadZipFile as exc:
        raise PluginError("不是有效的 zip 插件包") from exc
    return target


def _manifest_dir(extracted: Path) -> Path:
    if (extracted / "plugin.json").is_file():
        return extracted
    children = [p for p in extracted.iterdir() if p.is_dir()]
    if len(children) == 1 and (children[0] / "plugin.json").is_file():
        return children[0]
    raise PluginError("插件包根目录缺少 plugin.json")


class PluginRegistry:
    """Installed plugins from the user folder, overlaid on bundled plugins."""

    def __init__(self, user_root: Optional[Path] = None, bundled_root: Optional[Path] = None):
        self.user_root = Path(user_root) if user_root else default_plugin_root()
        self.bundled_root = Path(bundled_root) if bundled_root else None
        self.user_root.mkdir(parents=True, exist_ok=True)
        self._plugins: Dict[str, Dict[str, Any]] = {}
        self.reload()

    def reload(self) -> None:
        found: Dict[str, Dict[str, Any]] = {}
        if self.bundled_root and self.bundled_root.is_dir():
            for child in sorted(self.bundled_root.iterdir()):
                if not child.is_dir() or child.name.startswith("."):
                    continue
                plugin = load_plugin_dir(child, "bundled")
                if plugin:
                    found[plugin["id"]] = plugin
        for child in sorted(self.user_root.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            plugin = load_plugin_dir(child, "user")
            if plugin:
                found[plugin["id"]] = plugin
        self._plugins = found

    def list(self) -> List[Dict[str, Any]]:
        items = list(self._plugins.values())
        items.sort(key=lambda item: (int(item.get("order", 999)), item["name"]))
        return items

    def get(self, plugin_id: str) -> Optional[Dict[str, Any]]:
        return self._plugins.get(plugin_id)

    def install_zip(self, zip_bytes: bytes, imported: bool = False) -> Dict[str, Any]:
        temp_root = Path(tempfile.mkdtemp(prefix=".install-", dir=str(self.user_root)))
        try:
            extracted = _extract(zip_bytes, temp_root / "unpack")
            source_dir = _manifest_dir(extracted)
            raw = json.loads((source_dir / "plugin.json").read_text(encoding="utf-8"))
            manifest = validate_manifest(raw, plugin_dir=source_dir, imported=imported)
            target = self.user_root / manifest["id"]
            staging = self.user_root / (".staging-" + manifest["id"])
            if staging.exists():
                shutil.rmtree(staging)
            shutil.copytree(source_dir, staging)
            # Re-validate from the final location before replacing anything.
            validate_manifest(raw, plugin_dir=staging, imported=imported)
            if target.exists():
                backup = self.user_root / (".old-" + manifest["id"])
                if backup.exists():
                    shutil.rmtree(backup)
                os.replace(target, backup)
                try:
                    os.replace(staging, target)
                except Exception:
                    os.replace(backup, target)
                    raise
                shutil.rmtree(backup, ignore_errors=True)
            else:
                os.replace(staging, target)
            self.reload()
            plugin = self.get(manifest["id"])
            if not plugin:
                raise PluginError("插件安装后无法读取")
            return plugin
        finally:
            shutil.rmtree(temp_root, ignore_errors=True)

    def remove(self, plugin_id: str) -> bool:
        target = self.user_root / plugin_id
        bundled = self.bundled_root / plugin_id if self.bundled_root else None
        if not target.is_dir():
            raise PluginError("该插件不是用户安装的，无法卸载")
        # Ensure the id in the manifest matches before deleting anything.
        plugin = load_plugin_dir(target, "user")
        if not plugin or plugin["id"] != plugin_id:
            raise PluginError("插件目录校验失败")
        shutil.rmtree(target)
        self.reload()
        return bundled is not None and bundled.is_dir()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_url(url: str, timeout: float = 30.0) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme in ("", "file"):
        path = (
            Path(url)
            if not parsed.scheme
            else Path(urllib.request.url2pathname(parsed.path))
        )
        return path.read_bytes()
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "OMM-ZEN/1.0", "Accept": "*/*"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if getattr(response, "status", 200) != 200:
            raise PluginError("下载失败（HTTP %s）" % response.status)
        return response.read()


def _retry_network(fn: Callable[[], bytes], attempts: int = 3) -> bytes:
    last = None
    for index in range(attempts):
        try:
            return fn()
        except urllib.error.HTTPError as exc:
            last = exc
            if 400 <= exc.code < 500:
                break
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as exc:
            last = exc
        if index + 1 < attempts:
            time.sleep(1.5 * (index + 1))
    raise PluginError("网络请求失败：%s" % last)


def mirror_urls(url: str) -> List[str]:
    """下载源优先 Gitee Release，国内直连更快，无需翻墙。

    Gitee 资产直接返回；GitHub 资产保留 ghproxy 作为回退；本地文件和
    自定义主机不做变更。
    """
    if url.startswith("https://gitee.com/"):
        return [url]
    if url.startswith("https://github.com/"):
        return [url, MIRROR_PREFIX + url]
    return [url]


def fetch_json(url: str, timeout: float = 30.0) -> Dict[str, Any]:
    data = None
    last = None
    for candidate in mirror_urls(url):
        try:
            if urllib.parse.urlparse(candidate).scheme in ("", "file"):
                data = _read_url(candidate, timeout=timeout)
            else:
                data = _retry_network(
                    lambda candidate=candidate: _read_url(candidate, timeout=timeout),
                    attempts=2,
                )
            break
        except Exception as exc:
            last = exc
    if data is None:
        raise PluginError("插件目录下载失败：%s" % last)
    try:
        return json.loads(data.decode("utf-8"))
    except Exception as exc:
        raise PluginError("插件目录格式无效") from exc


def fetch_catalog(url: str = CATALOG_URL) -> Dict[str, Any]:
    catalog = fetch_json(url)
    if not isinstance(catalog, dict) or not isinstance(catalog.get("plugins"), list):
        raise PluginError("插件目录缺少 plugins 列表")
    if not isinstance(catalog.get("frameworks"), dict):
        raise PluginError("插件目录缺少 frameworks")
    return catalog


def download_bytes(
    url: str | List[str],
    expected_sha256: str = "",
    progress: Optional[Callable[[int, int], None]] = None,
    timeout: float = 60.0,
) -> bytes:
    def once(candidate: str) -> bytes:
        parsed = urllib.parse.urlparse(candidate)
        if parsed.scheme in ("", "file"):
            data = _read_url(candidate, timeout=timeout)
            if progress:
                progress(len(data), len(data))
            return data
        request = urllib.request.Request(
            candidate, headers={"User-Agent": "OMM-ZEN/1.0"}
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                raise PluginError("下载失败（HTTP %s）" % response.status)
            total = int(response.headers.get("Content-Length") or 0)
            chunks = []
            received = 0
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
                received += len(chunk)
                if received > MAX_ZIP_BYTES:
                    raise PluginError("下载文件过大")
                if progress:
                    progress(received, total)
            return b"".join(chunks)

    candidates = url if isinstance(url, list) else mirror_urls(url)
    data = None
    last = None
    for candidate in candidates:
        try:
            if urllib.parse.urlparse(candidate).scheme in ("", "file"):
                data = once(candidate)
            else:
                data = _retry_network(lambda candidate=candidate: once(candidate), attempts=2)
            break
        except Exception as exc:
            last = exc
    if data is None:
        raise PluginError("下载失败：%s" % last)
    if expected_sha256 and sha256_bytes(data).lower() != expected_sha256.lower():
        raise PluginError("文件校验失败（SHA-256 不匹配）")
    return data


def download_file(
    url: str,
    target: Path,
    expected_sha256: str = "",
    progress: Optional[Callable[[int, int], None]] = None,
) -> Path:
    data = download_bytes(url, expected_sha256=expected_sha256, progress=progress)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, target)
    return target


def framework_platform() -> str:
    if sys.platform == "darwin":
        machine = (os.uname().machine if hasattr(os, "uname") else "").lower()
        return "macos-arm64" if machine in ("arm64", "aarch64") else "macos-x86_64"
    return "win64"


def catalog_plugin(catalog: Dict[str, Any], plugin_id: str) -> Dict[str, Any]:
    for item in catalog.get("plugins", []):
        if item.get("id") == plugin_id:
            return item
    raise PluginError("在线目录中没有插件 %s" % plugin_id)


def bundle_url(catalog: Dict[str, Any], item: Dict[str, Any]) -> str:
    if item.get("url"):
        return item["url"]
    base = catalog.get("base_url") or ""
    bundle = item.get("bundle") or ""
    if not base or not bundle:
        raise PluginError("插件目录缺少下载地址")
    return base.rstrip("/") + "/" + bundle.lstrip("/")


def install_from_catalog(
    registry: PluginRegistry,
    catalog: Dict[str, Any],
    plugin_id: str,
    progress: Optional[Callable[[int, int], None]] = None,
) -> Dict[str, Any]:
    item = catalog_plugin(catalog, plugin_id)
    url = bundle_url(catalog, item)
    data = download_bytes(url, expected_sha256=item.get("sha256", ""), progress=progress)
    return registry.install_zip(data, imported=False)
