"""Wire-level transport tests: the system prompt, DeepSeek's native protocol and Ollama's daemon.

These assertions pin behaviours that were lost in the first migration: the system prompt reaching
the model, the real web-tool names, a 32k context window instead of Ollama's silent 4096 default,
incremental UTF-8 decoding (mojibake regression) and the real price table.
"""

from __future__ import annotations

import json

import pytest

from agent_workspace.errors import AIProviderError
from agent_workspace.providers.deepseek import DeepSeekProvider
from agent_workspace.providers.ollama import MAX_NUM_CTX, OllamaProvider
from agent_workspace.providers.openai_compat import OpenAICompatibleProvider
from agent_workspace.util import iter_utf8_lines


class FakeResponse:
    def __init__(self, frames=None, raw=None, status_code=200):
        if raw is None:
            raw = (
                b''.join(
                    b'data: ' + json.dumps(frame, ensure_ascii=False).encode('utf-8') + b'\n\n'
                    for frame in (frames or [])
                )
                + b'data: [DONE]\n\n'
            )
        self._chunks = [raw[: max(1, len(raw) // 2)], raw[max(1, len(raw) // 2) :]]
        self.status_code = status_code
        self.text = ''
        self.closed = False

    def iter_content(self, chunk_size=1024):
        return iter(self._chunks)

    def iter_lines(self, decode_unicode=False):
        text = b''.join(self._chunks).decode('utf-8')
        return iter(text.splitlines())

    def json(self):
        return {}

    def close(self):
        self.closed = True


BASE_REQUEST = {
    'model': 'deepseek-chat',
    'messages': [{'role': 'user', 'content': 'hi'}],
    'system': 'you are a careful assistant',
    'tools': [{'name': 'ping', 'description': 'ping', 'input_schema': {'type': 'object'}}],
    'api_key': 'k',
    'thinking': False,
    'web_search': False,
    'safety': 'high',
    'title': True,
    'temperature': 0.3,
    'max_tokens': 100,
}


# ── system prompt ──────────────────────────────────────────────────────────────


def test_openai_compat_injects_system_message():
    payload = OpenAICompatibleProvider().build_payload(dict(BASE_REQUEST))
    assert payload['messages'][0] == {'role': 'system', 'content': 'you are a careful assistant'}


def test_deepseek_keeps_system_and_gates_thinking():
    provider = DeepSeekProvider()
    plain = provider.build_payload(dict(BASE_REQUEST))
    assert plain['messages'][0]['role'] == 'system'
    assert plain['thinking'] == {'type': 'disabled'}
    assert 'reasoning_effort' not in plain
    assert plain['temperature'] == 0.3
    thinking = provider.build_payload(
        {**BASE_REQUEST, 'model': 'deepseek-reasoner', 'thinking': True, 'reasoning_effort': 'max'}
    )
    assert thinking['thinking'] == {'type': 'enabled'}
    assert thinking['reasoning_effort'] == 'high'
    assert 'temperature' not in thinking


def test_deepseek_uses_native_web_tool_names():
    provider = DeepSeekProvider()
    payload = provider.build_payload({**BASE_REQUEST, 'web_search': True})
    types = [item['type'] for item in payload['tools'] if 'type' in item]
    assert 'deepseek_web_search' in types
    assert 'deepseek_read_url' in types
    assert payload['safety_check'] == {'level': 'high'}
    assert payload['title'] == {'enabled': True}


# ── DeepSeek decode ────────────────────────────────────────────────────────────


def test_deepseek_decode_citations_signature_and_parse_error():
    frames = [
        {
            'choices': [
                {
                    'delta': {
                        'content': 'answer',
                        'annotations': [{'url': 'https://example.test'}],
                        'server_tool_calls': [{'type': 'deepseek_web_search', 'signature': 'sig'}],
                    },
                    'finish_reason': 'stop',
                }
            ]
        },
        {
            'choices': [
                {
                    'delta': {
                        'tool_calls': [{'index': 0, 'id': 'c1', 'function': {'name': 'ping', 'arguments': '{"a":'}}]
                    }
                }
            ]
        },
    ]
    response = FakeResponse(frames)
    events = list(DeepSeekProvider().decode(response))
    kinds = [item['type'] for item in events]
    assert 'citation' in kinds and 'server_tool' in kinds
    tool = next(item for item in events if item['type'] == 'tool_call')
    assert tool['arguments'] == {}
    assert tool['parse_error'] == 'truncated_arguments'
    assert next(item for item in events if item['type'] == 'done')['stop_reason'] == 'end_turn'
    assert response.closed is True


def test_deepseek_midstream_error_is_not_silently_empty():
    frames = [{'error': {'message': 'generation failed'}}, {}]
    with pytest.raises(AIProviderError) as exc:
        list(DeepSeekProvider().decode(FakeResponse(frames)))
    assert exc.value.kind == 'network'


def test_deepseek_cost_uses_published_prices():
    provider = DeepSeekProvider()
    price = provider.cost('deepseek-chat', prompt=1_000_000, completion=0, cached=0)
    assert price['amount'] == 2.0
    assert price['currency'] == 'CNY'
    cached = provider.cost('deepseek-chat', prompt=1_000_000, completion=0, cached=400_000)
    assert cached['amount'] == pytest.approx(0.4 * 0.5 + 0.6 * 2.0)
    assert provider.cost('unknown-model', 10, 10) is None


# ── Ollama ─────────────────────────────────────────────────────────────────────


def test_ollama_context_window_uses_real_window_capped(monkeypatch):
    provider = OllamaProvider()
    monkeypatch.setattr(provider, '_info', lambda model, host='': {'context': 131072, 'capabilities': []})
    assert provider.context_window('qwen') == MAX_NUM_CTX
    monkeypatch.setattr(provider, '_info', lambda model, host='': {'context': 8192, 'capabilities': []})
    assert provider.context_window('qwen') == 8192


def test_ollama_payload_carries_system_uses_num_ctx_and_keeps_zero_temperature(monkeypatch):
    provider = OllamaProvider()
    monkeypatch.setattr(provider, '_info', lambda model, host='': {'context': 0, 'capabilities': ['tools', 'thinking']})
    payload = provider.build_payload({**BASE_REQUEST, 'model': 'qwen', 'temperature': 0.0, 'thinking': True})
    assert payload['messages'][0] == {'role': 'system', 'content': 'you are a careful assistant'}
    assert payload['options']['num_ctx'] == MAX_NUM_CTX
    assert payload['options']['temperature'] == 0.0
    assert payload['options']['num_predict'] == 100
    assert payload['think'] is True
    assert payload['tools'][0]['function']['name'] == 'ping'


def test_ollama_filters_embedding_models(monkeypatch):
    import requests as real_requests

    class Response:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {'models': [{'name': 'qwen3:9b'}, {'name': 'nomic-embed-text'}]}

    monkeypatch.setattr(real_requests, 'get', lambda *a, **k: Response())
    provider = OllamaProvider()
    models = provider._catalog('http://localhost:11434')
    assert [row['id'] for row in models] == ['qwen3:9b']


def test_ollama_stream_decodes_split_utf8_and_keeps_tool_id(monkeypatch):
    import agent_workspace.providers.ollama as ollama_module

    provider = OllamaProvider()
    frame = {
        'message': {
            'content': '你好',
            'tool_calls': [{'id': 'daemon_id', 'function': {'name': 'ping', 'arguments': {'a': 1}}}],
        },
        'done': True,
        'prompt_eval_count': 5,
        'eval_count': 2,
    }
    raw = (json.dumps(frame, ensure_ascii=False) + '\n').encode('utf-8')
    chunks = [raw[: len(raw) // 2], raw[len(raw) // 2 :]]
    response = FakeResponse(raw=b''.join(chunks))
    monkeypatch.setattr(ollama_module, 'open_stream', lambda *a, **k: response)
    events = list(provider.stream({'model': 'qwen'}))
    assert any(item.get('text') == '你好' for item in events)
    tool = next(item for item in events if item['type'] == 'tool_call')
    assert tool['id'] == 'daemon_id' and tool['arguments'] == {'a': 1}
    assert any(item['type'] == 'usage' for item in events)
    assert response.closed is True


def test_incremental_utf8_roundtrip():
    raw = '中文测试'.encode('utf-8')
    assert ''.join(iter_utf8_lines([raw[:1], raw[1:3], raw[3:]])) == '中文测试'
