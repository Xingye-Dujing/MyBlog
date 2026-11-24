# -*- coding: utf-8 -*-
"""Static audit for the OMM-ZEN layered stylesheet migration.

Run from the repository root:
    python public/desktop/check_styles.py

Checks that every product page consumes the shared entry, that no product has
regressed to inline shell CSS, that no empty product-CSS placeholders remain,
that CSS is syntactically balanced, and that selected/highlight backgrounds
stay warm (no black/blue). A page with no product-specific rules simply omits
the product stylesheet; it does not need an empty placeholder file.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STYLE_DIRS = [ROOT / "zen" / d for d in ("foundation", "features", "products")]
PAGES = sorted(ROOT.glob("omm-*.html"))
ERRORS: list[str] = []


def fail(message: str) -> None:
    ERRORS.append(message)


for page in PAGES:
    text = page.read_text(encoding="utf-8", errors="ignore")
    if 'href="zen/zen.css"' not in text:
        fail(f"{page.name}: missing zen/zen.css")
    for match in re.finditer(r"^\s*<style\b", text, re.M):
        line = text[: match.start()].count("\n") + 1
        fail(f"{page.name}:{line}: inline <style> block remains")

for css in sorted((ROOT / "zen/products").glob("*.css")):
    body = re.sub(r"/\*.*?\*/", "", css.read_text(encoding="utf-8", errors="ignore"), flags=re.S)
    inner = re.sub(r"^\s*@layer\s+[\w.-]+\s*\{", "", body).rstrip()
    if inner.endswith("}"):
        inner = inner[:-1]
    if not inner.strip():
        fail(f"{css.relative_to(ROOT)}: empty placeholder stylesheet")
        continue

for css in sorted(c for d in STYLE_DIRS for c in d.rglob("*.css")):
    body = re.sub(r"/\*.*?\*/", "", css.read_text(encoding="utf-8", errors="ignore"), flags=re.S)
    depth = 0
    for ch in body:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        if depth < 0:
            fail(f"{css.relative_to(ROOT)}: unbalanced braces")
            break
    if depth:
        fail(f"{css.relative_to(ROOT)}: unbalanced braces ({depth})")
    for line_no, line in enumerate(body.splitlines(), 1):
        if re.search(
            r"background(?:-color)?\s*:\s*(?:#(?:000|000000|1a1a1a|1f1f1f|222|232323|3366cc|3f7fbf|f1e7dc|3a2f28|241e1a|b56545|faf7f1|f2eee7|f4f1ec)|rgba\(80,\s*160,\s*255|rgba\(181,\s*101,\s*69|rgba\(221,\s*142,\s*107)",
            line,
            re.I,
        ):
            fail(f"{css.relative_to(ROOT)}:{line_no}: black/blue background")

offline = (ROOT / "desktop" / "offline.py").read_text(encoding="utf-8", errors="ignore")
if "def copy_zen_styles" not in offline or offline.count("copy_zen_styles(dest)") < 3:
    fail("desktop/offline.py: visual asset staging is incomplete")
if "def copy_shared_lib" not in offline or offline.count("copy_shared_lib(dest)") < 3:
    fail("desktop/offline.py: shared lib staging is incomplete")

if ERRORS:
    print("STYLE AUDIT FAILED")
    for error in ERRORS:
        print(" -", error)
    sys.exit(1)

print(f"STYLE AUDIT OK: {len(PAGES)} pages, {sum(len(list(d.rglob('*.css'))) for d in STYLE_DIRS)} stylesheets")
