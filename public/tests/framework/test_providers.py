from __future__ import annotations

import json

from agent_workspace import AIError
from agent_workspace.providers.base import (
    CONTEXT_CLOSE,
    CONTEXT_OPEN,
    http_error,
    replay_context,
)
from agent_workspace.providers.openai_compat import OpenAICompatibleProvider, with_reasoning
from agent_workspace.types import ChatRequest


def test_catalog_is_single_and_caps_refused(offline):
    ids = offline.catalog.ids()
    assert {'deepseek', 'ollama', 'openrouter', 'opencode_go', 'complete'} <= set(ids)
    assert offline.catalog.supports('complete', 'vision') is False
    assert offline.catalog.supports('deepseek', 'web_search') is True
    assert offline.catalog.public()


def test_capability_request_is_refused_by_name(offline):
    request = ChatRequest(text='hi', provider='complete', thinking=True)
    try:
        list(offline.ask(request))
    except AIError as exc:
        assert exc.kind == 'capability'
    else:
        raise AssertionError('an unsupported capability must be refused')


def test_replay_context_preserves_turn_bytes():
    messages = [
        {'role': 'user', 'content': 'one', 'meta': {'context_text': 'facts A'}},
        {'role': 'assistant', 'content': 'answer'},
        {'role': 'user', 'content': 'two', 'meta': {'context_text': 'facts B'}},
    ]
    replayed = replay_context(messages)
    assert replayed[0]['content'].startswith(f'{CONTEXT_OPEN}\nfacts A\n{CONTEXT_CLOSE}')
    assert 'facts B' in replayed[2]['content']
    assert replayed[1] == messages[1]
    assert replay_context(replayed) == replayed  # idempotent: bytes never change


def test_with_reasoning_echoes_prior_thinking():
    messages = [
        {'role': 'assistant', 'content': 'ok', 'meta': {'reasoning_content': 'thought'}},
        {'role': 'user', 'content': 'again'},
    ]
    result = with_reasoning(messages)
    assert result[0]['reasoning_content'] == 'thought'
    assert 'reasoning_content' not in result[1]


def test_http_error_kinds():
    assert http_error(401).kind == 'auth'
    assert http_error(402).kind == 'quota'
    assert http_error(404).kind == 'model'
    assert http_error(429).kind == 'rate_limit'
    assert http_error(503).kind == 'network'


class FakeResponse:
    def __init__(self, frames):
        raw = b''.join(b'data: ' + json.dumps(frame, ensure_ascii=False).encode('utf-8') + b'\n\n' for frame in frames)
        raw += b'data: [DONE]\n\n'
        self._chunks = [raw[:7], raw[7:]]
        self.status_code = 200

    def iter_content(self, chunk_size=1024):
        return iter(self._chunks)


def test_openai_stream_decoding_with_split_utf8():
    frames = [
        {'choices': [{'delta': {'reasoning_content': '思考'}, 'index': 0}]},
        {'choices': [{'delta': {'content': '你好'}, 'index': 0}]},
        {
            'choices': [
                {
                    'delta': {
                        'tool_calls': [
                            {'index': 0, 'id': 'c1', 'function': {'name': 'project_facts', 'arguments': '{"a":'}}
                        ]
                    }
                }
            ]
        },
        {'choices': [{'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': '1}'}}]}}]},
        {
            'choices': [{'delta': {}, 'finish_reason': 'tool_calls'}],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 4},
        },
    ]
    provider = OpenAICompatibleProvider()
    events = list(provider.decode(FakeResponse(frames)))
    kinds = [item['type'] for item in events]
    assert kinds.count('thinking_delta') == 1
    assert any(item.get('text') == '你好' for item in events)
    tool = next(item for item in events if item['type'] == 'tool_call')
    assert tool['name'] == 'project_facts'
    assert tool['arguments'] == {'a': 1}
    done = next(item for item in events if item['type'] == 'done')
    assert done['stop_reason'] == 'tool_calls'
    assert done['reasoning_content'] == '思考'
    usage = next(item for item in events if item['type'] == 'usage')
    assert usage['usage']['total_tokens'] == 14


def test_offline_provider_stream_shape():
    provider = offline_provider()
    events = list(provider.stream({'messages': [{'role': 'user', 'content': 'ping'}], 'tools': []}))
    assert events[0]['type'] == 'meta'
    assert events[-1]['type'] == 'done'
    assert any(item['type'] == 'text_delta' for item in events)


def offline_provider():
    from agent_workspace.providers.complete import CompleteProvider

    return CompleteProvider()
