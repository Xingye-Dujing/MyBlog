#!/usr/bin/env python3
"""Detect and fix CJK corner brackets (日式繁体引号) anywhere in the source tree.

Forbidden: the four CJK corner brackets U+300C / U+300D / U+300E / U+300F. They are referred
to only by escape notation here, never written literally — this file is scanned too.
Allowed:   U+201C / U+201D / U+2018 / U+2019 (Chinese quotes) or " " ' ' (English quotes).

The replacement keeps the nesting order of Chinese quotes: an outer corner bracket becomes a
Chinese double quote and an inner one becomes a Chinese single quote. This is the single source of
truth for both the pytest gate in ``tests/test_quote_style.py`` and the OpenCode hook in
``.opencode/hooks/quote_style.mjs``.

Usage:
    python tools/check_quote_style.py              # report, exit 1 if any found
    python tools/check_quote_style.py --fix        # fix them in place, exit 0
    python tools/check_quote_style.py --path a.py  # scope to one file (used by the hook)
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]

#: bad character -> good character. The mapping is deliberately one-to-one and lossless.
FORBIDDEN: dict[str, str] = {
    '\u300c': '\u201c',  # U+300C -> U+201C
    '\u300d': '\u201d',  # U+300D -> U+201D
    '\u300e': '\u2018',  # U+300E -> U+2018
    '\u300f': '\u2019',  # U+300F -> U+2019
}
BAD_CHARS = frozenset(FORBIDDEN)

#: Generated or third-party trees are not our source. Add a pinned vendor path here only when a
#: third-party corpus legitimately contains these bytes; never silence a finding in our own code.
EXCLUDE_DIRS = frozenset(
    {
        '.git',
        '.venv',
        '.venv-build',
        'venv',
        '__pycache__',
        '.pytest_cache',
        '.ruff_cache',
        '.mypy_cache',
        '.hf-cache',
        'node_modules',
        'data',
        'live-data',
        'build',
        'dist',
        '*.egg-info',
        'logs',
        'scratchpad',
        'ml_train',
        'chrome_profile',
        'chrome_profiles',
    }
)
EXCLUDE_SUFFIXES = frozenset(
    {
        '.pyc',
        '.pyo',
        '.so',
        '.dll',
        '.dylib',
        '.exe',
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.webp',
        '.ico',
        '.pdf',
        '.db',
        '.db-wal',
        '.db-shm',
        '.zip',
        '.gz',
        '.whl',
        '.ttf',
        '.otf',
        '.woff',
        '.woff2',
        '.mo',
        '.bin',
    }
)
#: Pinned third-party vendor trees are exempt (the documented exception for vendor bytes).
ALLOW_PATHS: frozenset[str] = frozenset({'static/vendor'})


@dataclass(frozen=True)
class Finding:
    path: Path
    line: int
    column: int
    char: str
    text: str

    def __str__(self) -> str:
        rel = self.path.relative_to(ROOT) if self.path.is_relative_to(ROOT) else self.path
        return f'{rel}:{self.line}:{self.column}: {self.char!r} in {self.text.strip()[:100]!r}'


def _excluded(path: Path, root: Path) -> bool:
    rel = path.relative_to(root) if path.is_relative_to(root) else path
    for part in rel.parts:
        if part in EXCLUDE_DIRS or any(part.endswith(suffix[1:]) for suffix in EXCLUDE_DIRS if suffix.startswith('*')):
            return True
    if path.suffix.lower() in EXCLUDE_SUFFIXES:
        return True
    rel_str = rel.as_posix()
    return any(allowed in rel_str for allowed in ALLOW_PATHS)


def iter_text_files(paths: Iterable[Path] | None = None, root: Path = ROOT) -> Iterable[Path]:
    """Yield candidate text files, honouring the exclusion rules."""
    if paths:
        for item in paths:
            path = item if item.is_absolute() else (root / item)
            if path.is_file() and not _excluded(path, root):
                yield path
        return
    for path in sorted(root.rglob('*')):
        if path.is_file() and not _excluded(path, root):
            yield path


def scan(paths: Iterable[Path] | None = None, root: Path = ROOT) -> list[Finding]:
    findings: list[Finding] = []
    for path in iter_text_files(paths, root):
        try:
            text = path.read_bytes().decode('utf-8')
        except (UnicodeDecodeError, OSError):
            continue  # not a UTF-8 text file
        for line_number, line in enumerate(text.splitlines(), 1):
            for column, char in enumerate(line, 1):
                if char in BAD_CHARS:
                    findings.append(Finding(path, line_number, column, char, line))
    return findings


def fix(findings: list[Finding]) -> int:
    """Replace forbidden characters in each affected file. Byte-level to preserve line endings."""
    changed = 0
    for path in {item.path for item in findings}:
        data = path.read_bytes()
        original = data
        for bad, good in FORBIDDEN.items():
            data = data.replace(bad.encode('utf-8'), good.encode('utf-8'))
        if data != original:
            path.write_bytes(data)
            changed += 1
    return changed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT, help='repository root (default: this repo)')
    parser.add_argument('--path', nargs='*', default=None, help='only check these files')
    parser.add_argument('--fix', action='store_true', help='replace forbidden quotes in place')
    parser.add_argument('--quiet', action='store_true', help='suppress the per-finding report')
    args = parser.parse_args(argv)

    # A Windows console may be on GBK; a finding can contain Chinese text. Never crash while
    # reporting the very problem the tool exists to catch.
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')

    root = args.root.resolve()
    findings = scan(args.path, root)
    if not findings:
        if not args.quiet:
            print(f'quote style OK — no forbidden corner brackets found under {root}')
        return 0
    if not args.quiet:
        for finding in findings:
            print(finding)
        print(f'found {len(findings)} forbidden quote(s) in {len({f.path for f in findings})} file(s)')
    if args.fix:
        changed = fix(findings)
        if not args.quiet:
            print(f'fixed {changed} file(s)')
        remaining = scan(args.path, root)
        return 0 if not remaining else 1
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
