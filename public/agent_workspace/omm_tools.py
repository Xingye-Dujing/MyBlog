# -*- coding: utf-8 -*-
"""OMM-ZEN 领域只读工具。

框架自带 24 个通用工具；这里只增加“读懂静书房自身”的能力：产品目录、规范检索、
工作区状态与共享频道。所有工具默认只读；任何写操作都走 present_artifact →
用户应用 → OMMZenHostAdapter.apply_artifact，由宿主界面实际执行。
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List

from .omm_data import ALL, CHANNELS, PRODUCTS, PRODUCT_IDS, product
from .omm_validators import formats_for, validate as validate_format
from .types import ToolSpec

KNOWLEDGE_DIR = Path(__file__).resolve().parent / 'omm_knowledge'
_SPEC_FILES = tuple(sorted(path.name for path in KNOWLEDGE_DIR.glob('*.md'))) if KNOWLEDGE_DIR.is_dir() else ()


def _shared_dir() -> Path:
    override = os.environ.get('OMM_SHARED_DIR') or ''
    if override:
        return Path(override)
    if sys.platform == 'darwin':
        return Path.home() / 'Library' / 'Application Support' / 'OMM-ZEN'
    local = os.environ.get('LOCALAPPDATA') or ''
    if local:
        return Path(local) / 'OMM-ZEN'
    return Path.home() / '.local' / 'share' / 'OMM-ZEN'


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _excerpt(text: str, token: str, radius: int = 160) -> str:
    pos = text.lower().find(token.lower())
    if pos < 0:
        return text[:radius * 2].replace('\n', ' ')
    start = max(0, pos - radius)
    end = min(len(text), pos + len(token) + radius)
    return ('…' if start else '') + text[start:end].replace('\n', ' ') + ('…' if end < len(text) else '')


def _tokens(query: str) -> List[str]:
    raw = str(query or '').strip().lower()
    pieces = re.findall(r'[a-z0-9_.\-]+|[\u4e00-\u9fff]{2,}', raw)
    # 中文长词补一个二元组，让“间隔复习”“卡片”这类查询也能命中。
    expanded = list(pieces)
    for piece in pieces:
        if re.match(r'^[\u4e00-\u9fff]{4,}$', piece):
            expanded.extend(piece[i:i + 2] for i in range(len(piece) - 1))
    return [token for token in dict.fromkeys(expanded) if len(token) >= 2] or [raw] if raw else []


def _product_list(_args: dict, _ctx: dict) -> dict:
    return {
        'ok': True,
        'count': len(PRODUCT_IDS),
        'products': [
            {
                'id': key, 'name': item['name'], 'glyph': item['glyph'],
                'purpose': item['purpose'], 'port': item['port'],
                'runtime': item['runtime'], 'channels': list(item.get('channels') or []),
            }
            for key, item in PRODUCTS.items()
        ],
        'hub': {'id': 'hub', 'name': ALL['hub']['name'], 'port': ALL['hub']['port']},
    }


def _product_info(args: dict, _ctx: dict) -> dict:
    identifier = str(args.get('product') or args.get('id') or '').strip()
    item = product(identifier)
    if not item:
        return {'ok': False, 'error': 'unknown product: %s' % identifier,
                'available': list(PRODUCT_IDS) + ['hub']}
    result = dict(item)
    result['ok'] = True
    return result


def _spec_search(args: dict, _ctx: dict) -> dict:
    query = str(args.get('query') or '').strip()
    limit = max(1, min(10, int(args.get('limit') or 3)))
    tokens = _tokens(query)
    if not tokens:
        return {'ok': False, 'error': 'query is required', 'files': list(_SPEC_FILES)}
    hits = []
    for name in _SPEC_FILES:
        try:
            text = (KNOWLEDGE_DIR / name).read_text(encoding='utf-8')
        except Exception:
            continue
        lowered = text.lower()
        score = sum(lowered.count(token) for token in tokens)
        if score:
            hits.append({
                'file': name, 'score': score,
                'excerpt': _excerpt(text, tokens[0]),
            })
    hits.sort(key=lambda row: (-row['score'], row['file']))
    return {'ok': True, 'query': query, 'count': len(hits), 'results': hits[:limit]}


def _spec_read(args: dict, _ctx: dict) -> dict:
    name = os.path.basename(str(args.get('file') or '')).strip()
    if not name or not name.endswith('.md') or name not in _SPEC_FILES:
        return {'ok': False, 'error': 'unknown spec file', 'available': list(_SPEC_FILES)}
    try:
        text = (KNOWLEDGE_DIR / name).read_text(encoding='utf-8')
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}
    return {'ok': True, 'file': name, 'content': text[:24000], 'truncated': len(text) > 24000}


def _workspace_status(_args: dict, ctx: dict) -> dict:
    """静书房状态快照。密钥只回报“是否配置”，绝不进入模型上下文。"""
    account = str((ctx or {}).get('account') or 'default')
    shared = _shared_dir()
    cfg = _read_json(shared / 'shared.json')
    ai = cfg.get('ai') if isinstance(cfg.get('ai'), dict) else {}
    channels = []
    policy = _read_json(shared / 'share' / 'policy.json')
    raw_channels = policy.get('channels')
    if isinstance(raw_channels, dict):
        channels = [{'id': key, 'members': value} for key, value in raw_channels.items()]
    elif isinstance(raw_channels, list):
        channels = [row for row in raw_channels if isinstance(row, dict)]
    return {
        'ok': True,
        'account': account,
        'environment': '静书房桌面版' if os.environ.get('OMM_DESKTOP') else '本地/预览环境',
        'ai': {
            'configured': bool(ai.get('apiKey')),
            'provider': str(ai.get('provider') or ''),
            'apiModel': str(ai.get('apiModel') or ''),
            'apiBase': str(ai.get('apiBase') or ''),
            'hasSystemPrompt': bool(ai.get('system')),
        },
        'channels': channels or [{'id': key, 'name': value['name']} for key, value in CHANNELS.items()],
        'products': len(PRODUCT_IDS),
        'knowledge_files': list(_SPEC_FILES),
    }


def _channel_info(args: dict, _ctx: dict) -> dict:
    wanted = str(args.get('channel') or '').strip()
    rows = []
    for key, value in CHANNELS.items():
        if wanted and wanted != key:
            continue
        users = [
            {'id': pid, 'name': item['name'], 'channels': item.get('channels') or []}
            for pid, item in ALL.items() if key in (item.get('channels') or [])
        ]
        rows.append({'id': key, **value, 'products': users})
    return {'ok': bool(rows), 'channels': rows}


TOOLS: List[ToolSpec] = [
    ToolSpec(
        name='omm_product_list',
        description='列出静书房全部产品及 id/名称/用途/端口/共享频道。用户问“有哪些产品”时先调用它。',
        parameters={'type': 'object', 'properties': {}, 'required': []},
        permission='read:omm', handler=_product_list,
    ),
    ToolSpec(
        name='omm_product_info',
        description='按产品 id、中文名或字标读取该产品的完整知识：功能、数据落点、导入导出格式、AI 规范、最佳实践与常见坑。',
        parameters={
            'type': 'object',
            'properties': {'product': {'type': 'string', 'description': '产品 id、中文名或字标，如 mdforge / 铸造台 / M'}},
            'required': ['product'],
        },
        permission='read:omm', handler=_product_info,
    ),
    ToolSpec(
        name='omm_spec_search',
        description='在 OMM-ZEN 规范知识库（json-specs、MDFORGE AI 规范、产品总览、插件规范）中按关键词检索并返回摘录。生成精确字段前必须调用。',
        parameters={
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': '检索词，可含中文'},
                'limit': {'type': 'number', 'description': '返回条数，1–10，默认 3'},
            },
            'required': ['query'],
        },
        permission='read:omm', handler=_spec_search,
    ),
    ToolSpec(
        name='omm_spec_read',
        description='按文件名完整读取一份 OMM-ZEN 规范文档（先用 omm_spec_search 找到文件名）。',
        parameters={
            'type': 'object',
            'properties': {'file': {'type': 'string', 'description': '如 AI_MD_SPEC.md、zencard.md'}},
            'required': ['file'],
        },
        permission='read:omm', handler=_spec_read,
    ),
    ToolSpec(
        name='omm_workspace_status',
        description='读取静书房当前状态：AI 服务是否已配置（不返回密钥）、共享频道、产品数与规范文件清单。',
        parameters={'type': 'object', 'properties': {}, 'required': []},
        permission='read:omm', handler=_workspace_status,
    ),
    ToolSpec(
        name='omm_channel_info',
        description='查询共享频道定义及哪些产品使用它们；用于设计跨产品数据流与发送目标。',
        parameters={
            'type': 'object',
            'properties': {'channel': {'type': 'string', 'description': '可选：data.tables / notes.english / documents'}},
            'required': [],
        },
        permission='read:omm', handler=_channel_info,
    ),
]


def _format_list(args: dict, _ctx: dict) -> dict:
    identifier = str(args.get('product') or '').strip()
    if identifier:
        return formats_for(identifier)
    return {
        'ok': True,
        'products': [
            {'id': key, 'name': item['name'],
             'kinds': [row['kind'] for row in formats_for(key).get('formats', [])]}
            for key, item in PRODUCTS.items()
        ] + [{'id': 'hub', 'name': ALL['hub']['name'],
              'kinds': [row['kind'] for row in formats_for('hub').get('formats', [])]}],
        'tip': '先调 omm_format_list 看可用格式，再用 omm_format_template 取骨架、omm_format_validate 校验。',
    }


def _format_template(args: dict, _ctx: dict) -> dict:
    identifier = str(args.get('product') or '').strip()
    kind = str(args.get('kind') or '').strip()
    data = formats_for(identifier)
    if not data.get('ok'):
        return data
    rows = data['formats']
    if kind:
        rows = [row for row in rows if row['kind'] == kind]
        if not rows:
            return {'ok': False, 'error': '该产品没有这种格式：%s' % kind,
                    'available': [row['kind'] for row in data['formats']]}
    return {
        'ok': True, 'product': data['product'], 'product_name': data['product_name'],
        'templates': rows,
        'note': '按模板填好后调用 omm_format_validate(content=…)；JSON 模板直接输出，不要包代码围栏。',
    }


def _format_validate(args: dict, _ctx: dict) -> dict:
    identifier = str(args.get('product') or '').strip()
    content = args.get('content')
    kind = str(args.get('kind') or '').strip() or None
    if content is None:
        return {'ok': False, 'error': 'content 必填：粘贴要校验的 JSON/TeX/Markdown/CSV 内容'}
    return validate_format(identifier, content, kind)


TOOLS.extend([
    ToolSpec(
        name='omm_format_list',
        description='列出每个 OMM-ZEN 产品支持的导入/导出格式（kind）。不知道用哪种格式时先调用它。',
        parameters={'type': 'object', 'properties': {
            'product': {'type': 'string', 'description': '可选：产品 id 或中文名；省略则列出全部产品'}},
            'required': []},
        permission='read:omm', handler=_format_list,
    ),
    ToolSpec(
        name='omm_format_template',
        description='返回某个产品某种格式的空白模板（可直接填充的 JSON/TeX/Markdown/CSV 骨架）。不要自己凭记忆编造导入文件的结构。',
        parameters={'type': 'object', 'properties': {
            'product': {'type': 'string', 'description': '产品 id、中文名或字标'},
            'kind': {'type': 'string', 'description': '可选：格式类型，如 backup / restore / card / rules'}},
            'required': ['product']},
        permission='read:omm', handler=_format_template,
    ),
    ToolSpec(
        name='omm_format_validate',
        description='校验生成内容是否符合该产品的真实导入规则：返回 ok、带路径的 errors 与 warnings。生成任何导入文件后必须调用它，并按错误修正后再交付。',
        parameters={'type': 'object', 'properties': {
            'product': {'type': 'string', 'description': '产品 id、中文名或字标'},
            'content': {'type': 'string', 'description': '要校验的 JSON/TeX/Markdown/CSV 文本或对象'},
            'kind': {'type': 'string', 'description': '可选：格式类型；省略则自动识别'}},
            'required': ['product', 'content']},
        permission='read:omm', handler=_format_validate,
    ),
])


def build_tools() -> List[ToolSpec]:
    return list(TOOLS)
