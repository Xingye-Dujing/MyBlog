from __future__ import annotations

import pytest

from agent_workspace import Store
from agent_workspace.types import text_block, tool_use_block


@pytest.fixture
def store(tmp_path):
    instance = Store(tmp_path / 'ai.db')
    yield instance
    instance.close()


def test_conversation_lifecycle_and_account_isolation(store):
    first = store.create_conversation('alice', title='Hello')
    assert store.get_conversation(first['id'], 'alice')['title'] == 'Hello'
    assert store.get_conversation(first['id'], 'bob') == {}
    store.patch_conversation(first['id'], 'alice', title='Renamed', pinned=1)
    row = store.get_conversation(first['id'], 'alice')
    assert row['title'] == 'Renamed'
    assert row['pinned'] == 1
    assert store.list_conversations('bob') == []
    store.delete_conversation(first['id'], 'alice')
    assert store.get_conversation(first['id'], 'alice') == {}


def test_search_escapes_like_metacharacters(store):
    store.create_conversation('alice', title='100% done')
    store.create_conversation('alice', title='100x done')
    assert len(store.list_conversations('alice', query='100%')) == 1
    assert len(store.list_conversations('alice', query='100')) == 2


def test_messages_turns_and_stream_settling(store):
    conv = store.create_conversation('alice')
    cid = conv['id']
    user = store.append_message(cid, 'turn_1', 'user', [text_block('hi')])
    assert user['role'] == 'user'
    assistant = store.append_message(cid, 'turn_1', 'assistant', [text_block('answer')], status='streaming')
    store.settle_streams(cid, 'interrupted')
    assert store.get_message(assistant['id'])['status'] == 'interrupted'
    assert store.next_seq(cid) == 3
    store.update_message(assistant['id'], meta={'stop_reason': 'max_tokens'}, status='done')
    assert store.get_message(assistant['id'])['meta']['stop_reason'] == 'max_tokens'
    assert len(store.list_messages(cid)) == 2
    assert len(store.list_messages(cid, limit=1)) == 1
    assert store.last_message(cid, 'assistant')['id'] == assistant['id']


def test_export_formats(store):
    conv = store.create_conversation('alice', title='Chat')
    store.append_message(conv['id'], 't', 'user', [text_block('question')])
    store.append_message(conv['id'], 't', 'assistant', [text_block('reply')])
    assert '## User' in store.export_conversation(conv['id'], 'alice', 'md')
    assert 'reply' in store.export_conversation(conv['id'], 'alice', 'json')


def test_memories_dedupe_limits_and_scope(store):
    first = store.add_memory('alice', 'remember me')
    assert first['duplicate'] is False
    second = store.add_memory('alice', 'remember me')
    assert second['duplicate'] is True
    assert len(store.list_memories('alice')) == 1
    assert store.list_memories('bob') == []
    with pytest.raises(ValueError, match='tooLong'):
        store.add_memory('alice', 'x' * 2001)
    assert store.delete_memory('alice', first['id']) is True
    for index in range(200):
        store.add_memory('alice', f'memory {index}')
    with pytest.raises(ValueError, match='full'):
        store.add_memory('alice', 'one more')


def test_usage_and_budget_accounting(store):
    store.record_usage('alice', 'c1', 'deepseek', 'deepseek-chat', 100, 50, 20, 5)
    store.record_usage('bob', 'c2', 'deepseek', 'deepseek-chat', 10, 5)
    assert store.token_usage(account='alice')['tokens'] == 150
    assert store.token_usage(conversation_id='c1')['tokens'] == 150
    assert store.conversation_usage('c1')[0]['cached_tokens'] == 20
    assert store.token_usage(account='alice', since='2999-01-01T00:00:00+00:00')['tokens'] == 0


def test_prefs_artifacts_monitors_and_files(store):
    store.set_pref('alice', 'workspace.root', '/tmp/x')
    assert store.get_pref('alice', 'workspace.root') == '/tmp/x'
    assert store.get_pref('bob', 'workspace.root') == ''
    artifact = store.save_artifact('alice', 'c1', 'plan', {'steps': ['a']})
    assert store.get_artifact(artifact['id'])['payload']['steps'] == ['a']
    assert len(store.list_artifacts('alice', 'c1')) == 1
    monitor = store.create_monitor('alice', 'c1', {'events': ['failed']})
    delivery = store.add_delivery('alice', monitor['id'], {'event': 'failed'})
    assert len(store.pending_deliveries('alice')) == 1
    assert store.ack_delivery('alice', delivery['id']) is True
    assert store.pending_deliveries('alice') == []
    assert store.stop_monitor('alice', monitor['id']) is True
    assert store.list_monitors('alice', status='active') == []
    file_row = store.add_file('alice', 'notes.txt', size=12)
    assert store.get_file(file_row['id'])['name'] == 'notes.txt'
    assert store.delete_file('alice', file_row['id']) is True


def test_user_skills_are_data_not_code(store):
    store.save_skill('alice', {'id': 'custom', 'prompt': 'do things'})
    assert store.list_user_skills('alice')[0]['id'] == 'custom'
    with pytest.raises(ValueError):
        store.save_skill('alice', {'id': 'evil', 'prompt': 'import os'})
    with pytest.raises(ValueError):
        store.save_skill('alice', {'id': 'Bad ID'})
    assert store.delete_skill('alice', 'custom') is True


def test_message_blocks_shape(store):
    conv = store.create_conversation('alice')
    row = store.append_message(conv['id'], 't', 'assistant', [tool_use_block('c1', 'project_facts', {})])
    assert row['blocks'][0]['name'] == 'project_facts'
