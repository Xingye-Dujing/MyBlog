# -*- coding: utf-8 -*-
"""真实工作台集成：静书房把 AI 工作区作为内置插件启动并打开页面。"""
from __future__ import annotations

import json
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
        'omm-zenbackup.html': ('lib/zen-backup.js', 'lib/zen-pack.js'),
        'omm-zencard.html': ('lib/zen-card.js', 'lib/zen-srs.js'),
        'omm-zenclip.html': ('lib/zen-card.js',),
        'omm-zenflow.html': ('lib/zen-card.js', 'lib/zen-flow.js'),
        'omm-zenreview.html': ('lib/zen-card.js', 'lib/zen-review.js'),
    }
    for html, assets in cases.items():
        dest = tmp_path / html
        dest.mkdir()
        offline._copy_referenced_assets(html, dest)
        offline.copy_shared_lib(dest)
        for asset in assets:
            assert (dest / asset).is_file(), (html, asset)


@pytest.mark.parametrize("runtime", ["ai", "mdforge", "latex", "video"])
def test_hub_product_bridges_keep_product_identity(runtime, tmp_path, monkeypatch):
    """OMM_APP_ID=hub 是 Hub 进程身份，不能覆盖各产品的桌面桥身份。"""
    import hub_server

    monkeypatch.setenv("OMM_DESKTOP", "1")
    monkeypatch.setenv("OMM_APP_ID", "hub")
    monkeypatch.setenv("OMM_SHARED_DIR", str(tmp_path / "shared"))
    monkeypatch.setenv("OMM_DATA_DIR", str(tmp_path / "data"))
    hub = hub_server.HubServer(ROOT, 8398, plugin_root=tmp_path / "plugins")
    server = None
    try:
        server = getattr(hub, "_start_" + runtime)(0, ROOT)
        base = "http://127.0.0.1:%d" % server.server_port
        headers = {"Origin": base, "Sec-Fetch-Site": "same-origin"}
        for path in ("/__omm/fs/status", "/__omm/fs/config", "/__omm/share/space"):
            request = urllib.request.Request(base + path, headers=headers)
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.loads(response.read().decode("utf-8"))
                assert response.status == 200, (runtime, path, payload)
            assert payload["app"] == runtime, (runtime, path, payload)
            assert payload["ok"] is True, (runtime, path, payload)
        post_headers = dict(headers, **{"Content-Type": "application/json"})
        request = urllib.request.Request(
            base + "/__omm/fs/config",
            data=json.dumps({"mode": "overwrite"}).encode("utf-8"),
            headers=post_headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
            assert response.status == 200, (runtime, "POST /__omm/fs/config", payload)
        assert payload["app"] == runtime and payload["ok"] is True, (runtime, payload)
    finally:
        if server is not None:
            hub_server._stop_server(server)
        hub.stop_all()


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
