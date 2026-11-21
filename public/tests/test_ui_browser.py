# -*- coding: utf-8 -*-
"""浏览器端冒烟测试：无密钥时开箱可用、页面无脚本错误、可完成一轮对话。"""
from __future__ import annotations

import sys
import tempfile
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def test_ui_smoke_offline():
    playwright = pytest.importorskip('playwright.sync_api')
    from werkzeug.serving import make_server

    from agent_workspace.omm_server import create_app

    app = create_app(plugin_dir=ROOT, data_dir=tempfile.mkdtemp())
    server = make_server('127.0.0.1', 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    try:
        with playwright.sync_playwright() as p:
            try:
                browser = p.chromium.launch(headless=True)
            except Exception as exc:  # 浏览器未安装时静默跳过
                pytest.skip('Chromium 不可用：%s' % exc)
            page = browser.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto('http://127.0.0.1:%d/omm-ai.html' % port, wait_until='domcontentloaded')
            page.wait_for_timeout(800)
            assert page.locator('#productGrid .card').count() == 20
            assert page.locator('#skillGrid .card').count() == 24
            assert 'complete' in page.locator('#metaProvider').inner_text()
            page.fill('#input', '你能做什么？')
            page.click('#btnSend')
            page.wait_for_timeout(2500)
            assert page.locator('#chat .msg').count() == 2
            assert page.locator('#chat .msg.assistant .body').last.inner_text().strip()
            assert page.locator('#statusText').inner_text() == '完成'
            assert not errors, errors[:3]
            browser.close()
    finally:
        server.shutdown()
