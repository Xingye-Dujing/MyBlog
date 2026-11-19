"""Gate: CJK corner brackets (日式繁体引号) must never appear anywhere in this repository.

The scanner lives in ``tools/check_quote_style.py`` — the single source of truth shared with the
OpenCode hook, which auto-fixes the touched file after every write/edit. This test is the backstop:
run ``pytest`` after a change and any reintroduced corner bracket fails the suite with its exact
file:line:column. To correct it immediately, run ``python tools/check_quote_style.py --fix``.

Forbidden characters are written here as escapes so this file never contains one literally.
"""

from __future__ import annotations

from tools.check_quote_style import FORBIDDEN, ROOT, fix, scan


def test_no_forbidden_quotes_anywhere_in_the_repository():
    findings = scan(root=ROOT)
    details = '\n'.join(str(item) for item in findings[:40])
    assert not findings, f'found {len(findings)} forbidden quote(s):\n{details}'


def test_fixer_replaces_every_forbidden_character_and_preserves_rest(tmp_path):
    bad = ''.join(FORBIDDEN)
    source = tmp_path / 'sample.md'
    original = f'# heading\nouter {bad[0]}inner {bad[2]}nested{bad[3]}{bad[1]} text\r\nlast line\n'
    source.write_bytes(original.encode('utf-8'))

    findings = scan([source], root=tmp_path)
    assert len(findings) == 4

    assert fix(findings) == 1
    repaired = source.read_bytes().decode('utf-8')
    assert 'outer “inner ‘nested’” text' in repaired
    assert '\r\n' in repaired  # line endings are preserved byte-for-byte
    assert scan([source], root=tmp_path) == []


def test_allowed_quotes_are_left_alone(tmp_path):
    source = tmp_path / 'allowed.md'
    text = '中文 “引号” 和 ‘内层’，英文 "double" 与 \'single\' 都允许。\n'
    source.write_text(text, encoding='utf-8')
    assert scan([source], root=tmp_path) == []
