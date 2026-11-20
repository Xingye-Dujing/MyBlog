"""Regressions for agent/provider correctness bugs found in the second audit.

    python -m pytest public/tests/framework/test_agent_bugfixes.py -q
"""
from __future__ import annotations

import json

import pytest

from agent_workspace import AIError, ChatRequest
from agent_workspace.errors import AIProviderError
from agent_workspace.providers.base import Provider, event
from agent_workspace.providers.ollama import OllamaProvider
from agent_workspace.providers.openai_compat import OpenAICompatibleProvider
from agent_workspace.python_scripts import ScriptLibrary
from agent_workspace.store import Store
from agent_workspace.types import ModelSpec, ProviderSpec, ToolSpec


class _Spy(Provider):
    spec = ProviderSpec(
        id='spy', label_key='n', notes_key='n', protocol='spy', base_url='',
        models=(ModelSpec('spy', 'spy', 32000, frozenset()),),
        requires_key=False, capabilities=frozenset(),
    )

    def __init__(self):
        self.seen = []

    def stream(self, request):
        self.seen.append([m['role'] for m in request.get('messages') or []])
        yield event('text_delta', text='ok')
        yield event('done', stop_reason='end_turn')


class _Loop(Provider):
    spec = ProviderSpec(
        id='loop', label_key='n', notes_key='n', protocol='loop', base_url='',
        models=(ModelSpec('loop', 'loop', 32000, frozenset({'tools'})),),
        requires_key=False, capabilities=frozenset({'tools'}),
    )

    def stream(self, request):
        yield event('tool_call', id='c1', name='ping', arguments={})
        yield event('done', stop_reason='tool_calls')


class _Frame:
    def __init__(self, payload):
        self._data = ('data: ' + json.dumps(payload) + '\n\n').encode('utf-8')

    def iter_content(self, chunk_size=1024):
        yield self._data


def test_user_message_is_sent_to_provider_exactly_once(offline):
    spy = _Spy()
    offline.catalog.register(spy)
    offline.ask_text('HELLO', provider='spy')
    roles = spy.seen[0]
    assert roles.count('user') == 1, roles


def test_ollama_replay_preserves_canonical_tool_calls():
    messages = [
        {'role': 'assistant', 'content': '', 'tool_calls': [
            {'id': 'c1', 'type': 'function',
             'function': {'name': 'ping', 'arguments': '{"x": 1}'}},
        ]},
        {'role': 'tool', 'tool_call_id': 'c1', 'content': '{"pong": true}'},
    ]
    out = OllamaProvider._messages({'messages': messages})
    assistant = next(item for item in out if item['role'] == 'assistant')
    tool = next(item for item in out if item['role'] == 'tool')
    call = assistant['tool_calls'][0]
    assert call['function']['name'] == 'ping'
    assert call['function']['arguments'] == {'x': 1}
    assert tool['tool_call_id'] == 'c1'


def test_openai_compat_raises_on_mid_stream_error_frame():
    provider = OpenAICompatibleProvider.__new__(OpenAICompatibleProvider)

    class _Stream:
        def iter_content(self, chunk_size=1024):
            yield _Frame({'error': {'message': 'model overloaded'}})._data

    with pytest.raises(AIProviderError) as exc:
        list(provider.decode(_Stream()))
    assert 'model overloaded' in exc.value.detail


def test_foreign_conversation_id_is_refused_not_integrity_error(workspace):
    own = workspace.store.create_conversation('alice', title='A')
    with pytest.raises(AIError) as exc:
        list(workspace.ask(ChatRequest(text='hi', account='bob',
                                       conversation_id=own['id'], provider='complete')))
    assert exc.value.key == 'conversation.foreign'


def test_registered_omm_tools_are_offered_to_skills():
    from agent_workspace.omm_skills import COMMON_TOOLS
    from agent_workspace.omm_tools import TOOLS

    offered = {spec.name for spec in TOOLS}
    for name in ('omm_spec_read', 'omm_channel_info'):
        assert name in offered, name
        assert name in COMMON_TOOLS, name


def test_builtin_scripts_seed_for_multiple_accounts(tmp_path):
    store = Store(tmp_path / 'ai.db')
    library = ScriptLibrary(store)
    assert 'clean_text' in {row['id'] for row in library.all('default')}
    assert 'alice:clean_text' in {row['id'] for row in library.all('alice')}
    assert library.code('alice', 'clean_text')
    with pytest.raises(ValueError, match='another account'):
        store.save_script('bob', {'id': 'alice:clean_text', 'name': 'x'})


def test_rounds_question_stop_ends_turn(offline):
    offline.catalog.register(_Loop())
    offline.settings.set('chat.default_provider', 'loop')
    offline.tools.register(
        ToolSpec('ping', 'Ping', {'type': 'object', 'properties': {}},
                 handler=lambda args, ctx: {'pong': True})
    )
    offline.settings.set('tools.max_rounds', 1)
    first = list(offline.ask(ChatRequest(text='go', skill='general', provider='loop')))
    question = next(item for item in first if item['type'] == 'question')
    assert question['kind'] == 'rounds'
    answer = ChatRequest(
        text='', skill='general', provider='loop',
        answers={question['call_id']: {'selected': ['Stop']}},
        resume_call_id=question['call_id'],
        context_payload=first[-1].get('conversation_id') and {},
    )
    conv = next(item['conversation_id'] for item in first if item['type'] == 'meta')
    answer.conversation_id = conv
    resumed = list(offline.ask(answer))
    assert any(item['type'] == 'done' and item.get('stop_reason') == 'max_rounds' for item in resumed)
    assert not any(item['type'] == 'question' for item in resumed)
