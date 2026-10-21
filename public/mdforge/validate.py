"""Document and template validation."""
from __future__ import annotations

import os
import re
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urlparse

from .models import Document, plain_text

_WIDTH_RE = re.compile(r"^\s*(?:\d+(?:\.\d+)?\s*(?:cm|mm|in|px|%|pt)|0?\.\d+\s*\\(?:textwidth|linewidth)|-?\d+(?:\.\d+)?\s*\\(?:textwidth|linewidth))\s*$", re.I)


def _issue(level: str, message: str, line: int = 0, code: str = "") -> Dict[str, Any]:
    return {"level": level, "message": message, "line": int(line or 0), "code": code or level}


def resolve_image_path(path: str, base_dir: Optional[str]) -> Optional[str]:
    if not path:
        return None
    if re.match(r"^[a-z]+://", path, re.I):
        return None
    clean = path.replace("/", os.sep)
    if os.path.isabs(clean):
        return os.path.normpath(clean)
    root = base_dir or os.getcwd()
    return os.path.normpath(os.path.join(root, clean))


def validate_document(
    doc: Document,
    template_config: Optional[Dict[str, Any]] = None,
    check_images: bool = True,
) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = list(doc.issues)
    config = template_config or {}
    meta_cfg = config.get("metadata") or {}
    required: Iterable[str] = meta_cfg.get("required") or ["title"]
    metadata = doc.metadata or {}

    for key in required:
        value = metadata.get(key)
        if value is None or (isinstance(value, str) and not value.strip()) or (isinstance(value, list) and not value):
            issues.append(_issue("error", "frontmatter 缺少必填字段：%s" % key, 1, "metadata-required"))

    if not str(metadata.get("title") or "").strip():
        if not any(i.get("code") == "metadata-required" for i in issues):
            issues.append(_issue("error", "文档标题不能为空", 1, "metadata-title"))

    if not doc.blocks:
        issues.append(_issue("warning", "正文为空", 0, "empty-body"))

    for block in doc.blocks:
        if block.type == "heading" and not plain_text(block.inlines).strip():
            issues.append(_issue("warning", "存在空标题", block.line, "empty-heading"))
        if block.type == "table":
            cols = max([len(row) for row in block.rows] + [0])
            if cols == 0:
                issues.append(_issue("warning", "空表格已被忽略", block.line, "empty-table"))
        if block.type == "list":
            for item in block.items:
                if item.level > 3:
                    issues.append(_issue("warning", "列表超过 3 级，已按第 3 级处理", item.line, "list-depth"))
                    break
        if block.type == "image":
            image = block.image or {}
            path = str(image.get("path") or "")
            if not path:
                issues.append(_issue("error", "图片路径为空", block.line, "image-path"))
                continue
            parsed = urlparse(path)
            if parsed.scheme in ("http", "https"):
                issues.append(_issue("error", "仅支持本地图片：%s" % path, block.line, "image-remote"))
                continue
            resolved = resolve_image_path(path, doc.base_dir)
            if check_images and (not resolved or not os.path.isfile(resolved)):
                issues.append(_issue("error", "图片不存在：%s" % path, block.line, "image-missing"))
            width = str(image.get("width") or "")
            if width and not _WIDTH_RE.match(width) and not re.match(r"^\d+(?:\.\d+)?$", width):
                issues.append(_issue("warning", "无法识别的图片宽度：%s，将使用默认宽度" % width, block.line, "image-width"))
            align = str(image.get("align") or "").lower()
            if align and align not in ("left", "center", "right"):
                issues.append(_issue("warning", "无法识别的图片对齐：%s，将居中" % align, block.line, "image-align"))
    return issues


def has_errors(issues: List[Dict[str, Any]]) -> bool:
    return any(item.get("level") == "error" for item in issues)


def strict_failure(issues: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for item in issues:
        if item.get("level") == "error":
            return item
    return None
