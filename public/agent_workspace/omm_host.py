# -*- coding: utf-8 -*-
"""静书房 AI 工作区的宿主适配器。

这是框架与 OMM-ZEN 之间唯一的接缝：宿主提供事实、规范文档、技能、只读工具与
产物应用逻辑，引擎不反向依赖宿主。密钥永远不经过这里落盘。
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List

from .errors import AIError
from .host import CallableContextSource, DefaultHostAdapter, HostEnvironment
from .omm_data import CHANNELS, PRODUCT_IDS, PRODUCTS, ALL
from .omm_privacy import scrub_result
from .omm_privacy import is_secret_field
from .omm_skills import build_skills
from .omm_tools import KNOWLEDGE_DIR, build_tools

APP_NAME = '静书房 AI 工作区'
_SAFE_EXT = {'.md', '.json', '.txt', '.csv', '.tsv', '.tex', '.yaml', '.yml', '.zc', '.zwlib', '.zen-card', '.py'}



def omm_live_context(query: str, payload: dict, account: str = '') -> str:
    """Render a redacted snapshot of the user's real product data into context.

    The AI page collects `zen.cards.v1`, `zc-docs`, `omm-search-v1` and flow rules
    from the Hub (which can cross iframe origins) and sends them in
    `context.omm_live`. This source turns that into readable text. It is strictly
    read-only and defensive: unknown shapes degrade to an empty string, so a
    malformed or malicious payload can never break context assembly.
    """
    live = payload.get('omm_live') if isinstance(payload, dict) else None
    if not isinstance(live, dict) or not live:
        return ''
    # Unified privacy scrub: drops hidden items and masks credentials at once.
    # scrub_result keeps a hidden top-level object as {'hidden': True, ...} instead
    # of None, so a malicious cross-origin payload cannot break context assembly.
    safe = scrub_result(live)
    if not isinstance(safe, dict):
        return ''
    lines = []
    labels = {
        'cards': '知识卡片',
        'notes': '笔记',
        'searches': '最近搜索',
        'rules': '工作流规则',
        'clips': '剪藏',
    }
    for key, label in labels.items():
        rows = safe.get(key)
        if not isinstance(rows, list) or not rows:
            continue
        # scrub() already dropped hidden rows and masked credential fields.
        lines.append('【%s · %d 条】' % (label, len(rows)))
        for row in rows[:20]:
            text = json.dumps(row, ensure_ascii=False) if isinstance(row, (dict, list)) else str(row)
            lines.append('- ' + text[:300])
    if not lines:
        return ''
    return '\n'.join([
        '# 静书房实时数据（用户本机，仅供参考；写入仍需产物审批）',
        *lines,
        '说明：以上是用户真实产品数据的只读快照，敏感字段已脱敏。引用时不要编造未出现的内容。',
    ])


def shared_dir() -> Path:
    override = os.environ.get('OMM_SHARED_DIR') or ''
    if override:
        return Path(override)
    if sys.platform == 'darwin':
        return Path.home() / 'Library' / 'Application Support' / 'OMM-ZEN'
    local = os.environ.get('LOCALAPPDATA') or ''
    if local:
        return Path(local) / 'OMM-ZEN'
    return Path.home() / '.local' / 'share' / 'OMM-ZEN'


def default_data_dir() -> Path:
    override = os.environ.get('OMM_AI_DATA_DIR') or ''
    return Path(override) if override else shared_dir() / 'ai-workspace'


def _safe_name(name: str, default: str = 'ai-output.md') -> str:
    base = os.path.basename(str(name or '').replace('\\', '/').strip())
    base = re.sub(r'[<>:"|?*\x00-\x1f]', '_', base).strip('. ') or default
    if base.lower() in ('con', 'prn', 'aux', 'nul'):
        base = '_' + base
    return base


def _invalid(message: str) -> AIError:
    return AIError(message, kind='bad_request', key='omm.artifact.invalid')


def _assert_no_secret(value: Any, path: str = '') -> None:
    """拒绝把密钥或密码夹带进任何产物。

    字段名用 omm_privacy.is_secret_field 按词匹配，覆盖 accessToken / privateKey /
    client_secret / supabase 等写法，避免精确匹配表漏掉常见凭据字段。
    """
    if isinstance(value, dict):
        for key, item in value.items():
            if is_secret_field(key) and item:
                raise _invalid('产物中不允许包含密钥/密码字段：%s' % key)
            _assert_no_secret(item, path + '/' + str(key))
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _assert_no_secret(item, '%s[%d]' % (path, index))
    elif isinstance(value, str):
        stripped = value.strip()
        if stripped[:1] in ('{', '[') and len(stripped) > 2:
            try:
                import json
                _assert_no_secret(json.loads(stripped), path)
                return
            except (ValueError, TypeError):
                pass
        if re.search(r'\b(?:sk|sk-ant|sk-proj)-[A-Za-z0-9_\-]{8,}', value):
            raise _invalid('产物中看起来包含 API 密钥，已拒绝')


class OMMZenHostAdapter(DefaultHostAdapter):
    """宿主：把静书房的产品知识注入通用 Agent 引擎。"""

    def __init__(self, data_dir: str | Path | None = None, *, lang: str = 'zh'):
        self._omm_data_dir = Path(data_dir) if data_dir is not None else default_data_dir()
        environment = HostEnvironment(
            kind='desktop',
            source_root=str(KNOWLEDGE_DIR),
            extra={
                'app': APP_NAME,
                'products': len(PRODUCTS),
                # 显式关闭这三项：AI 工作区默认只读，写操作走产物审批。
                'python_exec': False,
                'cmd_exec': False,
                'code_plugins': False,
            },
        )
        super().__init__(
            data_dir=self._omm_data_dir,
            lang=lang,
            environment=environment,
            facts=self._facts_data(),
            doc_roots=[str(KNOWLEDGE_DIR) + os.sep],
        )
        self._tools = build_tools()
        self._skills = build_skills()
        self._bus = None

    # ── 身份与数据 ───────────────────────────────────────────────────────────
    def data_dir(self) -> Path:
        return self._omm_data_dir

    def account(self) -> str:
        return 'default'

    # ── 领域事实 ─────────────────────────────────────────────────────────────
    @staticmethod
    def _facts_data() -> Dict[str, str]:
        lines = ['%s（%s）：%s' % (item['name'], key, item['purpose']) for key, item in PRODUCTS.items()]
        return {
            'summary': (
                '静书房（OMM-ZEN）是一个插件化本地工作台，内置 %d 个产品，统一在“设置 → AI 服务”配置模型。'
                '每个产品页在独立回环端口运行，localStorage/IndexedDB 按 origin 隔离；跨产品内容通过 ZenCard '
                '与三个共享频道传递。AI 工作区是该工作台的专属 Agent/Harness。' % len(PRODUCTS)
            ),
            '规则': '\n'.join([
                '1. 任何写入都必须先 present_artifact，由用户在界面点“应用”；不得声称已经写入产品。',
                '2. 密钥只在请求期间留在内存，绝不写入生成文件、对话导出、设置或日志。',
                '3. 跨产品传递内容用 ZenCard（format: zen-card, v:1, content 非空），通过共享频道发送。',
                '4. 精确字段与枚举必须先检索 omm_knowledge 规范，禁止凭记忆编造。',
                '5. 替换型导入（标注/语料库/英文备份/统一备份）会覆盖原数据，操作前提醒用户导出。',
                '6. 没有文件导入的产品：脱敏工具、消息同步；LaTeX 只吃 .tex；可视化属性 JSON 不含数据。',
            ]),
            '产品清单': '\n'.join(lines),
            '共享频道': '\n'.join(
                '%s：%s（%s）' % (key, value['name'], value['role']) for key, value in CHANNELS.items()
            ),
        }

    def capabilities(self) -> dict:
        return {
            'omm_zen': True,
            'product_count': len(PRODUCTS),
            'shared_channels': tuple(CHANNELS),
            'artifact_apply': True,
            'knowledge_docs': len(list(KNOWLEDGE_DIR.glob('*.md'))) if KNOWLEDGE_DIR.is_dir() else 0,
            'static_plugin_runtime': True,
        }

    # ── 上下文 / 技能 / 工具 ──────────────────────────────────────────────────
    def context_sources(self):
        def omm_state(query: str, payload: dict, account: str = '') -> str:
            ai_path = shared_dir() / 'shared.json'
            try:
                import json
                cfg = json.loads(ai_path.read_text(encoding='utf-8-sig')) if ai_path.is_file() else {}
            except Exception:
                cfg = {}
            ai = cfg.get('ai') if isinstance(cfg.get('ai'), dict) else {}
            return '\n'.join([
                '# 静书房运行态',
                '- AI 服务：%s（%s / %s）' % (
                    '已配置' if ai.get('apiKey') else '未配置密钥',
                    ai.get('provider') or '未选', ai.get('apiModel') or '未选'),
                '- 产品数：%d；共享频道：%s' % (len(PRODUCTS), '、'.join(CHANNELS)),
                '- 规范文档：omm_knowledge/ 下 %d 份，可用 omm_spec_search / docs_search 读取。' % len(list(KNOWLEDGE_DIR.glob('*.md'))),
                '- 本工作区默认只读：写入通过产物审批，由界面调用 OMMDesktop.saveText / OMMShare 完成。',
            ])
        return [
            CallableContextSource('omm_workspace', omm_state),
            CallableContextSource('omm_live_data', omm_live_context),
        ]

    def tools(self):
        return list(self._tools)

    def skills(self):
        return list(self._skills)

    # ── 产物：唯一允许改变宿主数据的入口 ──────────────────────────────────────
    def apply_artifact(self, kind: str, payload: dict) -> dict:
        kind = str(kind or '').strip()
        data = dict(payload or {})
        _assert_no_secret(data)
        if kind in ('omm_text_file', 'omm_markdown', 'omm_json', 'omm_csv', 'omm_tex'):
            name = _safe_name(data.get('filename') or data.get('name') or 'ai-output.md')
            ext = {
                'omm_markdown': '.md', 'omm_json': '.json', 'omm_csv': '.csv', 'omm_tex': '.tex',
            }.get(kind)
            if ext and not name.lower().endswith(ext):
                name += ext
            if Path(name).suffix.lower() not in _SAFE_EXT:
                raise _invalid('不支持的文件类型：%s' % name)
            content = str(data.get('content') or '')
            if len(content.encode('utf-8')) > 8 * 1024 * 1024:
                raise _invalid('文件内容超过 8 MB 限制')
            return {
                'ok': True, 'kind': kind, 'action': 'save_text', 'filename': name,
                'mime': {'omm_markdown': 'text/markdown', 'omm_json': 'application/json',
                         'omm_csv': 'text/csv', 'omm_tex': 'text/x-tex'}.get(kind, 'text/plain'),
                'content': content, 'title': str(data.get('title') or name),
                'note': '请在界面点“保存到本机”完成写入；保存目录由静书房设置决定。',
            }
        if kind in ('omm_zen_card_pack', 'omm_zen_card'):
            cards = data.get('cards')
            if kind == 'omm_zen_card' and isinstance(data.get('card'), dict):
                cards = [data['card']]
            if not isinstance(cards, list) or not cards:
                raise _invalid('卡片包必须包含非空 cards[]')
            for card in cards:
                if not isinstance(card, dict) or not str(card.get('content') or '').strip():
                    raise _invalid('每张卡片都需要非空 content')
            return {
                'ok': True, 'kind': kind, 'action': 'publish_cards', 'channel': 'documents',
                'cards': cards, 'title': str(data.get('title') or 'AI 生成的卡片包'),
                'note': '请在界面选择“发送到间隔复习”或“发布到共享空间”。',
            }
        if kind in ('omm_zen_flow_rules', 'omm_zen_canvas'):
            name = _safe_name(data.get('filename') or ('rules.json' if kind == 'omm_zen_flow_rules' else 'canvas.zc'))
            return {
                'ok': True, 'kind': kind, 'action': 'save_text', 'filename': name,
                'mime': 'application/json', 'content': json_dumps(data.get('payload') if isinstance(data.get('payload'), (dict, list)) else data),
                'title': str(data.get('title') or name),
                'note': '产物已校验；请在界面保存到本机或发布到共享空间。',
            }
        if kind == 'omm_open_app':
            target = str(data.get('app') or data.get('product') or '').strip()
            item = ALL.get(target)
            if not item:
                raise _invalid('未知产品：%s' % target)
            return {'ok': True, 'kind': kind, 'action': 'open_app', 'app': target,
                    'title': '打开 %s' % item['name'], 'note': '请在界面确认后切换到该产品。'}
        raise _invalid('该宿主不支持的产物类型：%s' % kind)

    # 事件总线留给未来的监控扩展；默认不启用，避免后台无谓请求。
    def event_bus(self):
        return self._bus


def json_dumps(value: Any) -> str:
    import json
    return json.dumps(value, ensure_ascii=False, indent=2)
