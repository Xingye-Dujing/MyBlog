"""Unit tests for the unified OMM-ZEN product guard.

All tests are synthetic: no production file is modified and no real network or
build step is involved.  The guard is fed a small in-memory file map plus a
stub ``exists`` predicate so each check can be verified in isolation.
"""
import io
import json
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest import mock

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


class SpecSyncCheckTests(unittest.TestCase):
    def _files(self):
        files = g.snapshot()
        for path in (g.PUB / "json-specs").glob("*.md"):
            mirror = g.SPEC_MIRROR_DIR + "/" + g._mirror_name(path.name)
            disk = g.ROOT / mirror
            if disk.exists():
                files[mirror] = disk.read_text(encoding="utf-8")
        return files

    def test_real_knowledge_copies_match_every_spec(self):
        self.assertEqual(g.check_spec_sync(g.snapshot(), lambda t: True), [])

    def test_drifted_copy_is_reported(self):
        files = self._files()
        mirror = g.SPEC_MIRROR_DIR + "/zencard.md"
        files[mirror] = files[mirror].replace("zen-card", "zen-card-OLD")
        issues = g.check_spec_sync(files, lambda t: True)
        self.assertEqual(len(issues), 1)
        self.assertIn("zencard.md", issues[0].message)

    def test_missing_copy_is_reported(self):
        files = self._files()
        files[g.SPEC_MIRROR_DIR + "/zenpack.md"] = None
        issues = g.check_spec_sync(files, lambda t: True)
        self.assertTrue(any("zenpack.md" in i.message for i in issues))

    def test_readme_alias_is_used(self):
        self.assertEqual(g._mirror_name("README.md"), "json-specs-README.md")
        self.assertEqual(g._mirror_name("zencard.md"), "zencard.md")


class FormatCheckTests(unittest.TestCase):
    def _files(self):
        files = {"public/json-specs/README.md": "总表 " + " ".join(
            "[%s](%s)" % (doc, doc) for doc, _, _ in g.FORMAT_CONTRACTS)}
        for doc, sources, tokens in g.FORMAT_CONTRACTS:
            text = " ".join(tokens)
            files["public/json-specs/" + doc] = text
            for source in sources:
                files[source] = text
        return files

    def test_real_formats_are_consistent(self):
        self.assertEqual(g.check_format(g.snapshot(), lambda t: True), [])

    def test_source_drift_is_reported(self):
        files = self._files()
        files["public/zen-card.js"] = "zen-card zen-card-pack"
        issues = g.check_format(files, lambda t: True)
        self.assertEqual(len(issues), 1)
        self.assertIn("产品源码缺少格式标识: cards", issues[0].message)

    def test_spec_drift_is_reported(self):
        files = self._files()
        files["public/json-specs/zenpack.md"] = "zen-backup"
        issues = g.check_format(files, lambda t: True)
        self.assertTrue(any("规范缺少格式标识: products" in i.message for i in issues))

    def test_unregistered_contract_is_reported(self):
        files = self._files()
        files["public/json-specs/README.md"] = "空"
        issues = g.check_format(files, lambda t: True)
        self.assertEqual(len(issues), len(g.FORMAT_CONTRACTS))


class RuntimeCheckTests(unittest.TestCase):
    def _files(self):
        return {
            "public/desktop/plugin_manager.py": 'RUNTIMES = ("static", "mdforge", "latex", "ai")',
        }

    def test_real_tree_keeps_ai_runtime_exclusive(self):
        self.assertEqual(g.check_runtime(g.snapshot(), lambda t: True), [])

    def test_other_product_cannot_declare_ai_runtime(self):
        plugins = [
            {"id": "ai", "runtime": "ai", "entry": "omm-ai.html"},
            {"id": "writer", "runtime": "static", "entry": "omm-writer.html"},
        ]
        with mock.patch.object(g.product_registry, "BUILTIN_PLUGINS", plugins):
            issues = g.check_runtime(self._files(), lambda t: True)
        self.assertEqual(issues, [])

        plugins[1]["runtime"] = "ai"
        with mock.patch.object(g.product_registry, "BUILTIN_PLUGINS", plugins):
            issues = g.check_runtime(self._files(), lambda t: True)
        self.assertTrue(any("writer" in i.message for i in issues))

    def test_third_party_plugin_json_cannot_opt_in(self):
        files = self._files()
        files["public/plugins/evil/plugin.json"] = '{"id":"evil","runtime":"ai"}'
        files["public/build/stage/evil/plugin.json"] = '{"id":"evil","runtime":"ai"}'
        issues = g.check_runtime(files, lambda t: True)
        messages = [i.message for i in issues]
        self.assertTrue(any("第三方插件" in m for m in messages))
        self.assertEqual(sum("第三方插件" in m for m in messages), 1)  # build copies ignored

    def test_missing_ai_runtime_and_missing_registry_are_reported(self):
        plugins = [{"id": "writer", "runtime": "static", "entry": "omm-writer.html"}]
        with mock.patch.object(g.product_registry, "BUILTIN_PLUGINS", plugins):
            issues = g.check_runtime(self._files(), lambda t: True)
        self.assertTrue(any("未声明 ai 运行时" in i.message for i in issues))

        issues = g.check_runtime({}, lambda t: True)
        self.assertTrue(any("运行时注册表缺少 ai" in i.message for i in issues))


