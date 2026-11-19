"""Python extension surface: one script library, a scrubbed child environment and both contracts.

The original product's ``CIXI_*`` names must keep working after a host migrates, and a key present in
the server's environment must never reach a child script. These tests exercise the real subprocess
with the interpreter from the test venv, so they are fast and deterministic.
"""

from __future__ import annotations

import pytest

from agent_workspace import python_runtime
from agent_workspace.errors import AIError
from agent_workspace.python_scripts import BUILTINS


def test_scripts_seeded_once_and_builtins_read_only(offline):
    rows = offline.scripts('default')
    assert {row['id'] for row in rows} >= set(BUILTINS)
    assert all(row['builtin'] for row in rows if row['id'] in BUILTINS)
    with pytest.raises(AIError) as exc:
        offline.save_script('default', {'id': 'clean_text', 'code': 'overwrite'})
    assert exc.value.key == 'python.builtinReadOnly'


def test_script_save_version_fork_and_delete(offline):
    first = offline.save_script('default', {'id': 'my.clean', 'name': 'Clean', 'code': 'print(1)'})
    assert first['version'] == 1
    second = offline.save_script('default', {'id': 'my.clean', 'name': 'Clean2', 'code': 'print(2)'})
    assert second['version'] == 2
    forked = offline.fork_script('default', 'my.clean')
    assert forked['id'] == 'my.clean_copy'
    assert offline.get_script('default', 'my.clean')['code'] == 'print(2)'
    assert offline.delete_script('default', forked['id']) is True
    assert offline.delete_script('default', 'clean_text') is False  # builtins are read-only


def test_clean_env_removes_credentials(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-should-not-leak')
    monkeypatch.setenv('MY_ACCESS_TOKEN', 'secret')
    monkeypatch.setenv('PYTHONPATH', '/some/path')
    env = python_runtime.clean_env({'CIXI_ARGS': '{}'})
    assert 'OPENAI_API_KEY' not in env
    assert 'MY_ACCESS_TOKEN' not in env
    assert 'PYTHONPATH' not in env
    assert env['CIXI_ARGS'] == '{}'
    assert env['PYTHONIOENCODING'] == 'utf-8'


def test_run_code_exports_both_contract_names(offline):
    script = (
        'import json, os\n'
        "rows = [json.loads(x) for x in __import__('sys').stdin if x.strip()]\n"
        "out = os.environ.get('CIXI_OUTPUT') or os.environ.get('AGENT_OUTPUT')\n"
        "args = json.loads(os.environ.get('CIXI_ARGS') or os.environ.get('AGENT_ARGS') or '{}')\n"
        "with open(out, 'w', encoding='utf-8') as f:\n"
        '    for row in rows:\n'
        "        row['suffix'] = args.get('suffix', '')\n"
        "        f.write(json.dumps(row, ensure_ascii=False) + '\\n')\n"
    )
    result = python_runtime.run_code(
        script,
        rows=[{'text': '你好'}, {'text': '世界'}],
        args={'suffix': '!'},
        python_bin=python_runtime.interpreter(),
    )
    assert result['row_count'] == 2
    assert result['rows'][0] == {'text': '你好', 'suffix': '!'}


def test_builtin_script_runs_through_library(offline):
    code = offline.library.code('default', 'dedupe')
    result = python_runtime.run_code(
        code,
        rows=[{'text': 'a'}, {'text': 'a'}, {'text': 'b'}],
        python_bin=python_runtime.interpreter(),
    )
    assert result['row_count'] == 2


def test_python_run_tool_uses_script_id(offline):
    offline.settings.set('python.allowed', True)
    result = offline.tools.execute(
        'python_run', {'script_id': 'passthrough', 'rows': [{'text': 'x'}]}, {'account': 'default'}
    )
    assert result['row_count'] == 1
    with pytest.raises(AIError):
        offline.tools.execute('python_run', {'script_id': 'missing'}, {'account': 'default'})
