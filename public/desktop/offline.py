# -*- coding: utf-8 -*-
"""Build the offline staging folder for one app.

Source HTML keeps using CDNs (so the hosted site still works); at build time we
rewrite the external references to the vendored copies and bundle them into the
executable. This keeps a single source of truth and makes the EXE offline.
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"

LOCAL = {
    "html2canvas": "vendor/html2canvas/1.4.1/html2canvas.min.js",
    "jspdf251": "vendor/jspdf/2.5.1/jspdf.umd.min.js",
    "jspdf421": "vendor/jspdf/4.2.1/jspdf.umd.min.js",
    "pdfjsLib": "vendor/pdfjs/3.11.174/build/pdf.min.js",
    "pdfjsWorker": "vendor/pdfjs/3.11.174/build/pdf.worker.min.js",
    "pdfjsCmap": "vendor/pdfjs/3.11.174/cmaps/",
    "pdfjsStdFont": "vendor/pdfjs/3.11.174/standard_fonts/",
    "pdfLib": "vendor/pdf-lib/1.17.1/pdf-lib.min.js",
    "mupdf": "./vendor/mupdf/1.28.1/dist/",
    "mupdfEsm": "./vendor/mupdf/1.28.1/dist/mupdf.js",
    "jszip": "vendor/jszip/3.10.1/jszip.min.js",
    "pptxviewjs": "vendor/pptxviewjs/1.1.9/dist/PptxViewJS.min.js",
    "mammoth": "vendor/mammoth/1.6.0/mammoth.browser.min.js",
    "chart441": "vendor/chartjs/4.4.1/chart.umd.min.js",
    "chart451": "vendor/chartjs/4.5.1/chart.umd.min.js",
    "apexcharts": "vendor/apexcharts/7.4.0/apexcharts.min.js",
    "echarts": "vendor/echarts/6.1.0/echarts.min.js",
    "xlsx0203": "vendor/xlsx/0.20.3/xlsx.full.min.js",
    "mathjax": "vendor/mathjax/3/tex-svg.js",
    "supabase": "vendor/supabase/2/supabase.js",
    "bmob": "vendor/bmob/3.0.2/Bmob-latest.min.js",
}

FONT_KEYS = {
    "fontLiterataFull": "vendor/fonts/literata-full.css",
    "fontLiterataSub": "vendor/fonts/literata-sub.css",
    "fontLiterataAlt": "vendor/fonts/literata-alt.css",
    "fontLiterataCorpus": "vendor/fonts/literata-sub.css",
}

# Which vendored folders/files each app actually needs.
APP_VENDOR = {
    "annotate": ["pdfjs"],
    "corpus": ["supabase"],
    "data": ["supabase"],
    "english": ["supabase"],
    "latex": ["pdfjs"],
    "mdforge": [],
    "message": ["supabase"],
    "planner": ["html2canvas", "supabase"],
    "redact": [
        "pdfjs", "pdf-lib", "jszip", "pptxviewjs", "mammoth",
        "chartjs/4.4.1", "jspdf/2.5.1", "html2canvas", "mupdf",
    ],
    "visualization": [
        "chartjs/4.5.1", "apexcharts", "echarts", "html2canvas",
        "jspdf/4.2.1", "xlsx",
    ],
    "writer": ["html2canvas", "jspdf/2.5.1", "mathjax", "supabase"],
}

# external URL -> local file (exact matches used by the pages)
URL_MAP = {
    "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js": LOCAL["html2canvas"],
    "https://cdn.jsdmirror.com/npm/html2canvas@1.4.1/dist/html2canvas.min.js": LOCAL["html2canvas"],
    "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js": LOCAL["jspdf251"],
    "https://cdn.jsdmirror.com/npm/jspdf@2.5.1/dist/jspdf.umd.min.js": LOCAL["jspdf251"],
    "https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js": LOCAL["jspdf421"],
    "https://cdn.jsdmirror.com/npm/jspdf@4.2.1/dist/jspdf.umd.min.js": LOCAL["jspdf421"],
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js": LOCAL["pdfjsLib"],
    "https://cdn.jsdmirror.com/npm/pdfjs-dist@3.11.174/build/pdf.min.js": LOCAL["pdfjsLib"],
    "https://cdn.jsdmirror.com/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js": LOCAL["pdfLib"],
    "https://cdn.jsdmirror.com/npm/jszip@3.10.1/dist/jszip.min.js": LOCAL["jszip"],
    "https://cdn.jsdmirror.com/npm/chart.js@4.4.1/dist/chart.umd.min.js": LOCAL["chart441"],
    "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js": LOCAL["chart451"],
    "https://cdn.jsdmirror.com/npm/pptxviewjs@1.1.9/dist/PptxViewJS.min.js": LOCAL["pptxviewjs"],
    "https://cdn.jsdmirror.com/npm/mammoth@1.6.0/mammoth.browser.min.js": LOCAL["mammoth"],
    "https://cdn.jsdmirror.com/npm/mathjax@3/es5/tex-svg.js": LOCAL["mathjax"],
    "https://cdn.jsdelivr.net/npm/apexcharts@7.4.0/dist/apexcharts.min.js": LOCAL["apexcharts"],
    "https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js": LOCAL["echarts"],
    "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js": LOCAL["xlsx0203"],
}


def font_variant(url: str) -> str:
    query = unquote(url)
    if "600" in query and "300" in query and "700" in query:
        return "full"
    if "600" in query and "300" not in query:
        return "sub"
    return "alt"


def rewrite_html(text: str) -> str:
    for url, local in URL_MAP.items():
        text = text.replace(url, local)
    # Google Fonts stylesheet -> local Literata CSS
    def font_repl(match):
        return 'href="vendor/fonts/literata-%s.css"' % font_variant(match.group(1))

    text = re.sub(
        r'href="(https://fonts\.googleapis\.com/css2\?family=Literata[^"]*)"',
        font_repl,
        text,
    )
    # preconnect hints only add network noise offline
    text = re.sub(r'\s*<link rel="preconnect" href="https://fonts\.(googleapis|gstatic)\.com"[^>]*>', "", text)
    return text


def _replace_array(js: str, key: str, local: str) -> str:
    match = re.search(r"(^\s{4}%s:\s*)" % re.escape(key), js, re.M)
    if not match:
        raise ValueError("mirror key not found: %s" % key)
    start = match.end()
    if js[start:start + 1] != "[":
        raise ValueError("mirror key is not an array: %s" % key)
    depth = 0
    quote = ""
    i = start
    while i < len(js):
        ch = js[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = ""
        elif ch in "'\"":
            quote = ch
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i + 1
                if end < len(js) and js[end] == ",":
                    end += 1
                return js[:match.start()] + match.group(1) + "['%s']," % local + js[end:]
        i += 1
    raise ValueError("unterminated array for %s" % key)


def rewrite_mirrors(js: str) -> str:
    # Inside the packaged app the local copy is the only source: keep no CDN
    # fallbacks, so nothing attempts the network when offline.
    for key, local in LOCAL.items():
        js = _replace_array(js, key, local)
    for key, local in FONT_KEYS.items():
        pattern = re.compile(
            r"^\s{4}%s:\s*fonts\([^)]*\)," % re.escape(key), re.M
        )
        js, count = pattern.subn(
            lambda m: "    %s: ['%s']," % (key, local), js, count=1
        )
        if not count:
            raise ValueError("font key not found: %s" % key)
    return js


def copy_vendor(dest: Path, app_id: str) -> None:
    target = dest / "vendor"
    target.mkdir(parents=True, exist_ok=True)
    # fonts are small and shared by nearly every app
    shutil.copytree(VENDOR / "fonts", target / "fonts", dirs_exist_ok=True)
    for item in APP_VENDOR.get(app_id, []):
        src = VENDOR / item
        if not src.exists():
            raise FileNotFoundError("vendor asset missing: %s (run desktop/fetch_vendor.py)" % src)
        shutil.copytree(src, target / item, dirs_exist_ok=True)


def stage(app_id: str, html_name: str, dest: Path, common_assets=()) -> Path:
    """Create dest/ with offline html, offline mirror table and vendor subset."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    source = (ROOT / html_name).read_text(encoding="utf-8")
    (dest / html_name).write_text(rewrite_html(source), encoding="utf-8")
    mirrors = (ROOT / "cdn-mirrors.js").read_text(encoding="utf-8")
    (dest / "cdn-mirrors.js").write_text(rewrite_mirrors(mirrors), encoding="utf-8")
    for asset in common_assets:
        shutil.copy2(ROOT / asset, dest / Path(asset).name)
    copy_vendor(dest, app_id)
    return dest