class VersionCheckTests(unittest.TestCase):
    def _files(self):
        version = str(g.VERSION)
        catalog = {
            "version": version, "tag": "v" + version,
            "base_url": "https://example.com/v" + version,
            "gitee_url": "https://example.com/v" + version,
            "plugins": [{"id": "writer", "version": version, "sha256": "abc"}],
        }
        item = next(x for x in g.product_registry.BUILTIN_PLUGINS if x["id"] == "writer")
        rel = "public/" + item["entry"]
        files = {g.CATALOG: json.dumps(catalog), rel: "原始内容"}
        for module in g.SHARED_MODULES:
            files[module] = "共享模块内容"
        baseline = {
            "schema": 1, "suiteVersion": version,
            "products": {"writer": {
                "version": version,
                "fingerprint": g._fingerprint(rel, files),
                "sha256": "abc",
            }},
            "shared": {"fingerprint": g._shared_fingerprint(files)},
        }
        files[g.BASELINE] = json.dumps(baseline)
        self.entry = rel
        return files

    def _messages(self, files):
        return [i.message for i in g.check_version(files, lambda t: True)]

    def test_real_tree_passes_with_recorded_baseline(self):
        self.assertEqual(g.check_version(g.snapshot(), lambda t: True), [])

    def test_missing_baseline_is_reported(self):
        files = self._files()
        files.pop(g.BASELINE)
        self.assertTrue(any("缺少版本基线" in m for m in self._messages(files)))

    def test_suite_version_drift_is_reported(self):
        files = self._files()
        catalog = json.loads(files[g.CATALOG])
        catalog["tag"] = "v0.0.1"
        files[g.CATALOG] = json.dumps(catalog)
        self.assertTrue(any("tag 与套件版本不一致" in m for m in self._messages(files)))

    def test_product_version_drift_is_reported_only_for_same_product(self):
        files = self._files()
        catalog = json.loads(files[g.CATALOG])
        catalog["plugins"][0]["version"] = "0.0.1"
        files[g.CATALOG] = json.dumps(catalog)
        messages = self._messages(files)
        self.assertTrue(any("产品 writer 版本不一致" in m for m in messages))
        self.assertFalse(any("跨产品" in m for m in messages))

    def test_content_change_without_bump_suggests_patch(self):
        files = self._files()
        files[self.entry] = "内容已修改"
        messages = self._messages(files)
        self.assertTrue(any("内容已变更但版本未升" in m for m in messages))
        self.assertTrue(any("建议升至" in m for m in messages))

    def test_shared_module_change_suggests_suite_bump(self):
        files = self._files()
        files["public/zen-card.js"] = "共享模块已修改"
        self.assertTrue(any("共享模块已变更但套件版本未升" in m for m in self._messages(files)))

    def test_downgrade_and_republished_checksum_are_reported(self):
        files = self._files()
        baseline = json.loads(files[g.BASELINE])
        baseline["suiteVersion"] = "9.9.9"
        files[g.BASELINE] = json.dumps(baseline)
        self.assertTrue(any("套件版本降级" in m for m in self._messages(files)))

        files = self._files()
        catalog = json.loads(files[g.CATALOG])
        catalog["plugins"][0]["sha256"] = "changed"
        files[g.CATALOG] = json.dumps(catalog)
        self.assertTrue(any("校验和发生变化" in m for m in self._messages(files)))

    def test_empty_bump_is_reported(self):
        files = self._files()
        baseline = json.loads(files[g.BASELINE])
        baseline["products"]["writer"]["version"] = "0.0.1"
        files[g.BASELINE] = json.dumps(baseline)
        self.assertTrue(any("空 bump" in m for m in self._messages(files)))

    def test_suggested_bump_increments_patch(self):
        self.assertEqual(g._suggested_bump("1.0.17"), "1.0.18")
        self.assertEqual(g._suggested_bump("v2.3"), "2.3.1")
        self.assertEqual(g._suggested_bump("bad"), "0.0.1")


