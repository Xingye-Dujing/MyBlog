"""Unittest wrapper for the quote-style guard (see no_jp_quotes.py).

The guard's own source deliberately contains no forbidden glyphs (it builds
them with chr()), so this test file must avoid them too.
"""
import unittest

import no_jp_quotes as guard


class NoJapaneseQuoteTests(unittest.TestCase):
    def test_repair_maps_every_forbidden_character(self):
        for ch, expected in guard.FORBIDDEN.items():
            self.assertEqual(guard.repair_text(ch), expected)
            self.assertEqual(guard.count_forbidden(guard.repair_text(ch)), 0)

    def test_repair_is_idempotent_and_preserves_surrounding_text(self):
        src = "before" + chr(0x300C) + "标题" + chr(0x300D) + "after"
        once = guard.repair_text(src)
        self.assertEqual(guard.repair_text(once), once)
        self.assertEqual(guard.count_forbidden(once), 0)
        self.assertTrue(once.startswith("before"))
        self.assertTrue(once.endswith("after"))

    def test_no_forbidden_quotes_anywhere_in_product_sources(self):
        hits = guard.scan()
        self.assertEqual(
            hits, {},
            "OMM-ZEN 源码/文档/数据中仍存在禁用引号，请运行 "
            "python tests/no_jp_quotes.py --fix",
        )


if __name__ == "__main__":
    unittest.main()
