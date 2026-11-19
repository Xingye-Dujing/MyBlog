"""Guard against Japanese-style / Traditional-Chinese corner-bracket quotation marks.

OMM-ZEN products must use either Chinese curly quotes (U+201C / U+201D) or
plain ASCII quotes (").  The following "corner bracket" characters are banned
everywhere in the repository's own source, docs and data:

    U+300C / U+300D  left / right corner bracket
    U+300E / U+300F  left / right white corner bracket
    U+FE41 / U+FE42  small left / right corner bracket
    U+FE43 / U+FE44  small left / right white corner bracket
    U+301D / U+301E / U+301F  reversed / double / low double prime quotation

Each is mapped to the matching Chinese curly quote.  Third-party code under a
``vendor`` directory is excluded (it is not ours to edit), as are build output,
dependencies and binary files.

Usage:
    python tests/no_jp_quotes.py          # repair in place, then re-check (default)
    python tests/no_jp_quotes.py --fix    # same as default, kept as an explicit alias
    python tests/no_jp_quotes.py --check  # check only, exit 1 if any found (used by CI)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Built with chr() on purpose: this script must not itself contain any of the
# forbidden glyphs, otherwise it would flag its own source file.
LQ = chr(0x201C)  # Chinese left double quotation mark
RQ = chr(0x201D)  # Chinese right double quotation mark

FORBIDDEN = {
    chr(0x300C): LQ,
    chr(0x300D): RQ,
    chr(0x300E): LQ,
    chr(0x300F): RQ,
    chr(0xFE41): LQ,
    chr(0xFE42): RQ,
    chr(0xFE43): LQ,
    chr(0xFE44): RQ,
    chr(0x301D): LQ,
    chr(0x301E): RQ,
    chr(0x301F): RQ,
}

# Never touch these: third-party bundles, dependencies, build output, caches.
SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "coverage",
    "vendor", "__pycache__", ".vite", ".cache",
    # Local-only tooling / virtualenv (gitignored, not product source).
    ".venv", ".workbuddy", ".idea", ".vscode", "agent_workspace",
}


def iter_files():
    """Yield every candidate text file under the workspace root."""
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            yield Path(dirpath) / name


def count_forbidden(text: str) -> int:
    return sum(text.count(ch) for ch in FORBIDDEN)


def repair_text(text: str) -> str:
    for ch, replacement in FORBIDDEN.items():
        text = text.replace(ch, replacement)
    return text


def _read_text(path: Path):
    """Return decoded UTF-8 text, or None for binary / unreadable files."""
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw:  # binary
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def scan() -> dict[str, int]:
    """Return {relative_path: forbidden_count} for every offending file."""
    hits: dict[str, int] = {}
    for path in iter_files():
        text = _read_text(path)
        if text is None:
            continue
        n = count_forbidden(text)
        if n:
            hits[path.relative_to(ROOT).as_posix()] = n
    return hits


def fix() -> list[tuple[str, int]]:
    """Repair every offending file in place; return [(relative_path, count)]."""
    changed: list[tuple[str, int]] = []
    for path in iter_files():
        text = _read_text(path)
        if text is None:
            continue
        n = count_forbidden(text)
        if not n:
            continue
        repaired = repair_text(text)
        path.write_bytes(repaired.encode("utf-8"))  # preserve exact line endings
        changed.append((path.relative_to(ROOT).as_posix(), n))
    return changed


def _report(hits: dict[str, int], prefix: str) -> None:
    print(prefix)
    for rel, n in sorted(hits.items()):
        print("  %-62s %d" % (rel, n))


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    if "--check" in argv:
        hits = scan()
        if hits:
            _report(hits, "检测到禁用的日式/繁体角引号：")
            print("请运行 python tests/no_jp_quotes.py 自动修正。")
            return 1
        print("检查通过：OMM-ZEN 源码、文档与数据中无禁用引号。")
        return 0

    # Default (and --fix): repair immediately, then verify the whole tree.
    changed = fix()
    print("已修正 %d 个文件：" % len(changed))
    for rel, n in sorted(changed):
        print("  %-62s %d" % (rel, n))
    if not changed:
        print("无需修正：未发现禁用引号。")
    leftover = scan()
    if leftover:
        _report(leftover, "修正后仍有残留（需人工处理）：")
        return 1
    print("复核通过：OMM-ZEN 源码、文档与数据中已无禁用引号。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
