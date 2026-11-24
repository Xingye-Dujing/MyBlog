# -*- coding: utf-8 -*-
"""Shared ZEN overlay behaviour in a real browser (keyboard, focus, responsive)."""
from __future__ import annotations

import functools
import http.server
import json
import threading
from pathlib import Path

import pytest

PUBLIC = Path(__file__).resolve().parent.parent

PAGE = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="zen/zen.css">
<script src="zen/foundation/util.js"></script>
<script src="zen/components/layer.js"></script>
<script src="zen/components/popover.js"></script>
<script src="zen/components/toast.js"></script>
<script src="zen/components/dialog.js"></script>
<script src="zen/components/select.js"></script>
<script src="zen/components/menu.js"></script>
<script src="zen/components/shortcuts.js"></script>
<script src="zen/components/index.js"></script>
<script src="zen/components/picker.js"></script>
<script src="omm-desktop.js"></script>
</head><body>
<button id="opener" type="button">打开对话框</button>
<label for="date">日期</label><input id="date" type="date" value="2026-11-24">
<label for="choice">选项</label><select id="choice" data-zen-select>
<option value="a">甲</option><option value="b">乙</option><option value="c">丙</option>
</select>
<div id="legacy-action" data-action="test">旧式动作</div>
<script>
window.legacyActionCount = 0;
document.getElementById('legacy-action').addEventListener('click', () => { window.legacyActionCount++ });
document.getElementById('opener').addEventListener('click', function () {
  ZenUI.modal.open({title: '测试对话框', html: '<label for="modal-input">内容</label><input id="modal-input">',
    foot: '<button id="modal-ok" type="button">确定</button>'});
});
</script>
<script type="module" src="lib/zen-link.js"></script>
</body></html>'''

HUB_PAGE = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="zen/zen.css">
<script src="zen/foundation/util.js"></script>
<script src="zen/components/layer.js"></script>
<script src="zen/components/popover.js"></script>
<script src="zen/components/toast.js"></script>
<script src="zen/components/dialog.js"></script>
<script src="zen/components/select.js"></script>
<script src="zen/components/menu.js"></script>
<script src="zen/components/shortcuts.js"></script>
<script src="zen/components/index.js"></script>
</head><body data-omm-shell="hub" data-omm-app="hub">
<button id="hub-archive" type="button" data-omm-archive-toggle>存档</button>
<script>
document.getElementById('hub-archive').addEventListener('click', function () {
  window.OMMDesktop.openPanel();
});
window.addEventListener('omm:focus-request', function () {
  var detail = { app: 'writer', name: '所思所想' };
  window.__ommFocusedApp = detail;
  window.dispatchEvent(new CustomEvent('omm:focus-app', { detail: detail }));
});
</script>
<script src="omm-desktop.js"></script>
</body></html>'''


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass


