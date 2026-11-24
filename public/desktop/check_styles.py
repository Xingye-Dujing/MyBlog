# -*- coding: utf-8 -*-
"""Static audit for the OMM-ZEN layered stylesheet migration.

Run from the repository root:
    python public/desktop/check_styles.py

Checks that every product page consumes the shared entry, that no product has
regressed to inline shell CSS, that no empty product-CSS placeholders remain,
that CSS is syntactically balanced, that selected/highlight backgrounds stay
warm (no black/blue), and that interface radii come only from the shared ZEN
token. Semantic circles (status dots, canvas ports, swatches) may remain round.
A page with no product-specific rules simply omits the product stylesheet; it
does not need an empty placeholder file.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STYLE_DIRS = [ROOT / "zen" / d for d in ("foundation", "components", "features", "products")]
PAGES = sorted(ROOT.glob("omm-*.html"))
ERRORS: list[str] = []
FIXED_RADIUS = re.compile(r"border-radius\s*:\s*(?:[1-9]\d*(?:\.\d+)?px|99px|999px)", re.I)
DERIVED_RADIUS = re.compile(
    r"border-radius\s*:\s*calc\(var\(--(?:zen-)?radius\)\s*[+*-]\s*[0-9.]+\s*px\)",
    re.I,
)
RADIUS_OVERRIDE = re.compile(r"--(?:zen-)?radius\s*:\s*[1-9]\d*(?:\.\d+)?px", re.I)


def check_radius_line(path: Path, line_no: int, line: str) -> None:
    label = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path.relative_to(ROOT.parent)
    if FIXED_RADIUS.search(line):
        fail(f"{label}:{line_no}: fixed non-zero interface radius")
    if DERIVED_RADIUS.search(line):
        fail(f"{label}:{line_no}: derived non-zero interface radius")
    if RADIUS_OVERRIDE.search(line):
        fail(f"{label}:{line_no}: ZEN radius token override")


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
        check_radius_line(css, line_no, line)
        if re.match(r"\s*'\s*\+", line):
            fail(f"{css.relative_to(ROOT)}:{line_no}: stray JavaScript fragment in CSS")
        if re.search(
            r"background(?:-color)?\s*:\s*(?:#(?:000|000000|1a1a1a|1f1f1f|222|232323|3366cc|3f7fbf|f1e7dc|3a2f28|241e1a|b56545|faf7f1|f2eee7|f4f1ec)|rgba\(80,\s*160,\s*255|rgba\(181,\s*101,\s*69|rgba\(221,\s*142,\s*107)",
            line,
            re.I,
        ):
            fail(f"{css.relative_to(ROOT)}:{line_no}: black/blue background")

radius_sources = [ROOT / "lib" / "zen-link.js", ROOT / "omm-mdforge.html", ROOT / "index.html"]
radius_sources.extend(sorted(ROOT.glob("omm-*.html")))
core_css = ROOT.parent / "third_party" / "zenviz-core" / "core" / "zenviz.css"
if core_css.exists():
    radius_sources.append(core_css)
for source in radius_sources:
    for line_no, line in enumerate(source.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
        check_radius_line(source, line_no, line)

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
