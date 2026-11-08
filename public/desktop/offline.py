"""Stage one app for packaging: page + shared assets + its vendor subset."""
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"

# Which vendored folders/files each app needs.
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


def copy_vendor(dest: Path, app_id: str) -> None:
    target = dest / "vendor"
    target.mkdir(parents=True, exist_ok=True)
    # fonts are small and shared by nearly every app
    shutil.copytree(VENDOR / "fonts", target / "fonts", dirs_exist_ok=True)
    for item in APP_VENDOR.get(app_id, []):
        src = VENDOR / item
        if not src.exists():
            raise FileNotFoundError(
                "vendor asset missing: %s (run desktop/fetch_vendor.py)" % src
            )
        shutil.copytree(src, target / item, dirs_exist_ok=True)


def stage(app_id: str, html_name: str, dest: Path, common_assets=()) -> Path:
    """Create dest/ with the page, shared assets and the needed vendor files."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    shutil.copy2(ROOT / html_name, dest / html_name)
    for asset in common_assets:
        shutil.copy2(ROOT / asset, dest / Path(asset).name)
    copy_vendor(dest, app_id)
    return dest
