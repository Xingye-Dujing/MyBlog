"""OMM-ZEN unified product guard.

Runs a set of independent, deterministic checks over the suite's own source
files (never third-party bundles).  Each check reports ``Issue`` records; the
only auto-fixable one is the quote check, which delegates to ``no_jp_quotes``.

Checks
------
QUOTE  forbidden Japanese / Traditional corner-bracket quotes (auto-fixable)
LINK   local href/src and Markdown links that point to a missing file
IMPORT relative ES-module import specifiers that do not resolve
BRIDGE canonical consumer products must load ``lib/zen-link.js`` as a module
SPEC   every JSON spec document is indexed from ``json-specs/README.md``
SPEC_SYNC the AI workspace's mirrored knowledge docs stay byte-identical to
       ``public/json-specs`` — otherwise the assistant teaches stale formats
FORMAT every JSON spec's format tokens also appear in the product source that
       implements it — the spec and the code cannot silently drift apart
DEBUG  no ``debugger`` statement may ship in a product page or module
RESOURCE every static CSS url() and non-product-page asset reference resolves
XSS    no unescaped dynamic value is concatenated into innerHTML
A11Y   images have alt and clickable controls have an accessible name
REGISTRY product ids / entry pages / release catalog stay in sync with the
       single source of truth (``plugin_specs.BUILTIN_PLUGINS``)
RUNTIME only the official ``ai`` product may declare the local-code-execution
       runtime; third-party plugin.json files can never opt into it
PRIVACY Planner's editor-only hidden items must never enter any data snapshot
        that the AI workspace or ZenReview can read
GEN_FORMATS format-registry.json is the single source of truth: generated
        Python constants and AI skeletons must match it byte-for-byte, every
        bound validator / source / golden fixture must exist
VERSION layered version model: suite version strict across release surfaces,
       product versions compared only within the same product, and content
       fingerprints flag changes that forgot to bump a version

Usage
-----
    python tests/product_guard.py             # fix quotes, then run all checks
    python tests/product_guard.py --check     # read-only, exit 1 on any issue
    python tests/product_guard.py --only LINK,IMPORT
    python tests/product_guard.py --list
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import no_jp_quotes

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public"
DESKTOP = PUB / "desktop"

# The registry truth lives under desktop/.  Loading the derived module here
# lets the guard validate the exact same view the launcher uses, instead of
# re-parsing plugin_specs with a second, subtly different implementation.
sys.path.insert(0, str(DESKTOP))
import product_registry  # noqa: E402
from plugin_specs import DESKTOP_EXE_NAMES, VERSION, version_key  # noqa: E402

BASELINE = "tests/version_baseline.json"
CATALOG = "public/dist/catalog.json"
SPEC_MIRROR_DIR = "public/agent_workspace/omm_knowledge"
SPEC_MIRROR_ALIAS = {"README.md": "json-specs-README.md"}
LAUNCHER = "public/desktop/omm_launcher.py"

# (spec doc, implementing sources, tokens required in BOTH doc and sources)
# Tokens are the top-level hard requirements from json-specs/README.md.
# Products that import no JSON (latex / redact / message) have no contract.
FORMAT_CONTRACTS = [
    ("zencard.md", ["public/lib/zen-card.js"], ["zen-card", "zen-card-pack", "cards"]),
    ("zenpack.md", ["public/lib/zen-backup.js", "public/lib/zen-pack.js"], ["zen-backup", "products"]),
    ("writer.md", ["public/omm-writer.html"], ["zenwriter-canvas", "nodes", "connections"]),
    ("annotate.md", ["public/omm-annotate.html"], ["codes"]),
    ("corpus.md", ["public/omm-corpus.html"], ["entries", "categories"]),
    ("data.md", ["public/omm-data.html"], ["rows", "tables"]),
    ("english.md", ["public/omm-english.html"], ["books", "prog"]),
    ("planner.md", ["public/omm-planner.html"], ["planners", "version"]),
    ("visualization.md", ["public/omm-visualization.html"],
     ["zenviz-right-properties", "version"]),
    ("table.md", ["public/lib/zen-table.js"], ["omm-table-workflow", "nodes", "connections"]),
    ("video.md", ["public/lib/zen-video.js", "public/server/video-serve.py"],
     ["omm-video-workflow", "nodes", "connections"]),
]

# Cross-product infrastructure: changing any of these affects every consumer,
# so it is tied to the SUITE version rather than to individual products.
SHARED_MODULES = [
    "public/lib/zen-card.js", "public/lib/zen-link.js", "public/zen/canvas/layout.js",
    "public/lib/zen-chart.js", "public/lib/zen-flow.js", "public/lib/zen-srs.js",
    "public/lib/zen-backup.js", "public/lib/zen-pack.js", "public/lib/zen-review.js",
    "public/lib/data-viz.js", "public/lib/search-library.js", "public/viz-bridge.js",
    "public/omm-embed.js", "public/omm-share.js", "public/omm-desktop.js",
    "public/lib/zen-crypto.js", "public/lib/omm-bridge.js", "public/lib/zen-job.js",
    "public/lib/zen-cloud.js", "public/lib/zen-html.js", "public/lib/zen-csv.js",
    "public/zen/components/layer.js", "public/zen/components/toast.js",
    "public/zen/components/dialog.js", "public/zen/components/select.js",
    "public/zen/components/menu.js", "public/zen/components/popover.js",
    "public/zen/components/context-menu.js", "public/zen/components/shortcuts.js",
    "public/zen/components/tabs.js", "public/zen/components/tooltip.js",
    "public/zen/components/picker.js", "public/zen/components/index.js", "public/zen/components/components.css",
    "public/zen/components/archive.css",
    "public/zen/components/switch.js",
    "public/zen/canvas/engine.js", "public/zen/canvas/canvas.css",
    "public/zen/zen.css",
    "public/zen/foundation/tokens.css", "public/zen/foundation/base.css",
    "public/zen/foundation/primitives.css", "public/zen/foundation/util.js",
    "public/zen/features/grid.css", "public/zen/features/doc.css",
    "public/zen/features/learning.css", "public/zen/features/cloud.css",
    "public/zen/features/tool.css", "public/zen/features/launcher.css",
]

# Products that act as *consumers* of the universal card bridge.  The hub and
# the five ecosystem products are intentionally excluded: they produce/manage
# cards themselves instead of mounting the floating "card" button.
BRIDGE_PRODUCTS = {
    "annotate", "corpus", "data", "english", "latex", "mdforge",
    "message", "planner", "redact", "search", "visualization", "writer",
}

# A URL matching this is never a local-file reference.
EXTERNAL = re.compile(r"^(?:[a-z][a-z0-9+.-]*:|//|#)", re.I)
# JS template / replacement placeholders are not real paths.
PLACEHOLDER = re.compile(r"[\$\{\}<>]")
# Build-time variables such as %BASE_URL% are not paths either; note this does
# not match ordinary percent-encoding like %20.
BUILD_VAR = re.compile(r"%[A-Za-z_][A-Za-z0-9_]*%")
HTML_ATTR = re.compile(r"(?:href|src)\s*=\s*[\"']([^\"']+)[\"']", re.I)
MD_LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
JS_IMPORT = re.compile(r"""(?:from|import)\s+["'](\.[^"']+)["']""")
SCRIPT_TAG = re.compile(r"<script\b[^>]*>", re.I)
DEBUGGER = re.compile(r"\bdebugger\b")
CSS_URL = re.compile(r"url\(\s*[\"']?([^\)\"']+)[\"']?\s*\)", re.I)
# Only real static assets are checked: names like ``blob``, ``url`` or
# ``image.url`` are JavaScript expressions, not paths.
STATIC_ASSET = re.compile(
    r"\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|json|html?)(?:[?#]|$)",
    re.I)
# Only untrusted-looking data concatenated into innerHTML is flagged.  Static
# markup, trusted enums and explicit escaping are all intentional patterns in
# this codebase and must not produce noise.
XSS_ASSIGN = re.compile(r"(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\s*(?:=|\()?", re.I)
XSS_ESCAPERS = (
    "esc(", "escapeHtml(", "kgEscape(", "escape(", "sanitize(",
    "DOMPurify", "textContent", "JSON.stringify", "encodeURIComponent",
    "markSpanHTML",
)
XSS_UNTRUSTED = re.compile(
    r"\.value\b|location\.|decodeURIComponent|params\.|searchParams|"
    r"\bquery\b|\binput\b|\.dataset\b|\bpayload\b|\braw\b", re.I)
XSS_SAFE = re.compile(r"ZenCard\.(KINDS|SOURCES)|APP_LIST|\bICO\(|\bt\(", re.I)
A11Y_IMG = re.compile(r"<img\b([^>]*)>", re.I)
A11Y_CLICK = {
    "button": re.compile(r"<button\b([^>]*)>(.*?)</button>", re.I | re.S),
    "a": re.compile(r"<a\b([^>]*)>(.*?)</a>", re.I | re.S),
}
A11Y_NAMED = re.compile(
    r"aria-label\s*=|aria-labelledby\s*=|\btitle\s*=|data-i18n\s*=|aria-hidden\s*=", re.I)


@dataclass(frozen=True)
class Issue:
    code: str
    path: str
    line: int
    message: str

    def render(self) -> str:
        where = self.path if not self.line else "%s:%d" % (self.path, self.line)
        return "  %-58s %s" % (where, self.message)


@dataclass(frozen=True)
class Check:
    code: str
    title: str
    fixable: bool
    fn: Callable[[dict[str, str], Callable[[str], bool]], list[Issue]]


# --------------------------------------------------------------------------- #
# Path helpers
# --------------------------------------------------------------------------- #
def _public_rel(rel: str) -> str:
    """Strip the leading ``public/`` so paths are relative to the web root."""
    return rel[len("public/"):] if rel.startswith("public/") else rel


def _owner_dir(rel: str) -> str:
    """Directory of a workspace-relative file, relative to the web root."""
    s = _public_rel(rel)
    return s.rsplit("/", 1)[0] if "/" in s else ""


def _normalize(parts: list[str]) -> str:
    out: list[str] = []
    for seg in parts:
        if seg in ("", "."):
            continue
        if seg == "..":
            if out:
                out.pop()
            continue
        out.append(seg)
    return "/".join(out)


def local_target(owner: str, url: str) -> str | None:
    """Resolve a URL to a web-root-relative path, or None if not a local file.

    ``exists`` semantics: leading ``/`` is rooted at ``public/``; a bare path
    is relative to the owner's directory.  Query strings and fragments are
    dropped, percent-encoding decoded.
    """
    u = url.strip()
    if not u or EXTERNAL.match(u) or PLACEHOLDER.search(u) or BUILD_VAR.search(u):
        return None
    raw = urllib.parse.unquote(u.split("?")[0].split("#")[0]).strip()
    if not raw or PLACEHOLDER.search(raw):
        return None
    if raw.startswith("/"):
        return _normalize(raw.split("/"))
    return _normalize([*_owner_dir(owner).split("/"), *raw.split("/")])


def _lines(text: str) -> list[tuple[int, str]]:
    return list(enumerate(text.splitlines(), 1))


# --------------------------------------------------------------------------- #
# Checks.  Each takes (files, exists) so it is trivially unit-testable with a
# synthetic file map and a stub existence predicate.
# --------------------------------------------------------------------------- #
def check_quotes(files, exists) -> list[Issue]:
    issues = []
    for rel, n in sorted(no_jp_quotes.scan().items()):
        issues.append(Issue("QUOTE", rel, 0, "发现 %d 处禁用角引号，运行 no_jp_quotes.py 修正" % n))
    return issues


def _in_link_scope(rel: str) -> bool:
    """Only product pages and JSON-spec documents are covered by LINK."""
    return (
        rel.startswith("public/omm-") and rel.lower().endswith(".html")
    ) or (
        rel.startswith("public/json-specs/") and rel.lower().endswith(".md")
    )


def check_links(files, exists) -> list[Issue]:
    issues = []
    for rel, text in files.items():
        if not _in_link_scope(rel):
            continue
        is_md = rel.lower().endswith(".md")
        seen: set[str] = set()
        for lineno, line in _lines(text):
            urls = [m.group(1) for m in HTML_ATTR.finditer(line)]
            if is_md:
                # Only treat Markdown links that look like a file path; prose
                # examples such as [文字](链接) are not real references.
                urls += [m.group(1) for m in MD_LINK.finditer(line)
                         if "." in m.group(1) or "/" in m.group(1)]
            for url in urls:
                target = local_target(rel, url)
                if target is None or target in seen:
                    continue
                seen.add(target)
                if not exists(target):
                    issues.append(Issue("LINK", rel, lineno, "本地链接指向不存在的目标: %s" % url))
    return issues


def check_imports(files, exists) -> list[Issue]:
    issues = []
    for rel, text in files.items():
        if not rel.startswith("public/") or not rel.lower().endswith(".js"):
            continue
        if "/vendor/" in "/" + rel:
            continue
        base = _owner_dir(rel)
        for lineno, line in _lines(text):
            for spec in JS_IMPORT.findall(line):
                target = _normalize([base, *spec.split("/")])
                if not exists(target):
                    issues.append(Issue("IMPORT", rel, lineno, "ES 模块导入无法解析: %s" % spec))
    return issues


def check_bridge(files, exists) -> list[Issue]:
    issues = []
    for name in sorted(BRIDGE_PRODUCTS):
        rel = "public/omm-%s.html" % name
        text = files.get(rel)
        if text is None:
            issues.append(Issue("BRIDGE", rel, 0, "消费型产品文件缺失"))
            continue
        ok = False
        for tag in SCRIPT_TAG.findall(text):
            if "lib/zen-link.js" in tag and re.search(r"""type=["']module["']""", tag):
                ok = True
                break
        if not ok:
            issues.append(Issue("BRIDGE", rel, 0,
                                "缺少 <script type=\"module\" src=\"lib/zen-link.js\"> 桥接"))
    return issues


def check_specs(files, exists) -> list[Issue]:
    prefix = "public/json-specs/"
    readme = files.get(prefix + "README.md")
    if readme is None:
        return [Issue("SPEC", prefix + "README.md", 0, "规范索引文件缺失")]
    indexed = set()
    for m in MD_LINK.finditer(readme):
        target = local_target(prefix + "README.md", m.group(1))
        if target and target.endswith(".md"):
            indexed.add(target.split("/")[-1])
    issues = []
    for rel in files:
        if not rel.startswith(prefix) or not rel.endswith(".md"):
            continue
        name = rel[len(prefix):]
        if name in ("README.md", "prompts.md"):
            continue
        if name not in indexed:
            issues.append(Issue("SPEC", rel, 0, "规范文档未被 README 索引"))
    for name in sorted(indexed):
        if prefix + name not in files:
            issues.append(Issue("SPEC", prefix + "README.md", 0,
                                "索引指向不存在的规范: %s" % name))
    return issues


def check_debug(files, exists) -> list[Issue]:
    issues = []
    for rel, text in files.items():
        if not (rel.lower().endswith(".html") or rel.lower().endswith(".js")):
            continue
        if not rel.startswith("public/") or "/vendor/" in "/" + rel:
            continue
        for lineno, line in _lines(text):
            if DEBUGGER.search(line):
                issues.append(Issue("DEBUG", rel, lineno, "存在 debugger 调试语句"))
    return issues


def check_format(files, exists) -> list[Issue]:
    """Keep each JSON spec's declared format in sync with its implementation."""
    issues = []
    prefix = "public/json-specs/"
    readme = files.get(prefix + "README.md", "")
    for doc, sources, tokens in FORMAT_CONTRACTS:
        rel_doc = prefix + doc
        doc_text = files.get(rel_doc)
        if doc_text is None:
            issues.append(Issue("FORMAT", rel_doc, 0, "格式规范文档缺失"))
            continue
        if "](" + doc + ")" not in readme:
            issues.append(Issue("FORMAT", prefix + "README.md", 0,
                                "格式契约未登记总表: %s" % doc))
        parts = []
        for source in sources:
            text = files.get(source)
            if text is None:
                disk = ROOT / source
                text = disk.read_text(encoding="utf-8") if disk.exists() else None
            if text is None:
                issues.append(Issue("FORMAT", source, 0, "格式对应的产品源码缺失"))
            else:
                parts.append(text)
        source_text = "\n".join(parts)
        for token in tokens:
            if token not in doc_text:
                issues.append(Issue("FORMAT", rel_doc, 0, "规范缺少格式标识: %s" % token))
            if token not in source_text:
                issues.append(Issue("FORMAT", sources[0], 0,
                                    "产品源码缺少格式标识: %s" % token))
    return issues


def _mirror_name(name: str) -> str:
    return SPEC_MIRROR_ALIAS.get(name, name)


def check_spec_sync(files, exists) -> list[Issue]:
    """Keep the AI workspace's copied specs byte-identical to the real source.

    ``agent_workspace/omm_knowledge`` is a mirror of ``public/json-specs`` used
    by the assistant's retrieval tools. It is deliberately a copy (the framework
    ships its own data directory), so without this check a spec edit would leave
    the assistant teaching an obsolete format with no failing test.
    """
    issues = []
    for path in sorted((PUB / "json-specs").glob("*.md")):
        rel = "public/json-specs/" + path.name
        mirror = SPEC_MIRROR_DIR + "/" + _mirror_name(path.name)
        source = files.get(rel)
        if source is None:
            source = path.read_text(encoding="utf-8")
        if mirror in files:
            copy = files[mirror]  # a None value explicitly simulates a missing copy
        else:
            disk = ROOT / mirror
            copy = disk.read_text(encoding="utf-8") if disk.exists() else None
        if copy is None:
            issues.append(Issue("SPEC_SYNC", mirror, 0,
                                "AI 知识库缺少规范副本: %s" % path.name))
        elif copy != source:
            issues.append(Issue("SPEC_SYNC", mirror, 0,
                                "AI 知识副本与规范真源不一致: %s" % path.name))
    return issues


def _in_asset_scope(rel: str) -> bool:
    """Owned HTML/CSS only: no third-party bundles, builds or dist output."""
    if not rel.startswith("public/") or "/vendor/" in "/" + rel:
        return False
    if rel.startswith("public/dist/"):
        return False
    return rel.lower().endswith((".html", ".css"))


def check_resources(files, exists) -> list[Issue]:
    """Resolve CSS url() and non-product-page asset references."""
    issues = []
    for rel, text in files.items():
        if not _in_asset_scope(rel):
            continue
        is_css = rel.lower().endswith(".css")
        is_html = rel.lower().endswith(".html")
        seen: set[str] = set()
        for lineno, line in _lines(text):
            urls = [m.group(1) for m in CSS_URL.finditer(line)]
            if is_html and not re.match(r"public/omm-", rel):
                urls += [m.group(1) for m in HTML_ATTR.finditer(line)]
            for url in urls:
                if not STATIC_ASSET.search(url.strip()):
                    continue
                target = local_target(rel, url)
                if target is None or target in seen:
                    continue
                seen.add(target)
                if not exists(target):
                    issues.append(Issue("RESOURCE", rel, lineno,
                                        "本地资源引用不存在: %s" % url))
    return issues


def check_xss(files, exists) -> list[Issue]:
    """Flag dynamic values concatenated into an HTML sink without escaping."""
    issues = []
    for rel, text in files.items():
        if not rel.startswith("public/") or "/vendor/" in "/" + rel:
            continue
        if rel.startswith("public/dist/") or not rel.lower().endswith((".html", ".js", ".mjs")):
            continue
        for lineno, line in _lines(text):
            if not XSS_ASSIGN.search(line):
                continue
            if "+" not in line and "${" not in line and "`" not in line:
                continue
            if any(marker in line for marker in XSS_ESCAPERS):
                continue
            if XSS_SAFE.search(line) or not XSS_UNTRUSTED.search(line):
                continue
            issues.append(Issue("XSS", rel, lineno,
                                "HTML 拼接含未转义的动态值，请显式转义后再写入"))
    return issues


def check_a11y(files, exists) -> list[Issue]:
    """Require alt on sourced images and a name on interactive controls."""
    issues = []
    for rel, text in files.items():
        if not rel.startswith("public/") or "/vendor/" in "/" + rel:
            continue
        if rel.startswith("public/dist/") or not rel.lower().endswith(".html"):
            continue
        for m in A11Y_IMG.finditer(text):
            attrs = m.group(1)
            if re.search(r"\balt\s*=", attrs, re.I):
                continue
            if not re.search(r"\bsrc\s*=", attrs, re.I):  # runtime placeholder
                continue
            issues.append(Issue("A11Y", rel, text.count("\n", 0, m.start()) + 1,
                                "图片缺少 alt 属性"))
        for tag, pattern in A11Y_CLICK.items():
            for m in pattern.finditer(text):
                attrs, inner = m.group(1), m.group(2)
                if A11Y_NAMED.search(attrs) or "data-color=" in attrs:
                    continue
                plain = re.sub(r"<[^>]+>", "", inner)
                plain = re.sub(r"&[a-zA-Z#0-9]+;", "", plain).strip()
                if plain:
                    continue
                issues.append(Issue("A11Y", rel, text.count("\n", 0, m.start()) + 1,
                                    "%s 缺少可访问名称（aria-label 或文本）" % tag))
    return issues


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _content(rel: str, files) -> str:
    text = files.get(rel)
    if text is None:
        disk = ROOT / rel
        text = disk.read_text(encoding="utf-8") if disk.exists() else None
    return text or ""


def _fingerprint(rel: str, files) -> str:
    return _sha256(rel + "\n" + _content(rel, files))


def _shared_fingerprint(files) -> str:
    return _sha256("\n".join(
        rel + "\n" + _content(rel, files) for rel in SHARED_MODULES
    ))


def _suggested_bump(version) -> str:
    nums = [int(p) for p in re.findall(r"\d+", str(version))[:4]]
    if not nums:
        return "0.0.1"
    while len(nums) < 3:
        nums.append(0)
    nums[2] += 1
    return ".".join(str(n) for n in nums[:3])


def _read_catalog(files):
    text = _content(CATALOG, files)
    return json.loads(text) if text else {}


def _builtin_versions() -> dict[str, str]:
    return {
        item["id"]: str(item.get("version", VERSION))
        for item in product_registry.BUILTIN_PLUGINS
    }


def _suite_version_issues(catalog) -> list[Issue]:
    issues = []
    suite = str(VERSION)
    if str(catalog.get("version", "")) != suite:
        issues.append(Issue("VERSION", CATALOG, 0,
                            "发布目录 version 与套件版本不一致: %s != %s" % (catalog.get("version"), suite)))
    if str(catalog.get("tag", "")).lstrip("v") != suite:
        issues.append(Issue("VERSION", CATALOG, 0, "发布目录 tag 与套件版本不一致"))
    for key in ("base_url", "gitee_url"):
        url = str(catalog.get(key, ""))
        match = re.search(r"/v?(\d+(?:\.\d+){1,3})/?$", url)
        if not match or match.group(1) != suite:
            issues.append(Issue("VERSION", CATALOG, 0,
                                "%s 中的版本号与套件版本不一致: %s" % (key, url)))
    return issues


def _product_version_issues(catalog, versions) -> list[Issue]:
    issues = []
    for row in catalog.get("plugins", []):
        pid = row.get("id")
        if pid not in versions:
            continue  # unknown products are reported by REGISTRY
        source_version = versions[pid]
        catalog_version = str(row.get("version", ""))
        if catalog_version != source_version:
            issues.append(Issue("VERSION", CATALOG, 0,
                                "产品 %s 版本不一致: 清单 %s / 发布目录 %s"
                                % (pid, source_version, catalog_version)))
    return issues


def check_privacy(files, exists) -> list[Issue]:
    """Planner's editor-only hidden items must never reach the AI or ZenReview.

    ``ed.hidden`` marks a Planner event as "visible in the editor only" and the
    UI masks its title with ``•••••`` elsewhere. Both snapshot producers must
    drop those rows at the source, and the AI context renderer must drop them
    again as a defense-in-depth backstop. This check pins all three invariants.
    """
    issues = []
    hub = files.get("public/omm-hub.js", "")
    if "zp-data-v2" in hub:
        # Locate the planner aggregation block and require a hidden guard inside it.
        start = hub.find("planner: (function ()")
        end = hub.find("})(),", start) if start >= 0 else -1
        segment = hub[start:end] if start >= 0 and end > start else ""
        if not segment or "e.hidden === true" not in segment:
            issues.append(Issue("PRIVACY", "public/omm-hub.js", 0,
                                "Hub planner 快照未过滤 hidden 隐藏项"))

    base = "public/agent_workspace/"
    # Central privacy module must exist and define the hidden mask.
    privacy = files.get(base + "omm_privacy.py", "")
    if "HIDDEN_MASK" not in privacy or "def scrub" not in privacy:
        issues.append(Issue("PRIVACY", base + "omm_privacy.py", 0,
                            "统一隐私模块缺失或不完整"))

    # AI context source must go through the shared scrub backstop.
    host = files.get(base + "omm_host.py", "")
    if "omm_live_context" in host and "from .omm_privacy import scrub" not in host:
        issues.append(Issue("PRIVACY", base + "omm_host.py", 0,
                            "AI 实时上下文未使用统一隐私过滤"))

    # Every OMM tool must be wrapped so hidden items never leak via tool output.
    tools = files.get(base + "omm_tools.py", "")
    if "build_tools" in tools and "_privacy_wrapped" not in tools:
        issues.append(Issue("PRIVACY", base + "omm_tools.py", 0,
                            "工具未统一包装隐私过滤"))

    # Every skill must carry the privacy red line.
    skills = files.get(base + "omm_skills.py", "")
    if "build_skills" in skills and "PRIVACY_RULE" not in skills:
        issues.append(Issue("PRIVACY", base + "omm_skills.py", 0,
                            "技能缺少隐私红线守则"))
    return issues


def _load_format_generator():
    """Load public/tools/gen_formats.py as a module for deterministic rendering."""
    path = ROOT / "public" / "tools" / "gen_formats.py"
    spec = importlib.util.spec_from_file_location("_omm_gen_formats", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_gen_formats(files, exists) -> list[Issue]:
    """Pin format-registry.json as the single editable format contract.

    Generated artifacts (``omm_formats_generated.py`` and the two copies of
    ``formats.generated.md``) are re-rendered from the registry and compared
    byte-for-byte. A stale generated file, a missing validator binding, a
    missing implementing source or a missing golden fixture is a hard failure.
    """
    issues = []
    reg_rel = "public/json-specs/format-registry.json"
    if reg_rel in files:
        registry_text = files[reg_rel]  # an explicit None means "missing"
    else:
        disk = ROOT / reg_rel
        registry_text = disk.read_text(encoding="utf-8") if disk.exists() else None
    if registry_text is None:
        issues.append(Issue("GEN_FORMATS", reg_rel, 0, "格式契约注册表缺失"))
        return issues
    try:
        registry = json.loads(registry_text)
    except Exception as exc:
        issues.append(Issue("GEN_FORMATS", reg_rel, 0, "注册表不是合法 JSON: %s" % exc))
        return issues
    if registry.get("schema") != 1:
        issues.append(Issue("GEN_FORMATS", reg_rel, 0, "注册表 schema 不是 1"))
        return issues
    rows = registry.get("formats")
    if not isinstance(rows, list) or not rows:
        issues.append(Issue("GEN_FORMATS", reg_rel, 0, "注册表没有 formats"))
        return issues

    seen = set()
    validators = files.get("public/agent_workspace/omm_validators.py", "")
    if not validators:
        disk = ROOT / "public" / "agent_workspace" / "omm_validators.py"
        validators = disk.read_text(encoding="utf-8") if disk.exists() else ""
    for row in rows:
        key = (row.get("product"), row.get("kind"))
        if key in seen:
            issues.append(Issue("GEN_FORMATS", reg_rel, 0, "重复的契约: %s/%s" % key))
        seen.add(key)
        validator = row.get("validator")
        if validator and "def %s(" % validator not in validators:
            issues.append(Issue("GEN_FORMATS", reg_rel, 0,
                                "校验器未在 omm_validators.py 定义: %s" % validator))
        source = row.get("source") or ""
        source_text = files.get(source)
        if source_text is None:
            disk = ROOT / source
            source_text = disk.read_text(encoding="utf-8", errors="replace") if disk.exists() else None
        if not source:
            issues.append(Issue("GEN_FORMATS", reg_rel, 0, "契约缺少实现源码: %s" % (key,)))
        elif source_text is None:
            issues.append(Issue("GEN_FORMATS", source, 0, "契约对应的源码缺失"))
        else:
            token = row.get("format")
            if token and token != "bridge" and row.get("kind") != "properties" and token not in source_text:
                issues.append(Issue("GEN_FORMATS", source, 0,
                                    "源码缺少注册的格式标识: %s" % token))
        golden = row.get("golden")
        if golden:
            golden_rel = "tests/golden_formats/" + golden
            if golden_rel not in files and not (ROOT / golden_rel).exists():
                issues.append(Issue("GEN_FORMATS", golden_rel, 0, "Golden fixture 缺失"))

    detection = registry.get("detection") or {}
    for pid in sorted({row.get("product") for row in rows}):
        if pid not in detection:
            issues.append(Issue("GEN_FORMATS", reg_rel, 0, "产品缺少检测规则: %s" % pid))

    generator = _load_format_generator()
    if generator is None:
        issues.append(Issue("GEN_FORMATS", "public/tools/gen_formats.py", 0, "无法加载格式生成器"))
        return issues
    expected = {
        "public/agent_workspace/omm_formats_generated.py": generator.render_py(registry),
        "public/json-specs/formats.generated.md": generator.render_md(registry),
        "public/agent_workspace/omm_knowledge/formats.generated.md": generator.render_md(registry),
    }
    for rel, want in expected.items():
        actual = files.get(rel)
        if actual is None:
            disk = ROOT / rel
            actual = disk.read_text(encoding="utf-8") if disk.exists() else None
        if actual != want:
            issues.append(Issue("GEN_FORMATS", rel, 0,
                                "生成物与注册表不一致，请运行 python public/tools/gen_formats.py"))
    return issues


def check_version(files, exists) -> list[Issue]:
    """Layered version model: suite strict, product local, fingerprint-driven."""
    baseline_text = files.get(BASELINE)
    if not baseline_text:
        return [Issue("VERSION", BASELINE, 0,
                      "缺少版本基线，请运行 python tests/product_guard.py --record-baseline")]
    baseline = json.loads(baseline_text)
    catalog = _read_catalog(files)
    versions = _builtin_versions()
    issues = _suite_version_issues(catalog) + _product_version_issues(catalog, versions)

    old_products = baseline.get("products", {})
    by_id = {item["id"]: item for item in product_registry.BUILTIN_PLUGINS}
    for pid, source_version in versions.items():
        entry = by_id[pid]["entry"]
        rel = "public/" + entry
        fingerprint = _fingerprint(rel, files)
        old = old_products.get(pid)
        if not old:
            continue
        old_version = str(old.get("version", ""))
        if old.get("fingerprint") != fingerprint:
            if old_version == source_version:
                issues.append(Issue("VERSION", rel, 0,
                                    "产品内容已变更但版本未升，建议升至 %s"
                                    % _suggested_bump(source_version)))
        elif old_version != source_version:
            issues.append(Issue("VERSION", rel, 0,
                                "版本已升至 %s 但产品内容未变化（空 bump）" % source_version))

    old_shared = baseline.get("shared", {}).get("fingerprint")
    if old_shared and old_shared != _shared_fingerprint(files):
        suite = str(VERSION)
        if str(baseline.get("suiteVersion", "")) == suite:
            issues.append(Issue("VERSION", "public/lib/zen-card.js", 0,
                                "共享模块已变更但套件版本未升，建议升至 %s"
                                % _suggested_bump(suite)))

    old_suite = str(baseline.get("suiteVersion", ""))
    if old_suite and version_key(str(VERSION)) < version_key(old_suite):
        issues.append(Issue("VERSION", "public/desktop/plugin_specs.py", 0,
                            "套件版本降级: %s -> %s" % (old_suite, VERSION)))
    for pid, old in old_products.items():
        if pid in versions and version_key(versions[pid]) < version_key(str(old.get("version", ""))):
            issues.append(Issue("VERSION", "public/desktop/plugin_specs.py", 0,
                                "产品 %s 版本降级" % pid))

    for row in catalog.get("plugins", []):
        pid = row.get("id")
        old = old_products.get(pid)
        if not old or not row.get("sha256") or not old.get("sha256"):
            continue
        if str(row.get("version")) == str(old.get("version")) and row["sha256"] != old["sha256"]:
            issues.append(Issue("VERSION", CATALOG, 0,
                                "已发布版本 %s 的校验和发生变化，禁止同版本重发" % pid))
    return issues


def record_baseline() -> str:
    """Snapshot current versions / fingerprints as the release baseline."""
    files = snapshot()
    catalog = _read_catalog(files)
    rows = {row.get("id"): row for row in catalog.get("plugins", [])}
    baseline = {
        "schema": 1,
        "suiteVersion": str(VERSION),
        "products": {},
        "shared": {"fingerprint": _shared_fingerprint(files)},
    }
    for item in product_registry.BUILTIN_PLUGINS:
        pid = item["id"]
        row = rows.get(pid) or {}
        baseline["products"][pid] = {
            "version": str(item.get("version", VERSION)),
            "fingerprint": _fingerprint("public/" + item["entry"], files),
            "sha256": row.get("sha256", ""),
        }
    path = ROOT / BASELINE
    path.write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return BASELINE


def check_runtime(files, exists) -> list[Issue]:
    """Keep local code execution confined to the official AI workspace.

    ``runtime='ai'`` starts a Python backend on the user's machine. A typo or a
    malicious plugin.json must never be able to opt into that capability: only
    the built-in ``ai`` product may, and imported third-party plugins stay
    ``static``.
    """
    issues = []
    declared = {
        item["id"] for item in product_registry.BUILTIN_PLUGINS
        if item.get("runtime") == "ai"
    }
    for pid in sorted(declared - {"ai"}):
        issues.append(Issue("RUNTIME", "public/desktop/plugin_specs.py", 0,
                            "非官方产品声明了 ai 运行时: %s" % pid))
    if "ai" not in declared:
        issues.append(Issue("RUNTIME", "public/desktop/plugin_specs.py", 0,
                            "官方 AI 工作区未声明 ai 运行时"))

    for rel, text in files.items():
        if not rel.endswith("plugin.json") or rel.startswith("public/build/") \
                or rel.startswith("public/dist/"):
            continue
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            continue
        if data.get("runtime") == "ai" and data.get("id") != "ai":
            issues.append(Issue("RUNTIME", rel, 0, "第三方插件声明了 ai 运行时"))

    manager = files.get("public/desktop/plugin_manager.py", "")
    if "public/desktop/plugin_manager.py" not in files or \
            not re.search(r'RUNTIMES\s*=\s*\([^)]*\bai\b', manager, re.S):
        issues.append(Issue("RUNTIME", "public/desktop/plugin_manager.py", 0,
                            "运行时注册表缺少 ai"))
    return issues


def _tracked_paths():
    """Paths known to git, or None when git is unavailable.

    An untracked omm-*.html is an in-progress product page, not a release
    product yet.  REGISTRY must not fail on it; once it is committed, the
    check applies.  Tests override this with a lambda returning None.
    """
    try:
        result = subprocess.run(
            ["git", "ls-files"], cwd=ROOT,
            capture_output=True, text=True, check=True)
        return set(result.stdout.splitlines())
    except Exception:
        return None


def check_registry(files, exists) -> list[Issue]:
    """Keep every registration surface derived from plugin_specs.

    The launcher must consume ``product_registry`` (never its own hardcoded
    table), every registered product must have a page, and the release catalog
    may lag behind but must never contain unknown products or drifted fields.
    """
    issues = []
    products = product_registry.BUILTIN_PLUGINS
    by_id = {item["id"]: item for item in products}
    ids = set(by_id)
    all_ids = product_registry.all_ids()

    for item in products:
        rel = "public/" + item["entry"]
        if rel not in files and not (ROOT / rel).exists():
            issues.append(Issue("REGISTRY", rel, 0, "注册产品缺少入口页"))

    tracked = _tracked_paths()
    html_ids = {
        rel[len("public/omm-"):-len(".html")]
        for rel in files
        if rel.startswith("public/omm-") and rel.endswith(".html")
        and (tracked is None or rel in tracked)
    }
    # 入口页可以是非 omm-<id>.html 的约定名（例如 lambda 的 index.html）。
    # entry 字段是权威来源；只有既没有约定页、也没有声明入口的产品才算缺页。
    entry_ids = {
        item["id"] for item in products
        if (PUB / str(item.get("entry") or "")).is_file()
    }
    declared_ids = html_ids | entry_ids
    for name in sorted(html_ids - all_ids):
        issues.append(Issue("REGISTRY", "public/omm-%s.html" % name, 0,
                            "产品页未在任何注册表登记: %s" % name))
    for name in sorted(all_ids - declared_ids):
        # The snapshot may omit dist/, but source pages are always present.
        if (PUB / ("omm-%s.html" % name)).exists():
            continue
        issues.append(Issue("REGISTRY", "public/omm-%s.html" % name, 0,
                            "注册表产品缺少页面: %s" % name))

    exe_ids = set(DESKTOP_EXE_NAMES)
    # 带本地后端的产品可以只在静书房里以插件运行，不生成独立 EXE。
    # 这类 runtime 不要求进入 DESKTOP_EXE_NAMES（video / lambda / table）。
    plugin_only = {
        item["id"] for item in products
        if item.get("runtime") in ("video", "lambda", "table")
    }
    expected_exe_ids = all_ids - plugin_only
    for name in sorted(exe_ids ^ expected_exe_ids):
        issues.append(Issue("REGISTRY", "public/desktop/plugin_specs.py", 0,
                            "桌面程序表与产品注册表不一致: %s" % name))

    cat_text = files.get(CATALOG)
    if cat_text is None:
        disk = ROOT / CATALOG
        cat_text = disk.read_text(encoding="utf-8") if disk.exists() else None
    if cat_text is None:
        issues.append(Issue("REGISTRY", CATALOG, 0, "发布目录缺失"))
    else:
        catalog = json.loads(cat_text)
        rows = {row["id"]: row for row in catalog.get("plugins", [])}
        for name in sorted(set(rows) - ids):
            issues.append(Issue("REGISTRY", CATALOG, 0, "发布目录含未知产品: %s" % name))
        for name, row in rows.items():
            if name not in by_id:
                continue
            for field in ("name", "description", "glyph", "order"):
                if row.get(field) != by_id[name].get(field):
                    issues.append(Issue("REGISTRY", CATALOG, 0,
                                        "发布目录 %s 的 %s 与真源不一致" % (name, field)))

    launcher = files.get(LAUNCHER)
    if launcher is None:
        issues.append(Issue("REGISTRY", LAUNCHER, 0, "桌面启动器缺失"))
    else:
        if "from product_registry import" not in launcher:
            issues.append(Issue("REGISTRY", LAUNCHER, 0,
                                "启动器未从 product_registry 派生产品表"))
        if re.search(r'^\s*"annotate":\s*\(', launcher, re.M):
            issues.append(Issue("REGISTRY", LAUNCHER, 0,
                                "启动器仍保留硬编码的 APPS 表"))
    return issues


CHECKS: list[Check] = [
    Check("QUOTE", "禁用角引号", True, check_quotes),
    Check("LINK", "本地链接可达性", False, check_links),
    Check("IMPORT", "ES 模块导入解析", False, check_imports),
    Check("BRIDGE", "产品桥接注入", False, check_bridge),
    Check("SPEC", "JSON 规范索引同步", False, check_specs),
    Check("SPEC_SYNC", "AI 知识副本与规范同步", False, check_spec_sync),
    Check("FORMAT", "JSON 格式契约同步", False, check_format),
    Check("DEBUG", "调试语句残留", False, check_debug),
    Check("RESOURCE", "静态资源可达性", False, check_resources),
    Check("XSS", "HTML 拼接转义", False, check_xss),
    Check("A11Y", "可访问名称", False, check_a11y),
    Check("REGISTRY", "产品注册表一致性", False, check_registry),
    Check("RUNTIME", "ai 运行时仅官方可用", False, check_runtime),
    Check("PRIVACY", "隐藏日程不进入 AI 快照", False, check_privacy),
    Check("GEN_FORMATS", "格式契约单一真源与生成物一致", False, check_gen_formats),
    Check("VERSION", "分层版本与内容指纹", False, check_version),
]


# --------------------------------------------------------------------------- #
# Runtime
# --------------------------------------------------------------------------- #
def snapshot() -> dict[str, str]:
    files: dict[str, str] = {}
    for path in no_jp_quotes.iter_files():
        text = no_jp_quotes._read_text(path)
        if text is not None:
            files[path.relative_to(ROOT).as_posix()] = text
    return files


def real_exists(target: str) -> bool:
    # A leading "/" in a product page is rooted at public/; a path written in
    # a repo-level document is rooted at the workspace.  Accept either base.
    return (PUB / target).exists() or (ROOT / target).exists()


def run(selected: list[Check], files=None, exists=None) -> list[Issue]:
    files = snapshot() if files is None else files
    exists = real_exists if exists is None else exists
    issues: list[Issue] = []
    for check in selected:
        issues.extend(check.fn(files, exists))
    return issues


def report(issues: list[Issue]) -> None:
    if not issues:
        print("守卫通过：全部检查项无异常。")
        return
    by_code: dict[str, list[Issue]] = {}
    for issue in issues:
        by_code.setdefault(issue.code, []).append(issue)
    for check in CHECKS:
        group = by_code.get(check.code)
        if not group:
            continue
        print("\n[%s] %s — %d 项" % (check.code, check.title, len(group)))
        for issue in group:
            print(issue.render())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OMM-ZEN unified product guard")
    parser.add_argument("--check", action="store_true",
                        help="read-only: never modify files")
    parser.add_argument("--only", metavar="CODES",
                        help="run only these comma-separated check codes")
    parser.add_argument("--list", action="store_true", help="list available checks")
    parser.add_argument("--record-baseline", action="store_true",
                        help="snapshot current versions and content fingerprints")
    parser.add_argument("--suggest-bump", action="store_true",
                        help="print suggested version bumps for changed products")
    args = parser.parse_args(argv)

    if args.record_baseline:
        print("已写入版本基线:", record_baseline())
        return 0

    if args.suggest_bump:
        suggestions = [i for i in check_version(snapshot(), real_exists) if "建议" in i.message]
        for issue in suggestions:
            print(issue.render())
        if not suggestions:
            print("没有需要升版本的内容变更。")
        return 0

    if args.list:
        for c in CHECKS:
            print("%-7s %s%s" % (c.code, c.title, " (可自动修正)" if c.fixable else ""))
        return 0

    if args.only:
        wanted = {s.strip().upper() for s in args.only.split(",") if s.strip()}
        selected = [c for c in CHECKS if c.code in wanted]
        unknown = wanted - {c.code for c in selected}
        if unknown:
            print("未知检查项: %s" % ", ".join(sorted(unknown)), file=sys.stderr)
            return 2
    else:
        selected = CHECKS

    if not args.check:
        # Default: repair the one auto-fixable class first, then verify.
        if any(c.code == "QUOTE" for c in selected):
            changed = no_jp_quotes.fix()
            if changed:
                print("已自动修正引号: %d 个文件" % len(changed))

    issues = run(selected)
    report(issues)
    if issues:
        print("\n守卫失败：共 %d 项，需人工处理。" % len(issues), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
