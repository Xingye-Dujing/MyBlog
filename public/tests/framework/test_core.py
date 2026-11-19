from __future__ import annotations

import pytest

from agent_workspace import config
from agent_workspace.errors import AIError
from agent_workspace.i18n import BuiltinTranslator
from agent_workspace.settings import FileSettings, HostSettings, MemorySettings
from agent_workspace.types import (
    ChatRequest,
    new_id,
    skill_from_manifest,
    usage_totals,
)
from agent_workspace.util import (
    clip,
    estimate_tokens,
    iter_sse_frames,
    iter_utf8_lines,
    local_day_start_utc,
    redact,
    safe_filename,
)


def test_ids_and_usage():
    assert new_id('conv').startswith('conv_')
    value = usage_totals(
        {
            'prompt_tokens': 10,
            'completion_tokens': 5,
            'prompt_cache_hit_tokens': 4,
            'completion_tokens_details': {'reasoning_tokens': 2},
        }
    )
    assert value['total_tokens'] == 15
    assert value['cached_tokens'] == 4
    assert value['reasoning_tokens'] == 2
    assert usage_totals({'input_tokens': 7, 'output_tokens': 3})['total_tokens'] == 10


def test_redaction_and_clip():
    assert '[redacted]' in redact('key sk-abcdefgh1234 here')
    assert clip('abcdef', 3).endswith('…')
    assert safe_filename('../../etc/passwd') == 'passwd'
    assert estimate_tokens('中文') == 2
    assert local_day_start_utc().endswith('+00:00')


def test_incremental_utf8_decoding_never_splits_a_character():
    text = '中文测试'
    raw = text.encode('utf-8')
    chunks = [raw[:1], raw[1:3], raw[3:5], raw[5:]]
    assert ''.join(iter_utf8_lines(chunks)) == text


def test_sse_frames_and_done():
    wire = b'data: {"a": 1}\n\n' + b': keepalive\n\n' + b'data: {"b": "x"}\n\n' + b'data: [DONE]\n\n'
    frames = list(iter_sse_frames([wire]))
    assert frames == [('message', {'a': 1}), ('message', {'b': 'x'})]


def test_skill_manifest_validation():
    skill = skill_from_manifest({'id': 'my.skill', 'prompt': 'hi', 'tools': ['project_facts']})
    assert skill.id == 'my.skill'
    with pytest.raises(ValueError):
        skill_from_manifest({'id': 'Bad ID!'})


def test_settings_validation_and_legacy_keys():
    values = MemorySettings({'ai_context_scope': 'full', 'ai_max_tool_rounds': 5})
    assert values.get('context.scope') == 'full'
    assert values.get('tools.max_rounds') == 5
    values.set('context.scope', 'nonsense')
    assert values.get('context.scope') == 'summary'
    with pytest.raises(KeyError):
        values.set('unknown.key', 1)
    assert config.translate_legacy('ai_web_search_default') == 'chat.web_search_default'


def test_file_settings_roundtrip(tmp_path):
    path = tmp_path / 'settings.json'
    first = FileSettings(path)
    first.set('chat.web_search_default', False)
    second = FileSettings(path)
    assert second.get('chat.web_search_default') is False


def test_host_settings_adapter():
    stored = {}
    adapter = HostSettings(
        lambda key, default=None: stored.get(key, default), lambda key, value: stored.__setitem__(key, value)
    )
    adapter.set('tools.max_rounds', 12)
    assert adapter.get('tools.max_rounds') == 12
    assert stored['tools.max_rounds'] == 12


def test_i18n_missing_key_is_visible():
    translator = BuiltinTranslator(lang='en')
    assert translator.t('workspace.skill.project.name') == 'Project advisor'
    assert translator.t('unknown.key') == 'unknown.key'
    assert translator.t('totally.unknown.key') == 'totally.unknown.key'
    assert translator.t('workspace.refusal.capability', capability='vision') == (
        'The current provider does not support capability vision; refused by name.'
    )


def test_chat_request_dict():
    request = ChatRequest(text='hi', conversation_id='c1', skill='project')
    assert request.to_dict()['conversation_id'] == 'c1'
    assert request.to_dict()['skill'] == 'project'


def test_error_kind_and_serialization():
    error = AIError('nope', kind='refused', reason='missing')
    assert error.to_dict() == {'ok': False, 'error': 'nope', 'kind': 'refused', 'reason': 'missing'}
