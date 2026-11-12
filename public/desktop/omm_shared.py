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
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple
from urllib.parse import parse_qs, urlsplit

import omm_fs

try:
    from plugin_manager import app_data_base
except Exception:  # pragma: no cover - keeps the module importable by itself

    def app_data_base() -> Path:  # type: ignore[misc]
        return Path.home() / ".omm-zen"


API_VERSION = 1
MAX_BODY = 256 * 1024 * 1024
SNAPSHOT_SUFFIX = ".omm-snapshot.json"
SNAPSHOT_DIRNAME = "snapshots"
MODE_OVERWRITE = "overwrite"
MODE_VERSIONED = "versioned"
MODES = (MODE_OVERWRITE, MODE_VERSIONED)
DEFAULT_MODE = MODE_VERSIONED

APP_NAMES = {
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
    "hub": "OMM-ZEN 工作台",
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
        "ui": {"zoom": {}},
        "share": {"path": ""},
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
    cfg["ui"] = {"zoom": zoom, "appearance": _clean_appearance(appearance_raw)}
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
        data = json.loads(config_path().read_text(encoding="utf-8"))
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


def _allowed_roots(cfg: Optional[Dict[str, Any]] = None) -> list[Path]:
    cfg = cfg or load_config()
    roots: list[Path] = [shared_root() / "updates"]
    roots.append(Path(str((cfg.get("save") or {}).get("path") or default_save_path())))
    for app, entry in (cfg.get("apps") or {}).items():
        raw = str((entry or {}).get("save_path") or "").strip()
        if raw:
            roots.append(Path(os.path.expandvars(os.path.expanduser(raw))))
        for item in ((entry or {}).get("resources") or {}).values():
            if isinstance(item, dict) and str(item.get("path") or "").strip():
                roots.append(Path(str(item["path"])).parent)
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
    payload.setdefault("app", app)
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
    return json.loads(path.read_text(encoding="utf-8"))


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
        payload = json.loads(path.read_text(encoding="utf-8"))
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
        "config": cfg,
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
    if not _inside_any(path, _allowed_roots()):
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


# --------------------------------------------------------------------- routes


def _json(status: int, payload: Dict[str, Any]) -> Tuple[int, str, bytes]:
    return status, "application/json; charset=utf-8", json.dumps(
        payload, ensure_ascii=False
    ).encode("utf-8")


def _error(status: int, message: str) -> Tuple[int, str, bytes]:
    return _json(status, {"ok": False, "error": message})


def _client_app(default_app: str, query: Dict[str, list[str]]) -> str:
    raw = (query.get("app") or [""])[0]
    return clean_app_id(raw or default_app or "app")


def handle_get(
    path: str, query: Dict[str, list[str]], default_app: str = "app"
) -> Tuple[int, str, bytes]:
    if not desktop_enabled():
        return _error(404, "desktop API is not enabled")
    app = _client_app(default_app, query)
    if path == "/__omm/fs/status":
        cfg = load_config()
        return _json(
            200,
            {
                "ok": True,
                "desktop": True,
                "api": API_VERSION,
                "app": app,
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
                "config": cfg,
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
) -> Tuple[int, str, bytes]:
    if not desktop_enabled():
        return _error(404, "desktop API is not enabled")
    app = _client_app(default_app, query)
    try:
        if len(body) > MAX_BODY:
            return _error(413, "请求体过大")
        payload = json.loads(body.decode("utf-8")) if body else {}
        if not isinstance(payload, dict):
            raise ValueError("请求格式无效")
        payload_app = clean_app_id(payload.get("app") or app)
        if path == "/__omm/fs/config":
            return _json(200, _update_config(payload_app, payload))
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
        resources: Dict[str, Any] = {}
        for key, item in (entry.get("resources") or {}).items():
            if not isinstance(item, dict):
                continue
            raw = str(item.get("path") or "").strip()
            if not raw:
                continue
            old_key = str(Path(raw).resolve())
            if old_key in mapping:
                new_path = mapping[old_key]
                resources[key] = {
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