def test_shared_overlays_keyboard_focus_and_responsive_width():
    playwright = pytest.importorskip('playwright.sync_api')
    handler = functools.partial(QuietHandler, directory=str(PUBLIC))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = 'http://127.0.0.1:%d' % server.server_address[1]
    try:
        with playwright.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 375, 'height': 812})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/__ui_test__.html', lambda route: route.fulfill(
                status=200, content_type='text/html; charset=utf-8', body=PAGE,
            ))

            def desktop_api(route):
                path = route.request.url.split('/__omm/fs/', 1)[-1].split('?', 1)[0]
                payload = {'ok': True, 'desktop': True, 'app': 'test', 'entries': [], 'apps': [],
                           'config': {}, 'save_path': '', 'share_path': '', 'mode': 'versioned',
                           'auto_snapshot': True, 'auto_share': False}
                route.fulfill(status=200, content_type='application/json', body=json.dumps(payload))

            page.route('**/__omm/fs/**', desktop_api)
            page.goto(base + '/__ui_test__.html', wait_until='load')

            # Legacy data-action controls gain native-like keyboard semantics.
            assert page.locator('#legacy-action').get_attribute('role') == 'button'
            assert page.locator('#legacy-action').get_attribute('tabindex') == '0'
            page.locator('#legacy-action').focus()
            page.keyboard.press('Enter')
            page.keyboard.press('Space')
            assert page.evaluate('window.legacyActionCount') == 2
            page.evaluate("document.getElementById('legacy-action').classList.add('disabled')")
            page.wait_for_function("document.getElementById('legacy-action').getAttribute('aria-disabled') === 'true'")
            page.keyboard.press('Enter')
            assert page.evaluate('window.legacyActionCount') == 2
            page.evaluate("document.getElementById('legacy-action').classList.remove('disabled')")
            page.wait_for_function("!document.getElementById('legacy-action').hasAttribute('aria-disabled')")

            # Date picker: Enter opens, arrows move focus, Enter commits and returns focus.
            page.locator('#date').focus()
            page.keyboard.press('Enter')
            page.locator('.picker-pop.open').wait_for(state='visible')
            page.keyboard.press('ArrowDown')
            page.keyboard.press('Enter')
            page.wait_for_function("document.getElementById('date').value !== '2026-11-24'")
            assert page.evaluate('document.activeElement.id') == 'date'
            assert page.locator('.picker-pop.open').count() == 0

            # Shared select keeps focus on its trigger after keyboard selection.
            assert page.locator('button.zenui-select-trigger').get_attribute('aria-label') == '选项'
            page.locator('button.zenui-select-trigger').click()
            page.locator('.zenui-menu').wait_for(state='visible')
            page.keyboard.press('ArrowDown')
            page.keyboard.press('Enter')
            assert page.locator('#choice').input_value() == 'b'
            assert page.evaluate("document.activeElement.classList.contains('zenui-select-trigger')")

            # Content modal traps Tab/Shift+Tab, fits a phone, and restores its opener.
            page.locator('#opener').click()
            page.locator('.zenui-modal.on').wait_for(state='visible')
            card = page.locator('.zenui-modal-card').bounding_box()
            assert card['width'] <= 375
            page.keyboard.press('Shift+Tab')
            assert page.evaluate('document.activeElement.id') == 'modal-ok'
            page.keyboard.press('Tab')
            assert page.evaluate("document.activeElement.classList.contains('zenui-modal-x')")
            page.keyboard.press('Escape')
            assert page.locator('.zenui-modal').count() == 0
            assert page.evaluate('document.activeElement.id') == 'opener'

            # Archive panel is light DOM, uses the shared popover stack and restores focus.
            page.wait_for_function('window.OMMDesktop && window.OMMDesktop.enabled')
            page.locator('#omm-open').click()
            page.locator('#omm-panel.open').wait_for(state='visible')
            assert not errors, errors[:3]
            assert page.evaluate("document.getElementById('omm-desktop-host').shadowRoot === null")
            page.keyboard.press('Shift+Tab')
            assert page.evaluate("document.getElementById('omm-panel').contains(document.activeElement)")
            page.keyboard.press('Tab')
            assert page.evaluate("document.getElementById('omm-panel').contains(document.activeElement)")
            page.keyboard.press('Escape')
            assert page.locator('#omm-panel.open').count() == 0
            assert page.evaluate('document.activeElement.id') == 'omm-open'

            # ZenLink uses the shared popover/CSS and persists a real local card.
            page.locator('#zen-link-btn').wait_for(state='visible')
            page.locator('#zen-link-btn').click()
            page.locator('#zen-link-panel.open').wait_for(state='visible')
            assert page.evaluate('document.activeElement.id') == 'zlp-text'
            panel_style = page.locator('#zen-link-panel').get_attribute('style') or ''
            assert all(token not in panel_style for token in ('color', 'background', 'z-index', 'border-radius'))
            page.locator('#zlp-text').fill('共享卡片面板回归')
            page.locator('button[data-to=""]').click()
            page.locator('#zen-link-panel.open').wait_for(state='hidden')
            cards = page.evaluate("JSON.parse(localStorage.getItem('zen.cards.v1') || '[]')")
            assert cards[0]['content'] == '共享卡片面板回归'
            assert page.evaluate('document.activeElement.id') == 'zen-link-btn'
            assert not errors, errors[:3]

            # Hub answers the focus request synchronously while the archive is
            # opening. The deferred refresh must not throw or abort the popover.
            errors.clear()
            page.route('**/__hub_ui_test__.html', lambda route: route.fulfill(
                status=200, content_type='text/html; charset=utf-8', body=HUB_PAGE,
            ))
            page.goto(base + '/__hub_ui_test__.html', wait_until='load')
            page.wait_for_function('window.OMMDesktop && window.OMMDesktop.enabled')
            page.locator('#hub-archive').click()
            page.locator('#omm-panel.open').wait_for(state='visible')
            page.wait_for_timeout(200)
            assert not errors, errors[:3]
            assert '所思所想' in page.locator('#omm-save-scope').inner_text()
            page.keyboard.press('Escape')
            assert page.locator('#omm-panel.open').count() == 0
            assert page.evaluate('document.activeElement.id') == 'hub-archive'
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


CANVAS_MENU_PAGE = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="zen/zen.css">
<link rel="stylesheet" href="zen/canvas/canvas.css">
<script src="zen/foundation/util.js"></script>
<script src="zen/components/layer.js"></script>
<script src="zen/components/toast.js"></script>
<script src="zen/components/menu.js"></script>
<script src="zen/canvas/engine.js"></script>
</head><body><div id="host"></div>
<script>
window.hits = 0;
window.canvas = ZenCanvas.create({
  scope: 'browser-regression', mount: document.getElementById('host'), pan: false,
  nodeTypes: { note: { label: 'Note', render() {} } },
  onContextMenu: function () {
    return [{ label: '全选', action: function () { window.hits += 1 } }]
  },
});
</script></body></html>'''


def test_canvas_menu_click_and_right_drag_in_browser():
    playwright = pytest.importorskip('playwright.sync_api')
    handler = functools.partial(QuietHandler, directory=str(PUBLIC))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = 'http://127.0.0.1:%d' % server.server_address[1]
    try:
        with playwright.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 900, 'height': 600})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/__canvas_menu_test__.html', lambda route: route.fulfill(
                status=200, content_type='text/html; charset=utf-8', body=CANVAS_MENU_PAGE,
            ))
            page.goto(base + '/__canvas_menu_test__.html', wait_until='load')
            page.wait_for_function('window.canvas && window.canvas.workspace')

            # A real click on the shadow-DOM option must reach the action:
            # no document pointerdown handler may close the menu first.
            page.mouse.click(400, 300, button='right')
            option = page.locator('.zenui-popmenu .zenui-option')
            option.wait_for(state='visible')
            option.click()
            assert page.evaluate('window.hits') == 1
            assert page.evaluate('ZenUI.layer.get().stack.length') == 0

            # Right-drag pan is engine-owned even when pan:false disables wheel/touch.
            before = page.evaluate("document.querySelector('.zc-canvas-inner').style.transform")
            page.mouse.move(400, 300)
            page.mouse.down(button='right')
            page.mouse.move(500, 360, steps=6)
            page.mouse.up(button='right')
            after = page.evaluate("document.querySelector('.zc-canvas-inner').style.transform")
            assert before != after
            assert not errors, errors[:3]
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
