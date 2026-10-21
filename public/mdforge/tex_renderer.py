"""LaTeX renderer matched to the reference TeX layout."""
from __future__ import annotations

import os
import re
import shutil
import tempfile
from typing import Any, Dict, List, Optional, Tuple

from .errors import RenderError, TemplateError
from .escape import escape, escape_url
from .images import resolve_tex_width
from .models import Block, Document, Inline, ListItem, plain_text
from .template import Template


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "；".join(str(item) for item in value if str(item).strip())
    return str(value)


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
            full = source
            if not os.path.isabs(full):
                full = os.path.normpath(os.path.join(self.document.base_dir or os.getcwd(), source))
            if not os.path.isfile(full):
                self.document.add_issue("error", "图片不存在：%s" % source, block.line, "image-missing")
                continue
            counter += 1
            ext = os.path.splitext(full)[1].lower() or ".png"
            if ext not in (".png", ".jpg", ".jpeg", ".pdf", ".eps"):
                ext = ".png"
            dest_name = "img%02d%s" % (counter, ext)
            dest = os.path.join(image_dir, dest_name)
            try:
                shutil.copy2(full, dest)
                self.assets[id(block)] = "images/" + dest_name
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
        lines = ["\\begin{%s}" % environment]
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


def render_tex(document: Document, template: Template, output: Optional[str] = None) -> Dict[str, Any]:
    if output:
        output_dir = os.path.dirname(os.path.abspath(output)) or os.getcwd()
    else:
        output_dir = tempfile.mkdtemp(prefix="mdforge-tex-")
    renderer = TexRenderer(document, template, output_dir)
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
    context = {
        "title_tex": escape(_as_text(metadata.get("title"))),
        "subtitle_tex": escape(_as_text(metadata.get("subtitle"))),
        "abstract_tex": escape(abstract),
        "keywords_tex": escape(keywords),
        "author_tex": escape(_as_text(metadata.get("author"))),
        "subject_tex": escape(_as_text(metadata.get("subject"))),
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
    return {"tex": tex, "output": output, "asset_dir": output_dir, "assets": renderer.assets}
