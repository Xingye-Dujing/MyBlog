"""OMM-ZEN 端到端链路测试（真实浏览器）。

运行（需仓库自带 virtualenv 中的 Playwright）：
    public/.venv/Scripts/python.exe -m unittest discover -s tests/e2e -v

用本地静态 HTTP 服务器提供 public/，因此 /api/* 与 /__omm/* 这类本地后端
接口会返回 404；测试只把未捕获的脚本异常（pageerror）视为失败，忽略这类
预期的资源 404。每条测试用独立 BrowserContext，避免 localStorage 互相污染。
"""
from __future__ import annotations

import http.server
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public"

PAGES = sorted(
    p.name for p in PUBLIC.glob("omm-*.html")
)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def log_message(self, *args):
        pass


class BrowserCase:
    """Shared browser lifecycle; no tests live here so subclasses stay focused."""
    @classmethod
    def setUpClass(cls):
        cls._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls._thread = threading.Thread(target=cls._server.serve_forever, daemon=True)
        cls._thread.start()
        cls.base = "http://127.0.0.1:%d/" % cls._server.server_address[1]
        cls._pw = sync_playwright().start()
        cls.browser = cls._pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls._pw.stop()
        cls._server.shutdown()
        cls._server.server_close()

    def setUp(self):
        self.context = self.browser.new_context(accept_downloads=True)
        self.page = self.context.new_page()
        self._errors = []
        self.page.on("pageerror", lambda e: self._errors.append(str(e)))
        self.page.on("dialog", lambda d: d.accept())

    def tearDown(self):
        self.context.close()

    def open(self, name):
        self.page.goto(self.base + name, wait_until="domcontentloaded", timeout=30000)
        self.page.wait_for_timeout(350)
        return self.page

    def assert_no_script_errors(self):
        self.assertEqual(self._errors, [], "页面存在未捕获脚本异常: %s" % self._errors[:3])

    def select_zen_option(self, selector, value, label):
        """Use the shared select's visible trigger and shadow-DOM option list."""
        select = self.page.locator(selector)
        select.locator("xpath=..").locator(".zenui-select-trigger").click()
        self.page.locator(".zenui-option", has_text=label).click()
        self.assertEqual(select.input_value(), value)

class ChainTest(BrowserCase, unittest.TestCase):
    """Online chains: the suite runs against the local static server."""

    # ------------------------------------------------------------------ #
    def test_all_pages_boot_without_script_errors(self):
        self.assertGreaterEqual(len(PAGES), 18, "产品页数量异常")
        for name in PAGES:
            with self.subTest(page=name):
                self._errors.clear()
                self.open(name)
                self.assertTrue(self.page.title(), "%s 没有 title" % name)
                self.assert_no_script_errors()

    def test_zencard_creates_and_persists_card(self):
        self.open("omm-zencard.html")
        self.page.click('[data-view="library"]')
        self.page.fill("#new-content", "E2E 测试卡片")
        self.page.fill("#new-translation", "E2E card")
        self.page.fill("#new-note", "来自端到端测试")
        self.page.fill("#new-tags", "e2e,链路")
        self.page.click("#add-card")
        self.page.wait_for_timeout(200)

        cards = json.loads(self.page.evaluate("localStorage.getItem('zen.cards.v1') || '[]'"))
        self.assertTrue(any("E2E 测试卡片" in c.get("content", "") for c in cards))
        self.assert_no_script_errors()

        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_timeout(300)
        self.assertIn("E2E 测试卡片", self.page.locator("body").inner_text())

    def test_zenflow_rule_and_shared_layout_module(self):
        self.open("omm-zenflow.html")
        self.page.click('[data-view="editor"]')
        # 确认通用布局模块已加载（Writer 抽取的同一份实现）。
        self.assertTrue(self.page.evaluate("typeof window.ZenCanvasLayout === 'object'"))
        self.assertTrue(self.page.evaluate(
            "typeof window.ZenCanvasLayout.computeCanvasLayout === 'function'"))

        self.page.fill("#r-name", "E2E 自动化规则")
        self.page.fill("#w-tag", "e2e")
        self.select_zen_option("#a-type", "notify", "通知")
        self.page.fill("#a-value", "hello")
        self.page.click("#add-action")
        self.page.click("#save-rule")
        self.page.wait_for_timeout(200)

        rules = json.loads(self.page.evaluate("localStorage.getItem('zen.flow.rules.v1') || '[]'"))
        self.assertTrue(any("E2E 自动化规则" in r.get("name", "") for r in rules))
        self.assert_no_script_errors()

        self.page.click('[data-view="flow"]')
        self.page.wait_for_timeout(400)
        self.assertGreater(self.page.locator("#flow-canvas .flow-node").count(), 0)
        self.assertIn("条规则", self.page.locator("#flow-status").inner_text())
        self.assert_no_script_errors()

    def test_zenpack_export_import_restore_roundtrip(self):
        self.open("omm-zenbackup.html")
        self.page.evaluate("""() => {
            localStorage.setItem('zen.cards.v1', JSON.stringify([{ id: 'e2e', content: '搬家卡片' }]));
            localStorage.setItem('zen.theme', 'dark');
        }""")
        self.page.click("#zp-collect")
        self.page.wait_for_timeout(200)
        self.assertGreater(int(self.page.locator("#manifest-count").inner_text()), 0)

        with tempfile.TemporaryDirectory() as tmp:
            pack = os.path.join(tmp, "pack.json")
            with self.page.expect_download() as dl:
                self.page.click("#zp-export")
            dl.value.save_as(pack)
            data = json.loads(Path(pack).read_text(encoding="utf-8"))
            self.assertEqual(data["format"], "zen-backup")
            self.assertIn("zen.cards.v1", [p["id"] for p in data["products"]])

            # 换一个干净上下文模拟另一台设备：清空后导入同一份包并恢复。
            self.page.evaluate("localStorage.clear()")
            self.page.reload(wait_until="domcontentloaded")
            self.page.wait_for_timeout(300)
            self.assertIsNone(self.page.evaluate("localStorage.getItem('zen.cards.v1')"))

            self.page.set_input_files("#zp-file", pack)
            self.page.wait_for_timeout(300)
            self.assertNotIn("尚未导入", self.page.locator("#zp-diff").inner_text())
            self.page.click("#zp-restore")
            self.page.locator(".zenui-ok").click()
            self.page.wait_for_function("localStorage.getItem('zen.cards.v1') !== null")
            restored = json.loads(self.page.evaluate("localStorage.getItem('zen.cards.v1') || '[]'"))
            self.assertTrue(any("搬家卡片" in c.get("content", "") for c in restored))
        self.assert_no_script_errors()

    def test_hub_cmdk_finds_product_owned_data(self):
        self.open("omm-hub.html")
        self.page.evaluate("""() => {
            localStorage.setItem('zen.cards.v1', JSON.stringify([
                { id: 'c1', content: 'E2E 命令面板卡片', kind: 'note', source: 'manual', tags: ['e2e'] }
            ]));
        }""")
        self.page.click("#command-btn")
        self.page.wait_for_timeout(200)
        self.assertFalse(self.page.locator("#command-palette").is_hidden())
        self.page.fill("#cmdk-input", "E2E 命令面板卡片")
        self.page.wait_for_timeout(200)
        text = self.page.locator("#cmdk-list").inner_text()
        self.assertIn("E2E 命令面板卡片", text)
        self.assertIn("知识卡片", text)
        self.assert_no_script_errors()

