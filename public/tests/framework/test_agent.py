from __future__ import annotations

import threading

import pytest
from scripted_provider import ScriptedProvider

from agent_workspace import AIError, ChatRequest
from agent_workspace.errors import AIProviderError
from agent_workspace.providers.base import Provider
from agent_workspace.types import ModelSpec, ProviderSpec, SkillSpec


def test_full_turn_persists_rows_and_events(offline):
    events, answer = offline.ask_text('hello', provider='complete')
    assert answer.endswith('hello')  # the context wrapper precedes the user's words at transport level
    kinds = [item['type'] for item in events]
    assert kinds[0] == 'meta'
    assert kinds[-1] == 'done'
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    rows = offline.messages(conversation_id)
    assert [row['role'] for row in rows] == ['user', 'assistant']
    assert 'workspace_context' not in rows[0]['blocks'][0]['text']
    assert rows[0]['meta']['context_text']  # replay block stored on the user's own row


def test_tool_round_is_persisted_with_result(scripted):
    events = list(scripted.ask(ChatRequest(text='go', skill='tester')))
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    kinds = [item['type'] for item in events]
    assert 'tool_start' in kinds
    assert 'tool_result' in kinds
    rows = scripted.messages(conversation_id)
    assert any(block.get('name') == 'ping' for row in rows for block in row['blocks'])
    assert any(
        block.get('type') == 'tool_result' and block['content'] == {'pong': True}
        for row in rows
        for block in row['blocks']
    )
    text = ''.join(item.get('text', '') for item in events if item['type'] == 'text_delta')
    assert text == 'answer after tool'


def test_question_pause_and_resume(scripted):
    scripted.catalog.unregister('scripted')
    scripted.catalog.register(
        ScriptedProvider(tool='ask_user_question', args={'question': 'Pick one', 'options': ['Yes', 'No']})
    )
    events = list(scripted.ask(ChatRequest(text='go', skill='tester')))
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    question = next(item for item in events if item['type'] == 'question')
    assert question['question'] == 'Pick one'
    assert any(item['type'] == 'paused' for item in events)
    resumed = list(scripted.answer(conversation_id, question['call_id'], {question['call_id']: {'selected': ['Yes']}}))
    text = ''.join(item.get('text', '') for item in resumed if item['type'] == 'text_delta')
    assert text == 'answer after tool'
    assert not any(item['type'] == 'question' for item in resumed)  # no second question


def test_approval_pause_then_executes_exact_write(scripted):
    scripted.catalog.unregister('scripted')
    scripted.catalog.register(ScriptedProvider(tool='workspace_write', args={'path': 'note.txt', 'content': 'hello'}))
    scripted.settings.set('approval.auto', False)
    scripted.skills.register(SkillSpec('writer', 'n', 'd', 'prompt', tools=('workspace_write',)))
    folder = scripted.host.data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    scripted.workspace('default').set_root(str(folder))
    events = list(scripted.ask(ChatRequest(text='write', skill='writer')))
    question = next(item for item in events if item['type'] == 'question')
    assert question['kind'] == 'approval'
    assert question['detail']['preview']['facts']  # a diff preview, not the model's summary
    conversation_id = next(item['conversation_id'] for item in events if item['type'] == 'meta')
    resumed = list(
        scripted.answer(conversation_id, question['call_id'], {question['call_id']: {'selected': ['Allow once']}})
    )
    assert any(item['type'] == 'text_delta' for item in resumed)
    assert (folder / 'note.txt').read_text(encoding='utf-8') == 'hello'
    # A once grant is consumed: a second, different call is refused.
    exact = {'path': 'note.txt', 'content': 'hello'}
    assert scripted.approvals.consume(conversation_id, 'workspace_write', exact) is False


def test_stop_sets_cancel_and_turn_ends_cleanly(offline):
    cancel = threading.Event()
    request = ChatRequest(text='hi', provider='complete', cancel_event=cancel)
    cancel.set()
    events = list(offline.ask(request))
    assert any(item['type'] == 'done' and item.get('stop_reason') == 'cancelled' for item in events)


def test_budget_exceeded_refuses_before_call(offline):
    offline.settings.set('budget.conversation_tokens', 1)
    # The cap is a soft stop once it has been reached, so spend something first.
    offline.store.record_usage('default', 'c0', 'complete', 'complete', 20, 5)
    events = list(offline.ask(ChatRequest(text='hi', provider='complete', conversation_id='c0')))
    assert any(item['type'] == 'error' and item['kind'] == 'budget' for item in events)
    assert any(item['type'] == 'paused' for item in events)
    assert not any(item['type'] == 'text_delta' for item in events)


def test_unknown_provider_refused_by_name(offline):
    with pytest.raises(AIError) as exc:
        list(offline.ask(ChatRequest(text='hi', provider='nope')))
    assert exc.value.kind == 'refused'


def test_provider_error_becomes_error_event(offline):
    class Failing(Provider):
        spec = ProviderSpec(
            'fail',
            'n',
            'n',
            'x',
            '',
            models=(ModelSpec('fail'),),
            requires_key=False,
            capabilities=frozenset({'tools'}),
        )

        def stream(self, request):
            raise AIProviderError('boom', kind='network')
            yield  # pragma: no cover

    offline.catalog.register(Failing())
    events = list(offline.ask(ChatRequest(text='hi', provider='fail')))
    assert any(item['type'] == 'error' and item['kind'] == 'network' for item in events)
    assert any(item['type'] == 'done' and item['stop_reason'] == 'error' for item in events)
