"""Unit tests for the unified OMM-ZEN product guard.

All tests are synthetic: no production file is modified and no real network or
build step is involved.  The guard is fed a small in-memory file map plus a
stub ``exists`` predicate so each check can be verified in isolation.
"""
import io
import unittest
from contextlib import redirect_stdout, redirect_stderr

import product_guard as g


class LocalTargetTests(unittest.TestCase):
    def test_external_and_special_urls_are_ignored(self):
        for url in [
            "https://example.com/a.css", "http://x/y", "//cdn/x.js", "#top",
            "mailto:a@b.c", "data:text/plain,hi", "javascript:void(0)",
            "$2", "${BASE}/x", "%BASE_URL%vendor/x.css", "<placeholder>",
        ]:
            with self.subTest(url=url):
                self.assertIsNone(g.local_target("public/omm-x.html", url))

    def test_root_relative_is_rooted_at_web_root(self):
        self.assertEqual(g.local_target("public/omm-x.html", "/icon.ico"), "icon.ico")
        self.assertEqual(g.local_target("public/omm-x.html", "/js/a.js"), "js/a.js")

    def test_relative_paths_resolve_against_owner_directory(self):
        self.assertEqual(
            g.local_target("public/json-specs/README.md", "writer.md"),
            "json-specs/writer.md",
        )
        self.assertEqual(
            g.local_target("public/json-specs/README.md", "../zen-card.js"),
            "zen-card.js",
        )
        self.assertEqual(
            g.local_target("public/omm-x.html", "zen-link.js"), "zen-link.js",
        )

    def test_query_fragment_and_encoding_are_stripped(self):
        self.assertEqual(
            g.local_target("public/omm-x.html", "./img/a%20b.png?v=2#top"),
            "img/a b.png",
        )


class LinkCheckTests(unittest.TestCase):
    def setUp(self):
        self.exists = lambda t: t in {"zen-link.js", "img/ok.png", "json-specs/writer.md"}

    def test_detects_missing_local_link_once_per_target(self):
        files = {
            "public/omm-x.html":
                '<link href="nope.css">\n<img src="nope.css">\n<a href="zen-link.js">ok</a>',
        }
        issues = g.check_links(files, self.exists)
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].code, "LINK")
        self.assertEqual(issues[0].line, 1)

    def test_markdown_prose_example_is_not_a_link(self):
        files = {"public/json-specs/writer.md": "用 [文字](链接) 表示链接，见 [规范](writer.md)"}
        issues = g.check_links(files, self.exists)
        self.assertEqual(issues, [])

    def test_files_outside_scope_are_ignored(self):
        files = {"public/README-MDFORGE.md": "![图](images/pipeline.png)"}
        self.assertEqual(g.check_links(files, self.exists), [])


class ImportCheckTests(unittest.TestCase):
    def test_unresolved_import_is_reported(self):
        files = {"public/m.js": "import { X } from './missing.js'\n"}
        issues = g.check_imports(files, lambda t: False)
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].code, "IMPORT")

    def test_resolved_import_and_out_of_scope_file_are_ignored(self):
        files = {
            "public/m.js": "import { X } from './ok.js'\n",
            "src/main.js": "import App from './App.vue'\n",
        }
        self.assertEqual(g.check_imports(files, lambda t: t == "ok.js"), [])


class BridgeCheckTests(unittest.TestCase):
    def _files(self, omit=None):
        files = {}
        for name in sorted(g.BRIDGE_PRODUCTS):
            if name == omit:
                continue
            files["public/omm-%s.html" % name] = (
                '<script type="module" src="zen-link.js"></script>'
            )
        return files

    def test_all_products_correctly_injected(self):
        self.assertEqual(g.check_bridge(self._files(), lambda t: True), [])

    def test_missing_product_and_missing_script_are_reported(self):
        files = self._files(omit="writer")
        files["public/omm-data.html"] = '<script src="zen-link.js"></script>'
        issues = g.check_bridge(files, lambda t: True)
        self.assertEqual(len(issues), 2)
        self.assertTrue(all(i.code == "BRIDGE" for i in issues))

    def test_single_quoted_module_script_is_accepted(self):
        files = self._files()
        files["public/omm-writer.html"] = "<script type='module' src='zen-link.js'></script>"
        self.assertEqual(g.check_bridge(files, lambda t: True), [])


class SpecCheckTests(unittest.TestCase):
    def test_indexed_specs_are_clean(self):
        files = {
            "public/json-specs/README.md": "[A](a.md) [B](b.md) [P](prompts.md)",
            "public/json-specs/a.md": "a",
            "public/json-specs/b.md": "b",
            "public/json-specs/prompts.md": "p",
            "public/json-specs/README.md.bak": "ignored",
        }
        issues = g.check_specs(files, lambda t: True)
        self.assertEqual(issues, [])

    def test_unindexed_and_dangling_specs_are_reported(self):
        files = {
            "public/json-specs/README.md": "[A](a.md) [Ghost](ghost.md)",
            "public/json-specs/a.md": "a",
            "public/json-specs/orphan.md": "o",
        }
        issues = g.check_specs(files, lambda t: True)
        self.assertEqual(len(issues), 2)
        self.assertTrue(any("未被 README 索引" in i.message for i in issues))
        self.assertTrue(any("不存在" in i.message for i in issues))


class DebugCheckTests(unittest.TestCase):
    def test_debugger_statement_is_reported(self):
        files = {"public/omm-x.html": "function f(){ debugger; return 1 }"}
        issues = g.check_debug(files, lambda t: True)
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].line, 1)

    def test_word_in_a_string_outside_public_is_ignored(self):
        files = {"tests/example.py": "pattern = r'\\bdebugger\\b'"}
        self.assertEqual(g.check_debug(files, lambda t: True), [])


class IntegrationTests(unittest.TestCase):
    def test_real_tree_passes_every_check(self):
        issues = g.run(g.CHECKS)
        self.assertEqual(issues, [], "统一守卫在真实代码树上不应报异常: %r" % issues)

    def test_real_exists_handles_both_bases(self):
        self.assertTrue(g.real_exists("icon.ico"))
        self.assertTrue(g.real_exists("src/main.js"))
        self.assertFalse(g.real_exists("definitely/missing.file"))

    def test_report_lists_grouped_issues(self):
        issues = [
            g.Issue("LINK", "public/omm-x.html", 3, "断链"),
            g.Issue("BRIDGE", "public/omm-y.html", 0, "缺桥接"),
        ]
        out = io.StringIO()
        with redirect_stdout(out):
            g.report(issues)
        text = out.getvalue()
        self.assertIn("[LINK]", text)
        self.assertIn("[BRIDGE]", text)
        self.assertIn("public/omm-x.html:3", text)

    def test_cli_list_and_unknown_only_code(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(g.main(["--list"]), 0)
        self.assertIn("QUOTE", out.getvalue())
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(g.main(["--only", "NOPE"]), 2)
        self.assertIn("NOPE", err.getvalue())

    def test_check_quotes_is_clean_on_current_tree(self):
        self.assertEqual(g.check_quotes({}, lambda t: True), [])


if __name__ == "__main__":
    unittest.main()
