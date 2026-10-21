"""High-level conversion API."""
from __future__ import annotations

import os
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

from .compiler import compile_tex
from .docx_renderer import render_docx
from .errors import CompileError, TemplateError, ValidationError
from .metadata import edit_metadata as _edit_metadata
from .models import Document
from .parser import parse_markdown
from .preview import document_stats, toc_payload
from .template import Template, default_template_name, load_template
from .tex_renderer import render_tex
from .validate import validate_document


def _merge_metadata(metadata: Dict[str, Any], overrides: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    merged = dict(metadata or {})
    for key, value in (overrides or {}).items():
        if value is None:
            continue
        merged[key] = value
    return merged


def _format_from_output(output: Optional[str]) -> Optional[str]:
    if not output:
        return None
    lower = output.lower()
    if lower.endswith(".docx"):
        return "docx"
    if lower.endswith(".tex"):
        return "tex"
    return None


def _safe_stem(text: str, fallback: str = "document") -> str:
    stem = re.sub(r'[\\/:*?"<>|\s]+', "_", text or "").strip("._")
    return stem[:80] or fallback


def _prepare(
    source: str,
    source_name: str,
    base_dir: str,
    fmt: str,
    template_name: Optional[str],
    overrides: Optional[Dict[str, Any]],
    strict: bool,
):
    document = parse_markdown(source, source_name=source_name, base_dir=base_dir)
    metadata = _merge_metadata(document.metadata, overrides)
    document.metadata = metadata
    name = template_name or str(metadata.get("template") or "").strip() or default_template_name(fmt)
    template = load_template(fmt, name)
    metadata["template"] = name
    document.metadata = metadata
    issues = validate_document(document, template.config, check_images=True)
    failures = [item for item in issues if item.get("level") == "error"]
    if strict:
        failures = [item for item in issues if item.get("level") in ("error", "warning")]
    if failures:
        first = failures[0]
        message = first.get("message") or "文档校验失败"
        if first.get("line"):
            message = "第 %s 行：%s" % (first["line"], message)
        error = ValidationError(message, int(first.get("line") or 0))
        error.issues = issues
        raise error
    return document, template, issues


def convert_text(
    source: str,
    output: str,
    fmt: str = "docx",
    template: Optional[str] = None,
    base_dir: Optional[str] = None,
    strict: bool = False,
    compile_pdf: bool = False,
    engine: Optional[str] = None,
    overrides: Optional[Dict[str, Any]] = None,
    keep_anchor: bool = False,
    source_name: str = "untitled.md",
    tuning: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    fmt = fmt if fmt in ("docx", "tex") else "docx"
    output = os.path.abspath(output)
    os.makedirs(os.path.dirname(output) or os.getcwd(), exist_ok=True)
    document, template, issues = _prepare(
        source,
        source_name,
        base_dir or os.path.dirname(output) or os.getcwd(),
        fmt,
        template,
        overrides,
        strict,
    )
    result: Dict[str, Any] = {
        "ok": True,
        "format": fmt,
        "template": template.name,
        "output": output,
        "issues": issues,
        "stats": document_stats(document),
        "toc": toc_payload(document),
        "metadata": document.metadata,
    }
    if fmt == "docx":
        render_docx(document, template, output=output, keep_anchor=keep_anchor, tuning=tuning)
        result["filename"] = os.path.basename(output)
    else:
        tex_result = render_tex(document, template, output=output, tuning=tuning)
        result["tex"] = tex_result["tex"]
        result["asset_dir"] = tex_result["asset_dir"]
        result["filename"] = os.path.basename(output)
        if compile_pdf:
            engine_name = engine or str(template.config.get("engine") or "xelatex")
            try:
                compiled = compile_tex(output, engine=engine_name)
                result["pdf"] = compiled["pdf"]
                result["compile"] = {
                    "ok": True,
                    "ms": compiled["ms"],
                    "engine": compiled["engine"],
                    "log": compiled["log"],
                    "errors": compiled["errors"],
                }
                result["pdf_filename"] = os.path.basename(compiled["pdf"])
            except CompileError as exc:
                result["compile"] = {
                    "ok": False,
                    "error": exc.message,
                    "log": exc.log,
                    "errors": [{"line": exc.line, "message": exc.message}],
                }
            except Exception as exc:
                result["compile"] = {"ok": False, "error": str(exc), "log": "", "errors": []}
    render_issues = [item for item in document.issues if item not in issues]
    result["issues"] = issues + render_issues
    result["stats"] = document_stats(document)
    return result


def convert_file(
    input_path: str,
    output: Optional[str] = None,
    fmt: Optional[str] = None,
    template: Optional[str] = None,
    strict: bool = False,
    compile_pdf: bool = False,
    engine: Optional[str] = None,
    overrides: Optional[Dict[str, Any]] = None,
    keep_anchor: bool = False,
    tuning: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    input_path = os.path.abspath(input_path)
    if not os.path.isfile(input_path):
        raise ValidationError("输入文件不存在：%s" % input_path)
    with open(input_path, "r", encoding="utf-8-sig") as handle:
        source = handle.read()
    fmt = fmt or _format_from_output(output) or "docx"
    if fmt not in ("docx", "tex"):
        raise ValidationError("未知输出格式：%s" % fmt)
    if not output:
        stem = os.path.splitext(os.path.basename(input_path))[0]
        output = os.path.join(os.path.dirname(input_path), stem + "." + fmt)
    suffix = ".docx" if fmt == "docx" else ".tex"
    if not str(output).lower().endswith(suffix):
        output = str(output) + suffix
    return convert_text(
        source,
        output=output,
        fmt=fmt,
        template=template,
        base_dir=os.path.dirname(input_path),
        strict=strict,
        compile_pdf=compile_pdf,
        engine=engine,
        overrides=overrides,
        keep_anchor=keep_anchor,
        source_name=os.path.basename(input_path),
        tuning=tuning,
    )


def edit_metadata(*args, **kwargs):
    return _edit_metadata(*args, **kwargs)