class ResourceCheckTests(unittest.TestCase):
    def test_missing_static_asset_is_reported(self):
        files = {"public/page.html": '<link href="missing.css"><script src="ok.js"></script>'}
        issues = g.check_resources(files, lambda t: t == "ok.js")
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].code, "RESOURCE")
        self.assertIn("missing.css", issues[0].message)

    def test_css_url_is_checked_but_js_expressions_are_ignored(self):
        files = {"public/a.css": 'body{background:url("/img/nope.png")}'}
        issues = g.check_resources(files, lambda t: False)
        self.assertEqual(len(issues), 1)
        js = {"public/a.js": "a.href = url\nimg.src = blob"}
        self.assertEqual(g.check_resources(js, lambda t: False), [])

    def test_product_pages_are_covered_by_link_check_instead(self):
        files = {"public/omm-x.html": '<link href="missing.css">'}
        self.assertEqual(g.check_resources(files, lambda t: False), [])


class XssCheckTests(unittest.TestCase):
    def test_unescaped_dynamic_value_is_reported(self):
        files = {"public/omm-x.html": "box.innerHTML = '<b>' + input.value + '</b>'"}
        issues = g.check_xss(files, lambda t: True)
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].code, "XSS")

    def test_escaped_and_static_values_are_ignored(self):
        files = {
            "public/omm-x.html": "\n".join([
                "box.innerHTML = '<b>' + esc(input.value) + '</b>'",
                "box.innerHTML = '<b>' + ZenCard.KINDS.join('') + '</b>'",
                "box.innerHTML = '<b>static</b>'",
            ])
        }
        self.assertEqual(g.check_xss(files, lambda t: True), [])


class A11yCheckTests(unittest.TestCase):
    def test_missing_alt_and_name_are_reported(self):
        files = {"public/omm-x.html": '<img src="a.png"><button></button>'}
        issues = g.check_a11y(files, lambda t: True)
        self.assertEqual(len(issues), 2)
        self.assertTrue(all(i.code == "A11Y" for i in issues))

    def test_labelled_controls_and_placeholders_are_ignored(self):
        files = {"public/omm-x.html": "\n".join([
            '<img src="a.png" alt="">',
            '<img>',
            '<button aria-label="确定"></button>',
            '<button data-i18n="ok"></button>',
            '<button data-color="#fff"></button>',
            '<a href="/" title="home"></a>',
        ])}
        self.assertEqual(g.check_a11y(files, lambda t: True), [])


class RegistryCheckTests(unittest.TestCase):
    def setUp(self):
        # Synthetic file maps are not in git; disable the tracked-path filter.
        self._orig = g._tracked_paths
        g._tracked_paths = lambda: None

    def tearDown(self):
        g._tracked_paths = self._orig

    def test_real_registry_is_consistent(self):
        issues = g.check_registry(g.snapshot(), lambda t: True)
        self.assertEqual(issues, [], "真实注册表不应报异常: %r" % issues)

    def test_unregistered_product_page_is_reported(self):
        files = {"public/omm-ghost.html": ""}
        issues = g.check_registry(files, lambda t: True)
        self.assertTrue(any("未在任何注册表登记" in i.message for i in issues))

    def test_catalog_rejects_unknown_product_and_drifted_fields(self):
        catalog = {"plugins": [
            {"id": "ghost", "name": "幽灵"},
            {"id": "writer", "name": "漂移名称", "description": "x",
             "glyph": "x", "order": 999},
        ]}
        files = {g.CATALOG: json.dumps(catalog, ensure_ascii=False)}
        issues = g.check_registry(files, lambda t: True)
        messages = [i.message for i in issues]
        self.assertTrue(any("未知产品: ghost" in m for m in messages))
        self.assertTrue(any("writer 的 name" in m for m in messages))

    def test_launcher_must_be_derived_from_registry(self):
        hardcoded = 'APPS = {\n    "annotate": ("omm-annotate.html", 8311, None),\n}\n'
        issues = g.check_registry({g.LAUNCHER: hardcoded}, lambda t: True)
        messages = [i.message for i in issues]
        self.assertTrue(any("未从 product_registry 派生" in m for m in messages))
        self.assertTrue(any("硬编码的 APPS" in m for m in messages))

    def test_derived_launcher_is_clean(self):
        derived = "from product_registry import apps, window_titles\nAPPS = apps()\n"
        issues = g.check_registry({g.LAUNCHER: derived}, lambda t: True)
        self.assertEqual([i for i in issues if i.path == g.LAUNCHER], [])


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
