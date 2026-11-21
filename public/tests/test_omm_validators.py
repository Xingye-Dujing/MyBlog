# -*- coding: utf-8 -*-
"""导入导出格式校验器 / 模板 / 工具 / 接口的全面测试。"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from agent_workspace.omm_data import PRODUCT_IDS  # noqa: E402
from agent_workspace.omm_server import create_app  # noqa: E402
from agent_workspace.omm_validators import (  # noqa: E402
    TEMPLATES, formats_for, js_checksum, validate,
)
from agent_workspace.service import AgentWorkspace  # noqa: E402
from agent_workspace.omm_host import OMMZenHostAdapter  # noqa: E402


def tpl(pid: str, kind: str) -> str:
    data = formats_for(pid)
    assert data.get('ok'), (pid, data)
    for row in data['formats']:
        if row['kind'] == kind:
            return row['template']
    raise AssertionError('no template for %s/%s' % (pid, kind))


def obj(pid: str, kind: str) -> dict:
    return json.loads(tpl(pid, kind))


@pytest.fixture()
def ws(tmp_path):
    workspace = AgentWorkspace(OMMZenHostAdapter(data_dir=tmp_path / 'ai'))
    for spec in workspace.host.tools():
        workspace.tools.register(spec)
    return workspace


@pytest.fixture()
def client(tmp_path):
    app = create_app(plugin_dir=ROOT, data_dir=tmp_path / 'ai')
    app.config['TESTING'] = True
    return app.test_client()


# ── 模板本身可校验 ───────────────────────────────────────────────────────────
def test_every_product_has_templates():
    assert set(TEMPLATES) == set(PRODUCT_IDS) | {'hub'}
    for identifier in PRODUCT_IDS:
        data = formats_for(identifier)
        assert data['ok'] and data['formats'], identifier
        assert data['formats_from_spec'], identifier
        assert data['best_practices'], identifier


def test_templates_validate_clean():
    for identifier in TEMPLATES:
        for row in formats_for(identifier)['formats']:
            result = validate(identifier, row['template'], row['kind'])
            # 消息同步/脱敏工具本来就没有文件导入，校验器按设计报错。
            if row['kind'] == 'unsupported':
                assert not result['ok'] and result['errors']
            else:
                assert result['ok'], (identifier, row['kind'], result['errors'])


# ── 真实硬约束 ───────────────────────────────────────────────────────────────
@pytest.mark.parametrize('pid,kind,mutate,expect', [
    ('annotate', 'backup', lambda o: o['project'].pop('codes') and None, 'codes'),
    ('corpus', 'restore', lambda o: o.pop('categories') and None, 'categories'),
    ('data', 'rows', lambda o: {'tables': []}, 'tables'),
    ('english', 'doodles', lambda o: o['drawings']['word']['strokes'][0]['points'][0].update(x=2000), 'x'),
    ('planner', 'backup', lambda o: o.update(version='2'), 'version'),
    ('visualization', 'properties', lambda o: o.update(kind='wrong'), 'kind'),
    ('writer', 'canvas', lambda o: o['nodes'][0].update(x=0), 'x'),
    ('zencard', 'pack', lambda o: o['cards'][0].update(kind='bogus'), 'kind'),
    ('zenflow', 'rules', lambda o: o[0]['actions'][0].update(type='dropDatabase'), 'type'),
    ('zenbackup', 'manifest', lambda o: o['products'][0].update(checksum='wrong'), 'checksum'),
    ('table', 'workflow', lambda o: o.update(format='wrong'), 'format'),
    ('table', 'workflow', lambda o: o['nodes'].append(dict(o['nodes'][0])), '重复'),
    ('table', 'workflow', lambda o: o['connections'][0].update(to='missing'), '不存在'),
    ('table', 'workflow', lambda o: o['nodes'][1].update(type='dropDatabase'), '节点类型'),
    ('hub', 'ai-config', lambda o: o.update(apiKey='sk-secret'), 'apiKey'),
])
def test_hard_gates_rejected(pid, kind, mutate, expect):
    data = obj(pid, kind)
    data = mutate(data) or data  # 有的用例就地修改，有的整体替换
    result = validate(pid, json.dumps(data, ensure_ascii=False), kind)
    assert not result['ok']
    assert any(expect in error for error in result['errors']), (pid, result['errors'])


def test_text_format_gates():
    latex = validate('latex', '正文但没有文档类', 'tex')
    assert not latex['ok'] and any('documentclass' in e for e in latex['errors'])
    latex2 = validate('latex', tpl('latex', 'tex').replace('\\begin{document}', '\\input{other}'), 'tex')
    assert not latex2['ok'] and any('input' in e for e in latex2['errors'])
    md = validate('mdforge', '# 没有 frontmatter', 'markdown')
    assert not md['ok'] and any('frontmatter' in e for e in md['errors'])
    csv = validate('data', 'a,b\n1,2,3\n', 'csv')
    assert not csv['ok'] and any('列数不一致' in e for e in csv['errors'])
    bad_json = validate('zencard', '{ "format": "zen-card", }', 'card')
    assert not bad_json['ok'] and 'JSON 解析失败' in bad_json['errors'][0]


def test_unsupported_products_are_explicit():
    for pid in ('message', 'redact'):
        result = validate(pid, '{}', 'unsupported')
        assert not result['ok'] and result['kind'] == 'unsupported'
        assert '导入' in result['errors'][0]


def test_auto_detection():
    assert validate('annotate', tpl('annotate', 'bridge'))['kind'] == 'bridge'
    assert validate('english', tpl('english', 'doodles'))['kind'] == 'doodles'
    assert validate('english', tpl('english', 'backup'))['kind'] == 'backup'
    assert validate('writer', tpl('writer', 'library'))['kind'] == 'library'
    assert validate('zenreview', tpl('zenreview', 'timeline'))['kind'] == 'timeline'
    assert validate('visualization', tpl('visualization', 'properties'))['kind'] == 'properties'
    assert validate('search', tpl('search', 'export'))['kind'] == 'export'


def test_json_input_and_unknown_product():
    assert validate('zencard', obj('zencard', 'card'))['ok']
    unknown = validate('not-a-product', '{}')
    assert not unknown['ok'] and '未知产品' in unknown['errors'][0]


def test_checksum_matches_browser_implementation():
    # 与 lib/zen-backup.js 用 node 实算的结果一致（含中文）。
    assert js_checksum([]) == 'w7k42t'
    assert js_checksum({'a': '中文', 'b': [1, 2]}) == 'xcp1c5'
    data = obj('zenbackup', 'manifest')
    data['products'][0]['data'] = {'内容': '中文'}
    data['products'][0]['checksum'] = js_checksum(data['products'][0]['data'])
    assert validate('zenbackup', data)['ok']
    data['products'][0]['checksum'] = 'bad'
    assert not validate('zenbackup', data)['ok']


def test_referential_integrity_messages():
    corpus = obj('corpus', 'restore')
    corpus['entries'][0]['categoryId'] = 'missing'
    result = validate('corpus', corpus)
    assert any('categoryId' in e for e in result['errors'])

    annotate = obj('annotate', 'backup')
    annotate['project']['anns'][0]['quote'] = '错误的引文'
    result = validate('annotate', annotate)
    assert any('quote' in e for e in result['errors'])

    writer = obj('writer', 'canvas')
    writer['connections'] = [{'from': 'node-1', 'to': 'node-999'}]
    result = validate('writer', writer)
    assert any('端点' in e for e in result['errors'])


# ── 工具 / 接口 ──────────────────────────────────────────────────────────────
def test_domain_tools(ws):
    names = {row['name'] for row in ws.tools.schemas()}
    assert {'omm_format_list', 'omm_format_template', 'omm_format_validate'} <= names
    ctx = {'account': 'default'}
    listing = ws.tools.execute('omm_format_list', {}, ctx)
    assert listing['ok'] and len(listing['products']) == 21
    template = ws.tools.execute('omm_format_template', {'product': 'zencard', 'kind': 'pack'}, ctx)
    assert template['ok'] and template['templates'][0]['kind'] == 'pack'
    good = ws.tools.execute('omm_format_validate', {
        'product': 'zencard', 'content': template['templates'][0]['template']}, ctx)
    assert good['ok'] and good['kind'] == 'pack'
    broken = copy.deepcopy(json.loads(template['templates'][0]['template']))
    broken['cards'][0]['content'] = ''
    bad = ws.tools.execute('omm_format_validate', {
        'product': 'zencard', 'content': broken, 'kind': 'pack'}, ctx)
    assert not bad['ok'] and 'content' in bad['errors'][0]


def test_http_routes(client):
    listing = client.get('/api/omm/formats').get_json()
    assert listing['ok'] and len(listing['products']) == 21
    detail = client.get('/api/omm/formats?product=mdforge').get_json()
    assert detail['product'] == 'mdforge' and detail['formats']
    template = client.get('/api/omm/template?product=zencard&kind=card').get_json()
    assert template['ok']
    result = client.post('/api/omm/validate', json={
        'product': 'zencard', 'content': template['templates'][0]['template']}).get_json()
    assert result['ok']
    assert client.post('/api/omm/validate', data='not json', content_type='application/json').status_code == 400


def test_skills_instruct_validate_first(ws):
    rows = [row for row in ws.skills.list('default') if row['id'].startswith('omm.zen.')]
    assert all('omm_format_template' in row['tools'] for row in rows)
    assert all('omm_format_validate' in row['tools'] for row in rows)
    from agent_workspace.omm_skills import SKILL_BY_ID
    prompt = SKILL_BY_ID['omm.zen.zencard'].prompt
    assert 'omm_format_validate' in prompt and 'ok=true' in prompt


def test_frontend_validation_contract():
    html = (ROOT / 'omm-ai.html').read_text(encoding='utf-8')
    for token in ('data-tab="validate"', 'id="valProduct"', 'id="valKind"',
                  'id="btnValidate"', '/api/omm/validate', '/api/omm/template',
                  'omm_format_validate', '校验格式'):
        assert token in html, token


# ── 不可信导入不得让校验器崩溃 / 合法内容不得被误拒 ─────────────────────────

def test_annotate_quote_uses_utf16_offsets():
    text = '\U0001f600hello'  # emoji precedes the annotation (surrogate pair in JS)
    backup = {
        'app': 'zenmark', 'version': 1,
        'project': {
            'docs': [{'id': 'd1', 'text': text}],
            'codes': [{'id': 'c1'}],
            'anns': [{'id': 'a1', 'doc': 'd1', 'code': 'c1', 'start': 2, 'end': 7, 'quote': 'hello'}],
        },
    }
    result = validate('annotate', json.dumps(backup, ensure_ascii=False), 'backup')
    assert not any('quote' in item for item in result['errors']), result['errors']


def test_english_doodles_points_non_list_reports_error_not_crash():
    result = validate('english', {'drawings': {'word': {'strokes': [{'points': 5}]}}}, 'doodles')
    assert not result['ok']
    assert any('points' in item for item in result['errors'])


def test_english_backup_books_non_dict_reports_error_not_crash():
    result = validate('english', {'books': [1], 'prog': {}}, 'backup')
    assert not result['ok']
    assert any('books' in item for item in result['errors'])


def test_planner_events_non_list_reports_error_not_crash():
    payload = {'app': 'zenplan', 'version': 2, 'planners': [{'id': 'p1'}],
               'eventsBy': {'p1': {'2026-01-01': 5}}, 'recursBy': {'p1': []}}
    result = validate('planner', payload, 'backup')
    assert not result['ok']
    assert any('事件数组' in item for item in result['errors'])


def _mdforge(body: str) -> str:
    return '---\ntitle: T\ntemplate: academic\n---\n\n' + body


def test_mdforge_http_link_is_not_rejected_as_remote_image():
    result = validate('mdforge', _mdforge('See [ref](https://example.com/paper) for details.'), 'markdown')
    assert not any('远程图片' in item for item in result['errors']), result['errors']


def test_mdforge_remote_image_still_rejected():
    result = validate('mdforge', _mdforge('![](https://example.com/a.png)'), 'markdown')
    assert any('远程图片' in item for item in result['errors'])


def test_mdforge_whitespace_image_destination_does_not_crash():
    result = validate('mdforge', _mdforge('![](   )'), 'markdown')
    assert isinstance(result['errors'], list)


def test_mdforge_code_block_as_first_body_block_is_allowed():
    result = validate('mdforge', _mdforge('```python\nprint(1)\n```\n\nSome prose.'), 'markdown')
    assert not any('代码围栏包裹' in item for item in result['errors']), result['errors']


def test_mdforge_whole_body_fence_still_rejected():
    result = validate('mdforge', _mdforge('```markdown\n# Title\n```'), 'markdown')
    assert any('代码围栏包裹' in item for item in result['errors'])


def test_mdforge_includegraphics_not_flagged_as_include():
    result = validate('mdforge', _mdforge(
        '```latex-figure\n\\begin{figure}\n\\includegraphics[width=0.5\\textwidth]{images/a.png}\n\\end{figure}\n```'
    ), 'markdown')
    assert not any('禁止 \\include' in item for item in result['errors']), result['errors']
