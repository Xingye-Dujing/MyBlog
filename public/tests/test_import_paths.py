# -*- coding: utf-8 -*-
"""锁定 agent_workspace 的导入方式。

包内有一个 ``types.py``，如果把包目录本身放进 sys.path，它会遮蔽标准库
``types`` 并导致循环导入。唯一支持的用法是把 ``public/`` 放进 sys.path，
再以 ``agent_workspace.<模块>`` 的包路径导入（conftest.py 已如此配置）。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

PUBLIC = Path(__file__).resolve().parents[1]
PKG = PUBLIC / 'agent_workspace'


def _run(code: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, '-c', code],
        cwd=str(PUBLIC),
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )


def test_package_path_import_is_supported():
    result = _run(
        "import sys; sys.path.insert(0, %r); "
        "import agent_workspace.omm_data as d; "
        "import agent_workspace.omm_validators as v; "
        "print(d.VERSION, callable(v.validate))" % str(PUBLIC)
    )
    assert result.returncode == 0, result.stderr
    assert 'True' in result.stdout


def test_flat_import_is_known_unsupported():
    """Document the caveat with an executable assertion, not just a comment."""
    result = _run(
        "import sys; sys.path.insert(0, %r); import omm_data" % str(PKG)
    )
    assert result.returncode != 0
    assert 'MappingProxyType' in result.stderr or 'circular import' in result.stderr
