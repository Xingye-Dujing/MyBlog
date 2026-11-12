# -*- coding: utf-8 -*-
"""Cross-product share space.

Products are plugins that run on separate loopback origins, so they cannot use
localStorage or BroadcastChannel to talk to each other.  This module is the
small broker they share instead:

``channel``
    A typed space (``data.tables``, ``notes.english``, ``documents``).  The
    policy records which product may publish into a channel and which product
    may consume from it.  Capabilities are declared by each plugin's manifest
    and merged into ``share/policy.json`` by the hub, where the user can also
    revoke a pair.

``artifact``
    A file or a JSON record published into a channel.  Files are copied into
    ``share/files`` so the artifact survives the original save being rotated;
    records are stored in ``share/records``.

``message``
    A transient delivery to one product's inbox.  Used for the OMM Bridge note
    packages (english ↔ corpus ↔ annotate) and for "open this dataset in the
    chart editor".  Messages are removed when the receiver takes them.

Every loopback server exposes the same API under ``/__omm/share``::

    GET  /__omm/share/space?app=data         channels, policy and artifacts
    GET  /__omm/share/items?app=data         artifact list
    GET  /__omm/share/item?id=...            one artifact (records include payload)
    GET  /__omm/share/file?id=...            artifact bytes
    GET  /__omm/share/inbox?app=corpus       take pending messages
    POST /__omm/share/publish                publish a file or a record
    POST /__omm/share/send                   deliver to one product
    POST /__omm/share/delete                 remove an artifact
    POST /__omm/share/policy                 allow/deny a product on a channel

The storage lives next to ``shared.json`` in the user data folder, so a product
opened on its own (without the hub) uses exactly the same space.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from omm_shared import (
    FileLock,
    _allowed_roots,
    _inside_any,
    app_name,
    clean_app_id,
    desktop_enabled,
    now_iso,
    resolve_share_dir,
    shared_root,
)

SCHEMA = 1
INDEX_LIMIT = 600
MAX_PUBLISH_BYTES = 64 * 1024 * 1024
MAX_MESSAGE_BYTES = 16 * 1024 * 1024
# A 64 MB upload arrives base64 encoded in a JSON body (~85 MB), so the HTTP
# limit is deliberately larger than the artifact limit.
MAX_BODY_BYTES = 96 * 1024 * 1024

ROLE_PUBLISH = "publish"
ROLE_CONSUME = "consume"
ROLE_BOTH = "both"

# Built-in channels.  A manifest may define more; the hub merges the manifest
# capabilities into the policy, and the user can revoke any pair afterwards.
CHANNEL_DEFS: Dict[str, Dict[str, Any]] = {
    "data.tables": {
        "name": "数据表",
        "description": "表格与结构化数据：CSV、TSV、XLSX、JSON",
        "types": [
            "text/csv",
            "text/tab-separated-values",
            "application/json",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ],
    },
    "notes.english": {
        "name": "英语笔记",
        "description": "单词、句子、文章与标注笔记（OMM Bridge 包）",
        "types": [
            "application/x-omm-bridge+json",
            "text/markdown",
            "application/json",
        ],
    },
    "documents": {
        "name": "文档",
        "description": "Markdown、TeX、PDF、DOCX、图片等写作产物",
        "types": [
            "text/markdown",
            "text/x-tex",
            "text/plain",
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/zip",
            "image/png",
            "image/jpeg",
            "image/svg+xml",
        ],
    },
}

# First run defaults, so a product opened without the hub still has a working
# policy.  The hub refines this from the installed manifests.
DEFAULT_MEMBERS: Dict[str, Dict[str, str]] = {
    "data.tables": {"data": ROLE_BOTH, "visualization": ROLE_CONSUME},
    "notes.english": {
        "english": ROLE_BOTH,
        "corpus": ROLE_BOTH,
        "annotate": ROLE_BOTH,
    },
    "documents": {
        "writer": ROLE_BOTH,
        "mdforge": ROLE_BOTH,
        "latex": ROLE_BOTH,
        "message": ROLE_BOTH,
        "redact": ROLE_BOTH,
        "annotate": ROLE_BOTH,
    },
}


# --------------------------------------------------------------------- paths


def share_root() -> Path:
    path = resolve_share_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path


def policy_path() -> Path:
    return share_root() / "policy.json"


def index_path() -> Path:
    return share_root() / "index.json"


def files_dir() -> Path:
    path = share_root() / "files"
    path.mkdir(parents=True, exist_ok=True)
    return path


def records_dir() -> Path:
    path = share_root() / "records"
    path.mkdir(parents=True, exist_ok=True)
    return path


def inbox_dir(app: str) -> Path:
    path = share_root() / "inbox" / clean_app_id(app)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _lock_path() -> Path:
    return share_root() / ".share.lock"


# ------------------------------------------------------------------- helpers


def _stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def _new_id(prefix: str) -> str:
    return "%s-%s-%s" % (prefix, _stamp(), uuid.uuid4().hex[:6])


def _clean_text(value: Any, limit: int = 160) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or "")).strip()
    return text[:limit]


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex[:8])
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def _json_response(status: int, payload: Dict[str, Any]) -> Tuple[int, str, bytes]:
    return status, "application/json; charset=utf-8", json.dumps(
        payload, ensure_ascii=False
    ).encode("utf-8")


def _error(status: int, message: str) -> Tuple[int, str, bytes]:
    return _json_response(status, {"ok": False, "error": message})


def _mime_for(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def _type_match(types: Iterable[str], mime: str) -> bool:
    mime = (mime or "").lower()
    for item in types or []:
        text = str(item or "").strip().lower()
        if not text:
            continue
        if text == mime or text == "*/*":
            return True
        if text.endswith("/*") and mime.startswith(text[:-1]):
            return True
    return False


def _role_flags(role: str) -> Tuple[bool, bool]:
    role = str(role or ROLE_BOTH).lower()
    if role == ROLE_PUBLISH:
        return True, False
    if role == ROLE_CONSUME:
        return False, True
    return True, True


# -------------------------------------------------------------------- policy


def default_policy() -> Dict[str, Any]:
    channels: Dict[str, Any] = {}
    for channel_id, definition in CHANNEL_DEFS.items():
        members = {}
        for app, role in DEFAULT_MEMBERS.get(channel_id, {}).items():
            publish, consume = _role_flags(role)
            members[app] = {
                "name": app_name(app),
                "publish": publish,
                "consume": consume,
            }
        channels[channel_id] = {
            "name": definition["name"],
            "description": definition["description"],
            "types": list(definition["types"]),
            "apps": members,
        }
    return {"schema": SCHEMA, "updated": now_iso(), "channels": channels}


def _normalize_policy(raw: Any) -> Dict[str, Any]:
    policy = default_policy()
    if not isinstance(raw, dict):
        return policy
    channels = raw.get("channels")
    if not isinstance(channels, dict):
        return policy
    clean: Dict[str, Any] = {}
    for channel_id, entry in channels.items():
        if not isinstance(entry, dict):
            continue
        key = re.sub(r"[^a-z0-9_.-]+", "", str(channel_id).lower())[:48]
        if not key:
            continue
        types = [str(t).strip() for t in (entry.get("types") or []) if str(t).strip()]
        apps: Dict[str, Any] = {}
        for app, caps in (entry.get("apps") or {}).items():
            if not isinstance(caps, dict):
                continue
            app_id = clean_app_id(app)
            apps[app_id] = {
                "name": _clean_text(caps.get("name") or app_name(app_id), 60),
                "publish": bool(caps.get("publish", True)),
                "consume": bool(caps.get("consume", True)),
                "source": "manifest" if caps.get("source") == "manifest" else "user",
            }
        clean[key] = {
            "name": _clean_text(entry.get("name") or key, 60),
            "description": _clean_text(entry.get("description") or "", 200),
            "types": types or ["*/*"],
            "apps": apps,
        }
    if clean:
        policy["channels"] = clean
    policy["updated"] = str(raw.get("updated") or now_iso())
    return policy


def load_policy() -> Dict[str, Any]:
    return _normalize_policy(_read_json(policy_path(), {}))


def save_policy(policy: Dict[str, Any]) -> Dict[str, Any]:
    policy["schema"] = SCHEMA
    policy["updated"] = now_iso()
    with FileLock(_lock_path()):
        _atomic_json(policy_path(), policy)
    return policy


def sync_policy(plugins: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Merge plugin capabilities into the policy.

    A manifest only *offers* a capability.  Once a channel/app pair exists the
    user's on/off choice is kept, so syncing after an update never silently
    re-enables a channel somebody switched off.
    """
    policy = load_policy()
    changed = False
    for plugin in plugins or []:
        if not isinstance(plugin, dict):
            continue
        app = clean_app_id(plugin.get("id") or "")
        if not app:
            continue
        share = plugin.get("share") if isinstance(plugin.get("share"), dict) else {}
        for entry in share.get("channels") or []:
            if not isinstance(entry, dict):
                continue
            channel_id = re.sub(
                r"[^a-z0-9_.-]+", "", str(entry.get("id") or "").lower()
            )[:48]
            if not channel_id:
                continue
            definition = CHANNEL_DEFS.get(channel_id, {})
            channel = policy["channels"].get(channel_id)
            if channel is None:
                channel = {
                    "name": _clean_text(
                        entry.get("name") or definition.get("name") or channel_id, 60
                    ),
                    "description": _clean_text(
                        entry.get("description") or definition.get("description") or "", 200
                    ),
                    "types": list(definition.get("types") or ["*/*"]),
                    "apps": {},
                }
                policy["channels"][channel_id] = channel
                changed = True
            types = entry.get("types")
            if isinstance(types, list) and types:
                for item in types:
                    if item not in channel["types"]:
                        channel["types"].append(str(item))
                        changed = True
            if entry.get("name") and channel.get("name") in ("", channel_id):
                channel["name"] = _clean_text(entry["name"], 60)
                changed = True
            if app not in channel["apps"]:
                publish, consume = _role_flags(entry.get("role"))
                channel["apps"][app] = {
                    "name": _clean_text(plugin.get("name") or app_name(app), 60),
                    "publish": publish,
                    "consume": consume,
                    "source": "manifest",
                }
                changed = True
            else:
                caps = channel["apps"][app]
                if caps.get("name") != _clean_text(plugin.get("name") or caps.get("name"), 60):
                    caps["name"] = _clean_text(plugin.get("name") or caps.get("name"), 60)
                    changed = True
    if changed:
        save_policy(policy)
    return policy


