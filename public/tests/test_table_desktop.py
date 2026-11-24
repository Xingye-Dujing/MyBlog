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
        for name in ("omm-table.html", "lib/zen-table.js", "zen/canvas/engine.js",
                     "zen/products/table.css", "table-serve.py",
                     "table_engine.py", "plugin.json"):
            assert (dest / name).is_file(), name
        assert (dest / "table-runtime" / "work" / "uploads").is_dir()
        assert (dest / "table-runtime" / "work" / "jobs").is_dir()
        import json
        manifest = json.loads((dest / "plugin.json").read_text(encoding="utf-8"))
        assert manifest["runtime"] == "table"
        assert manifest["port"] == 8331


def test_stage_plugin_only_stages_its_own_product_styles(tmp_path):
    table = offline.stage_plugin("table", tmp_path / "table")
    lambda_app = offline.stage_plugin("lambda", tmp_path / "lambda")
    assert (table / "zen/products/table.css").is_file()
    assert not (table / "zen/products/lambda.css").exists()
    assert (lambda_app / "zen/products/lambda.css").is_file()
    assert not (lambda_app / "zen/products/table.css").exists()
    assert (lambda_app / "fonts/APL385.ttf").is_file()


def test_lambda_runtime_stages_desktop_bridge_modules_without_state(tmp_path, monkeypatch):
    source = tmp_path / "source"
    dest = tmp_path / "lambda"
    dest.mkdir()
    (source / "server").mkdir(parents=True)
    (source / "desktop").mkdir()
    (source / "server" / "lambda-app.py").write_text("backend", encoding="utf-8")
    modules = ("omm_fs.py", "omm_shared.py", "omm_share.py", "plugin_specs.py", "plugin_manager.py")
    for name in modules:
        (source / "desktop" / name).write_text("# " + name, encoding="utf-8")
    for name in ("sessions.json", "shares.json", "tokens.json", "sharepages.json"):
        (source / name).write_text("private", encoding="utf-8")
    (source / "sharepages").mkdir()
    (source / "sharepages" / "private.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(offline, "ROOT", source)
    offline.copy_lambda_runtime(dest)
    for name in modules:
        assert (dest / name).read_text(encoding="utf-8") == "# " + name
    for name in ("sessions.json", "shares.json", "tokens.json", "sharepages", "sharepages.json"):
        assert not (dest / name).exists(), name


def test_lambda_runtime_does_not_stage_user_state(tmp_path, monkeypatch):
    source = tmp_path / "source"
    dest = tmp_path / "lambda"
    (source / "server").mkdir(parents=True)
    (source / "server" / "lambda-app.py").write_text("backend", encoding="utf-8")
    (source / "fonts").mkdir()
    (source / "fonts" / "font.ttf").write_bytes(b"font")
    for name in ("benchmarks.json", "sessions.json", "shares.json", "tokens.json", "sharepages.json"):
        (source / name).write_text("{}", encoding="utf-8")
    (source / "sharepages").mkdir()
    (source / "sharepages" / "private.json").write_text("{}", encoding="utf-8")
    dest.mkdir()
    for name in ("sessions.json", "shares.json", "tokens.json", "sharepages.json"):
        (dest / name).write_text("stale", encoding="utf-8")
    (dest / "sharepages").mkdir()
    (dest / "sharepages" / "stale.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(offline, "ROOT", source)
    offline.copy_lambda_runtime(dest)
    assert (dest / "lambda-app.py").is_file()
    assert (dest / "benchmarks.json").is_file()
    assert (dest / "fonts" / "font.ttf").is_file()
    for name in ("sessions.json", "shares.json", "tokens.json", "sharepages", "sharepages.json"):
        assert not (dest / name).exists(), name
