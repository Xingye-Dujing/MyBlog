# -*- coding: utf-8 -*-
"""Source-tree entrypoints must work without the desktop plugin staging step."""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PUBLIC = Path(__file__).resolve().parent.parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_mdforge_launcher_help_from_public():
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    env.pop("OMM_PLUGIN_ROOT", None)
    result = subprocess.run(
        [sys.executable, str(PUBLIC / "server" / "mdforge_serve.py"), "--help"],
        cwd=PUBLIC, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    assert result.returncode == 0, result.stderr
    assert "MDFORGE" in result.stdout.upper()


def test_latex_source_root_contains_product_page(monkeypatch):
    monkeypatch.delenv("OMM_PLUGIN_ROOT", raising=False)
    module = _load("latex_serve_entrypoint_test", PUBLIC / "server" / "latex-serve.py")
    assert (Path(module.ROOT) / "omm-latex.html").is_file()


@pytest.fixture(scope="module")
def lambda_module():
    return _load("lambda_app_entrypoint_test", PUBLIC / "server" / "lambda-app.py")


def test_lambda_version_prefers_staged_manifest(lambda_module, tmp_path):
    original = lambda_module.APP_DIR
    try:
        lambda_module.APP_DIR = tmp_path
        (tmp_path / "plugin.json").write_text(
            json.dumps({"id": "lambda", "version": "9.8.7"}), encoding="utf-8")
        assert lambda_module._read_version() == "9.8.7"
    finally:
        lambda_module.APP_DIR = original


def test_lambda_version_falls_back_to_source_spec(lambda_module, tmp_path):
    original = lambda_module.APP_DIR
    try:
        lambda_module.APP_DIR = tmp_path
        desktop = tmp_path / "desktop"
        desktop.mkdir()
        (desktop / "plugin_specs.py").write_text('VERSION = "1.2.3"\n', encoding="utf-8")
        assert lambda_module._read_version() == "1.2.3"
    finally:
        lambda_module.APP_DIR = original
