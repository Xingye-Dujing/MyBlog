from __future__ import annotations

from agent_workspace.host import CallableContextSource


def test_project_facts_are_generated_from_host(workspace):
    text = workspace.context.project_facts()
    assert 'A test product' in text
    assert '节点' in text
    assert 'catbus' in text  # host capability
    assert 'count, mean' in text


def test_context_scope_off(workspace):
    text, meta = workspace.context.build('hi', 'default', {'scope': 'off'})
    assert text == ''
    assert meta['scope'] == 'off'


def test_context_budget_reports_omissions(workspace):
    workspace.settings.set('context.max_chars', 2000)
    workspace.settings.set('context.scope', 'full')
    text, meta = workspace.context.build('图表', 'default')
    assert meta['budget'] == 2000
    assert len(text) <= 2000 + 40
    assert isinstance(meta['omitted'], list)
    assert meta['chars'] == len(text)


def test_context_redacts_secrets(workspace, tmp_path):
    source = CallableContextSource('secret_source', lambda query, payload: 'key sk-abcdefgh1234')
    workspace.host.context_sources = lambda: [source]
    text, _meta = workspace.context.build('hi', 'default')
    assert 'sk-abcdefgh1234' not in text
    assert '[redacted]' in text


def test_context_includes_host_sources_and_memories(workspace):
    workspace.add_memory('default', 'user likes charts')
    source = CallableContextSource('canvas', lambda query, payload: 'canvas with 3 nodes')
    workspace.host.context_sources = lambda: [source]
    text, meta = workspace.context.build('hi', 'default')
    assert 'canvas with 3 nodes' in text
    assert 'user likes charts' in text
    assert meta['memories']['shown'] == 1
    assert any(item['title'] == 'canvas' for item in meta['items'])


def test_memory_context_limits_to_20(workspace):
    for index in range(23):
        workspace.add_memory('default', f'memory {index}')
    _text, meta = workspace.context.build('hi', 'default')
    assert meta['memories']['total'] == 23
    assert meta['memories']['shown'] == 20
    assert meta['memories']['omitted'] == 3


def test_docs_search_uses_bigrams(workspace):
    results = workspace.context.docs_search('评论采集', limit=3)
    assert results
    assert results[0]['title']


def test_replay_block_is_stable_and_clamped(workspace):
    workspace.settings.set('context.replay_chars', 1000)
    text = '长' * 2000
    clamped, meta = workspace.context.for_replay(text)
    assert meta['replay_truncated'] is True
    assert len(clamped) <= 1000 + 100
    assert 'read the rest with a tool' in clamped
    workspace.settings.set('context.replay_chars', 16000)
    same, same_meta = workspace.context.for_replay('abc')
    assert same == 'abc'
    assert same_meta['replay_truncated'] is False


def test_context_preview_shape(workspace):
    preview = workspace.context_preview('hi', 'default')
    assert preview['ok'] is True
    assert 'meta' in preview and 'context' in preview
