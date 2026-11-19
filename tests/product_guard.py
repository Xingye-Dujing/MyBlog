"""OMM-ZEN unified product guard.

Runs a set of independent, deterministic checks over the suite's own source
files (never third-party bundles).  Each check reports ``Issue`` records; the
only auto-fixable one is the quote check, which delegates to ``no_jp_quotes``.

Checks
------
QUOTE  forbidden Japanese / Traditional corner-bracket quotes (auto-fixable)
LINK   local href/src and Markdown links that point to a missing file
IMPORT relative ES-module import specifiers that do not resolve
BRIDGE canonical consumer products must load ``zen-link.js`` as a module
SPEC   every JSON spec document is indexed from ``json-specs/README.md``
DEBUG  no ``debugger`` statement may ship in a product page or module
RESOURCE every static CSS url() and non-product-page asset reference resolves
XSS    no unescaped dynamic value is concatenated into innerHTML
A11Y   images have alt and clickable controls have an accessible name
REGISTRY product ids / entry pages / release catalog stay in sync with the
       single source of truth (``plugin_specs.BUILTIN_PLUGINS``)

Usage
-----
    python tests/product_guard.py             # fix quotes, then run all checks
    python tests/product_guard.py --check     # read-only, exit 1 on any issue
    python tests/product_guard.py --only LINK,IMPORT
    python tests/product_guard.py --list
"""
from __future__ import annotations

import argparse
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
from plugin_specs import DESKTOP_EXE_NAMES  # noqa: E402

CATALOG = "public/dist/catalog.json"
LAUNCHER = "public/desktop/omm_launcher.py"

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
    return _normalize([_owner_dir(owner), *raw.split("/")])


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
            if "zen-link.js" in tag and re.search(r"""type=["']module["']""", tag):
                ok = True
                break
        if not ok:
            issues.append(Issue("BRIDGE", rel, 0,
                                "缺少 <script type=\"module\" src=\"zen-link.js\"> 桥接"))
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
    for name in sorted(html_ids - all_ids):
        issues.append(Issue("REGISTRY", "public/omm-%s.html" % name, 0,
                            "产品页未在任何注册表登记: %s" % name))
    for name in sorted(all_ids - html_ids):
        # The snapshot may omit dist/, but source pages are always present.
        if (PUB / ("omm-%s.html" % name)).exists():
            continue
        issues.append(Issue("REGISTRY", "public/omm-%s.html" % name, 0,
                            "注册表产品缺少页面: %s" % name))

    exe_ids = set(DESKTOP_EXE_NAMES)
    for name in sorted(exe_ids ^ all_ids):
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
    Check("DEBUG", "调试语句残留", False, check_debug),
    Check("RESOURCE", "静态资源可达性", False, check_resources),
    Check("XSS", "HTML 拼接转义", False, check_xss),
    Check("A11Y", "可访问名称", False, check_a11y),
    Check("REGISTRY", "产品注册表一致性", False, check_registry),
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
    args = parser.parse_args(argv)

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