def update_policy(payload: Dict[str, Any]) -> Dict[str, Any]:
    channel_id = str(payload.get("channel") or "")
    app = clean_app_id(payload.get("app") or "")
    if not channel_id or not app:
        raise ValueError("缺少频道或应用")
    policy = load_policy()
    channel = policy["channels"].get(channel_id)
    if not channel:
        raise ValueError("未知频道：%s" % channel_id)
    caps = channel["apps"].get(app) or {
        "name": app_name(app),
        "publish": False,
        "consume": False,
        "source": "user",
    }
    if "publish" in payload:
        caps["publish"] = bool(payload["publish"])
    if "consume" in payload:
        caps["consume"] = bool(payload["consume"])
    caps["source"] = "user"
    channel["apps"][app] = caps
    save_policy(policy)
    return policy


def channel_allows(
    policy: Dict[str, Any], channel_id: str, app: str, action: str
) -> bool:
    if app == "hub":
        return True
    channel = (policy.get("channels") or {}).get(channel_id)
    if not channel:
        return False
    caps = (channel.get("apps") or {}).get(app)
    if not caps:
        return False
    return bool(caps.get("publish") if action == "publish" else caps.get("consume"))


def visible_channels(policy: Dict[str, Any], app: str) -> List[str]:
    if app == "hub":
        return list((policy.get("channels") or {}).keys())
    result = []
    for channel_id, channel in (policy.get("channels") or {}).items():
        caps = (channel.get("apps") or {}).get(app)
        if caps and (caps.get("publish") or caps.get("consume")):
            result.append(channel_id)
    return result


