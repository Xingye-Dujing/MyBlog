"""Template-level format tuning shared by DOCX and TeX renderers."""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, Optional

FONT_KEYS = ("songti", "fangsong", "heiti", "kaiti")
DOCX_FONTS = {
    "songti": "宋体",
    "fangsong": "仿宋",
    "heiti": "黑体",
    "kaiti": "楷体",
}
TEX_FONTS = {
    "songti": "SimSun",
    "fangsong": "FangSong",
    "heiti": "SimHei",
    "kaiti": "KaiTi",
}
DEFAULT_TUNING: Dict[str, Dict[str, Any]] = {
    "docx": {
        "margins": {"top": 2.54, "bottom": 2.54, "left": 3.175, "right": 3.175},
        "body": {
            "font_size": 10.5,
            "line_spacing": 1.5,
            "first_line_indent": 2,
            "font": "songti",
        },
        "fonts": {"heading": "heiti"},
        "headings": {"title_size": 15, "h1_size": 12, "h2_size": 10.5, "h3_size": 10.5},
    },
    "tex": {
        "margins": {"top": 2.54, "bottom": 2.54, "left": 3.18, "right": 3.18},
        "body": {
            "font_size": 10.5,
            "line_spacing": 1.25,
            "first_line_indent": 2,
            "font": "fangsong",
        },
        "fonts": {"heading": "fangsong"},
        "headings": {"title_size": 16, "h1_size": 16, "h2_size": 10.5, "h3_size": 10.5},
    },
}


def _number(value: Any, default: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return round(max(minimum, min(maximum, number)), 3)


def _font(value: Any, default: str) -> str:
    key = str(value or "").strip().lower()
    return key if key in FONT_KEYS else default


def _merge(base: Dict[str, Any], override: Dict[str, Any]) -> None:
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = value


def normalize_tuning(
    config: Optional[Dict[str, Any]],
    fmt: str,
    overrides: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    fmt = fmt if fmt in DEFAULT_TUNING else "docx"
    if isinstance(overrides, dict) and isinstance(overrides.get("tuning"), dict):
        overrides = overrides["tuning"]
    template_tuning = (config or {}).get("tuning")
    base = deepcopy(template_tuning) if isinstance(template_tuning, dict) and template_tuning else deepcopy(DEFAULT_TUNING[fmt])
    if isinstance(overrides, dict) and overrides:
        _merge(base, overrides)
    defaults = DEFAULT_TUNING[fmt]
    for section in ("margins", "body", "fonts", "headings"):
        if not isinstance(base.get(section), dict):
            base[section] = {}
    margins = base["margins"]
    body = base["body"]
    fonts = base["fonts"]
    headings = base["headings"]
    for edge in ("top", "bottom", "left", "right"):
        margins[edge] = _number(margins.get(edge), defaults["margins"][edge], 0.5, 8.0)
    body["font_size"] = _number(body.get("font_size"), defaults["body"]["font_size"], 6.0, 30.0)
    body["line_spacing"] = _number(body.get("line_spacing"), defaults["body"]["line_spacing"], 1.0, 3.0)
    body["first_line_indent"] = _number(
        body.get("first_line_indent"), defaults["body"]["first_line_indent"], 0.0, 8.0
    )
    body["font"] = _font(body.get("font"), defaults["body"]["font"])
    fonts["heading"] = _font(fonts.get("heading"), defaults["fonts"]["heading"])
    for key in ("title_size", "h1_size", "h2_size", "h3_size"):
        headings[key] = _number(headings.get(key), defaults["headings"][key], 6.0, 40.0)
    return base


def docx_font(key: Any, fallback: str = "宋体") -> str:
    return DOCX_FONTS.get(str(key or ""), fallback)


def tex_font(key: Any, fallback: str = "FangSong") -> str:
    return TEX_FONTS.get(str(key or ""), fallback)