class OfflineChainTest(BrowserCase, unittest.TestCase):
    """Same user flows, but every non-local network request is blocked.

    A static page still loads from 127.0.0.1; anything leaving the machine is
    aborted.  This turns "fully offline" from a claim into a regression test.
    """

    def setUp(self):
        super().setUp()
        self.context.route("**/*", self._offline)

    def _offline(self, route):
        url = route.request.url
        if (url.startswith("http://127.0.0.1")
                or url.startswith("data:")
                or url.startswith("blob:")):
            route.continue_()
        else:
            route.abort()

    def test_offline_zencard_roundtrip(self):
        self.open("omm-zencard.html")
        self.page.click('[data-view="library"]')
        self.page.fill("#new-content", "离线卡片")
        self.page.click("#add-card")
        self.page.wait_for_timeout(200)
        cards = json.loads(self.page.evaluate("localStorage.getItem('zen.cards.v1') || '[]'"))
        self.assertTrue(any("离线卡片" in c.get("content", "") for c in cards))
        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_timeout(300)
        self.assertIn("离线卡片", self.page.locator("body").inner_text())
        self.assert_no_script_errors()

    def test_offline_zenflow_rule_and_layout(self):
        self.open("omm-zenflow.html")
        self.assertTrue(self.page.evaluate("typeof window.ZenCanvasLayout === 'object'"))
        self.page.click('[data-view="editor"]')
        self.page.fill("#r-name", "离线规则")
        self.page.fill("#w-tag", "offline")
        self.select_zen_option("#a-type", "notify", "通知")
        self.page.fill("#a-value", "hello")
        self.page.click("#add-action")
        self.page.click("#save-rule")
        self.page.wait_for_timeout(200)
        rules = json.loads(self.page.evaluate("localStorage.getItem('zen.flow.rules.v1') || '[]'"))
        self.assertTrue(any("离线规则" in r.get("name", "") for r in rules))
        self.page.click('[data-view="flow"]')
        self.page.wait_for_timeout(300)
        self.assertGreater(self.page.locator("#flow-canvas .flow-node").count(), 0)
        self.assert_no_script_errors()

    def test_offline_zenpack_export(self):
        self.open("omm-zenbackup.html")
        self.page.evaluate("localStorage.setItem('zen.cards.v1', '[{\"id\":\"off\",\"content\":\"离线包\"}]')")
        self.page.click("#zp-collect")
        self.page.wait_for_timeout(200)
        self.assertGreater(int(self.page.locator("#manifest-count").inner_text()), 0)
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "offline-pack.json")
            with self.page.expect_download() as dl:
                self.page.click("#zp-export")
            dl.value.save_as(target)
            data = json.loads(Path(target).read_text(encoding="utf-8"))
            self.assertEqual(data["format"], "zen-backup")
        self.assert_no_script_errors()

    def test_offline_hub_cmdk(self):
        self.open("omm-hub.html")
        self.page.evaluate("""() => {
            localStorage.setItem('zen.cards.v1', JSON.stringify([
                { id: 'o1', content: '离线命令卡片', kind: 'note', source: 'manual', tags: ['offline'] }
            ]));
        }""")
        self.page.click("#command-btn")
        self.page.fill("#cmdk-input", "离线命令卡片")
        self.page.wait_for_timeout(200)
        self.assertIn("离线命令卡片", self.page.locator("#cmdk-list").inner_text())
        self.assert_no_script_errors()


if __name__ == "__main__":
    unittest.main(verbosity=2)
