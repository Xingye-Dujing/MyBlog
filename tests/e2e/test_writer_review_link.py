"""Writer 引用回链复习 + 今日复习画布的浏览器端到端验证。

    public/.venv/Scripts/python.exe -m unittest discover -s tests/e2e -v

复用 test_chain 的静态服务器与浏览器生命周期，只在真实 DOM 里验证：
1) card picker 的"今日到期"筛选确实过滤出到期卡片；
2) 插入卡片后引用节点带"习"复习按钮与 zenCardId。
"""
from __future__ import annotations

import unittest

from test_chain import BrowserCase


class WriterReviewLinkTest(BrowserCase, unittest.TestCase):
    def _seed(self):
        self.page.evaluate("""() => {
            localStorage.setItem('zen.cards.v1', JSON.stringify([
                { id: 'due-card', content: '到期的卡片', kind: 'question', source: 'manual', tags: ['复习'] },
                { id: 'future-card', content: '未到期的卡片', kind: 'note', source: 'manual', tags: [] }
            ]));
            localStorage.setItem('zen.srs.v1', JSON.stringify([
                { id: 'due-card', due: Date.now() - 1000, reps: 1 },
                { id: 'future-card', due: Date.now() + 86400000, reps: 1 }
            ]));
        }""")

    def test_due_filter_shows_only_due_cards(self):
        self.open("omm-writer.html")
        self._seed()
        self.assert_no_script_errors()
        # Open the card picker directly via its exposed API.
        self.page.evaluate("window.ZenWriterDeep.openCardPicker({x:0,y:0})")
        self.page.wait_for_timeout(150)
        self.assertTrue(self.page.evaluate("typeof window.ZenWriterDeep.dueCardIds === 'function'"))
        due = self.page.evaluate("Object.keys(window.ZenWriterDeep.dueCardIds())")
        self.assertIn("due-card", due)
        self.assertNotIn("future-card", due)
        # Toggle the due-only checkbox and re-open through the change handler.
        self.page.check("#zw-zen-due")
        self.page.wait_for_timeout(150)
        items = self.page.locator("#zw-zen-card-list .zw-zen-item").count()
        self.assertEqual(items, 1)
        self.assert_no_script_errors()

    def test_inserted_citation_has_review_action(self):
        self.open("omm-writer.html")
        self._seed()
        self.page.evaluate("""() => {
            window.ZenWriterDeep.insertCard({
                id: 'due-card', content: '到期的卡片', kind: 'question', source: 'manual', tags: []
            });
        }""")
        self.page.wait_for_timeout(200)
        # The inserted citation node carries the card id and a review button.
        self.assertGreater(self.page.locator('[data-action="reviewCard"]').count(), 0)
        node_id = self.page.evaluate("""() => {
            const n = document.querySelector('.node[data-zen-card-id="due-card"]');
            return n ? n.dataset.zenCardId : '';
        }""")
        self.assertEqual(node_id, "due-card")
        self.assert_no_script_errors()


if __name__ == "__main__":
    unittest.main()
