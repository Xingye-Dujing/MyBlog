"""Document and template validation."""
from __future__ import annotations

import os
import re
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urlparse

from PIL import Image

from .escape import escape
from .models import Document, plain_text

_UNTRUSTED_TEX: ContextVar[bool] = ContextVar("mdforge_untrusted_tex", default=False)
_SAFE_MATH_COMMANDS = frozenset("""
frac dfrac tfrac sqrt root sum prod int iint iiint oint lim max min sup inf
log ln exp sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh
alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa
lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi
psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega
cdot times pm mp div ast star circ bullet cup cap setminus landor lor neg lnot
le leq leqslant ge geq geqslant neq ne approx sim simeq equiv propto to
rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow mapsto
in notin ni subset supset subseteq supseteq subsetneq supsetneq sqsubset
sqsupset sqsubseteq sqsupseteq varnothing emptyset forall exists nexists partial
nabla infty ell hbar Re Im angle triangle perp parallel mid prime
mathrm mathit mathbf mathsf mathtt mathcal mathbb boldsymbol bm text operatorname
binom overline underline widehat vec hat bar dot ddot tilde
left right big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr Biggl Biggr
limits nolimits displaystyle textstyle scriptstyle scriptscriptstyle
quad qquad enspace space
""".split())
_SAFE_MATH_PUNCTUATION = frozenset([",", ";", ":", "!"])
_MATH_CONTROL_RE = re.compile(r"\\([A-Za-z]+|.)", re.S)


@contextmanager
def untrusted_tex():
    """Mark a Web/AI conversion as unable to compile caller-provided TeX."""
    token = _UNTRUSTED_TEX.set(True)
    try:
        yield
    finally:
        _UNTRUSTED_TEX.reset(token)


def raw_tex_allowed(allow_raw_tex: Optional[bool] = None) -> bool:
    if allow_raw_tex is not None:
        return bool(allow_raw_tex)
    return not _UNTRUSTED_TEX.get()


def sanitize_math(code: str) -> str:
    """Keep a small math subset verbatim; render everything else as literal text.

    This is an allowlist, not a dangerous-command blacklist. Unknown control
    sequences, TeX catcode tricks and environment switches never reach TeX.
    """
    original = str(code or "").strip()
    if not original:
        return ""
    unsafe = any(char in original for char in ("%", "#", "$", "&")) or "^^" in original
    depth = 0
    for char in original:
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth < 0:
                unsafe = True
                break
    if depth:
        unsafe = True
    matches = list(_MATH_CONTROL_RE.finditer(original))
    if original.count("\\") != len(matches):
        unsafe = True
    for match in matches:
        command = match.group(1)
        if command not in _SAFE_MATH_COMMANDS and command not in _SAFE_MATH_PUNCTUATION:
            unsafe = True
            break
    if unsafe:
        literal = escape(original.replace("\r", " ").replace("\n", " "))
        return r"\texttt{%s}" % literal
    return original


_WIDTH_RE = re.compile(r"^\s*(?:\d+(?:\.\d+)?\s*(?:cm|mm|in|px|%|pt)|0?\.\d+\s*\\(?:textwidth|linewidth)|-?\d+(?:\.\d+)?\s*\\(?:textwidth|linewidth))\s*$", re.I)
_ALLOWED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg"}
_DANGEROUS_TEX_RE = re.compile(
    r"\\(?:write18|input|include|includeonly|openin|openout|read|usepackage|documentclass|directlua|latelua|luadirect|includegraphics)\b",
    re.I,
)


def _tex_without_comments(code: str) -> str:
    lines = []
    for line in str(code or "").splitlines():
        cut = len(line)
        for index, char in enumerate(line):
            if char == "%" and (index == 0 or line[index - 1] != "\\"):
                cut = index
                break
        lines.append(line[:cut])
    return "\n".join(lines)


def _issue(level: str, message: str, line: int = 0, code: str = "") -> Dict[str, Any]:
    return {"level": level, "message": message, "line": int(line or 0), "code": code or level}


def _is_inside_base(path: str, base_dir: Optional[str]) -> bool:
    base = os.path.abspath(base_dir or os.getcwd())
    target = os.path.abspath(path)
    try:
        return os.path.commonpath([os.path.normcase(base), os.path.normcase(target)]) == os.path.normcase(base)
    except ValueError:
        return False


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


