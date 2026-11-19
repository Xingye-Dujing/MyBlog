# -*- coding: utf-8 -*-
"""产品注册表的派生视图。

唯一真源是 ``plugin_specs.BUILTIN_PLUGINS``。凡是需要“有哪些产品 / 入口页 /
端口 / 窗口标题”的层（桌面启动器、统一守卫、发布脚本）都从这里取值，
不再各自维护一份容易漂移的硬编码表。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from plugin_specs import BUILTIN_PLUGINS, DESKTOP_EXE_NAMES

HUB_ID = "hub"


def product_ids() -> Set[str]:
    """All built-in product ids (the hub shell is not a plugin)."""
    return {item["id"] for item in BUILTIN_PLUGINS}


def all_ids() -> Set[str]:
    """Product ids plus the hub shell — the complete set of startable apps."""
    return product_ids() | {HUB_ID}


def launchable_products() -> List[Dict[str, Any]]:
    """Products the desktop launcher can start, in manifest order."""
    return [
        item for item in BUILTIN_PLUGINS
        if item["id"] in DESKTOP_EXE_NAMES and item["id"] != HUB_ID
    ]


def backend_of(item: Dict[str, Any]) -> Optional[str]:
    """``None`` for a static page, otherwise the id of its backend service."""
    runtime = item.get("runtime", "static")
    return None if runtime == "static" else runtime


def apps() -> Dict[str, Tuple[str, int, Optional[str]]]:
    """app id -> (html file, loopback port, backend)."""
    return {
        item["id"]: (item["entry"], item["port"], backend_of(item))
        for item in launchable_products()
    }


def window_titles() -> Dict[str, str]:
    """app id -> native window title."""
    return {item["id"]: item["name"] for item in launchable_products()}
