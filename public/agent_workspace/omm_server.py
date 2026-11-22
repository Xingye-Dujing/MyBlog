# -*- coding: utf-8 -*-
"""静书房 AI 工作区的本地后端（Flask）。

职责：
1. 在同一端口提供插件页面与 omm-embed/desktop/share 三个桥接脚本；
2. 把 /__omm/fs/* 与 /__omm/share/* 转发给静书房的磁盘桥（与 mdforge 一致）；
3. 挂载 agent-workspace 的 /api/ai/* 路由，让前端直接消费统一的会话/工具/技能/审批事件；
4. 把静书房“设置 → AI 服务”里的 provider/baseUrl/model 映射到框架 catalog，密钥只从请求头进入内存。
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from flask import Flask, Response, abort, jsonify, request, send_from_directory

from .adapters.flask import create_blueprint
from .errors import WorkspaceError
from .omm_data import ALL, CHANNELS, PRODUCTS
from .omm_host import APP_NAME, OMMZenHostAdapter
from .omm_tools import KNOWLEDGE_DIR
from .providers.openai_compat import OpenAICompatibleProvider
from .service import AgentWorkspace
from .types import ModelSpec, ProviderSpec

VERSION = '1.0.0'
FRAMEWORK_VERSION = '0.1.0'

# 静书房桌面桥所在的目录：源码运行时是 public/desktop，打包后由 hidden-import 提供。
_DESKTOP = Path(__file__).resolve().parent.parent / 'desktop'
if _DESKTOP.is_dir() and str(_DESKTOP) not in sys.path:
    sys.path.insert(0, str(_DESKTOP))

try:  # pragma: no cover - 浏览器预览 / 单测环境可能没有桌面桥
    import omm_shared as _omm_shared
except Exception:  # pragma: no cover
    _omm_shared = None
try:  # pragma: no cover
    import omm_share as _omm_share
except Exception:  # pragma: no cover
    _omm_share = None

_BUILTIN_PROVIDERS = frozenset({'deepseek', 'openrouter', 'ollama', 'complete', 'opencode_go', 'openai_compat'})
_DEFAULT_BASE = {
    'openai': 'https://api.openai.com/v1',
    'zhipu': 'https://open.bigmodel.cn/api/paas/v4',
    'custom': '',
}
_PROVIDER_CAPABILITIES = frozenset({'tools', 'ask_user', 'vision', 'title'})


def _app_id() -> str:
    return str(os.environ.get('OMM_APP_ID') or 'ai')


def _public_root(app: Flask) -> Path:
    return Path(app.config['PUBLIC_ROOT']).resolve()


def _safe_asset(root: Path, filename: str) -> Path | None:
    """Resolve *filename* inside *root*; never escape the bundled asset tree."""
    target = (root / filename).resolve()
    if root not in target.parents or not target.is_file():
        return None
    return target


def _register_custom_provider(ws: AgentWorkspace, identifier: str, base_url: str, model: str) -> str:
    """按需注册一个带 Base URL 的 OpenAI-compatible provider。"""
    target = 'omm_' + (re.sub(r'[^a-z0-9_]', '_', identifier.lower()) or 'custom')
    existing = ws.catalog.get(target, check_scope=False)
    if existing is not None and str(existing.spec.base_url or '') == base_url:
        return target
    if existing is not None:
        ws.catalog.unregister(target)
    provider = OpenAICompatibleProvider()
    provider.spec = ProviderSpec(
        id=target,
        label_key='omm.provider.' + target,
        notes_key='omm.providerNote.' + target,
        protocol='openai',
        base_url=base_url,
        models=(ModelSpec(model or 'gpt-4o-mini', model or 'gpt-4o-mini'),),
        requires_key=True,
        capabilities=frozenset(_PROVIDER_CAPABILITIES),
    )
    ws.catalog.register(provider)
    return target


def _resolve_provider(ws: AgentWorkspace, payload: dict) -> None:
    """就地改写请求体里的 provider/model（get_json 缓存的是同一个 dict）。"""
    provider = str(payload.get('provider') or '').strip().lower()
    base_url = str(payload.get('baseUrl') or payload.get('apiBase') or '').strip()
    model = str(payload.get('model') or '').strip()
    if not provider:
        provider = str(ws.catalog.default_id() or 'complete')
    if provider in _BUILTIN_PROVIDERS:
        resolved = provider
    else:
        base_url = base_url or _DEFAULT_BASE.get(provider, '')
        if not base_url:
            # 没有 Base URL 的自定义服务无法发出请求：回退离线回显，界面会给出提示。
            resolved = 'complete'
        else:
            resolved = _register_custom_provider(ws, provider, base_url, model)
    payload['provider'] = resolved
    if model:
        payload['model'] = model


def create_app(plugin_dir: str | Path | None = None, data_dir: str | Path | None = None) -> Flask:
    """构造一个独立的 AI 工作区 Flask app。"""
    app = Flask(__name__, static_folder=None)
    app.config['PUBLIC_ROOT'] = Path(plugin_dir).resolve() if plugin_dir else Path(__file__).resolve().parent.parent
    app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024
    app.config['JSON_AS_ASCII'] = False

    host = OMMZenHostAdapter(data_dir=data_dir)
    ws = AgentWorkspace(host)
    # 宿主领域工具需要显式注册进统一 ToolRegistry（技能已由 host.skills() 自动加载）。
    for spec in host.tools():
        ws.tools.register(spec)
    ws.settings.set('chat.default_provider', 'complete')
    ws.settings.set('chat.default_model', 'complete')
    app.extensions['omm_ai_workspace'] = ws

    # agent-workspace 的标准路由：/api/ai/bootstrap、/chat、/conversations、/skills …
    app.register_blueprint(create_blueprint(ws, url_prefix='/api/ai', account_resolver=lambda: 'default'))

    @app.before_request
    def _omm_local_guard():
        # 桌面桥的其它 HTTP 服务都做 Host/Origin 双重校验；这里也不能例外，
        # 否则恶意网页可用 no-cors 的 text/plain POST 把 JSON 写进本机磁盘桥。
        if _omm_shared is not None and _omm_shared.desktop_enabled():
            if not _omm_shared.headers_are_local(
                request.headers.get('Host'), request.headers.get('Origin'),
                request.headers.get('Sec-Fetch-Site'),
            ):
                abort(403)
        return None

    @app.before_request
    def _omm_map_provider():
        if not request.path.startswith('/api/ai/'):
            return None
        payload = request.get_json(silent=True)
        if isinstance(payload, dict):
            _resolve_provider(ws, payload)
        return None

    @app.errorhandler(WorkspaceError)
    def _omm_error(exc: WorkspaceError):
        return jsonify(exc.to_dict()), 400

    # ── 静态资源 ─────────────────────────────────────────────────────────────
    def _serve(name: str):
        return send_from_directory(str(_public_root(app)), name)

    @app.get('/')
    @app.get('/omm-ai.html')
    def index():
        return _serve('omm-ai.html')

    for _asset in ('omm-desktop.js', 'omm-share.js', 'omm-embed.js', 'omm-icons.js', 'icon.ico',
                   'zen/zen.css'):
        def _make(name):
            def handler():
                return _serve(name)
            return handler
        app.add_url_rule('/' + _asset, 'asset_' + _asset.replace('.', '_'), _make(_asset))

    @app.get('/vendor/<path:filename>')
    def vendor(filename: str):
        target = _safe_asset(_public_root(app) / 'vendor', filename)
        if target is None:
            abort(404)
        return send_from_directory(str(target.parent), target.name)

    # 共享样式与模块树同样放在插件目录里：静态插件由 ShellHandler 直接托管，
    # 带后端的插件必须显式放行，否则页面能打开但样式和模块全部 404。
    def _make_asset_handler(tree: str):
        def handler(filename: str):
            target = _safe_asset(_public_root(app) / tree, filename)
            if target is None:
                abort(404)
            return send_from_directory(str(target.parent), target.name)
        return handler

    for _tree in ('zen/foundation', 'zen/features', 'zen/products', 'zen/components', 'zen/canvas', 'lib'):
        app.add_url_rule(
            '/' + _tree + '/<path:filename>',
            'asset_' + _tree.replace('/', '_').replace('-', '_'),
            _make_asset_handler(_tree),
        )

    # ── 桌面桥（与 mdforge/server.py 保持一致） ───────────────────────────────
    @app.get('/__omm/fs/<path:sub>')
    def fs_get(sub: str):
        if _omm_shared is None:
            abort(404)
        parsed = urlsplit(request.full_path)
        status, content_type, body = _omm_shared.handle_get(
            '/__omm/fs/' + sub, parse_qs(parsed.query), _app_id())
        return Response(body, status=status, content_type=content_type)

    @app.post('/__omm/fs/<path:sub>')
    def fs_post(sub: str):
        if _omm_shared is None:
            abort(404)
        parsed = urlsplit(request.full_path)
        status, content_type, body = _omm_shared.handle_post(
            '/__omm/fs/' + sub, parse_qs(parsed.query), request.get_data(cache=False), _app_id())
        return Response(body, status=status, content_type=content_type)

    @app.get('/__omm/share/<path:sub>')
    def share_get(sub: str):
        if _omm_share is None:
            abort(404)
        parsed = urlsplit(request.full_path)
        status, content_type, body = _omm_share.handle_get(
            '/__omm/share/' + sub, parse_qs(parsed.query), _app_id())
        return Response(body, status=status, content_type=content_type)

    @app.post('/__omm/share/<path:sub>')
    def share_post(sub: str):
        if _omm_share is None:
            abort(404)
        parsed = urlsplit(request.full_path)
        status, content_type, body = _omm_share.handle_post(
            '/__omm/share/' + sub, parse_qs(parsed.query), request.get_data(cache=False), _app_id())
        return Response(body, status=status, content_type=content_type)

    # ── 本插件自己的轻量接口（给前端渲染产品/技能/规范） ──────────────────────
    @app.get('/api/omm/env')
    def omm_env():
        return jsonify({
            'ok': True,
            'app': 'ai',
            'name': APP_NAME,
            'version': VERSION,
            'framework': FRAMEWORK_VERSION,
            'python': '.'.join(str(part) for part in os.sys.version_info[:3]),
            'products': len(PRODUCTS),
            'skills': len([s for s in ws.skills.list('default') if s['id'].startswith('omm.zen.')]),
            'tools': len(ws.tools.schemas()),
            'knowledge': sorted(path.name for path in KNOWLEDGE_DIR.glob('*.md')) if KNOWLEDGE_DIR.is_dir() else [],
            'data_dir': str(Path(host.data_dir())),
        })

    @app.get('/api/omm/products')
    def omm_products():
        return jsonify({
            'ok': True,
            'products': [
                {'id': key, 'name': item['name'], 'glyph': item['glyph'], 'purpose': item['purpose'],
                 'port': item['port'], 'entry': item['entry'], 'runtime': item['runtime'],
                 'channels': list(item.get('channels') or []), 'suggested': list(item.get('suggested') or [])}
                for key, item in PRODUCTS.items()
            ],
            'hub': {'id': 'hub', 'name': ALL['hub']['name'], 'port': ALL['hub']['port']},
            'channels': CHANNELS,
        })

    @app.get('/api/omm/skills')
    def omm_skills_route():
        rows = [row for row in ws.skills.list('default') if row['id'].startswith('omm.zen.')]
        return jsonify({'ok': True, 'skills': rows})

    @app.get('/api/omm/spec')
    def omm_spec():
        from .omm_tools import _spec_read, _spec_search
        name = str(request.args.get('file') or '').strip()
        query = str(request.args.get('query') or '').strip()
        if name:
            return jsonify(_spec_read({'file': name}, {}))
        if query:
            return jsonify(_spec_search({'query': query, 'limit': request.args.get('limit', 5)}, {}))
        return jsonify({'ok': False, 'error': 'file 或 query 必填'})

    @app.get('/api/omm/formats')
    def omm_formats():
        from .omm_tools import _format_list
        return jsonify(_format_list({'product': request.args.get('product', '')}, {}))

    @app.get('/api/omm/template')
    def omm_template():
        from .omm_tools import _format_template
        return jsonify(_format_template({
            'product': request.args.get('product', ''),
            'kind': request.args.get('kind', ''),
        }, {}))

    @app.post('/api/omm/validate')
    def omm_validate():
        from .omm_tools import _format_validate
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({'ok': False, 'error': '请求体必须是 JSON 对象'}), 400
        return jsonify(_format_validate(payload, {}))

    @app.get('/api/omm/ai-config')
    def omm_ai_config():
        """只返回非敏感字段；密钥永远不进响应。"""
        from .omm_host import shared_dir
        import json
        try:
            cfg = json.loads((shared_dir() / 'shared.json').read_text(encoding='utf-8-sig'))
        except Exception:
            cfg = {}
        ai = cfg.get('ai') if isinstance(cfg.get('ai'), dict) else {}
        return jsonify({
            'ok': True,
            'configured': bool(ai.get('apiKey')),
            'provider': str(ai.get('provider') or 'deepseek'),
            'apiBase': str(ai.get('apiBase') or ''),
            'apiModel': str(ai.get('apiModel') or ''),
            'system': str(ai.get('system') or ''),
        })

    return app
