# -*- coding: utf-8 -*-
"""OMM-ZEN AI 配置、暂停恢复与产物幂等的服务端回归测试。"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import requests

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'public'
sys.path.insert(0, str(PUBLIC))

from agent_workspace.omm_config import (  # noqa: E402
    OMMOllamaProvider,
    _resolve_provider,
    normalize_base_url,
)
from agent_workspace.omm_host import OMMZenHostAdapter  # noqa: E402
from agent_workspace.omm_server import create_app  # noqa: E402
from agent_workspace.omm_workspace import OMMWorkspace  # noqa: E402


def _shared(**ai):
    return {
        'provider': ai.get('provider', ''),
        'baseUrl': ai.get('baseUrl', ''),
        'model': ai.get('model', ''),
        'apiKey': ai.get('apiKey', ''),
        'system': ai.get('system', ''),
    }


def _write_shared(directory: Path, **ai) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'shared.json').write_text(
        json.dumps({'ai': ai}, ensure_ascii=False), encoding='utf-8'
    )


class _SSEResponse:
    status_code = 200

    def __init__(self, payload: str):
        self.payload = payload.encode('utf-8')

    def iter_content(self, chunk_size=1024):
        yield self.payload

    def close(self):
        pass


def _text_frame(text: str) -> str:
    return ('data: ' + json.dumps({'choices': [{'delta': {'content': text}, 'finish_reason': 'stop'}]}) +
            '\n\ndata: [DONE]\n\n')


def _question_frame(call_id: str) -> str:
    args = json.dumps({'question': '继续吗？', 'options': ['继续', '停止']}, ensure_ascii=False)
    frame = {'choices': [{'delta': {'tool_calls': [{
        'index': 0, 'id': call_id,
        'function': {'name': 'ask_user_question', 'arguments': args},
    }]}, 'finish_reason': 'tool_calls'}]}
    return 'data: ' + json.dumps(frame, ensure_ascii=False) + '\n\ndata: [DONE]\n\n'


def _workspace(tmp_path):
    return OMMWorkspace(OMMZenHostAdapter(data_dir=tmp_path / 'ai'))


def _client(tmp_path):
    app = create_app(plugin_dir=PUBLIC, data_dir=tmp_path / 'ai')
    app.config['TESTING'] = True
    return app, app.test_client()


def test_shared_config_drives_requests_and_temp_key_wins(tmp_path, monkeypatch):
    monkeypatch.setenv('OMM_SHARED_DIR', str(tmp_path / 'shared'))
    _write_shared(tmp_path / 'shared', provider='deepseek',
                  baseUrl='https://DeepSeek.Example/v1/', apiModel='deepseek-reasoner',
                  apiKey='sk-shared-secret', system='只回答已确认的事实。')
    app, client = _client(tmp_path)
    calls = []

    def fake_post(url, headers=None, json=None, **kwargs):
        calls.append({'url': url, 'headers': headers or {}, 'json': json or {}})
        return _SSEResponse(_text_frame('好的'))

    monkeypatch.setattr(requests, 'post', fake_post)
    response = client.post('/api/ai/chat', json={
        'text': '你好', 'stream': False, 'title': False,
    })
    assert response.status_code == 200, response.get_data(as_text=True)
    assert 'text_delta' in [item['type'] for item in response.get_json()['events']]
    assert calls[0]['url'] == 'https://deepseek.example/v1/chat/completions'
    assert calls[0]['headers']['Authorization'] == 'Bearer sk-shared-secret'
    assert calls[0]['json']['model'] == 'deepseek-reasoner'
    assert calls[0]['json']['messages'][0]['role'] == 'system'
    assert '只回答已确认的事实。' in calls[0]['json']['messages'][0]['content']
    assert 'sk-shared-secret' not in response.get_data(as_text=True)

    client.post('/api/ai/chat', headers={'X-Provider-Key': 'sk-temp-secret'}, json={
        'text': '再次你好', 'stream': False, 'title': False,
    })
    assert calls[1]['headers']['Authorization'] == 'Bearer sk-temp-secret'

    public = client.get('/api/omm/ai-config')
    body = public.get_data(as_text=True)
    assert 'sk-shared-secret' not in body and 'sk-temp-secret' not in body
    config = public.get_json()
    assert config['provider'] == 'deepseek'
    assert config['baseUrl'] == 'https://DeepSeek.Example/v1/'
    assert config['model'] == 'deepseek-reasoner'
    assert 'apiKey' not in config


def test_answer_restores_original_provider_model_base_and_system(tmp_path, monkeypatch):
    monkeypatch.setenv('OMM_SHARED_DIR', str(tmp_path / 'shared'))
    _write_shared(tmp_path / 'shared', system='原始系统提示')
    app, client = _client(tmp_path)
    calls = []

    def fake_post(url, headers=None, json=None, **kwargs):
        calls.append({'url': url, 'headers': headers or {}, 'json': json or {}})
        if len(calls) == 1:
            return _SSEResponse(_question_frame('call_resume'))
        return _SSEResponse(_text_frame('已继续'))

    monkeypatch.setattr(requests, 'post', fake_post)
    first = client.post('/api/ai/chat', headers={'X-Provider-Key': 'sk-memory-only'}, json={
        'text': '开始', 'provider': 'custom', 'baseUrl': 'https://a.test/v1/',
        'model': 'model-a', 'stream': False, 'title': False,
    })
    assert first.status_code == 200, first.get_data(as_text=True)
    events = first.get_json()['events']
    question = next(item for item in events if item['type'] == 'question')
    conversation = next(item for item in events if item['type'] == 'meta')['conversation_id']

    _write_shared(tmp_path / 'shared', system='后来修改的系统提示')
    second = client.post('/api/ai/answer', headers={'X-Provider-Key': 'sk-memory-only'}, json={
        'conversation_id': conversation, 'call_id': question['call_id'],
        'answers': {question['call_id']: {'selected': ['继续']}},
        'provider': 'custom', 'baseUrl': 'https://b.test/v2/', 'model': 'model-b',
        'stream': False,
    })
    assert second.status_code == 200, second.get_data(as_text=True)
    assert calls[1]['url'] == 'https://a.test/v1/chat/completions'
    assert calls[1]['json']['model'] == 'model-a'
    assert calls[1]['headers']['Authorization'] == 'Bearer sk-memory-only'
    system = calls[1]['json']['messages'][0]['content']
    assert '原始系统提示' in system and '后来修改的系统提示' not in system

    ws = app.extensions['omm_ai_workspace']
    saved = ws.store.get_pref('default', 'omm.ai.provider.' + conversation)
    assert 'sk-memory-only' not in saved
    for db_file in (tmp_path / 'ai').glob('ai.db*'):
        assert b'sk-memory-only' not in db_file.read_bytes()


def test_custom_provider_ids_are_stable_and_instances_are_immutable(tmp_path):
    ws = _workspace(tmp_path)
    first = {'provider': 'custom', 'baseUrl': 'https://EXAMPLE.test:443/v1/', 'model': 'model-a'}
    _resolve_provider(ws, first, _shared())
    provider_id = first['provider']
    provider = ws.catalog.get(provider_id, check_scope=False)
    assert provider_id.startswith('omm_custom_') and len(provider_id.rsplit('_', 1)[1]) == 16

    equivalent = {'provider': 'custom', 'baseUrl': 'https://example.test/v1', 'model': 'model-b'}
    _resolve_provider(ws, equivalent, _shared())
    assert equivalent['provider'] == provider_id
    assert ws.catalog.get(provider_id, check_scope=False) is provider
    assert provider.spec.base_url == 'https://example.test/v1'
    assert provider.spec.models[0].id == 'model-a'

    other = {'provider': 'custom', 'baseUrl': 'https://example.test/v2', 'model': 'model-c'}
    _resolve_provider(ws, other, _shared())
    assert other['provider'] != provider_id
    assert ws.catalog.get(provider_id, check_scope=False) is provider

    deepseek_root = {'provider': 'deepseek', 'baseUrl': 'https://api.deepseek.com'}
    deepseek_endpoint = {'provider': 'deepseek', 'baseUrl': 'https://api.deepseek.com/chat/completions/'}
    _resolve_provider(ws, deepseek_root, _shared())
    _resolve_provider(ws, deepseek_endpoint, _shared())
    assert deepseek_root['provider'] == deepseek_endpoint['provider']

    def register(index):
        payload = {'provider': 'custom', 'baseUrl': f'https://concurrent-{index}.test/v1', 'model': 'm'}
        _resolve_provider(ws, payload, _shared())
        return payload['provider']

    with ThreadPoolExecutor(max_workers=6) as pool:
        ids = list(pool.map(register, range(12)))
    assert len(set(ids)) == 12
    assert ws.catalog.get(provider_id, check_scope=False) is provider


def test_ollama_defaults_to_11434_and_never_uses_plugin_host(tmp_path):
    ws = _workspace(tmp_path)
    ws.settings.set('ollama.host', 'http://127.0.0.1:8328')
    payload = {'provider': 'ollama', 'model': 'qwen3:8b'}
    _resolve_provider(ws, payload, _shared())
    provider = ws.catalog.get(payload['provider'], check_scope=False)
    assert isinstance(provider, OMMOllamaProvider)
    assert provider.spec.base_url == 'http://127.0.0.1:11434'
    assert provider._base({'host': 'http://127.0.0.1:8328'}) == 'http://127.0.0.1:11434'
    assert provider._base('http://127.0.0.1:8328') == 'http://127.0.0.1:11434'
    assert normalize_base_url('HTTP://LOCALHOST:80', 'ollama') == 'http://localhost'


def test_artifact_commit_route_marks_applied_only_after_client_success(tmp_path):
    app, client = _client(tmp_path)
    ws = app.extensions['omm_ai_workspace']
    conversation = ws.store.create_conversation('default', title='commit')['id']
    artifact = ws.store.save_artifact('default', conversation, 'omm_markdown', {
        'filename': 'commit.md', 'content': '# commit',
    })
    prepared = client.post('/api/ai/artifacts/' + artifact['id'] + '/apply')
    assert prepared.status_code == 200
    assert ws.store.get_artifact(artifact['id'])['status'] == 'prepared'
    committed = client.post('/api/ai/artifacts/' + artifact['id'] + '/commit')
    assert committed.status_code == 200
    assert committed.get_json()['status'] == 'applied'
    assert ws.store.get_artifact(artifact['id'])['status'] == 'applied'


def test_artifact_apply_is_idempotent_under_concurrent_calls(tmp_path, monkeypatch):
    ws = _workspace(tmp_path)
    conversation = ws.store.create_conversation('default', title='artifact')['id']
    artifact = ws.store.save_artifact('default', conversation, 'omm_markdown', {
        'filename': 'report.md', 'content': '# 报告',
    })
    calls = []
    original = ws.host.apply_artifact

    def apply(kind, payload):
        calls.append((kind, payload))
        return original(kind, payload)

    monkeypatch.setattr(ws.host, 'apply_artifact', apply)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: ws.apply_artifact('default', artifact['id']), range(2)))
    assert len(calls) == 1
    assert sum(bool(item.get('already_prepared')) for item in results) == 1
    assert ws.store.get_artifact(artifact['id'])['status'] == 'prepared'
    assert ws.commit_artifact('default', artifact['id'])['status'] == 'applied'
    assert ws.store.get_artifact(artifact['id'])['status'] == 'applied'