def pick_channel(policy: Dict[str, Any], app: str, mime: str, requested: str = "") -> str:
    if requested and requested != "auto":
        if not channel_allows(policy, requested, app, "publish"):
            raise ValueError("「%s」不允许写入频道 %s" % (app, requested))
        channel = policy["channels"][requested]
        if not _type_match(channel.get("types"), mime):
            raise ValueError("频道 %s 不接受类型 %s" % (requested, mime))
        return requested

    # Prefer the channel that matches the product's own purpose.
    hints = {
        "data": ["data.tables"],
        "visualization": ["data.tables"],
        "english": ["notes.english"],
        "corpus": ["notes.english"],
        "annotate": ["notes.english"],
        "writer": ["documents"],
        "mdforge": ["documents"],
        "latex": ["documents"],
        "message": ["documents"],
        "redact": ["documents"],
    }
    ordered = list(hints.get(app) or []) + list(policy["channels"].keys())
    seen = set()
    for channel_id in ordered:
        if channel_id in seen:
            continue
        seen.add(channel_id)
        if not channel_allows(policy, channel_id, app, "publish"):
            continue
        if _type_match(policy["channels"][channel_id].get("types"), mime):
            return channel_id
    raise ValueError("没有频道接受类型 %s" % mime)


# ---------------------------------------------------------------- index/items


