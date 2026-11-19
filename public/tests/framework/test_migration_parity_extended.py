"""Extended parity checks for the migration defects found by the audit.

Each test corresponds to a concrete regression: a dropped system prompt, a lost analyzer path,
column-only isolation, an unenforced tool offer list, built-in shadowing, a vanished transcript on
crash, and the missing durable question/retry contract. The domain itself stays in ``TestHost``.
"""

from __future__ import annotations

import pytest

from agent_workspace import AIError, ChatRequest, ToolSpec
from agent_workspace.host import CallableContextSource, HostEnvironment
from agent_workspace.types import text_block, tool_use_block
from agent_workspace.util import event


class CapturingProvider:
    """A transport that records its last payload and emits one text delta."""

    spec = None

    def __init__(self, identifier='capture', events=None):
        from agent_workspace.types import ModelSpec, ProviderSpec

        self.spec = ProviderSpec(
            id=identifier,
            label_key='n',
            notes_key='n',
            protocol='capture',
            base_url='',
            models=(ModelSpec('capture', 'capture', 32000, frozenset({'tools', 'ask_user', 'title', 'web_search'})),),
            requires_key=False,
            capabilities=frozenset({'tools', 'ask_user', 'title', 'web_search'}),
        )
        self.payloads: list[dict] = []
        self._events = events

    def stream(self, request):
        self.payloads.append(request)
        if self._events:
            yield from self._events
        else:
            yield event('text_delta', text='captured')
            yield event('done', stop_reason='end_turn')

    def supports(self, capability, model=''):
        return capability in self.spec.capabilities

    def context_window(self, model=''):
        return 32000


def _capture(offline):
    provider = CapturingProvider()
    offline.catalog.register(provider)
    offline.settings.set('chat.default_provider', 'capture')
    return provider


# ── system prompt + transport wiring ───────────────────────────────────────────


def test_system_prompt_reaches_the_provider(offline):
    provider = _capture(offline)
    offline.ask_text('hello', provider='capture')
    assert provider.payloads
    system = provider.payloads[0]['system']
    assert 'operating in a' in system
    assert 'Writes are proposals' in system


def test_chat_once_uses_one_call_and_no_conversation_rows(offline, host):
    provider = _capture(offline)
    before = len(offline.store.list_conversations('default'))
    text = offline.chat_once('capture', '', '', 'one prompt')
    after = len(offline.store.list_conversations('default'))
    assert text == 'captured'
    assert before == after
    assert provider.payloads[0]['thinking'] is False
    assert provider.payloads[0]['title'] is False
    assert provider.payloads[0]['messages'] == [{'role': 'user', 'content': 'one prompt'}]


def test_chat_once_refuses_empty_answer(offline):
    provider = CapturingProvider(events=[event('done', stop_reason='end_turn')])
    offline.catalog.register(provider)
    with pytest.raises(AIError) as exc:
        offline.chat_once('capture', '', '', 'one prompt')
    assert exc.value.kind == 'bad_response'


# ── isolation ──────────────────────────────────────────────────────────────────


def test_store_resolves_db_path_at_call_time(tmp_path):
    from agent_workspace import AgentWorkspace
    from agent_workspace.host import DefaultHostAdapter

    current = {'account': 'alice'}

    class SwitchingHost(DefaultHostAdapter):
        def data_dir(self):
            return tmp_path / 'users' / current['account']

        def account(self):
            return current['account']

    workspace = AgentWorkspace(SwitchingHost())
    try:
        alice = workspace.store.create_conversation('alice', title='alice only')
        assert workspace.store.get_conversation(alice['id'])
        current['account'] = 'bob'
        assert workspace.store.get_conversation(alice['id']) == {}
        assert workspace.store.list_conversations('bob') == []
    finally:
        workspace.close()


def test_provider_scope_blocks_cross_account_call(offline):
    provider = CapturingProvider()
    offline.catalog.register(provider, owner='alice')
    with pytest.raises(AIError):
        offline.catalog.get('capture', 'bob')
    assert offline.catalog.get('capture', 'alice') is provider


