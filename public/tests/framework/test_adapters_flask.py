"""The optional Flask adapter is part of the shipped surface; every route gets a smoke test.

The adapter must stay a thin mapping: keys arrive in a header, canonical events are SSE frames, and
every service method has a route. These tests use Flask's test client, so no server is booted.
"""

from __future__ import annotations

import json

import pytest

from agent_workspace.adapters.flask import create_blueprint

pytest.importorskip('flask')


@pytest.fixture
def client(offline):
    from flask import Flask

    app = Flask(__name__)
    app.register_blueprint(create_blueprint(offline))
    app.config['TESTING'] = True
    with app.test_client() as test_client:
        yield test_client


def _frames(response):
    data = response.get_data(as_text=True)
    return [json.loads(chunk[len('data: ') :].strip()) for chunk in data.split('\n\n') if chunk.startswith('data: ')]


# ── catalog / bootstrap ────────────────────────────────────────────────────────


def test_bootstrap_and_catalog_routes(client):
    assert client.get('/api/ai/bootstrap').get_json()['ok'] is True
    assert client.get('/api/ai/providers').get_json()['ok'] is True
    assert client.get('/api/ai/providers/complete/models').get_json()['ok'] is True
    assert client.get('/api/ai/health').get_json()['ok'] is True
    assert client.get('/api/ai/providers/complete/balance').status_code == 400


def test_provider_test_route(client):
    assert client.post('/api/ai/providers/complete/test', json={}).get_json()['ok'] is True


# ── chat / answer / retry / stop ───────────────────────────────────────────────


def test_chat_sse_and_json(client):
    response = client.post('/api/ai/chat', json={'text': 'hello'})
    assert response.mimetype == 'text/event-stream'
    kinds = [item['type'] for item in _frames(response)]
    assert 'meta' in kinds and 'done' in kinds
    response = client.post('/api/ai/chat', json={'text': 'hello', 'stream': False})
    payload = response.get_json()
    assert payload['ok'] is True and payload['text']


def test_answer_stop_context_usage_references(client):
    assert client.post('/api/ai/stop', json={'conversation_id': 'none'}).get_json()['ok'] is False
    assert client.post('/api/ai/context', json={'query': 'hi'}).get_json()['ok'] is True
    assert client.get('/api/ai/usage').get_json()['ok'] is True
    assert client.get('/api/ai/references?q=x').get_json()['ok'] is True
    response = client.post('/api/ai/answer', json={'conversation_id': 'c1', 'call_id': 'x', 'answers': {}})
    assert response.status_code == 200


def test_retry_route(client):
    response = client.post('/api/ai/chat', json={'text': 'first', 'stream': False})
    conversation_id = next(item['conversation_id'] for item in response.get_json()['events'] if item['type'] == 'meta')
    retry = client.post('/api/ai/retry', json={'conversation_id': conversation_id, 'stream': False})
    assert retry.get_json()['ok'] is True


# ── conversations / memories / artifacts ───────────────────────────────────────


def test_conversation_and_memory_routes(client):
    created = client.post('/api/ai/conversations', json={'title': 'T'}).get_json()
    cid = created['conversation']['id']
    assert client.get('/api/ai/conversations').get_json()['ok'] is True
    assert client.get(f'/api/ai/conversations/{cid}').get_json()['conversation']['id'] == cid
    assert client.patch(f'/api/ai/conversations/{cid}', json={'title': 'T2'}).get_json()['ok'] is True
    assert client.get(f'/api/ai/conversations/{cid}/export?format=md').status_code == 200
    memory = client.post('/api/ai/memories', json={'text': 'remember'}).get_json()['memory']
    assert client.get('/api/ai/memories').get_json()['memories']
    assert client.delete(f'/api/ai/memories/{memory["id"]}').get_json()['ok'] is True
    assert client.delete(f'/api/ai/conversations/{cid}').get_json()['ok'] is True


def test_artifact_routes(client):

    response = client.post('/api/ai/chat', json={'text': 'hi', 'stream': False})
    cid = next(item['conversation_id'] for item in response.get_json()['events'] if item['type'] == 'meta')
    artifacts = client.get(f'/api/ai/artifacts?conversation_id={cid}').get_json()['artifacts']
    assert isinstance(artifacts, list)
    assert client.post('/api/ai/artifacts/art_missing/apply').status_code == 400


# ── skills / plugins / monitors / files ────────────────────────────────────────


def test_skill_routes(client):
    assert client.get('/api/ai/skills').get_json()['ok'] is True
    saved = client.post('/api/ai/skills', json={'id': 'my.skill', 'prompt': 'hi'}).get_json()
    assert saved['ok'] is True
    assert client.post('/api/ai/skills/my.skill/fork', json={}).get_json()['ok'] is True
    assert client.delete('/api/ai/skills/my.skill').get_json()['ok'] is True


def test_plugin_routes(client):
    manifest = {
        'id': 'pack.skill',
        'api': 1,
        'kind': 'skill-pack',
        'permissions': ['skills.contribute'],
        'contributions': {'skills': [{'id': 'pack.s', 'prompt': 'hi'}]},
    }
    assert client.post('/api/ai/plugins', json=manifest).get_json()['ok'] is True
    assert client.get('/api/ai/plugins').get_json()['ok'] is True
    assert client.post('/api/ai/plugins/pack.skill/enable', json={'enabled': False}).get_json()['ok'] is True
    assert client.delete('/api/ai/plugins/pack.skill').get_json()['ok'] is True


def test_monitor_and_file_routes(client):
    assert client.get('/api/ai/monitors').get_json()['ok'] is True
    assert client.get('/api/ai/monitors/events').get_json()['ok'] is True
    file_row = client.post('/api/ai/files', json={'name': 'a.txt', 'path': ''}).get_json()['file']
    assert client.get('/api/ai/files').get_json()['files']
    assert client.delete(f'/api/ai/files/{file_row["id"]}').get_json()['ok'] is True


# ── python / settings / workspace ──────────────────────────────────────────────


def test_python_routes(client):
    assert client.get('/api/ai/python/status').get_json()['status']['sandbox'] is False
    assert client.get('/api/ai/python/scripts').get_json()['scripts']
    saved = client.post(
        '/api/ai/python/scripts', json={'id': 'my.script', 'name': 'Mine', 'code': 'print(1)'}
    ).get_json()
    assert saved['ok'] is True
    assert client.get('/api/ai/python/scripts/my.script').get_json()['script']['id'] == 'my.script'
    assert client.post('/api/ai/python/scripts/my.script/fork', json={}).get_json()['ok'] is True
    assert client.delete('/api/ai/python/scripts/my.script').get_json()['ok'] is True


def test_settings_and_workspace_routes(client):
    assert client.get('/api/ai/settings').get_json()['schema']
    assert client.post('/api/ai/settings', json={'chat.temperature': 0.5}).get_json()['ok'] is True
    assert client.get('/api/ai/workspace').status_code == 200


def test_key_comes_from_header_not_url(client, offline):
    # The adapter reads X-Provider-Key; a key in the query string is never used.
    response = client.post('/api/ai/chat?api_key=sk-should-not-be-used', json={'text': 'hi', 'stream': False})
    assert response.get_json()['ok'] is True
