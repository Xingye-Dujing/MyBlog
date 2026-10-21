"""LaTeX renderer matched to the reference TeX layout."""
from __future__ import annotations

import os
import re
import shutil
import tempfile
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

from .errors import RenderError, TemplateError
from .escape import escape, escape_url
from .images import resolve_tex_width
from .models import Block, Document, Inline, ListItem, plain_text
from .template import Template
from .tuning import normalize_tuning, tex_font


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "；".join(str(item) for item in value if str(item).strip())
    return str(value)


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() not in ("", "false", "0", "no", "off")
    return default


def _toc_settings(metadata: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
    toc_config = config.get("toc") or {}
    enabled: Any = toc_config.get("enabled", False)
    title: Any = toc_config.get("title") or "目录"
    levels: Any = toc_config.get("levels") or 2
    include_references: Any = toc_config.get("include_references", True)
    toc_meta = metadata.get("toc")
    if isinstance(toc_meta, dict):
        enabled = toc_meta.get("enabled", enabled)
        title = toc_meta.get("title", title)
        levels = toc_meta.get("levels", levels)
        include_references = toc_meta.get("include_references", include_references)
    elif "toc" in metadata:
        enabled = toc_meta
    title = str(metadata.get("toc_title", title) or "目录").strip() or "目录"
    levels = metadata.get("toc_levels", levels)
    include_references = metadata.get("toc_include_references", include_references)
    try:
        level_value = max(1, min(3, int(levels)))
    except (TypeError, ValueError):
        level_value = 2
    return {
        "enabled": _as_bool(enabled, False),
        "title": title,
        "levels": level_value,
        "include_references": _as_bool(include_references, True),
    }


def _strip_caption_number(text: str, kind: str) -> str:
    if not text:
        return ""
    pattern = r"^\s*(?:图|圖|表)\s*\d+\s*[：:、.\-—\s]*"
    return re.sub(pattern, "", str(text)).strip()


class TexRenderer:
    def __init__(self, document: Document, template: Template, asset_dir: str):
        self.document = document
        self.template = template
        self.config = template.config
        self.asset_dir = asset_dir
        self.asset_prefix = os.path.basename(os.path.normpath(asset_dir)) or "assets"
        self.assets: Dict[int, str] = {}

    def prepare_assets(self) -> None:
        image_dir = os.path.join(self.asset_dir, "images")
        os.makedirs(image_dir, exist_ok=True)
        counter = 0
        for block in self.document.blocks:
            if block.type != "image":
                continue
            image = block.image or {}
            source = str(image.get("path") or "")
            if not source or re.match(r"^[a-z]+://", source, re.I):
                continue
            if os.path.isabs(source):
                self.document.add_issue("error", "图片必须使用相对路径：%s" % source, block.line, "image-absolute")
                continue
            full = os.path.normpath(os.path.join(self.document.base_dir or os.getcwd(), source))
            if not os.path.isfile(full):
                self.document.add_issue("error", "图片不存在：%s" % source, block.line, "image-missing")
                continue
            counter += 1
            ext = os.path.splitext(full)[1].lower() or ".png"
            dest_name = "img%02d%s" % (counter, ext if ext in (".png", ".jpg", ".jpeg") else ".png")
            dest = os.path.join(image_dir, dest_name)
            try:
                if ext in (".png", ".jpg", ".jpeg"):
                    shutil.copy2(full, dest)
                else:
                    with Image.open(full) as image_obj:
                        converted = image_obj.convert("RGBA" if "A" in image_obj.getbands() else "RGB")
                        converted.save(dest, format="PNG")
                self.assets[id(block)] = self.asset_prefix + "/images/" + dest_name
            except Exception as exc:
                self.document.add_issue("error", "图片复制失败：%s (%s)" % (source, exc), block.line, "image-copy")

    def inlines(self, inlines: List[Inline]) -> str:
        parts: List[str] = []
        for item in inlines:
            if item.type == "text":
                parts.append(escape(item.text))
            elif item.type == "strong":
                parts.append(r"\textbf{%s}" % self.inlines(item.children))
            elif item.type == "em":
                parts.append(r"\textit{%s}" % self.inlines(item.children))
            elif item.type == "strike":
                parts.append(r"\sout{%s}" % self.inlines(item.children))
            elif item.type == "code":
                parts.append(r"\mdinlinecode{%s}" % escape(item.text))
            elif item.type == "link":
                text = self.inlines(item.children) or escape(item.url)
                parts.append(r"\href{%s}{%s}" % (escape_url(item.url), text))
            elif item.type == "math":
                parts.append("$%s$" % item.text)
            elif item.type == "break":
                parts.append(r"\\")
            else:
                parts.append(self.inlines(item.children))
        return "".join(parts)

    def blocks(self, blocks: List[Block]) -> str:
        rendered: List[str] = []
        for block in blocks:
            fragment = self.block(block)
            if fragment:
                rendered.append(fragment)
        return "\n\n".join(rendered)

    def block(self, block: Block) -> str:
        if block.type == "heading":
            level = max(1, min(4, block.level))
            commands = {1: "section", 2: "subsection", 3: "subsubsection", 4: "paragraph"}
            command = commands[level]
            return "\\%s{%s}" % (command, self.inlines(block.inlines))
        if block.type == "paragraph":
            return self.inlines(block.inlines)
        if block.type == "list":
            return self._list_block(block)
        if block.type == "code_block":
            text = block.text.rstrip("\n")
            text = text.replace(r"\end{mdcode}", r"\end {mdcode}")
            return "\\begin{mdcode}\n%s\n\\end{mdcode}" % text
        if block.type == "quote":
            return "\\begin{quote}\n%s\n\\end{quote}" % self.inlines(block.inlines)
        if block.type == "table":
            return self._table(block)
        if block.type == "image":
            return self._figure(block)
        if block.type == "latex_figure":
            return self._latex_figure(block)
        if block.type == "pagebreak":
            return r"\newpage"
        if block.type == "hr":
            return r"\par\noindent\rule{\linewidth}{0.4pt}\par"
        if block.type == "math_block":
            return "\\[\n%s\n\\]" % block.text
        if block.type == "bibliography":
            return ""
        return ""

    def _list_block(self, block: Block) -> str:
        environment = "enumerate" if block.ordered else "itemize"
        start = max(1, int(block.start or 1))
        start_option = "[start=%d]" % start if block.ordered and start != 1 else ""
        lines = ["\\begin{%s}%s" % (environment, start_option)]
        for item in block.items:
            content = self.inlines(item.inlines)
            child_fragments = []
            for child in item.children:
                if child.type == "list":
                    child_fragments.append(self._list_block(child))
            if child_fragments:
                lines.append("\\item %s\n%s" % (content, "\n".join(child_fragments)))
            else:
                lines.append("\\item %s" % content)
        lines.append("\\end{%s}" % environment)
        return "\n".join(lines)

    def _table(self, block: Block) -> str:
        rows = block.rows or []
        if not rows:
            return ""
        cols = max(len(row) for row in rows)
        if cols == 0:
            return ""
        specs = []
        for index in range(cols):
            align = block.aligns[index] if index < len(block.aligns) else ""
            if align == "center":
                specs.append(r">{\centering\arraybackslash}X")
            elif align == "right":
                specs.append(r">{\raggedleft\arraybackslash}X")
            else:
                specs.append(r">{\raggedright\arraybackslash}X")
        lines = [r"\begin{table}[htbp]\centering\footnotesize"]
        caption = _strip_caption_number(block.caption or "", "table")
        if caption:
            lines.append(r"\caption{%s}" % escape(caption))
        lines.append(r"\begin{tabularx}{\textwidth}{@{}%s@{}}" % "".join(specs))
        lines.append(r"\toprule")
        for row_index, row in enumerate(rows):
            cells = []
            for col_index in range(cols):
                cell_inlines = row[col_index] if col_index < len(row) else []
                text = self.inlines(cell_inlines).replace("\n", " ")
                if row_index == 0:
                    text = r"\textbf{%s}" % text
                cells.append(text)
            lines.append(" & ".join(cells) + r" \\")
            if row_index == 0:
                lines.append(r"\midrule")
        lines.append(r"\bottomrule")
        lines.append(r"\end{tabularx}")
        lines.append(r"\end{table}")
        return "\n".join(lines)

    def _latex_figure(self, block: Block) -> str:
        code = (block.text or "").strip()
        if not code:
            return ""
        if "\\begin{figure}" in code or "\\begin{figure*}" in code:
            return code
        lines = [r"\begin{figure}[htbp]", r"\centering", code]
        caption = _strip_caption_number(block.caption or "", "figure")
        if caption and "\\caption" not in code:
            lines.append(r"\caption{%s}" % escape(caption))
        lines.append(r"\end{figure}")
        return "\n".join(lines)

    def _figure(self, block: Block) -> str:
        image = block.image or {}
        rel = self.assets.get(id(block))
        if not rel:
            return ""
        width = resolve_tex_width(
            str(image.get("width") or ""),
            str((self.config.get("image") or {}).get("default_width") or r"0.9\textwidth"),
        )
        align = str(image.get("align") or "center").lower()
        align_cmd = r"\centering" if align == "center" else (r"\raggedleft" if align == "right" else r"\raggedright")
        lines = [r"\begin{figure}[htbp]", align_cmd]
        lines.append(r"\includegraphics[width=%s]{%s}" % (width, escape_url(rel)))
        caption = _strip_caption_number(block.caption or image.get("caption") or image.get("alt") or "", "figure")
        if caption:
            lines.append(r"\caption{%s}" % escape(caption))
        lines.append(r"\end{figure}")
        return "\n".join(lines)


def render_tex(
    document: Document,
    template: Template,
    output: Optional[str] = None,
    tuning: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if output:
        absolute_output = os.path.abspath(output)
        output_dir = os.path.dirname(absolute_output) or os.getcwd()
        stem = os.path.splitext(os.path.basename(absolute_output))[0] or "document"
    else:
        output_dir = tempfile.mkdtemp(prefix="mdforge-tex-")
        stem = "document"
    asset_dir = os.path.join(output_dir, stem + "-assets")
    renderer = TexRenderer(document, template, asset_dir)
    renderer.prepare_assets()
    body = renderer.blocks(document.blocks)
    bibliography = []
    for block in document.blocks:
        if block.type == "bibliography":
            for inlines in block.items:
                text = plain_text(inlines).strip()
                if text:
                    bibliography.append(escape(text))
    metadata = document.metadata or {}
    keywords = _as_text(metadata.get("keywords"))
    abstract = _as_text(metadata.get("abstract")).replace("\n", " ")
    toc = _toc_settings(metadata, template.config)
    tune = normalize_tuning(template.config, "tex", tuning)
    margins = tune.get("margins") or {}
    body_tuning = tune.get("body") or {}
    heading = tune.get("headings") or {}
    body_size = float(body_tuning.get("font_size") or 10.5)
    body_line = round(body_size * float(body_tuning.get("line_spacing") or 1.25), 2)
    body_font_tex = tex_font(body_tuning.get("font"), "FangSong")
    heading_font_tex = tex_font((tune.get("fonts") or {}).get("heading"), "FangSong")
    title_size = float(heading.get("title_size") or 16)
    h1_size = float(heading.get("h1_size") or 16)
    h2_size = float(heading.get("h2_size") or 10.5)
    h3_size = float(heading.get("h3_size") or 10.5)
    context = {
        "title_tex": escape(_as_text(metadata.get("title"))),
        "subtitle_tex": escape(_as_text(metadata.get("subtitle"))),
        "abstract_tex": escape(abstract),
        "keywords_tex": escape(keywords),
        "author_tex": escape(_as_text(metadata.get("author"))),
        "subject_tex": escape(_as_text(metadata.get("subject"))),
        "toc_enabled": toc["enabled"],
        "toc_title_tex": escape(toc["title"]),
        "toc_levels": toc["levels"],
        "toc_include_references": toc["include_references"],
        "margin_top": margins.get("top", 2.54),
        "margin_bottom": margins.get("bottom", 2.54),
        "margin_left": margins.get("left", 3.18),
        "margin_right": margins.get("right", 3.18),
        "body_size": body_size,
        "body_line": body_line,
        "par_indent": float(body_tuning.get("first_line_indent") or 2),
        "body_font_tex": body_font_tex,
        "heading_font_tex": heading_font_tex,
        "title_size": title_size,
        "title_line": round(title_size * 1.5, 2),
        "h1_size": h1_size,
        "h1_line": round(h1_size * 1.375, 2),
        "h2_size": h2_size,
        "h2_line": round(h2_size * 1.4286, 2),
        "h3_size": h3_size,
        "h3_line": round(h3_size * 1.4286, 2),
        "body": body,
        "bibliography": bibliography,
        "documentclass": template.config.get("documentclass") or "article",
        "classoptions": template.config.get("classoptions") or ["a4paper"],
    }
    try:
        tex_template = template.jinja_env().get_template(str(template.config.get("file") or "template.tex.j2"))
        tex = tex_template.render(**context)
    except Exception as exc:
        raise TemplateError("Jinja2 模板渲染失败：%s" % exc)
    tex = re.sub(r"\n{4,}", "\n\n\n", tex)
    if output:
        with open(output, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(tex)
    return {"tex": tex, "output": output, "asset_dir": asset_dir, "assets": renderer.assets}
