"""Hub“今日”聚合面板端到端测试（真实浏览器）。"""
from __future__ import annotations

import unittest

from test_chain import BrowserCase


class TodayPanelTest(BrowserCase, unittest.TestCase):
    def test_hub_today_panel_aggregates_product_data(self):
        self.open("omm-hub.html")
        self.page.evaluate("""() => {
            var now = Date.now();
            localStorage.setItem('zen.cards.v1', JSON.stringify([
                { id: 'c1', content: '卡片一' }, { id: 'c2', content: '卡片二' }
            ]));
            localStorage.setItem('zen.srs.v1', JSON.stringify([
                { id: 'c1', due: now - 1000 }, { id: 'c2', due: now + 9999999 }
            ]));
            localStorage.setItem('zc-docs', JSON.stringify({
                meta: { a: { name: '笔记甲' }, b: { name: '笔记乙' } }
            }));
            localStorage.setItem('zen.flow.rules.v1', JSON.stringify([
                { id: 'r1', name: '规则一', enabled: true }
            ]));
            localStorage.setItem('omm-search-v1', JSON.stringify({
                history: [{ query: '搜索词' }]
            }));
        }""")
        self.page.click("#today-btn")
        self.page.wait_for_timeout(250)
        self.assertFalse(self.page.locator("#today-panel").is_hidden())
        body = self.page.locator("#today-body").inner_text()
        status = self.page.locator("#today-status").inner_text()
        self.assertIn("待复习", body)
        self.assertIn("笔记甲", body)
        self.assertIn("搜索词", body)
        self.assertIn("1 张待复习", status)
        self.assertIn("1/1 条规则", status)
        self.assert_no_script_errors()


if __name__ == "__main__":
    unittest.main(verbosity=2)
