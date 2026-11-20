# -*- coding: utf-8 -*-
"""AI 读取用户真实产品数据的上下文渲染测试。

omm_host.omm_live_context 把浏览器送来的只读快照渲染进模型上下文；必须脱敏、
限量、容错，且绝不把 API Key 之类的凭据带进提示词。
"""
from __future__ import annotations

from agent_workspace.omm_host import omm_live_context
from agent_workspace.omm_privacy import scrub


def test_empty_or_malformed_payload_yields_no_context():
    for payload in ({}, {'omm_live': None}, {'omm_live': 'not-a-dict'}, {'omm_live': []},
                    {'omm_live': {'cards': 'oops'}}, None):
        assert omm_live_context('', payload or {}) == ''


def test_renders_known_sections_with_counts():
    payload = {'omm_live': {
        'cards': [{'content': 'SM-2 是间隔重复算法', 'tags': ['学习']}],
        'searches': [{'query': '什么是卡片盒', 'answer': '一种笔记方法'}],
        'rules': [{'name': '搜索归档'}],
        'unknown': [1, 2, 3],
    }}
    text = omm_live_context('', payload)
    assert '知识卡片 · 1 条' in text
    assert '最近搜索 · 1 条' in text
    assert '工作流规则 · 1 条' in text
    assert 'SM-2' in text
    assert 'unknown' not in text  # 未登记的段落不渲染


def test_credentials_are_always_redacted():
    payload = {'omm_live': {'searches': [{
        'query': 'test',
        'apiKey': 'sk-SECRET',
        'supabaseKey': 'sup-SECRET',
        'nested': {'accessToken': 'tok-SECRET', 'title': 'ok'},
    }]}}
    text = omm_live_context('', payload)
    assert 'SECRET' not in text
    assert '***' in text


def test_arrays_and_strings_are_capped():
    payload = {'omm_live': {'cards': [{'content': 'x' * 5000} for _ in range(80)]}}
    text = omm_live_context('', payload)
    assert text.count('- ') == 20  # 最多渲染 20 条
    assert '…' in text or len(text) < 12000


def test_scrub_handles_deep_structures_without_recursion_error():
    value = {'a': {'b': {'c': {'d': {'e': {'f': {'g': 'deep'}}}}}}}
    out = scrub(value)
    assert out['a']['b']['c']['d']['e']['f']['g'] == 'deep'  # depth 8 within limit


def test_hidden_rows_never_reach_the_model():
    """Planner's editor-only items must be dropped even if a caller sends them."""
    payload = {'omm_live': {
        'cards': [
            {'content': '可见卡片'},
            {'content': '机密', 'hidden': True},
            {'content': '•••••'},
        ],
        'planner': [
            {'title': '可见待办', 'done': True},
            {'title': '隐藏待办', 'done': False, 'hidden': True},
        ],
    }}
    text = omm_live_context('', payload)
    assert '可见卡片' in text
    assert '机密' not in text
    assert '隐藏待办' not in text
    assert '•••••' not in text
    # planner 不在白名单段落里，整段都不应进入模型上下文。
    assert 'planner' not in text.lower()


def test_live_source_registered_on_host():
    from agent_workspace.omm_host import OMMZenHostAdapter

    host = OMMZenHostAdapter()
    names = {src.name for src in host.context_sources()}
    assert 'omm_live_data' in names

    source = next(src for src in host.context_sources() if src.name == 'omm_live_data')
    rendered = source.build('', {'omm_live': {'cards': [{'content': '测试卡片'}]}})
    assert '知识卡片' in rendered
    assert '测试卡片' in rendered
