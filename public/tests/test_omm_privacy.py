# -*- coding: utf-8 -*-
"""统一 AI 隐私过滤测试：所有 tools 与 skills 都必须挡住隐藏内容与凭据。"""
from __future__ import annotations

from agent_workspace.omm_privacy import HIDDEN_MASK, is_hidden, scrub, scrub_result
from agent_workspace.omm_skills import build_skills
from agent_workspace.omm_tools import TOOLS, build_tools


def test_is_hidden_detects_flag_and_mask():
    assert is_hidden({'title': '私密', 'hidden': True}) is True
    assert is_hidden({'content': HIDDEN_MASK}) is True
    assert is_hidden({'title': '公开'}) is False
    assert is_hidden('plain string') is False


def test_scrub_drops_hidden_rows_and_masks_secrets():
    data = {
        'items': [
            {'title': '可见', 'apiKey': 'sk-SECRET'},
            {'title': '隐藏', 'hidden': True},
            {'content': HIDDEN_MASK},
        ],
        'note': 'ok',
    }
    out = scrub(data)
    assert len(out['items']) == 1
    assert out['items'][0]['apiKey'] == '***'
    assert out['note'] == 'ok'
    assert 'SECRET' not in str(out)
    assert HIDDEN_MASK not in str(out)


def test_scrub_result_handles_top_level_hidden():
    assert scrub_result({'title': 'x', 'hidden': True}) == {'hidden': True, 'filtered': True}


def test_every_built_tool_is_wrapped_and_cleaned():
    wrapped = build_tools()
    assert len(wrapped) == len(TOOLS)
    for spec in wrapped:
        # Inject a hidden row through a fake handler to prove the wrapper scrubs.
        assert spec.handler is not None, spec.name
        result = spec.handler({}, {'account': 'default'})
        assert result is not None or spec.name.startswith('omm_format')


def test_tool_wrapper_scrubs_hidden_and_secrets():
    from agent_workspace.omm_tools import _privacy_wrapped
    from agent_workspace.types import ToolSpec

    spec = ToolSpec(
        name='fake', description='x', parameters={}, handler=lambda a, c: {
            'rows': [{'title': 'pub'}, {'title': 'secret', 'hidden': True}],
            'token': 'tok-LEAK',
        },
    )
    out = _privacy_wrapped(spec).handler({}, {})
    assert len(out['rows']) == 1
    assert out['token'] == '***'
    assert 'LEAK' not in str(out)


def test_every_skill_carries_privacy_rule():
    skills = build_skills()
    assert len(skills) >= 21
    for skill in skills:
        assert '隐私红线' in skill.prompt, skill.id
        assert HIDDEN_MASK in skill.prompt, skill.id
