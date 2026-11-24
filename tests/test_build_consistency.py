"""离线打包与发布默认值一致性回归测试。

    python -m unittest discover -s tests -p 'test_build_consistency.py' -v
"""
from __future__ import annotations

import posixpath
import re
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "public" / "desktop"
for path in (str(DESKTOP), str(ROOT / "public")):
    if path not in sys.path:
        sys.path.insert(0, path)

import offline  # noqa: E402
from plugin_specs import BUILTIN_PLUGINS, VERSION  # noqa: E402


class _PageAssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.refs: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        name = tag.lower()
        if name not in ("link", "script"):
            return
        attr = "href" if name == "link" else "src"
        value = dict(attrs).get(attr)
        if value is not None:
            self.refs.append((name, value))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)


_IMPORT_URL_RE = re.compile(r"@import\s+url\(\s*['\"]?([^'\")\s]+)['\"]?\s*\)", re.I)
_IMPORT_STRING_RE = re.compile(r"@import\s+['\"]([^'\"]+)['\"]", re.I)
_CSS_URL_RE = re.compile(r"url\(\s*(?:\"([^\"]*)\"|'([^']*)'|([^)]*?))\s*\)", re.I)


def _local_reference(ref: str) -> str | None:
    ref = ref.strip()
    if not ref or ref.startswith("#"):
        return None
    parsed = urlsplit(ref)
    if parsed.scheme or parsed.netloc:
        return None
    path = unquote(parsed.path).replace("\\", "/")
    return path or None


def _resolve_reference(base: str, ref: str) -> str | None:
    if ref.startswith("/"):
        relative = posixpath.normpath(ref.lstrip("/"))
    else:
        relative = posixpath.normpath(posixpath.join(posixpath.dirname(base), ref))
    if relative in ("", "."):
        return ""
    if relative == ".." or relative.startswith("../"):
        return None
    return relative


def _staged_asset_problems(dest: Path, page_name: str) -> list[str]:
    problems: list[str] = []
    seen_css: set[str] = set()

    def resolve(base: str, ref: str) -> tuple[str | None, Path | None]:
        relative = _resolve_reference(base, ref)
        if not relative:
            return "", None
        if relative is None:
            return None, None
        return relative, dest.joinpath(*relative.split("/"))

    def check_css(css_name: str, css_path: Path) -> None:
        if css_name in seen_css:
            return
        seen_css.add(css_name)
        text = css_path.read_text(encoding="utf-8", errors="replace")
        refs = set(_IMPORT_URL_RE.findall(text)) | set(_IMPORT_STRING_RE.findall(text))
        for match in _CSS_URL_RE.findall(text):
            refs.add(next(value for value in match if value != "").strip())
        for ref in sorted(refs):
            local = _local_reference(ref)
            if local is None:
                continue
            relative, target = resolve(css_name, local)
            if target is None:
                problems.append(f"{css_name}: CSS reference escapes staged root: {ref}")
            elif not target.is_file():
                problems.append(f"{css_name}: missing CSS asset {ref} -> {relative}")
            elif target.suffix.lower() == ".css":
                check_css(relative, target)

    page_path = dest.joinpath(*page_name.split("/"))
    parser = _PageAssetParser()
    parser.feed(page_path.read_text(encoding="utf-8", errors="replace"))
    for tag, ref in parser.refs:
        local = _local_reference(ref)
        if local is None:
            continue
        relative, target = resolve(page_name, local)
        if target is None:
            problems.append(f"{page_name}: {tag} reference escapes staged root: {ref}")
        elif not target.is_file():
            problems.append(f"{page_name}: missing {tag} asset {ref} -> {relative}")
        elif target.suffix.lower() == ".css":
            check_css(relative, target)
    return problems


