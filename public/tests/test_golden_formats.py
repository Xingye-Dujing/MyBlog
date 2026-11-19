# -*- coding: utf-8 -*-
"""Golden 样本对拍：与 tests/test_golden_formats.mjs 共用同一批 fixtures。

产品 JS 导出（zen-card.js / zen-backup.js / zen-flow.js）与本模块的 Python
校验器必须同时接受这些样例。一侧的格式规则改了、另一侧没跟上，测试即失败。
"""
from __future__ import annotations

import json
from pathlib import Path

from agent_workspace.omm_validators import validate

# public/tests/ -> public/ -> web/
GOLDEN = Path(__file__).resolve().parents[2] / 'tests' / 'golden_formats'


def _load(name):
    return json.loads((GOLDEN / name).read_text(encoding='utf-8'))


CASES = [
    ('zencard', 'card', 'zencard-card.json'),
    ('zencard', 'pack', 'zencard-pack.json'),
    ('zenbackup', 'manifest', 'zenbackup-manifest.json'),
    ('zenflow', 'rules', 'zenflow-rules.json'),
]


def test_golden_samples_are_accepted_by_python_validator():
    for identifier, kind, name in CASES:
        result = validate(identifier, _load(name), kind)
        assert result['ok'] is True, (name, result['errors'])


def test_golden_samples_are_enforced_by_python_validator():
    card = _load('zencard-card.json')
    assert validate('zencard', {**card, 'format': 'zen-card-OLD'}, 'card')['ok'] is False

    manifest = _load('zenbackup-manifest.json')
    tampered = {**manifest, 'products': [{**manifest['products'][0], 'checksum': 'deadbeef'}]}
    assert validate('zenbackup', tampered, 'manifest')['ok'] is False

    rules = _load('zenflow-rules.json')
    assert validate('zenflow', [{**rules[0], 'actions': []}], 'rules')['ok'] is False


def test_js_counterpart_shares_the_same_fixtures():
    js_test = GOLDEN.parent / 'test_golden_formats.mjs'
    assert 'golden_formats' in js_test.read_text(encoding='utf-8')