def test_tool_scope_blocks_cross_account_execution(offline):
    offline.tools.register(
        ToolSpec('alice.tool', 'private', {'type': 'object', 'properties': {}}, handler=lambda args, ctx: {'ok': True}),
        owner='alice',
    )
    assert offline.tools.execute('alice.tool', {}, {'account': 'alice'})['ok'] is True
    with pytest.raises(AIError):
        offline.tools.execute('alice.tool', {}, {'account': 'bob'})


def test_plugin_cannot_override_builtin_tool_or_provider(offline):
    manifest = {
        'id': 'bad.pack',
        'api': 1,
        'kind': 'tool-pack',
        'permissions': ['tools.contribute'],
        'contributions': {'tools': [{'name': 'run_cmd', 'description': 'x'}]},
    }
    with pytest.raises(AIError) as exc:
        offline.install_plugin(manifest, 'alice')
    assert exc.value.key == 'plugin.builtinConflict'
    manifest['contributions'] = {'providers': [{'id': 'deepseek', 'transport': 'openai_compat'}]}
    with pytest.raises(AIError):
        offline.install_plugin(manifest, 'alice')


def test_plugin_owner_cannot_be_reassigned(offline):
    manifest = {
        'id': 'owned.pack',
        'api': 1,
        'kind': 'skill-pack',
        'permissions': ['skills.contribute'],
        'contributions': {'skills': [{'id': 'owned.skill', 'prompt': 'hi'}]},
    }
    offline.install_plugin(manifest, 'alice')
    with pytest.raises(AIError) as exc:
        offline.toggle_plugin('owned.pack', 'bob', enabled=False)
    assert exc.value.key == 'plugin.foreign'


# ── tool offer list ────────────────────────────────────────────────────────────


def test_execute_refuses_a_tool_not_offered_this_turn(offline):
    with pytest.raises(AIError) as exc:
        offline.tools.execute('run_cmd', {'command': 'echo hi'}, {'account': 'default'}, allowed=set())
    assert exc.value.key == 'tool.notOffered'


def test_chat_only_turn_refuses_a_generic_tool(offline):
    events = []
    provider = CapturingProvider(
        events=[
            event('tool_call', id='c1', name='project_facts', arguments={}),
            event('done', stop_reason='tool_calls'),
        ]
    )
    offline.catalog.register(provider)
    offline.settings.set('chat.default_provider', 'capture')
    for item in offline.ask(ChatRequest(text='go', context_payload={'chat_only': True})):
        events.append(item)
    results = [item for item in events if item['type'] == 'tool_result']
    assert results and results[0]['content'].get('error') == 'tool.notOffered'


# ── streaming / crash / resume ─────────────────────────────────────────────────


def test_assistant_row_exists_as_streaming_during_call(offline):
    seen = {}

    class ObserveProvider(CapturingProvider):
        def stream(self, request):
            yield event('text_delta', text='partial')
            seen['rows'] = offline.store.list_messages(offline.store.list_conversations('default')[-1]['id'])
            yield event('done', stop_reason='end_turn')

    provider = ObserveProvider()
    offline.catalog.register(provider)
    offline.settings.set('chat.default_provider', 'capture')
    list(offline.ask(ChatRequest(text='hi')))
    assert any(row['role'] == 'assistant' and row['status'] == 'streaming' for row in seen['rows'])


def test_cancel_settles_streaming_row_not_error(offline):
    import threading

    cancel = threading.Event()

    class CancelProvider(CapturingProvider):
        def stream(self, request):
            yield event('text_delta', text='partial')
            cancel.set()
            yield event('done', stop_reason='end_turn')

    provider = CancelProvider()
    offline.catalog.register(provider)
    offline.settings.set('chat.default_provider', 'capture')
    events = list(offline.ask(ChatRequest(text='hi', cancel_event=cancel)))
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    rows = offline.messages(conversation_id)
    assert rows[-1]['role'] == 'assistant'
    assert rows[-1]['status'] in ('done', 'interrupted')


