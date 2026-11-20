# -*- coding: utf-8 -*-
"""OMM-ZEN AI 隐私过滤：所有交给模型的数据都必须经过这里。

隐私不变量
----------
1. Planner 的“隐藏内容（仅编辑页可见）”（``hidden: true``，UI 用 ``•••••`` 掩码）
   绝不能出现在任何工具返回值、技能上下文或模型提示词里。
2. 凭据字段（apiKey / password / token / supabase 等）一律脱敏。
3. 过滤是递归且防御性的：任意嵌套结构、未知形态都安全降级，绝不抛错把上下文
   组装带崩。

这个模块是 OMM 自写文件，属于 AI 工作区的可编辑接缝；vendored 框架不引用它，
由 omm_tools.build_tools() 与 omm_host 的 context source 统一调用。
"""
from __future__ import annotations

import json
import re
from typing import Any

#: Planner 在非编辑视图用来遮盖隐藏条目的占位符。
HIDDEN_MASK = '•••••'

#: 凭据类字段名（规范化后比较，兼容 apiKey / api_key / access-token）。
_SECRET_WORDS = (
    'apikey', 'token', 'secret', 'password', 'passwd', 'pwd',
    'credential', 'authorization', 'supabase', 'privatekey',
)
_REDACTED = '***'


def _norm(key: Any) -> str:
    return re.sub(r'[^a-z0-9]', '', str(key).lower())


def is_secret_field(key: Any) -> bool:
    """字段名是否是凭据类（含 apiKey / accessToken / supabase 等组合词）。"""
    n = _norm(key)
    return any(word in n for word in _SECRET_WORDS)


def is_hidden(item: Any) -> bool:
    """条目是否是用户标记为“仅编辑页可见”的隐藏内容。"""
    if not isinstance(item, dict):
        return False
    if item.get('hidden') is True:
        return True
    # 即便 hidden 标志被去掉，掩码标题也不该进入模型。
    for field in ('title', 'content', 'text', 'name', 'answer', 'note'):
        if item.get(field) == HIDDEN_MASK:
            return True
    return False


def scrub(value: Any, depth: int = 0) -> Any:
    """递归清除隐藏条目与凭据字段；列表里的隐藏项被丢弃，字典里的被跳过。

    - 列表：丢弃 ``is_hidden`` 为真的元素，其余递归处理，最多保留 200 条。
    - 字典：跳过隐藏项与凭据字段，其余递归处理，深度上限 8 防循环/超深。
    - 标量：字符串截断到 4000 字符，其它原样。
    """
    if depth > 8:
        return '…'
    if isinstance(value, dict):
        if is_hidden(value):
            return None  # 由调用方（列表）丢弃；单对象场景见 scrub_result
        out = {}
        for key, item in value.items():
            if is_secret_field(key):
                out[key] = _REDACTED
                continue
            cleaned = scrub(item, depth + 1)
            if cleaned is not None:
                out[key] = cleaned
        return out
    if isinstance(value, list):
        out = []
        for item in value[:200]:
            cleaned = scrub(item, depth + 1)
            if cleaned is not None:
                out.append(cleaned)
        return out
    if isinstance(value, str):
        return value[:4000]
    return value


def scrub_result(value: Any) -> Any:
    """工具返回值 / 上下文对象的统一过滤入口。

    顶层如果是隐藏条目，返回 ``{'hidden': True, 'filtered': True}`` 而不是内容；
    否则递归清洗整个结构。
    """
    if is_hidden(value):
        return {'hidden': True, 'filtered': True}
    return scrub(value)
