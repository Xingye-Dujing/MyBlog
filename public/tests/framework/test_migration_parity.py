"""Parity checks: the invariants the 采析绘 AI workspace relied on, now domain-free.

Every test in this file corresponds to an invariant documented in the original
``docs/ai_workspace.md`` / ``AGENTS.md``. The domain itself is supplied by ``TestHost``; the engine
must not know what a node or a dataset is.
"""

from __future__ import annotations

import json

import pytest

from agent_workspace import AIError, ChatRequest
from agent_workspace.host import CallableContextSource, HostEnvironment
from agent_workspace.providers.base import CONTEXT_CLOSE, CONTEXT_OPEN


def test_one_catalog_serves_workspace_and_analyzers(offline):
    ids = set(offline.catalog.ids())
    assert 'deepseek' in ids and 'ollama' in ids
    for row in offline.providers():
        assert row['id'] in ids
    assert offline.providers('default')


def test_api_key_never_persisted(offline, host):
    key = 'sk-abcdefgh1234567890'
    offline.ask_text('hi', provider='complete', api_key=key)
    for path in host.data_dir().rglob('*'):
        if path.is_file() and path.suffix in ('.db', '.json', '.log'):
            assert key not in path.read_bytes().decode('utf-8', errors='replace')


def test_turn_is_several_rows_grouped_by_turn_id(scripted):
    events = list(scripted.ask(ChatRequest(text='go', skill='tester')))
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    rows = scripted.messages(conversation_id)
    assert len(rows) >= 3
    assert len({row['turn_id'] for row in rows}) == 1
    assert any(block.get('type') == 'tool_use' for row in rows for block in row['blocks'])
    assert any(block.get('type') == 'tool_result' for row in rows for block in row['blocks'])


def test_context_reaches_every_provider_offline(offline):
    source = CallableContextSource('facts', lambda query, payload: 'stable project facts')
    offline.host.context_sources = lambda: [source]
    events, _answer = offline.ask_text('hi', provider='complete')
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    user_row = offline.messages(conversation_id)[0]
    assert 'stable project facts' in user_row['meta']['context_text']
    # The replay wrapper is applied at the transport layer, not to the stored row.
    assert 'stable project facts' not in user_row['blocks'][0]['text']


def test_writes_are_artifacts_not_side_effects(offline, host):
    from agent_workspace.types import ToolSpec

    def propose(args, ctx):
        offline.store.save_artifact(ctx['account'], ctx['conversation_id'], 'note', {'text': 'proposed'})
        return {'ok': True}

    offline.tools.register(ToolSpec('propose', 'propose', {'type': 'object', 'properties': {}}, handler=propose))
    from agent_workspace import SkillSpec

    offline.skills.register(SkillSpec('proposer', 'n', 'd', 'p', tools=('propose',)))
    offline.settings.set('tools.max_rounds', 1)
    events, _ = offline.ask_text('go', skill='proposer', provider='complete', context_payload={'tool_mode': 'call'})
    assert host.applied == []  # nothing was applied to the host
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    assert offline.artifacts('default', conversation_id)


def test_omission_is_reported_not_silent(offline):
    offline.settings.set('context.max_chars', 2000)
    offline.settings.set('context.scope', 'summary')
    for index in range(30):
        offline.host.facts = lambda i=index: {'summary': 'x' * 1000, 'extra': 'y' * 500}
    text, meta = offline.context.build('hi', 'default')
    assert isinstance(meta['omitted'], list)
    assert meta['chars'] == len(text)


def test_cloud_refuses_local_tools_by_name(offline):
    offline.host._environment = HostEnvironment(kind='cloud')
    with pytest.raises(AIError) as exc:
        offline.tools.execute('run_cmd', {'command': 'echo hi'}, {'account': 'default'})
    assert exc.value.kind == 'capability'


def test_control_tools_never_in_skill_allowlist(offline):
    names = [schema['name'] for schema in offline.tools.schemas({'project_facts'})]
    assert 'present_artifact' in names  # control tools are engine-owned
    assert 'workspace_write' not in names


def test_memory_duplicate_and_context_reports_omitted(offline):
    first = offline.add_memory('default', 'note')
    assert offline.add_memory('default', 'note')['duplicate'] is True
    _text, meta = offline.context.build('hi', 'default')
    assert meta['memories']['total'] == 1
    assert meta['memories']['shown'] == 1
    assert offline.delete_memory('default', first['id']) is True


def test_bootstrap_is_framework_agnostic(offline):
    data = offline.bootstrap('default')
    assert data['ok'] is True
    assert {'providers', 'skills', 'tools', 'runtime', 'settings', 'settings_schema'} <= set(data)
    assert json.dumps(data, ensure_ascii=False, default=str)


def test_context_wrapper_identifiers_are_generic(offline):
    assert CONTEXT_OPEN == '<workspace_context>'
    assert CONTEXT_CLOSE == '</workspace_context>'
