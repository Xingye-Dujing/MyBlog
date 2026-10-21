"""Image sizing helpers for DOCX and TeX."""
from __future__ import annotations

import os
import re
from typing import Any, Dict, Optional, Tuple

from PIL import Image

from .errors import RenderError

_NUMERIC_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(cm|mm|in|px|pt|%)?\s*$", re.I)
_TEXWIDTH_RE = re.compile(r"^\s*(\d*\.?\d+)\s*\\(textwidth|linewidth)\s*$", re.I)


def _pixels_to_cm(px: float, dpi: int = 96) -> float:
    return px / dpi * 2.54


def image_size_cm(path: str) -> Tuple[float, float]:
    try:
        with Image.open(path) as image:
            width_px, height_px = image.size
            dpi = image.info.get("dpi", (96, 96))[0] or 96
    except Exception as exc:
        raise RenderError("无法读取图片尺寸：%s (%s)" % (os.path.basename(path), exc))
    return _pixels_to_cm(width_px, int(dpi)), _pixels_to_cm(height_px, int(dpi))


def parse_percent(raw: str) -> Optional[float]:
    match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*%\s*$", raw)
    return float(match.group(1)) / 100.0 if match else None


def resolve_docx_width_cm(raw: str, path: str, available_width_cm: float, max_width_cm: float) -> float:
    natural_w, _ = image_size_cm(path)
    if raw:
        numeric = _NUMERIC_RE.match(raw)
        if numeric:
            value = float(numeric.group(1))
            unit = (numeric.group(2) or "cm").lower()
            if unit == "cm":
                width = value
            elif unit == "mm":
                width = value / 10.0
            elif unit == "in":
                width = value * 2.54
            elif unit == "px":
                width = _pixels_to_cm(value)
            elif unit == "pt":
                width = value * 2.54 / 72.0
            elif unit == "%":
                width = available_width_cm * value / 100.0
            else:
                width = value
        else:
            ratio = parse_percent(raw)
            width = available_width_cm * ratio if ratio is not None else natural_w
    else:
        width = natural_w
    width = min(width, available_width_cm)
    if max_width_cm:
        width = min(width, max_width_cm)
    return max(0.5, width)


def resolve_tex_width(raw: str, default: str = r"0.9\textwidth") -> str:
    if not raw:
        return default
    raw = raw.strip()
    tex_match = _TEXWIDTH_RE.match(raw)
    if tex_match:
        factor = tex_match.group(1)
        unit = tex_match.group(2)
        return r"%s\%s" % (factor, unit)
    numeric = _NUMERIC_RE.match(raw)
    if numeric:
        value = numeric.group(1)
        unit = (numeric.group(2) or "cm").lower()
        if unit == "%":
            return r"%s\linewidth" % (float(value) / 100.0)
        if unit == "px":
            return r"%scm" % round(_pixels_to_cm(float(value)), 3)
        if unit == "pt":
            return r"%spt" % value
        return "%s%s" % (value, unit)
    if raw in (r"\textwidth", r"\linewidth"):
        return raw
    if re.match(r"^\d*\.?\d+$", raw):
        return raw + r"\linewidth"
    return default


def align_value(align: str) -> str:
    align = (align or "center").lower()
    return align if align in ("left", "center", "right") else "center"