def load_index() -> Dict[str, Any]:
    raw = _read_json(index_path(), {})
    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        items = []
    return {"schema": SCHEMA, "updated": str(raw.get("updated") or ""), "items": items}


def _save_index(index: Dict[str, Any]) -> None:
    index["schema"] = SCHEMA
    index["updated"] = now_iso()
    _atomic_json(index_path(), index)


def _remove_payload(entry: Dict[str, Any]) -> None:
    for key in ("file", "record"):
        raw = str(entry.get(key) or "")
        if not raw:
            continue
        path = (share_root() / raw).resolve()
        try:
            if path.is_file() and _inside_any(path, [share_root()]):
                path.unlink()
        except OSError:
            pass


def _public_item(entry: Dict[str, Any]) -> Dict[str, Any]:
    item = {
        "id": entry.get("id"),
        "kind": entry.get("kind"),
        "type": entry.get("type"),
        "channel": entry.get("channel"),
        "title": entry.get("title"),
        "source_app": entry.get("source_app"),
        "source_name": entry.get("source_name"),
        "created_at": entry.get("created_at"),
        "size": entry.get("size") or 0,
        "tags": entry.get("tags") or [],
        "format": entry.get("format") or "",
        "meta": entry.get("meta") or {},
    }
    if entry.get("kind") == "file":
        item["url"] = "/__omm/share/file?id=" + str(entry.get("id"))
    return item


def _item_visible(policy: Dict[str, Any], entry: Dict[str, Any], app: str) -> bool:
    if app == "hub":
        return True
    if entry.get("source_app") == app:
        return True
    return channel_allows(policy, str(entry.get("channel") or ""), app, "consume")


def _find(index: Dict[str, Any], item_id: str) -> Optional[Dict[str, Any]]:
    for entry in index.get("items") or []:
        if entry.get("id") == item_id:
            return entry
    return None


def list_items(app: str, channel: str = "") -> List[Dict[str, Any]]:
    policy = load_policy()
    index = load_index()
    visible = set(visible_channels(policy, app))
    result = []
    for entry in index.get("items") or []:
        if channel and entry.get("channel") != channel:
            continue
        if entry.get("channel") not in visible:
            continue
        if not _item_visible(policy, entry, app):
            continue
        if not channel and app != "hub" and entry.get("channel") not in visible:
            continue
        result.append(_public_item(entry))
    return result


def get_item(app: str, item_id: str) -> Dict[str, Any]:
    policy = load_policy()
    index = load_index()
    entry = _find(index, item_id)
    if not entry:
        raise ValueError("共享项目不存在")
    if not _item_visible(policy, entry, app):
        raise ValueError("没有权限读取这个共享项目")
    item = _public_item(entry)
    if entry.get("kind") == "record":
        raw = _read_json(share_root() / str(entry.get("record") or ""), {})
        item["payload"] = raw.get("payload")
        item["format"] = raw.get("format") or item.get("format") or "application/json"
    return item


def item_file(app: str, item_id: str) -> Tuple[bytes, str]:
    policy = load_policy()
    index = load_index()
    entry = _find(index, item_id)
    if not entry or entry.get("kind") != "file":
        raise ValueError("共享文件不存在")
    if not _item_visible(policy, entry, app):
        raise ValueError("没有权限读取这个共享文件")
    path = (share_root() / str(entry.get("file") or "")).resolve()
    if not _inside_any(path, [share_root()]) or not path.is_file():
        raise ValueError("共享文件已被移除")
    return path.read_bytes(), str(entry.get("type") or "application/octet-stream")