class StagedAssetsTests(unittest.TestCase):
    def assert_complete(self, dest: Path, pages: list[str | tuple[str, Path]]) -> None:
        problems: list[str] = []
        for page in pages:
            if isinstance(page, tuple):
                page_name, asset_root = page
            else:
                page_name, asset_root = page, dest
            problems.extend(_staged_asset_problems(asset_root, page_name))
        self.assertEqual(problems, [], "staged pages reference missing local assets")

    def test_copy_zen_styles_includes_css_entry(self):
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder)
            (dest / "zen" / "products").mkdir(parents=True)
            (dest / "zen" / "products" / "lambda.css").write_text("stale", encoding="utf-8")
            offline.copy_zen_styles(dest, "table")
            self.assertTrue((dest / "zen" / "zen.css").is_file())
            self.assertTrue((dest / "zen" / "foundation" / "tokens.css").is_file())
            self.assertTrue((dest / "zen" / "products" / "table.css").is_file())
            self.assertFalse((dest / "zen" / "products" / "lambda.css").exists())

    def test_asset_checker_follows_css_imports_fonts_and_nested_scripts(self):
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder)
            (dest / "styles" / "nested").mkdir(parents=True)
            (dest / "scripts" / "nested").mkdir(parents=True)
            (dest / "fonts").mkdir()
            (dest / "page.html").write_text(
                '<link rel="stylesheet" href="/styles/main.css?v=1#shell">'
                '<script src="scripts/nested/app.js"></script>'
                '<script src="https://example.test/remote.js"></script>',
                encoding="utf-8",
            )
            (dest / "styles" / "main.css").write_text(
                '@import "nested/theme.css";\n'
                'body{background:url("/fonts/local.woff2?v=2")}'
                'mask:url("data:image/svg+xml;utf8,<svg></svg>")',
                encoding="utf-8",
            )
            (dest / "styles" / "nested" / "theme.css").write_text("body{color:black}", encoding="utf-8")
            (dest / "scripts" / "nested" / "app.js").write_text("", encoding="utf-8")
            (dest / "fonts" / "local.woff2").write_bytes(b"font")
            self.assertEqual(_staged_asset_problems(dest, "page.html"), [])
            (dest / "fonts" / "local.woff2").unlink()
            self.assertTrue(any("local.woff2" in problem for problem in _staged_asset_problems(dest, "page.html")))

    def test_every_plugin_page_reference_is_staged(self):
        for item in BUILTIN_PLUGINS:
            with self.subTest(plugin=item["id"]), tempfile.TemporaryDirectory() as folder:
                dest = offline.stage_plugin(item["id"], Path(folder))
                self.assert_complete(dest, [item["entry"]])

    def test_hub_and_bundled_plugin_pages_reference_complete_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            dest = offline.stage_hub(Path(folder))
            pages = ["omm-hub.html"] + [
                (item["entry"], dest / "plugins" / item["id"]) for item in BUILTIN_PLUGINS
            ]
            self.assert_complete(dest, pages)

    def test_framework_and_installer_pages_reference_complete_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            framework = offline.stage_framework(Path(folder) / "framework")
            self.assert_complete(framework, ["omm-hub.html"])
        with tempfile.TemporaryDirectory() as folder:
            installer = offline.stage_installer(Path(folder))
            self.assert_complete(installer, ["installer.html"])
            self.assertTrue((installer / "zen" / "components" / "select.js").is_file())


class ReleaseDefaultTests(unittest.TestCase):
    def test_release_defaults_track_suite_version(self):
        expected = "v" + VERSION
        scripts = [
            DESKTOP / "release" / name for name in (
                "create_gitee_release.ps1", "delete_gitee_assets.ps1",
                "publish_pointer.ps1", "upload_gitee_assets.ps1",
            )
        ]
        scripts.append(DESKTOP / "release" / "verify_release.py")
        for script in scripts:
            text = script.read_text(encoding="utf-8-sig")
            tags = re.findall(r"v(\d+(?:\.\d+){2})", text)
            self.assertTrue(tags, "%s has no default tag" % script.name)
            self.assertEqual(tags[0], VERSION.lstrip("v"), "%s default tag drifted" % script.name)
        workflow = (ROOT / ".github" / "workflows" / "macos-build.yml").read_text(encoding="utf-8")
        self.assertIn(expected, workflow)


if __name__ == "__main__":
    unittest.main()
