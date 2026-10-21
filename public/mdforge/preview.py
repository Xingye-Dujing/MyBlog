"""HTML preview and statistics for the web console."""
from __future__ import annotations

import html
import math
import re
from typing import Any, Dict, List
from urllib.parse import urlparse

from .models import Block, Document, Inline, plain_text

_CJK_RE = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
_WORD_RE = re.compile(r"[A-Za-z0-9_]+")


def _safe_url(url: str) -> str:
    url = (url or "").strip()
    parsed = urlparse(url)
    if parsed.scheme in ("http", "https", "mailto") or url.startswith("#") or url.startswith("/"):
        return html.escape(url, quote=True)
    return "#"


def inline_html(inlines: List[Inline]) -> str:
    parts: List[str] = []
    for item in inlines:
        if item.type == "text":
            parts.append(html.escape(item.text))
        elif item.type == "strong":
            parts.append("<strong>%s</strong>" % inline_html(item.children))
        elif item.type == "em":
            parts.append("<em>%s</em>" % inline_html(item.children))
        elif item.type == "strike":
            parts.append("<del>%s</del>" % inline_html(item.children))
        elif item.type == "code":
            parts.append("<code>%s</code>" % html.escape(item.text))
        elif item.type == "link":
            parts.append('<a href="%s" target="_blank" rel="noopener">%s</a>' % (_safe_url(item.url), inline_html(item.children)))
        elif item.type == "math":
            parts.append('<span class="math">%s</span>' % html.escape(item.text))
        elif item.type == "break":
            parts.append("<br>")
        else:
            parts.append(inline_html(item.children))
    return "".join(parts)


def _block_html(block: Block) -> str:
    if block.type == "heading":
        level = max(1, min(4, block.level))
        return "<h%d>%s</h%d>" % (level, inline_html(block.inlines), level)
    if block.type == "paragraph":
        return "<p>%s</p>" % inline_html(block.inlines)
    if block.type == "list":
        return _list_html(block)
    if block.type == "code_block":
        return '<pre><code data-lang="%s">%s</code></pre>' % (html.escape(block.lang), html.escape(block.text.rstrip("\n")))
    if block.type == "quote":
        return "<blockquote><p>%s</p></blockquote>" % inline_html(block.inlines)
    if block.type == "table":
        return _table_html(block)
    if block.type == "image":
        image = block.image or {}
        path = html.escape(str(image.get("path") or ""), quote=True)
        caption = html.escape(str(block.caption or image.get("alt") or ""))
        body = '<div class="img-placeholder"><span class="img-glyph">IMG</span><span class="img-path">%s</span></div>' % path
        cap = "<figcaption>%s</figcaption>" % caption if caption else ""
        return '<figure data-image-path="%s">%s%s</figure>' % (path, body, cap)
    if block.type == "latex_figure":
        image = block.image or {}
        path = str(image.get("path") or "")
        safe_path = html.escape(path, quote=True)
        caption = html.escape(str(block.caption or image.get("alt") or ""))
        if path:
            body = '<div class="img-placeholder"><span class="img-glyph">LATEX</span><span class="img-path">%s</span></div>' % safe_path
        else:
            body = '<div class="img-placeholder latex-placeholder"><span class="img-glyph">LATEX</span><span class="img-path">TeX 原生绘制，请在源码中编辑图表代码</span></div>'
        cap = '<figcaption><span class="latex-badge">LATEX</span>%s</figcaption>' % ((" " + caption) if caption else "")
        data_attr = ' data-image-path="%s"' % safe_path if path else ""
        return '<figure class="latex-figure"%s>%s%s</figure>' % (data_attr, body, cap)
    if block.type == "pagebreak":
        return '<div class="pagebreak"><span>PAGE BREAK</span></div>'
    if block.type == "hr":
        return "<hr>"
    if block.type == "math_block":
        return '<div class="math-block">%s</div>' % html.escape(block.text)
    if block.type == "bibliography":
        items = "".join("<p>%s</p>" % inline_html(inlines) for inlines in block.items)
        return '<section class="bibliography"><h2>参考文献</h2>%s</section>' % items
    return ""


