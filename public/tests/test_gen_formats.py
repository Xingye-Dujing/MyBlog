# -*- coding: utf-8 -*-
"""格式契约单一真源测试：注册表 → 生成物 → 校验器 → AI 骨架全链路。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from agent_workspace import omm_formats_generated as generated  # noqa: E402
from agent_workspace.omm_validators import TEMPLATES, detect_kind, validate  # noqa: E402
from tools import gen_formats  # noqa: E402


@pytest.fixture()
def registry():
    return json.loads(gen_formats.REGISTRY.read_text(encoding='utf-8'))


def test_registry_is_a_complete_contract(registry):
    assert registry['schema'] == 1
    assert registry['checksum'] == 'fnv1a-utf16-base36'
    rows = registry['formats']
    assert len(rows) >= 28
    keys = [(row['product'], row['kind']) for row in rows]
    assert len(keys) == len(set(keys))
    for row in rows:
        assert row['source'].startswith('public/')
        assert row['validator'].startswith('v_')
        assert isinstance(row['template'], (dict, list, str))
        assert isinstance(row['hard'], list)
    for pid in {row['product'] for row in rows}:
        assert pid in registry['detection']


def test_generated_artifacts_match_registry(registry):
    assert gen_formats.PY_OUT.read_text(encoding='utf-8') == gen_formats.render_py(registry)
    md = gen_formats.render_md(registry)
    assert gen_formats.MD_OUT.read_text(encoding='utf-8') == md
    assert gen_formats.MD_MIRROR.read_text(encoding='utf-8') == md
    assert gen_formats.main(check=True) == 0


def test_render_is_deterministic(registry):
    assert gen_formats.render_md(registry) == gen_formats.render_md(registry)
    assert gen_formats.render_py(registry) == gen_formats.render_py(registry)


def test_check_detects_stale_generated_file(registry, tmp_path, monkeypatch):
    stale = tmp_path / 'stale.py'
    stale.write_text('# stale\n', encoding='utf-8')
    monkeypatch.setattr(gen_formats, 'PY_OUT', stale)
    monkeypatch.setattr(gen_formats, 'MD_OUT', tmp_path / 'a.md')
    monkeypatch.setattr(gen_formats, 'MD_MIRROR', tmp_path / 'b.md')
    assert gen_formats.main(check=True) == 1


def test_every_template_validates_and_detects(registry):
    for row in registry['formats']:
        pid, kind, tpl = row['product'], row['kind'], row['template']
        assert TEMPLATES[pid][kind] == tpl
        result = validate(pid, tpl, kind)
        if kind == 'unsupported':
            assert not result['ok']
        else:
            assert result['ok'], (pid, kind, result['errors'])
        payload = tpl if isinstance(tpl, (dict, list)) else None
        text = tpl if isinstance(tpl, str) else ''
        assert detect_kind(pid, payload, text) == kind, (pid, kind)


def test_declarative_contract_rejects_drift():
    from agent_workspace.omm_validators import declarative_errors
    # format token / version / enum are declared by the registry, not code.
    assert declarative_errors('zencard', 'pack', {'format': 'zen-card'})
    card = json.loads(json.dumps(TEMPLATES['zencard']['card']))
    assert declarative_errors('zencard', 'card', card) == []
    card['kind'] = 'bogus'
    assert declarative_errors('zencard', 'card', card)
    backup = json.loads(json.dumps(TEMPLATES['planner']['backup']))
    assert declarative_errors('planner', 'backup', backup) == []
    backup['version'] = '2'
    assert declarative_errors('planner', 'backup', backup)


def test_golden_fixtures_still_accepted(registry):
    goldens = ROOT.parent / 'tests' / 'golden_formats'
    for row in registry['formats']:
        if not row.get('golden'):
            continue
        content = json.loads((goldens / row['golden']).read_text(encoding='utf-8'))
        assert validate(row['product'], content, row['kind'])['ok'], row['golden']


def test_generated_format_tokens_and_strengths():
    assert 'zen-card' in generated.FORMAT_TOKENS
    assert 'zen-card-pack' in generated.FORMAT_TOKENS
    assert 'zen-backup' in generated.FORMAT_TOKENS
    assert ('zencard', 'card') in generated.HARD_GATES
    assert len(generated.REGISTRY) >= 28
