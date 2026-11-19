from __future__ import annotations

import pytest

from agent_workspace import AIError, approval_preview
from agent_workspace.approvals import ONCE, SESSION, Approvals
from agent_workspace.python_runtime import run_code, status
from agent_workspace.workspace import Workspace


@pytest.fixture
def folder(tmp_path):
    root = tmp_path / 'work'
    root.mkdir()
    (root / 'a.txt').write_text('old content\n', encoding='utf-8')
    return root


@pytest.fixture
def work(folder, workspace):
    return Workspace(workspace.store, 'default', str(folder))


def test_path_sandbox_refuses_escape_and_absolute(work, folder):
    assert work.resolve('a.txt') == folder / 'a.txt'
    with pytest.raises(AIError) as exc:
        work.resolve('../outside.txt')
    assert exc.value.kind == 'refused'
    with pytest.raises(AIError):
        work.resolve(str(folder / 'a.txt'))
    assert work.describe()['configured'] is True


def test_list_read_write_and_bounds(work):
    assert any(item['name'] == 'a.txt' for item in work.list()['entries'])
    assert work.read('a.txt')['content'].replace('\r\n', '\n') == 'old content\n'
    written = work.write('sub/b.txt', 'new')
    assert written['bytes'] == 3
    assert work.read('sub/b.txt')['content'] == 'new'
    with pytest.raises(AIError):
        work.read('missing.txt')
    with pytest.raises(AIError) as exc:
        work.read('a.txt', max_bytes=2)
    assert exc.value.kind == 'refused'


def test_command_allowlist_and_shell_syntax(work):
    with pytest.raises(AIError) as exc:
        work.run('echo hi | cat', allow=('echo',))
    assert exc.value.kind == 'refused'
    with pytest.raises(AIError):
        work.run('python -c "print(1)"', allow=('echo',))
    result = work.run('python -c "print(42)"', allow=('python',), timeout=10)
    assert '42' in result['stdout']


def test_approvals_are_keyed_by_exact_arguments():
    approvals = Approvals()
    approvals.grant('c1', 'run_cmd', {'command': 'echo hi'}, ONCE)
    assert approvals.consume('c1', 'run_cmd', {'command': 'echo hi'}) is True
    assert approvals.consume('c1', 'run_cmd', {'command': 'echo hi'}) is False
    approvals.grant('c1', 'run_cmd', {'command': 'echo bye'}, SESSION)
    assert approvals.consume('c1', 'run_cmd', {'command': 'echo bye'}) is True
    assert approvals.consume('c1', 'run_cmd', {'command': 'echo bye'}) is True
    assert approvals.consume('c2', 'run_cmd', {'command': 'echo bye'}) is False
    assert approvals.revoke('c1') == 1


def test_approval_settle_needs_matching_labels():
    approvals = Approvals()
    labels = {ONCE: 'Allow once', SESSION: 'Always'}
    approvals.request('c1', 'run_cmd', {'command': 'x'}, 'call_1', labels)
    assert approvals.settle('c1', 'call_1', [{'selected': ['Deny']}]) == ''
    approvals.request('c1', 'run_cmd', {'command': 'x'}, 'call_2', labels)
    assert approvals.settle('c1', 'call_2', [{'selected': ['Always']}]) == SESSION
    assert approvals.consume('c1', 'run_cmd', {'command': 'x'}) is True


def test_preview_shows_diff_and_never_writes(work, folder):
    preview = approval_preview.preview('workspace_write', {'path': 'a.txt', 'content': 'new\n'}, work)
    assert any('-old content' in str(line) for line in preview['diff'])
    assert work.read('a.txt')['content'].replace('\r\n', '\n') == 'old content\n'
    assert approval_preview.preview('run_cmd', {'command': 'python x', 'cwd': '.'}, work)['facts']
    assert approval_preview.preview('unknown', {'x': 1}, work)['facts']


def test_python_runtime_contract():
    info = status()
    assert info['sandbox'] is False
    assert 'AGENT_OUTPUT' in info['contract']['output']
    result = run_code(
        "import json, os\nrows=[json.loads(l) for l in __import__('sys').stdin if l.strip()]\n"
        "open(os.environ['AGENT_OUTPUT'],'w').write(''.join(json.dumps({'v': r['n']*2})+chr(10) for r in rows))",
        rows=[{'n': 1}, {'n': 3}],
    )
    assert result['rows'] == [{'v': 2}, {'v': 6}]
    with pytest.raises(ValueError):
        run_code('')