def _list_html(block: Block) -> str:
    tag = "ol" if block.ordered else "ul"
    start_attr = ' start="%d"' % block.start if block.ordered and block.start != 1 else ""
    parts = ["<%s%s>" % (tag, start_attr)]
    for item in block.items:
        parts.append("<li>%s" % inline_html(item.inlines))
        for child in item.children:
            if child.type == "list":
                parts.append(_list_html(child))
        parts.append("</li>")
    parts.append("</%s>" % tag)
    return "".join(parts)


def _table_html(block: Block) -> str:
    if not block.rows:
        return ""
    parts = []
    if block.caption:
        parts.append('<div class="table-caption">%s</div>' % html.escape(block.caption))
    parts.append('<div class="table-wrap"><table>')
    for row_index, row in enumerate(block.rows):
        cell_tag = "th" if row_index == 0 else "td"
        parts.append("<tr>")
        for col_index, cell in enumerate(row):
            align = block.aligns[col_index] if col_index < len(block.aligns) else ""
            style = ' style="text-align:%s"' % align if align in ("left", "center", "right") else ""
            parts.append("<%s%s>%s</%s>" % (cell_tag, style, inline_html(cell), cell_tag))
        parts.append("</tr>")
    parts.append("</table></div>")
    return "".join(parts)


def render_preview(document: Document) -> str:
    metadata = document.metadata or {}
    parts: List[str] = ['<article class="preview-doc">']
    title = plain_text([Inline("text", str(metadata.get("title") or ""))]).strip()
    if title:
        parts.append('<div class="preview-title">%s</div>' % html.escape(title))
    subtitle = str(metadata.get("subtitle") or "").strip()
    if subtitle:
        parts.append('<div class="preview-subtitle">%s</div>' % html.escape(subtitle))
    abstract = metadata.get("abstract")
    if abstract:
        parts.append('<div class="preview-abstract"><span class="label">摘&nbsp;&nbsp;要：</span>%s</div>' % html.escape(str(abstract)))
    keywords = metadata.get("keywords")
    if keywords:
        if isinstance(keywords, (list, tuple)):
            keywords_text = "；".join(str(item) for item in keywords)
        else:
            keywords_text = str(keywords)
        parts.append('<div class="preview-keywords"><span class="label">关键词：</span>%s</div>' % html.escape(keywords_text))
    for block in document.blocks:
        parts.append(_block_html(block))
    parts.append("</article>")
    return "".join(parts)


def document_stats(document: Document) -> Dict[str, Any]:
    text = document.body or ""
    cjk = len(_CJK_RE.findall(text))
    words = cjk + len(_WORD_RE.findall(_CJK_RE.sub(" ", text)))
    chars = len(re.sub(r"\s+", "", text))
    counts: Dict[str, int] = {}
    for block in document.blocks:
        counts[block.type] = counts.get(block.type, 0) + 1
    headings = [b for b in document.blocks if b.type == "heading"]
    lines = 0
    for block in document.blocks:
        if block.type == "heading":
            lines += 2
        elif block.type == "paragraph":
            lines += max(1, math.ceil(len(plain_text(block.inlines)) / 38))
        elif block.type == "list":
            lines += _list_line_count(block)
        elif block.type == "code_block":
            lines += len(block.text.splitlines()) + 1
        elif block.type == "table":
            lines += len(block.rows) + 2
        elif block.type == "image":
            lines += 14
        elif block.type == "math_block":
            lines += 3
        elif block.type == "bibliography":
            lines += len(block.items) + 2
    pages = max(1, math.ceil(lines / 43))
    return {
        "words": words,
        "chars": chars,
        "blocks": len(document.blocks),
        "headings": len(headings),
        "tables": counts.get("table", 0),
        "images": counts.get("image", 0) + counts.get("latex_figure", 0),
        "latex_figures": counts.get("latex_figure", 0),
        "code_blocks": counts.get("code_block", 0),
        "lists": counts.get("list", 0),
        "references": sum(len(b.items) for b in document.blocks if b.type == "bibliography"),
        "pages": pages,
        "line_count": len(text.splitlines()) + 1,
        "types": counts,
    }


def _list_line_count(block: Block) -> int:
    total = 0
    for item in block.items:
        total += max(1, math.ceil(len(plain_text(item.inlines)) / 38))
        for child in item.children:
            if child.type == "list":
                total += _list_line_count(child)
    return total


def toc_payload(document: Document) -> List[Dict[str, Any]]:
    return [
        {"level": block.level, "title": plain_text(block.inlines).strip(), "line": block.line}
        for block in document.blocks
        if block.type == "heading"
    ]
