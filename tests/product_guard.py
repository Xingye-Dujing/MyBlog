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

Usage
-----
    python tests/product_guard.py             # fix quotes, then run all checks
    python tests/product_guard.py --check     # read-only, exit 1 on any issue
    python tests/product_guard.py --only LINK,IMPORT
    python tests/product_guard.py --list
"""
from __future__ import annotations

import argparse
import re
import sys
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import no_jp_quotes

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public"

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


CHECKS: list[Check] = [
    Check("QUOTE", "禁用角引号", True, check_quotes),
    Check("LINK", "本地链接可达性", False, check_links),
    Check("IMPORT", "ES 模块导入解析", False, check_imports),
    Check("BRIDGE", "产品桥接注入", False, check_bridge),
    Check("SPEC", "JSON 规范索引同步", False, check_specs),
    Check("DEBUG", "调试语句残留", False, check_debug),
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