def _image_reference_issues(
    path: str,
    base_dir: Optional[str],
    line: int,
    check_images: bool,
    level: str,
    prefix: str,
) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []

    def add(message: str, suffix: str) -> None:
        result.append(_issue(level, message, line, "%s-%s" % (prefix, suffix)))

    if not path:
        add("图片路径为空", "path")
        return result
    if os.path.isabs(path) or re.match(r"^[A-Za-z]:[\\/]", path):
        add("图片必须使用相对路径：%s" % path, "absolute")
        return result
    parsed = urlparse(path)
    if parsed.scheme:
        add("仅支持本地相对图片路径：%s" % path, "remote")
        return result
    extension = os.path.splitext(path)[1].lower()
    if extension not in _ALLOWED_IMAGE_EXTENSIONS:
        add("图片仅支持 PNG / JPG：%s" % path, "format")
        return result
    resolved = resolve_image_path(path, base_dir)
    if resolved and not _is_inside_base(resolved, base_dir):
        add("图片路径不能超出 Markdown 所在目录：%s" % path, "outside-base")
        return result
    if check_images and (not resolved or not os.path.isfile(resolved)):
        add("图片不存在：%s" % path, "missing")
    elif check_images and resolved:
        try:
            with Image.open(resolved) as image_obj:
                image_format = (image_obj.format or "").upper()
            if image_format not in ("PNG", "JPEG"):
                add("图片内容必须是 PNG / JPG：%s" % path, "content")
        except Exception:
            add("无法读取图片：%s" % path, "invalid")
    return result


def validate_document(
    doc: Document,
    template_config: Optional[Dict[str, Any]] = None,
    check_images: bool = True,
    allow_raw_tex: Optional[bool] = None,
) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = list(doc.issues)
    trusted_tex = raw_tex_allowed(allow_raw_tex)
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
        # Trusted local files keep the legacy diagnostic. Web/AI input never
        # emits arbitrary math TeX: the renderer applies the allowlisted subset.
        if block.type == "math_block":
            source = block.text or ""
            if trusted_tex:
                dangerous = _DANGEROUS_TEX_RE.search(_tex_without_comments(source))
                if dangerous:
                    issues.append(
                        _issue(
                            "error",
                            "公式包含不允许的命令：\\%s" % dangerous.group(0).lstrip("\\"),
                            block.line,
                            "math-dangerous",
                        )
                    )
            elif sanitize_math(source) != source.strip():
                issues.append(
                    _issue(
                        "warning",
                        "公式包含 Web/AI 受限数学语法之外的内容，将按原文显示",
                        block.line,
                        "math-sanitized",
                    )
                )
        for inline in block.inlines or ():
            if inline.type == "math":
                source = inline.text or ""
                if trusted_tex:
                    dangerous = _DANGEROUS_TEX_RE.search(_tex_without_comments(source))
                    if dangerous:
                        issues.append(
                            _issue(
                                "error",
                                "行内公式包含不允许的命令：\\%s" % dangerous.group(0).lstrip("\\"),
                                block.line,
                                "math-dangerous",
                            )
                        )
                elif sanitize_math(source) != source.strip():
                    issues.append(
                        _issue(
                            "warning",
                            "行内公式包含 Web/AI 受限数学语法之外的内容，将按原文显示",
                            block.line,
                            "math-sanitized",
                        )
                    )
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
            issues.extend(_image_reference_issues(path, doc.base_dir, block.line, check_images, "error", "image"))
            width = str(image.get("width") or "")
            if width and not _WIDTH_RE.match(width) and not re.match(r"^\d+(?:\.\d+)?$", width):
                issues.append(_issue("warning", "无法识别的图片宽度：%s，将使用默认宽度" % width, block.line, "image-width"))
            align = str(image.get("align") or "").lower()
            if align and align not in ("left", "center", "right"):
                issues.append(_issue("warning", "无法识别的图片对齐：%s，将居中" % align, block.line, "image-align"))
        if block.type == "latex_figure":
            if not (block.text or "").strip():
                issues.append(_issue("error", "LaTeX 图表代码为空", block.line, "latex-figure-empty"))
            if not trusted_tex:
                issues.append(
                    _issue(
                        "error",
                        "Web/AI 输入禁用原始 TeX 图表；请使用 Markdown 图片或受限绘图 DSL",
                        block.line,
                        "latex-figure-disabled",
                    )
                )
            else:
                dangerous = _DANGEROUS_TEX_RE.search(_tex_without_comments(block.text or ""))
                if dangerous:
                    issues.append(
                        _issue(
                            "error",
                            "LaTeX 图表包含不允许的命令：\\%s" % dangerous.group(0).lstrip("\\"),
                            block.line,
                            "latex-figure-dangerous",
                        )
                    )
            fallback = (block.image or {}).get("path") if block.image else ""
            if fallback:
                fallback_issues = _image_reference_issues(
                    str(fallback), doc.base_dir, block.line, check_images, "warning", "latex-fallback"
                )
                for item in fallback_issues:
                    if item.get("code") in (
                        "latex-fallback-absolute",
                        "latex-fallback-remote",
                        "latex-fallback-outside-base",
                        "latex-fallback-format",
                        "latex-fallback-invalid",
                    ):
                        item["level"] = "error"
                issues.extend(fallback_issues)
    return issues


def has_errors(issues: List[Dict[str, Any]]) -> bool:
    return any(item.get("level") == "error" for item in issues)


def strict_failure(issues: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for item in issues:
        if item.get("level") == "error":
            return item
    return None
