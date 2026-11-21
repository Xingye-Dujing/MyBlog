# -*- coding: utf-8 -*-
"""表格自动化在桌面插件体系中的注册与打包契约。"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "desktop"
for path in (str(ROOT), str(DESKTOP)):
    if path not in sys.path:
        sys.path.insert(0, path)

import offline  # noqa: E402
import plugin_manager  # noqa: E402
from plugin_specs import BUILTIN_PLUGINS, PLUGIN_BY_ID  # noqa: E402


def test_plugin_registered():
    item = PLUGIN_BY_ID["table"]
    assert item["name"] == "表格自动化"
    assert item["entry"] == "omm-table.html"
    assert item["runtime"] == "table"
    assert item["port"] == 8331
    assert item["share"]["channels"] == [{"id": "documents", "role": "publish"}]
    assert "table" in [p["id"] for p in BUILTIN_PLUGINS]


def test_runtime_and_hub_branch():
    assert "table" in plugin_manager.RUNTIMES
    hub = (DESKTOP / "hub_server.py").read_text(encoding="utf-8")
    assert "def _start_table" in hub
    assert 'runtime == "table"' in hub


def test_build_bundles_openpyxl():
    build = (DESKTOP / "build_exes.py").read_text(encoding="utf-8")
    assert "def _table_backend_args" in build
    assert "--collect-submodules" in build and '"openpyxl"' in build
    workflow = (ROOT.parent / ".github" / "workflows" / "macos-build.yml").read_text(encoding="utf-8")
    assert "requirements-table.txt" in workflow
    assert (ROOT / "requirements-table.txt").is_file()


def test_stage_plugin_contains_backend_and_page():
    with tempfile.TemporaryDirectory() as tmp:
        dest = offline.stage_plugin("table", Path(tmp) / "table")
        for name in ("omm-table.html", "zen-table.js", "zen-canvas/zen-canvas.js",
                     "zen-style/product/omm-table.css", "table-serve.py",
                     "table_engine.py", "plugin.json"):
            assert (dest / name).is_file(), name
        assert (dest / "table-runtime" / "work" / "uploads").is_dir()
        assert (dest / "table-runtime" / "work" / "jobs").is_dir()
        import json
        manifest = json.loads((dest / "plugin.json").read_text(encoding="utf-8"))
        assert manifest["runtime"] == "table"
        assert manifest["port"] == 8331
