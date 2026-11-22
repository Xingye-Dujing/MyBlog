# -*- coding: utf-8 -*-
"""静书房 AI 工作区插件的全面测试。

覆盖：产品知识库、25 个技能、6 个领域工具、宿主事实与产物审批、离线对话路由、
Flask 路由与密钥不落盘、桌面构建契约、前端 OMM-ZEN 样式与桥接契约。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from agent_workspace.adapters.flask import create_blueprint  # noqa: E402
from agent_workspace.errors import AIError  # noqa: E402
from agent_workspace.omm_data import ALL, CHANNELS, PRODUCTS, PRODUCT_IDS, product  # noqa: E402
from agent_workspace.omm_host import OMMZenHostAdapter, shared_dir  # noqa: E402
from agent_workspace.omm_server import _resolve_provider, _safe_asset, create_app  # noqa: E402
from agent_workspace.omm_skills import SKILLS  # noqa: E402
from agent_workspace.omm_tools import KNOWLEDGE_DIR  # noqa: E402
from agent_workspace.service import AgentWorkspace  # noqa: E402
from agent_workspace.types import SKILL_ID_RE  # noqa: E402


@pytest.fixture()
def host(tmp_path):
    return OMMZenHostAdapter(data_dir=tmp_path / 'ai')


@pytest.fixture()
def ws(host):
    workspace = AgentWorkspace(host)
    for spec in host.tools():
        workspace.tools.register(spec)
    workspace.settings.set('chat.default_provider', 'complete')
    workspace.settings.set('chat.default_model', 'complete')
    return workspace


@pytest.fixture()
def client(tmp_path):
    app = create_app(plugin_dir=ROOT, data_dir=tmp_path / 'ai')
    app.config['TESTING'] = True
    return app.test_client()


# ── 1. 产品知识库 ─────────────────────────────────────────────────────────────
def test_catalog_completeness():
    assert len(PRODUCT_IDS) == 20
    assert len(set(PRODUCT_IDS)) == 20
    assert set(PRODUCTS) == set(PRODUCT_IDS)
    assert 'hub' not in PRODUCTS and 'hub' in ALL
    required = {'name', 'glyph', 'purpose', 'port', 'entry', 'runtime', 'order',
                'channels', 'features', 'storage', 'formats', 'ai', 'best_practices', 'pitfalls', 'suggested'}
    ports = []
    for identifier, item in PRODUCTS.items():
        assert required <= set(item), identifier
        assert item['id'] == identifier
        assert isinstance(item['port'], int) and item['port'] > 0
        ports.append(item['port'])
        assert len(item['best_practices']) >= 5, identifier
        assert all(len(text) >= 12 for text in item['best_practices']), identifier
        assert len(item['pitfalls']) >= 2, identifier
        assert len(item['suggested']) >= 2, identifier
        assert all(channel in CHANNELS for channel in item['channels']), identifier
    assert len(set(ports)) == 20
    assert set(CHANNELS) == {'documents', 'notes.english', 'data.tables'}


def test_product_lookup_by_name_and_glyph():
    assert product('mdforge')['name'] == 'Markdown 铸造台'
    assert product('铸造台')['id'] == 'mdforge'
    assert product('M')['id'] == 'mdforge'
    assert product('不存在的插件') is None


# ── 2. 每个产品的技能 ────────────────────────────────────────────────────────
def test_skill_coverage_and_depth():
    ids = [skill.id for skill in SKILLS]
    assert len(ids) == len(set(ids)) == 25
    for identifier in PRODUCT_IDS:
        assert 'omm.zen.' + identifier in ids
    for extra in ('omm.zen.hub', 'omm.zen.cross', 'omm.zen.ai', 'omm.zen.study', 'omm.zen.dev'):
        assert extra in ids
    for skill in SKILLS:
        assert SKILL_ID_RE.match(skill.id)
        assert len(skill.prompt) > 900, skill.id
        assert '最佳实践' in skill.prompt, skill.id
        assert 'omm_spec_search' in skill.prompt, skill.id
        assert 'present_artifact' in skill.prompt, skill.id
        assert skill.name and skill.description
        assert skill.tools and 'omm_live_data' in skill.context


def test_skills_available_in_workspace(ws):
    rows = ws.skills.list('default')
    omm_rows = [row for row in rows if row['id'].startswith('omm.zen.')]
    assert len(omm_rows) == 25
    assert all(row['available'] for row in omm_rows), [
        (row['id'], row.get('reason')) for row in omm_rows if not row['available']
    ]
    routed = ws.skills.route('请介绍 MDFORGE 的 Markdown 最佳实践')
    assert routed == 'omm.zen.mdforge'


# ── 3. 领域工具 ───────────────────────────────────────────────────────────────
def test_domain_tools_execute(ws):
    names = {row['name'] for row in ws.tools.schemas()}
    expected = {'omm_product_list', 'omm_product_info', 'omm_spec_search', 'omm_spec_read',
                'omm_workspace_status', 'omm_channel_info'}
    assert expected <= names
    ctx = {'account': 'default', 'conversation_id': 'conv_test'}
    result = ws.tools.execute('omm_product_list', {}, ctx)
    assert result['ok'] and result['count'] == 20
    info = ws.tools.execute('omm_product_info', {'product': '文本标注'}, ctx)
    assert info['ok'] and info['name'] == '文本标注' and info['best_practices']
    search = ws.tools.execute('omm_spec_search', {'query': 'zen-card', 'limit': 3}, ctx)
    assert search['ok'] and search['results']
    read = ws.tools.execute('omm_spec_read', {'file': 'AI_MD_SPEC.md'}, ctx)
    assert read['ok'] and 'frontmatter' in read['content']
    rejected = ws.tools.execute('omm_spec_read', {'file': '../../secret.md'}, ctx)
    assert rejected['ok'] is False
    channels = ws.tools.execute('omm_channel_info', {'channel': 'data.tables'}, ctx)
    assert channels['ok'] and any(row['id'] == 'visualization' for row in channels['channels'][0]['products'])


def test_workspace_status_never_leaks_key(ws, tmp_path, monkeypatch):
    monkeypatch.setenv('OMM_SHARED_DIR', str(tmp_path))
    (tmp_path / 'shared.json').write_text(json.dumps({
        'ai': {'provider': 'deepseek', 'apiModel': 'deepseek-chat', 'apiKey': 'sk-super-secret'}
    }), encoding='utf-8')
    status = ws.tools.execute('omm_workspace_status', {}, {'account': 'default'})
    assert status['ok'] and status['ai']['configured'] is True
    assert 'sk-super-secret' not in json.dumps(status, ensure_ascii=False)


# ── 4. 宿主事实、上下文、产物 ────────────────────────────────────────────────
def test_host_facts_and_environment(host):
    facts = host.facts()
    assert '产品清单' in facts and '规则' in facts and '共享频道' in facts
    assert 'mdforge' in facts['产品清单'] and '密钥' in facts['规则']
    env = host.environment()
    assert env.kind == 'desktop' and env.local and not env.cloud
    caps = env.capabilities()
    assert caps['python_exec'] is False and caps['cmd_exec'] is False
    assert str(KNOWLEDGE_DIR) + '\\' in [str(root) for root in host.doc_roots()] or \
        any(str(KNOWLEDGE_DIR) in root for root in host.doc_roots())


def test_context_preview_contains_omm_knowledge(ws):
    preview = ws.context_preview('zen-card 卡片格式', account='default')
    blob = json.dumps(preview, ensure_ascii=False)
    assert '项目事实' in blob or 'omm_workspace' in blob
    assert 'ZenCard' in blob or 'ZenCard' in blob or '静书房' in blob


def test_apply_artifact_text_file(host, tmp_path):
    result = host.apply_artifact('omm_markdown', {'filename': '../../bad.md', 'content': '# 标题\n正文'})
    assert result['ok'] and result['action'] == 'save_text'
    assert result['filename'] == 'bad.md' and result['filename'].endswith('.md')
    assert result['mime'] == 'text/markdown'
    with pytest.raises(AIError):
        host.apply_artifact('omm_text_file', {'filename': 'x.md', 'content': '{"apiKey":"sk-secret"}'})
    with pytest.raises(AIError):
        host.apply_artifact('unknown.kind', {})


def test_apply_artifact_cards_and_app(host):
    cards = host.apply_artifact('omm_zen_card_pack', {
        'cards': [{'format': 'zen-card', 'v': 1, 'content': '一句话卡片'}]
    })
    assert cards['ok'] and cards['action'] == 'publish_cards' and cards['channel'] == 'documents'
    with pytest.raises(AIError):
        host.apply_artifact('omm_zen_card_pack', {'cards': [{'content': ''}]})
    app = host.apply_artifact('omm_open_app', {'app': 'mdforge'})
    assert app['ok'] and app['action'] == 'open_app' and app['app'] == 'mdforge'
    with pytest.raises(AIError):
        host.apply_artifact('omm_open_app', {'app': 'not-a-product'})


def test_apply_artifact_via_workspace(ws):
    conv = ws.store.create_conversation('default', title='产物测试')['id']
    artifact = ws.store.save_artifact('default', conv, 'omm_markdown',
                                      {'filename': 'report.md', 'content': '# 报告'})
    applied = ws.apply_artifact('default', artifact['id'])
    assert applied['ok'] and applied['result']['action'] == 'save_text'
    row = ws.store.get_artifact(artifact['id'])
    assert row['status'] == 'applied'


# ── 5. 离线对话 ───────────────────────────────────────────────────────────────
def test_offline_chat_with_product_skill(ws):
    events, answer = ws.ask_text('介绍 MDFORGE 的最佳实践', provider='complete', skill='omm.zen.mdforge')
    types = [event.get('type') for event in events]
    assert 'meta' in types and 'text_delta' in types and 'done' in types
    meta = next(event for event in events if event['type'] == 'meta')
    assert meta['skill'] == 'omm.zen.mdforge'
    assert answer and 'workspace_context' not in answer or isinstance(answer, str)
    assert ws.store.list_conversations('default')


def test_provider_mapping_registers_custom_catalog(ws):
    payload = {'provider': 'custom', 'baseUrl': 'https://example.test/v1', 'model': 'my-model'}
    _resolve_provider(ws, payload)
    assert payload['provider'] == 'omm_custom' and payload['model'] == 'my-model'
    registered = ws.catalog.get('omm_custom', check_scope=False)
    assert registered is not None and registered.spec.base_url == 'https://example.test/v1'
    assert 'tools' in registered.spec.capabilities


# ── 6. Flask 路由 ─────────────────────────────────────────────────────────────
def test_flask_meta_routes(client):
    env = client.get('/api/omm/env').get_json()
    assert env['ok'] and env['products'] == 20 and env['skills'] == 25
    assert 'AI_MD_SPEC.md' in env['knowledge'] and 'PRODUCTS.md' in env['knowledge']
    products = client.get('/api/omm/products').get_json()
    assert len(products['products']) == 20 and 'documents' in products['channels']
    skills = client.get('/api/omm/skills').get_json()
    assert len(skills['skills']) == 25 and all(row['available'] for row in skills['skills'])
    bootstrap = client.get('/api/ai/bootstrap').get_json()
    assert bootstrap['ok'] and bootstrap['default_provider'] == 'complete'
    assert client.get('/api/ai/health').get_json()['ok']
    assert client.get('/').status_code == 200
    assert client.get('/omm-desktop.js').status_code == 200
    assert client.get('/omm-share.js').status_code == 200


def test_flask_spec_and_chat(client):
    spec = client.get('/api/omm/spec?file=AI_MD_SPEC.md').get_json()
    assert spec['ok'] and 'title' in spec['content']
    search = client.get('/api/omm/spec?query=latex-figure').get_json()
    assert search['ok'] and search['results']
    chat = client.post('/api/ai/chat', json={
        'text': '你能做什么？', 'provider': 'complete', 'stream': False, 'title': False,
    }).get_json()
    assert chat['ok'] and 'text_delta' in [event['type'] for event in chat['events']]
    assert chat['text']


def test_flask_ai_config_has_no_key(client, tmp_path, monkeypatch):
    monkeypatch.setenv('OMM_SHARED_DIR', str(tmp_path))
    (tmp_path / 'shared.json').write_text(json.dumps({
        'ai': {'apiKey': 'sk-leak-check', 'provider': 'deepseek'}
    }), encoding='utf-8')
    body = client.get('/api/omm/ai-config').get_data(as_text=True)
    assert 'sk-leak-check' not in body
    assert client.get('/api/omm/ai-config').get_json()['configured'] is True


# ── 7. 桌面构建契约（静态检查，避免启动 GUI） ─────────────────────────────────
def test_desktop_registration_contract():
    specs = (ROOT / 'desktop' / 'plugin_specs.py').read_text(encoding='utf-8')
    assert '"id": "ai"' in specs and '"runtime": "ai"' in specs and '"OMM-AI"' in specs
    manager = (ROOT / 'desktop' / 'plugin_manager.py').read_text(encoding='utf-8')
    assert '"ai"' in manager.split('RUNTIMES =')[1].split('\n')[0]
    hub = (ROOT / 'desktop' / 'hub_server.py').read_text(encoding='utf-8')
    assert 'def _start_ai' in hub and 'runtime == "ai"' in hub
    launcher = (ROOT / 'desktop' / 'omm_launcher.py').read_text(encoding='utf-8')
    assert 'def start_ai' in launcher and 'backend == "ai"' in launcher
    build = (ROOT / 'desktop' / 'build_exes.py').read_text(encoding='utf-8')
    assert 'def _ai_backend_args' in build and 'agent_workspace.omm_server' in build
    shared = (ROOT / 'desktop' / 'omm_shared.py').read_text(encoding='utf-8')
    assert '"ai": "AI 工作区"' in shared


def test_knowledge_files_bundled():
    expected = ['PRODUCTS.md', 'prompts.md', 'zencard.md', 'writer.md', 'annotate.md', 'corpus.md',
                'data.md', 'english.md', 'planner.md', 'visualization.md', 'latex.md', 'redact.md',
                'message.md', 'zenpack.md', 'video.md', 'lambda.md', 'table.md',
                'AI_MD_SPEC.md', 'AI_LATEX_FIGURE_SPEC.md',
                'FORMAT_VALIDATION.md', 'plugin-spec.md', 'PLUGIN-GUIDE.md']
    for name in expected:
        assert (KNOWLEDGE_DIR / name).is_file(), name
    catalog = (KNOWLEDGE_DIR / 'PRODUCTS.md').read_text(encoding='utf-8')
    for identifier, item in PRODUCTS.items():
        assert item['name'] in catalog and identifier in catalog


def test_frontend_shared_assets_are_served(client):
    """后端插件必须显式托管 zen/foundation，否则页面能打开但完全没有样式。"""
    for path in ('/zen/zen.css', '/zen/products/ai.css',
                 '/zen/features/grid.css', '/lib/zen-card.js'):
        response = client.get(path)
        assert response.status_code == 200, (path, response.status_code)
        assert 'text/css' in response.content_type or 'javascript' in response.content_type, (
            path, response.content_type)
    # 未放开整个插件目录：入口页仍走自己的路由，配置与源码不可被当静态资源读取。
    assert client.get('/zen/foundation/missing.css').status_code == 404
    assert client.get('/plugin.json').status_code == 404


def test_safe_asset_rejects_traversal(tmp_path):
    root = tmp_path / 'assets'
    root.mkdir()
    (root / 'ok.css').write_text('a{}', encoding='utf-8')
    assert _safe_asset(root, 'ok.css') == (root / 'ok.css').resolve()
    assert _safe_asset(root, '../secret.css') is None
    assert _safe_asset(root, 'missing.css') is None


def test_frontend_style_and_bridge_contract():
    html = (ROOT / 'omm-ai.html').read_text(encoding='utf-8')
    assert html.index('omm-embed.js') < html.index('omm-desktop.js') < html.index('omm-share.js')
    # OMM-ZEN 样式契约：接入 zen/foundation 共享系统（zen.css + 产品 css），并按 design token 施工。
    assert 'zen/zen.css' in html and 'zen/products/ai.css' in html
    tokens = (ROOT / 'zen/foundation' / 'tokens.css').read_text(encoding='utf-8')
    for token in ('--zen-ink', '--zen-accent', '--zen-radius', '--ink', '--accent', '--radius'):
        assert token in tokens, token
    assert not re.search(r'<script[^>]+src=["\']https?://', html)
    assert not re.search(r'<link[^>]+href=["\']https?://', html)
    for token in ['/api/ai/chat', '/api/ai/artifacts/', 'X-Provider-Key', 'OMMShare.openApp',
                  'OMMDesktop.saveText', 'omm:theme', 'Ctrl+Enter', 'omm.zen.']:
        assert token in html, token


def test_framework_blueprint_surface():
    """确认框架 adapter 仍可独立构造（升级框架时不破坏路由契约）。"""
    blueprint = create_blueprint(
        AgentWorkspace(OMMZenHostAdapter()),
        url_prefix='/api/ai', account_resolver=lambda: 'default',
    )
    assert blueprint.name == 'agent_workspace'
