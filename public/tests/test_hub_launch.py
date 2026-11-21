# -*- coding: utf-8 -*-
"""真实工作台集成：静书房把 AI 工作区作为内置插件启动并打开页面。"""
from __future__ import annotations

import os
import sys
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
for path in (ROOT, ROOT / 'desktop'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))


def test_cli_hub_enables_desktop_bridge_by_default(monkeypatch):
    import hub_server

    monkeypatch.delenv('OMM_DESKTOP', raising=False)
    monkeypatch.delenv('OMM_APP_ID', raising=False)
    hub_server.configure_desktop_env()
    assert os.environ['OMM_DESKTOP'] == '1'
    assert os.environ['OMM_APP_ID'] == 'hub'


def test_cli_hub_web_preview_keeps_public_behaviour(monkeypatch):
    import hub_server

    monkeypatch.setenv('OMM_DESKTOP', '1')
    hub_server.configure_desktop_env(web_preview=True)
    assert os.environ['OMM_DESKTOP'] == '0'


def test_stage_copies_es_module_siblings(tmp_path):
    """Regression: `import { X } from './zen-card.js'` must be staged as well.

    The old src/href-only scan silently skipped ES module imports, so plugin
    dirs shipped without their shared JS and the page module failed to load.
    """
    import offline

    cases = {
        'omm-zenbackup.html': ('zen-backup.js', 'zen-pack.js'),
        'omm-zencard.html': ('zen-card.js', 'zen-srs.js'),
        'omm-zenclip.html': ('zen-card.js',),
        'omm-zenflow.html': ('zen-card.js', 'zen-flow.js'),
        'omm-zenreview.html': ('zen-card.js', 'zen-review.js'),
    }
    for html, assets in cases.items():
        dest = tmp_path / html
        dest.mkdir()
        offline._copy_referenced_assets(html, dest)
        for asset in assets:
            assert (dest / asset).is_file(), (html, asset)


def test_hub_starts_ai_plugin(tmp_path, monkeypatch):
    import offline
    from hub_server import HubServer

    shared = tmp_path / 'shared'
    shared.mkdir()
    monkeypatch.setenv('OMM_SHARED_DIR', str(shared))
    monkeypatch.setenv('OMM_APP_ID', 'hub')

    plugin_root = tmp_path / 'plugins'
    staged = offline.stage_plugin('ai', plugin_root / 'ai')
    assert (staged / 'plugin.json').is_file()
    assert (staged / 'omm-ai.html').is_file()
    for asset in ('omm-embed.js', 'omm-desktop.js', 'omm-share.js'):
        assert (staged / asset).is_file()

    hub = HubServer(ROOT, 8398, plugin_root=plugin_root)
    try:
        record = hub.ensure('ai')
        assert record['backend'] == 'ai'
        assert record['url'].endswith('/omm-ai.html')
        with urllib.request.urlopen(record['url'], timeout=10) as response:
            html = response.read().decode('utf-8')
        assert response.status == 200
        assert 'AI 工作区' in html
        assert 'omm-share.js' in html
        # 后端接口在同一起源可用（与产品页共享 origin）。
        base = record['url'].rsplit('/', 1)[0]
        with urllib.request.urlopen(base + '/api/omm/env', timeout=10) as response:
            env = response.read().decode('utf-8')
        assert '"products":20' in env or '"products": 20' in env
    finally:
        hub.stop_all()
