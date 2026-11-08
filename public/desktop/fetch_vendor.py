# -*- coding: utf-8 -*-
"""Download the third-party browser assets used by the OMM pages into vendor/.

Run once (or when bumping a library):

    .venv/Scripts/python.exe desktop/fetch_vendor.py

Output is committed/packaged so the executables work without internet.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import tarfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " \
     "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
MIRRORS = {
    "jsd": "https://cdn.jsdelivr.net/npm/",
    "fastly": "https://fastly.jsdelivr.net/npm/",
    "npmmirror": "https://registry.npmmirror.com/",
}

FILES = {
    "html2canvas/1.4.1/html2canvas.min.js": ["html2canvas@1.4.1/dist/html2canvas.min.js"],
    "jspdf/2.5.1/jspdf.umd.min.js": ["jspdf@2.5.1/dist/jspdf.umd.min.js"],
    "jspdf/4.2.1/jspdf.umd.min.js": ["jspdf@4.2.1/dist/jspdf.umd.min.js"],
    "pdf-lib/1.17.1/pdf-lib.min.js": ["pdf-lib@1.17.1/dist/pdf-lib.min.js"],
    "jszip/3.10.1/jszip.min.js": ["jszip@3.10.1/dist/jszip.min.js"],
    "chartjs/4.4.1/chart.umd.min.js": ["chart.js@4.4.1/dist/chart.umd.min.js"],
    "chartjs/4.5.1/chart.umd.min.js": ["chart.js@4.5.1/dist/chart.umd.min.js"],
    "mammoth/1.6.0/mammoth.browser.min.js": ["mammoth@1.6.0/mammoth.browser.min.js"],
    "mathjax/3/tex-svg.js": ["mathjax@3/es5/tex-svg.js"],
    "apexcharts/7.4.0/apexcharts.min.js": ["apexcharts@7.4.0/dist/apexcharts.min.js"],
    "echarts/6.1.0/echarts.min.js": ["echarts@6.1.0/dist/echarts.min.js"],
    "supabase/2/supabase.js": ["@supabase/supabase-js@2/dist/umd/supabase.js"],
    "bmob/3.0.2/Bmob-latest.min.js": ["hydrogen-js-sdk@3.0.2/dist/Bmob-latest.min.js"],
}
DIRECT = {
    "xlsx/0.20.3/xlsx.full.min.js": [
        "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
        "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    ],
}
# packages whose whole directory tree is needed
TREES = {
    "pdfjs/3.11.174": ("pdfjs-dist", "3.11.174", ["build/pdf.min.js", "build/pdf.worker.min.js", "cmaps", "standard_fonts"]),
    "mupdf/1.28.1": ("mupdf", "1.28.1", ["dist"]),
    "pptxviewjs/1.1.9": ("pptxviewjs", "1.1.9", ["dist"]),
}

FONT_QUERIES = {
    "literata-full": "family=Literata:ital,opsz,wght@0,7..72,300;0,7..72,400;0,7..72,500;0,7..72,600;0,7..72,700;1,7..72,400&display=swap",
    "literata-sub": "family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,500;0,7..72,600;1,7..72,400&display=swap",
    "literata-alt": "family=Literata:ital,opsz,wght@0,7..72,300;0,7..72,400;0,7..72,500;0,7..72,700;1,7..72,400&display=swap",
}


def fetch(url: str, retries: int = 3) -> bytes:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError("download failed: %s (%s)" % (url, last))


def fetch_first(paths: list[str]) -> bytes:
    errors = []
    for path in paths:
        for mirror in ("jsd", "fastly", "npmmirror"):
            url = MIRRORS[mirror] + path
            if mirror == "npmmirror":
                # registry.npmmirror.com serves package files via /<name>/<version>/files/<path>
                name, _, rest = path.partition("@")
                version, _, file_path = rest.partition("/")
                url = "%s%s/%s/files/%s" % (MIRRORS["npmmirror"], name, version, file_path)
            try:
                return fetch(url, retries=1)
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))
    raise RuntimeError("all mirrors failed: %s\n%s" % (paths[0], "\n".join(errors)))


def download_file(rel_path: str, candidates: list[str]) -> None:
    dest = VENDOR / rel_path
    if dest.is_file() and dest.stat().st_size > 0:
        print("  skip", rel_path)
        return
    data = fetch_first(candidates)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    print("  ok  %-52s %.1f KB" % (rel_path, len(data) / 1024))


def download_tree(rel_dir: str, package: str, version: str, wanted: list[str]) -> None:
    dest_root = VENDOR / rel_dir
    tgz = fetch("%s%s/-/%s-%s.tgz" % (MIRRORS["npmmirror"], package, package.split("/")[-1], version))
    print("  tar %s %.1f MB" % (package, len(tgz) / 1024 / 1024))
    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as tar:
        members = []
        for member in tar.getmembers():
            name = member.name
            if not name.startswith("package/"):
                continue
            rel = name[len("package/"):]
            if any(rel == w or rel.startswith(w + "/") for w in wanted):
                members.append(member)
        for member in members:
            rel = member.name[len("package/"):]
            target = dest_root / rel
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(member)
            if source is None:
                continue
            target.write_bytes(source.read())
    for w in wanted:
        p = dest_root / w
        if p.is_dir():
            count = sum(1 for _ in p.rglob("*") if _.is_file())
            print("  ok  %-52s %d files" % ("%s/%s" % (rel_dir, w), count))


def download_fonts() -> None:
    font_dir = VENDOR / "fonts"
    font_dir.mkdir(parents=True, exist_ok=True)
    for name, query in FONT_QUERIES.items():
        css_path = font_dir / ("%s.css" % name)
        if css_path.is_file() and css_path.stat().st_size > 0:
            print("  skip fonts/%s.css" % name)
            continue
        css_url = "https://fonts.googleapis.com/css2?" + query
        css = fetch(css_url).decode("utf-8")
        seen = {}

        def repl(match):
            url = match.group(1)
            if url not in seen:
                ext = ".woff2" if ".woff2" in url else ".woff"
                filename = "%s-%02d%s" % (name, len(seen) + 1, ext)
                (font_dir / filename).write_bytes(fetch(url))
                seen[url] = filename
            return "url(%s)" % seen[url]

        css = re.sub(r"url\((https://fonts\.gstatic\.com/[^)]+)\)", repl, css)
        css_path.write_text(css, encoding="utf-8")
        print("  ok  fonts/%s.css (%d font files)" % (name, len(seen)))


def main() -> None:
    VENDOR.mkdir(exist_ok=True)
    print("single files:")
    for rel, candidates in FILES.items():
        download_file(rel, candidates)
    for rel, urls in DIRECT.items():
        dest = VENDOR / rel
        if dest.is_file() and dest.stat().st_size > 0:
            print("  skip", rel)
            continue
        data = None
        last = None
        for url in urls:
            try:
                data = fetch(url, retries=1)
                break
            except Exception as exc:  # noqa: BLE001
                last = exc
        if data is None:
            raise RuntimeError("download failed: %s (%s)" % (urls[0], last))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        print("  ok  %-52s %.1f KB" % (rel, len(data) / 1024))

    print("package trees:")
    for rel_dir, (package, version, wanted) in TREES.items():
        download_tree(rel_dir, package, version, wanted)

    print("fonts:")
    download_fonts()
    total = sum(f.stat().st_size for f in VENDOR.rglob("*") if f.is_file())
    print("\nvendor total: %.1f MB in %s" % (total / 1024 / 1024, VENDOR))


if __name__ == "__main__":
    main()