def test_retry_reuses_last_user_turn_without_new_user_row(offline):
    provider = _capture(offline)
    events, _ = offline.ask_text('original question', provider='capture')
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    before = len([row for row in offline.messages(conversation_id) if row['role'] == 'user'])
    list(offline.retry(conversation_id))
    after = len([row for row in offline.messages(conversation_id) if row['role'] == 'user'])
    assert before == after == 1
    assert provider.payloads[-1]['messages'][-1]['content'].endswith('original question')


def test_orphan_tool_use_is_repaired_before_next_turn(offline, scripted):
    conversation = offline.store.create_conversation('default')
    offline.store.append_message(conversation['id'], 'turn_1', 'user', [text_block('go')])
    offline.store.append_message(
        conversation['id'], 'turn_1', 'assistant', [tool_use_block('orphan_1', 'ping', {})], status='done'
    )
    rows = offline.agent.repair_tool_pairs(offline.store.list_messages(conversation['id']), 'turn_2')
    assert any(row.get('role') == 'tool' for row in rows)
    assert offline.store.list_messages(conversation['id'])[-1]['blocks'][0]['content'] == {'interrupted': True}


def test_citation_and_server_tool_events_are_persisted(offline):
    provider = CapturingProvider(
        events=[
            event('citation', payload={'url': 'https://example.test'}),
            event('server_tool', payload={'type': 'deepseek_web_search', 'signature': 'sig'}),
            event('text_delta', text='answer'),
            event('done', stop_reason='end_turn'),
        ]
    )
    offline.catalog.register(provider)
    offline.settings.set('chat.default_provider', 'capture')
    events = list(offline.ask(ChatRequest(text='hi')))
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    row = [row for row in offline.messages(conversation_id) if row['role'] == 'assistant'][-1]
    assert row['meta']['citations'] == [{'url': 'https://example.test'}]
    assert row['meta']['server_tools']


# ── named refusals / i18n ──────────────────────────────────────────────────────


def test_error_key_is_serialized_only_when_set():
    assert AIError('nope', kind='refused', reason='missing').to_dict() == {
        'ok': False,
        'error': 'nope',
        'kind': 'refused',
        'reason': 'missing',
    }
    data = AIError('nope', kind='refused', key='tool.no').to_dict()
    assert data['key'] == 'tool.no'


def test_bootstrap_explains_hidden_local_provider(offline):
    offline.host._environment = HostEnvironment(kind='cloud')
    rows = {row['id']: row for row in offline.bootstrap('default')['providers']}
    assert rows['ollama']['available'] is False
    assert rows['ollama']['why_not'] == 'provider.localCloud'
    assert rows['ollama']['why_not_text']


def test_context_source_may_read_account(offline):
    seen = {}

    def builder(query, payload, account):
        seen['account'] = account
        return f'facts for {account}'

    offline.host.context_sources = lambda: [CallableContextSource('live', builder)]
    offline.context.build('hi', 'alice')
    assert seen['account'] == 'alice'


def test_skill_validation_and_deterministic_route(offline):
    from agent_workspace.skills import validate_manifest

    with pytest.raises(ValueError):
        validate_manifest({'id': 'bad', 'prompt': 'import os'})
    with pytest.raises(AIError):
        offline.save_skill('default', {'id': 'bad.tool', 'prompt': 'hi', 'tools': ['present_artifact']})
    assert offline.skills.route('please clean the workspace', 'default') == 'workspace'
    listed = {row['id']: row for row in offline.skills.list('default')}
    assert 'why_not' in listed['developer']


def test_python_status_reports_both_contract_names(offline):
    status = offline.bootstrap('default')['python']
    assert status['sandbox'] is False
    assert 'CIXI_INPUT' in status['contract']['input']
    assert 'AGENT_OUTPUT' in status['contract']['output']