def delete_item(app: str, item_id: str) -> Dict[str, Any]:
    policy = load_policy()
    index = load_index()
    entry = _find(index, item_id)
    if not entry:
        raise ValueError("共享项目不存在")
    if app != "hub" and entry.get("source_app") != app:
        raise ValueError("只能删除自己发布的共享项目")
    _remove_payload(entry)
    index["items"] = [item for item in index.get("items") or [] if item.get("id") != item_id]
    _save_index(index)
    return {"ok": True, "id": item_id}


# -------------------------------------------------------------------- publish


def _clean_tags(value: Any) -> List[str]:
    if isinstance(value, str):
        parts = re.split(r"[,，;；\s]+", value)
    elif isinstance(value, list):
        parts = value
    else:
        parts = []
    tags = []
    for item in parts:
        text = _clean_text(item, 24)
        if text and text not in tags:
            tags.append(text)
    return tags[:8]


def publish(app: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    app = clean_app_id(app)
    policy = load_policy()
    source_path = str(payload.get("source_path") or "").strip()
    record = payload.get("record") if isinstance(payload.get("record"), dict) else None
    data_b64 = str(payload.get("data") or "")
    title = _clean_text(payload.get("title") or payload.get("name") or "", 160)

    raw_name = str(payload.get("name") or title or "shared.bin")
    mime = str(payload.get("type") or "").strip() or _mime_for(raw_name)
    if record is not None:
        mime = str(payload.get("type") or "application/json").strip()
    channel_id = pick_channel(policy, app, mime, str(payload.get("channel") or "auto"))

    entry: Dict[str, Any] = {
        "id": _new_id("sh"),
        "kind": "record" if record is not None else "file",
        "type": mime,
        "channel": channel_id,
        "title": title or raw_name,
        "source_app": app,
        "source_name": app_name(app),
        "created_at": now_iso(),
        "size": 0,
        "tags": _clean_tags(payload.get("tags")),
        "format": _clean_text(payload.get("format") or "", 60),
        "meta": payload.get("meta") if isinstance(payload.get("meta"), dict) else {},
        "replace_key": _clean_text(payload.get("replace_key") or "", 80),
    }

    if record is not None:
        body = json.dumps(
            {"format": entry["format"] or mime, "payload": record},
            ensure_ascii=False,
        ).encode("utf-8")
        if len(body) > MAX_MESSAGE_BYTES:
            raise ValueError("共享记录过大")
        entry["size"] = len(body)
        entry["record"] = "records/%s.json" % entry["id"]
    else:
        if source_path:
            path = Path(os.path.expandvars(os.path.expanduser(source_path)))
            if not path.is_file() or not _inside_any(path, _allowed_roots()):
                raise ValueError("源文件不在允许保存的目录中")
            body = path.read_bytes()
        elif data_b64:
            try:
                body = base64.b64decode(data_b64, validate=True)
            except Exception as exc:
                raise ValueError("共享内容无效") from exc
        else:
            raise ValueError("缺少共享内容")
        if not body:
            raise ValueError("共享内容为空")
        if len(body) > MAX_PUBLISH_BYTES:
            raise ValueError("共享文件超过 64 MB")
        entry["size"] = len(body)
        ext = Path(raw_name).suffix[:16] or mimetypes.guess_extension(mime) or ".bin"
        entry["file"] = "files/%s%s" % (entry["id"], ext)

    with FileLock(_lock_path()):
        if entry["kind"] == "record":
            _atomic_json(share_root() / entry["record"], {"format": entry["format"], "payload": record})
        else:
            target = share_root() / entry["file"]
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(target.name + ".tmp-" + uuid.uuid4().hex[:6])
            tmp.write_bytes(body)
            os.replace(tmp, target)
        index = load_index()
        if entry["replace_key"]:
            for old in list(index["items"]):
                if (
                    old.get("replace_key") == entry["replace_key"]
                    and old.get("source_app") == app
                ):
                    _remove_payload(old)
                    index["items"].remove(old)
        index["items"].insert(0, entry)
        if len(index["items"]) > INDEX_LIMIT:
            for old in index["items"][INDEX_LIMIT:]:
                _remove_payload(old)
            index["items"] = index["items"][:INDEX_LIMIT]
        _save_index(index)
    return _public_item(entry)


# ------------------------------------------------------------------ messaging


def send(from_app: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    from_app = clean_app_id(from_app)
    policy = load_policy()
    to_app = clean_app_id(payload.get("to") or "")
    channel_id = str(payload.get("channel") or "")
    if not to_app:
        raise ValueError("缺少接收方")
    if not channel_id:
        raise ValueError("缺少频道")
    if not channel_allows(policy, channel_id, from_app, "publish"):
        raise ValueError("「%s」不能向频道 %s 发送" % (from_app, channel_id))
    if not channel_allows(policy, channel_id, to_app, "consume"):
        raise ValueError("「%s」不能从频道 %s 接收" % (to_app, channel_id))

    message: Dict[str, Any] = {
        "id": _new_id("msg"),
        "from": from_app,
        "from_name": app_name(from_app),
        "to": to_app,
        "channel": channel_id,
        "created_at": now_iso(),
        "format": _clean_text(payload.get("format") or "", 60),
        "title": _clean_text(payload.get("title") or "", 160),
        "payload": payload.get("payload"),
        "artifact": None,
    }
    artifact_id = str(payload.get("artifact_id") or "")
    if artifact_id:
        index = load_index()
        entry = _find(index, artifact_id)
        if not entry:
            raise ValueError("要发送的共享项目不存在")
        if entry.get("channel") != channel_id:
            raise ValueError("共享项目不属于该频道")
        message["artifact"] = _public_item(entry)
        message["format"] = message["format"] or entry.get("format") or ""
        message["title"] = message["title"] or entry.get("title") or ""

    if message["payload"] is not None:
        encoded = json.dumps(message["payload"], ensure_ascii=False).encode("utf-8")
        if len(encoded) > MAX_MESSAGE_BYTES:
            raise ValueError("消息内容过大")

    folder = inbox_dir(to_app)
    target = folder / (message["id"] + ".json")
    _atomic_json(target, message)
    _prune_inbox(folder)
    return message


def take_inbox(
    app: str, limit: int = 40, consume: bool = False
) -> List[Dict[str, Any]]:
    """Read pending messages.

    They are kept until the receiver acknowledges them, so a product that
    boots slowly (or has not registered its import handler yet) cannot lose a
    note package between the HTTP response and its UI.  ``consume=True`` is
    the old at-most-once behaviour and is only used by diagnostics.
    """
    app = clean_app_id(app)
    folder = share_root() / "inbox" / app
    if not folder.is_dir():
        return []
    files = sorted(folder.glob("*.json"))
    messages: List[Dict[str, Any]] = []
    for path in files[: max(1, min(limit, 200))]:
        raw = _read_json(path, None)
        if consume:
            try:
                path.unlink()
            except OSError:
                pass
        if isinstance(raw, dict):
            messages.append(raw)
    return messages


def _prune_inbox(folder: Path, keep: int = 200, max_age_days: int = 14) -> None:
    """Keep a runaway inbox (an app that never acknowledges) bounded."""
    try:
        files = sorted(folder.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    except OSError:
        return
    cutoff = time.time() - max_age_days * 86400
    for index, path in enumerate(files):
        try:
            if index < keep and path.stat().st_mtime >= cutoff:
                continue
            path.unlink()
        except OSError:
            pass


def ack_inbox(app: str, ids: List[str]) -> Dict[str, Any]:
    app = clean_app_id(app)
    folder = share_root() / "inbox" / app
    removed = 0
    for message_id in ids or []:
        name = re.sub(r"[^A-Za-z0-9_.-]+", "", str(message_id))[:80]
        if not name:
            continue
        path = folder / (name + ".json")
        try:
            if path.is_file():
                path.unlink()
                removed += 1
        except OSError:
            pass
    return {"ok": True, "removed": removed}


# -------------------------------------------------------------------- space


def describe_space(app: str) -> Dict[str, Any]:
    app = clean_app_id(app)
    policy = load_policy()
    channels = []
    visible = visible_channels(policy, app)
    for channel_id, channel in (policy.get("channels") or {}).items():
        members = []
        for member_id, caps in (channel.get("apps") or {}).items():
            members.append(
                {
                    "app": member_id,
                    "name": caps.get("name") or app_name(member_id),
                    "publish": bool(caps.get("publish")),
                    "consume": bool(caps.get("consume")),
                    "source": caps.get("source") or "user",
                }
            )
        members.sort(key=lambda item: item["name"])
        caps = (channel.get("apps") or {}).get(app) or {}
        channels.append(
            {
                "id": channel_id,
                "name": channel.get("name") or channel_id,
                "description": channel.get("description") or "",
                "types": channel.get("types") or [],
                "apps": members,
                "visible": channel_id in visible or app == "hub",
                "can_publish": bool(caps.get("publish")) or app == "hub",
                "can_consume": bool(caps.get("consume")) or app == "hub",
            }
        )
    if app != "hub":
        # A product only learns about the channels it may actually use; the
        # full policy matrix stays in the hub.
        channels = [channel for channel in channels if channel["visible"]]
    channels.sort(key=lambda item: item["name"])
    return {
        "ok": True,
        "app": app,
        "schema": SCHEMA,
        "channels": channels,
        "items": list_items(app),
        "inbox_url": "/__omm/share/inbox?app=" + app,
    }


def policy_view() -> Dict[str, Any]:
    return describe_space("hub")


# ----------------------------------------------------------------------- HTTP


def _client_app(default_app: str, query: Dict[str, List[str]]) -> str:
    raw = (query.get("app") or [""])[0]
    return clean_app_id(raw or default_app or "app")


def handle_get(
    path: str, query: Dict[str, List[str]], default_app: str = "app"
) -> Tuple[int, str, bytes]:
    if not desktop_enabled():
        return _error(404, "desktop API is not enabled")
    app = _client_app(default_app, query)
    try:
        if path == "/__omm/share/space":
            return _json_response(200, describe_space(app))
        if path == "/__omm/share/items":
            channel = (query.get("channel") or [""])[0]
            return _json_response(200, {"ok": True, "app": app, "items": list_items(app, channel)})
        if path == "/__omm/share/item":
            item_id = (query.get("id") or [""])[0]
            return _json_response(200, {"ok": True, "item": get_item(app, item_id)})
        if path == "/__omm/share/file":
            item_id = (query.get("id") or [""])[0]
            data, mime = item_file(app, item_id)
            return 200, mime, data
        if path == "/__omm/share/inbox":
            limit = int((query.get("limit") or ["40"])[0] or 40)
            consume = (query.get("consume") or ["0"])[0] == "1"
            return _json_response(
                200, {"ok": True, "app": app, "messages": take_inbox(app, limit, consume)}
            )
    except ValueError as exc:
        return _error(400, str(exc))
    except Exception as exc:  # noqa: BLE001
        return _error(500, str(exc))
    return _error(404, "unknown endpoint")


def handle_post(
    path: str, query: Dict[str, List[str]], body: bytes, default_app: str = "app"
) -> Tuple[int, str, bytes]:
    if not desktop_enabled():
        return _error(404, "desktop API is not enabled")
    app = _client_app(default_app, query)
    try:
        if len(body) > MAX_BODY_BYTES:
            return _error(413, "请求体过大")
        payload = json.loads(body.decode("utf-8")) if body else {}
        if not isinstance(payload, dict):
            raise ValueError("请求格式无效")
        sender = clean_app_id(payload.get("app") or app)
        if path == "/__omm/share/publish":
            return _json_response(200, {"ok": True, "item": publish(sender, payload)})
        if path == "/__omm/share/send":
            return _json_response(200, {"ok": True, "message": send(sender, payload)})
        if path == "/__omm/share/delete":
            return _json_response(200, delete_item(sender, str(payload.get("id") or "")))
        if path == "/__omm/share/ack":
            ids = payload.get("ids") if isinstance(payload.get("ids"), list) else []
            return _json_response(200, ack_inbox(sender, ids))
        if path == "/__omm/share/policy":
            policy = update_policy(payload)
            return _json_response(200, {"ok": True, "policy": policy})
    except ValueError as exc:
        return _error(400, str(exc))
    except Exception as exc:  # noqa: BLE001
        return _error(500, str(exc))
    return _error(404, "unknown endpoint")
