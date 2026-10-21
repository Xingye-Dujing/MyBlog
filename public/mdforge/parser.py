"""Markdown parser producing the shared intermediate representation."""
from __future__ import annotations

import os
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import unquote

import yaml
from markdown_it import MarkdownIt

from .errors import ValidationError
from .models import Block, Document, Inline, ListItem, plain_text

_MATH_RE = re.compile(r"(?<!\\)\$(?!\$)(.+?)(?<!\\)\$")
_ATTR_RE = re.compile(r"\{([^{}]+)\}")
_WIDTH_RE = re.compile(r"(?:^|[\s,;])(?:width|w)\s*=\s*([^\s,;}]+)", re.I)
_ALIGN_RE = re.compile(r"(?:^|[\s,;])align\s*=\s*(left|center|right)", re.I)
_PAGEBREAK_RE = re.compile(r"^\s*<!--\s*pagebreak\s*-->\s*$", re.I | re.S)
_CAPTION_RE = re.compile(r"^\s*<!--\s*caption\s*:\s*(.*?)\s*-->\s*$", re.I | re.S)
_HTML_BLOCK_RE = re.compile(r"^\s*<")
_FENCE_ATTR_RE = re.compile(r"""([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))""")
_LATEX_FIGURE_LANGS = {"latex-figure", "latex_figure", "tex-figure", "tex_figure"}


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def split_frontmatter(source: str) -> Tuple[Dict[str, Any], str, int]:
    source = source.lstrip("\ufeff")
    normalized = source.replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, normalized, 1
    closing = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() in ("---", "..."):
            closing = idx
            break
    if closing is None:
        raise ValidationError("frontmatter 缺少结束分隔符 ---", 1)
    raw = "\n".join(lines[1:closing])
    try:
        data = yaml.safe_load(raw) if raw.strip() else {}
    except yaml.YAMLError as exc:
        line = 1
        mark = getattr(exc, "problem_mark", None)
        if mark is not None:
            line = mark.line + 2
        raise ValidationError("frontmatter YAML 解析失败：%s" % str(exc).splitlines()[0], line)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ValidationError("frontmatter 必须是 YAML 映射", 1)
    body = "\n".join(lines[closing + 1 :])
    return _jsonable(data), body, closing + 2


def make_markdown() -> MarkdownIt:
    md = MarkdownIt(
        "commonmark",
        {
            "html": True,
            "linkify": False,
            "typographer": False,
            "breaks": False,
        },
    )
    md.enable("table").enable("strikethrough")
    return md


def _attrs_text(children: List[Any]) -> str:
    parts: List[str] = []
    for token in children:
        if token.type in ("text", "code_inline"):
            parts.append(token.content or "")
    return " ".join(parts).strip()


def _parse_fence_attrs(info: str) -> Dict[str, str]:
    attrs: Dict[str, str] = {}
    for match in _FENCE_ATTR_RE.finditer(info or ""):
        value = match.group(2) if match.group(2) is not None else (match.group(3) if match.group(3) is not None else match.group(4))
        attrs[match.group(1).lower()] = value
    return attrs


def _extract_tex_caption(code: str) -> str:
    match = re.search(r"\\caption(?:\[[^\]]*\])?\{", code or "")
    if not match:
        return ""
    start = match.end()
    depth = 1
    index = start
    while index < len(code):
        char = code[index]
        if char == "\\":
            index += 2
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return code[start:index].strip()
        index += 1
    return ""


def _display_tex_caption(caption: str) -> str:
    text = str(caption or "")
    text = re.sub(r"\\(?:textbf|textit|emph|textrm|textsf|underline|mbox)\{([^{}]*)\}", r"\1", text)
    replacements = {
        "\\&": "&",
        "\\%": "%",
        "\\_": "_",
        "\\#": "#",
        "\\$": "$",
        "\\{": "{",
        "\\}": "}",
        "\\textbackslash{}": "\\",
        "\\textasciitilde{}": "~",
        "\\textasciicircum{}": "^",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return text.strip()


def _decode_local_image_path(src: str) -> str:
    if not src or re.match(r"^[a-z][a-z0-9+.-]*://", src, re.I) or src.startswith("//"):
        return src
    try:
        return unquote(src)
    except Exception:
        return src


def _extract_image(children: List[Any], caption_hint: str) -> Optional[Dict[str, Any]]:
    images = [t for t in children if t.type == "image"]
    if len(images) != 1:
        return None
    image = images[0]
    extras = []
    for token in children:
        if token is image:
            continue
        if token.type in ("text", "code_inline"):
            extras.append(token.content or "")
        elif token.type in ("softbreak", "hardbreak"):
            extras.append(" ")
    extra_text = "".join(extras).strip()
    attrs: Dict[str, Any] = {}
    attr_match = _ATTR_RE.search(extra_text)
    attr_body = attr_match.group(1) if attr_match else ""
    if extra_text:
        remainder = (extra_text[: attr_match.start()] + extra_text[attr_match.end() :]).strip() if attr_match else extra_text
        if remainder:
            return None
    width = ""
    align = ""
    if attr_body:
        wm = _WIDTH_RE.search(attr_body)
        am = _ALIGN_RE.search(attr_body)
        if wm:
            width = wm.group(1)
        if am:
            align = am.group(1).lower()
    src = _decode_local_image_path(image.attrGet("src") or "")
    alt = image.content or image.attrGet("alt") or ""
    caption = caption_hint or alt
    attrs.update({"path": src, "alt": alt, "width": width, "align": align, "caption": caption})
    return attrs


def _split_math(text: str) -> List[Inline]:
    result: List[Inline] = []
    pos = 0
    for match in _MATH_RE.finditer(text):
        if match.start() > pos:
            result.append(Inline("text", text[pos : match.start()]))
        result.append(Inline("math", match.group(1).strip()))
        pos = match.end()
    if pos < len(text):
        result.append(Inline("text", text[pos:]))
    return result


def _convert_children(children: List[Any], doc: Document, line: int) -> List[Inline]:
    result: List[Inline] = []
    i = 0
    pairs = {
        "strong_open": "strong_close",
        "em_open": "em_close",
        "s_open": "s_close",
        "link_open": "link_close",
    }
    while i < len(children):
        token = children[i]
        kind = token.type
        if kind == "text":
            result.extend(_split_math(token.content or ""))
        elif kind == "code_inline":
            result.append(Inline("code", token.content or ""))
        elif kind in ("softbreak",):
            result.append(Inline("text", " "))
        elif kind in ("hardbreak",):
            result.append(Inline("break"))
        elif kind == "html_inline":
            raw = (token.content or "").strip().lower()
            if raw in ("<br>", "<br/>", "<br />"):
                result.append(Inline("break"))
            else:
                doc.add_issue("warning", "忽略不支持的行内 HTML：%s" % (token.content or "")[:40], line, "html")
        elif kind in pairs:
            close_kind = pairs[kind]
            depth = 1
            j = i + 1
            inner: List[Any] = []
            while j < len(children) and depth > 0:
                if children[j].type == kind:
                    depth += 1
                elif children[j].type == close_kind:
                    depth -= 1
                    if depth == 0:
                        break
                inner.append(children[j])
                j += 1
            converted = _convert_children(inner, doc, line)
            if kind == "strong_open":
                result.append(Inline("strong", children=converted))
            elif kind == "em_open":
                result.append(Inline("em", children=converted))
            elif kind == "s_open":
                result.append(Inline("strike", children=converted))
            else:
                url = token.attrGet("href") or ""
                result.append(Inline("link", url=url, children=converted))
            i = j + 1
            continue
        elif kind == "image":
            src = token.attrGet("src") or ""
            alt = token.content or ""
            result.append(Inline("text", alt or src))
            doc.add_issue("warning", "图片必须独占一个段落，已降级为文字", line, "image-inline")
        elif kind == "math_inline":
            result.append(Inline("math", token.content or ""))
        elif kind in ("fence", "code_block"):
            result.append(Inline("code", token.content or ""))
        i += 1
    return result


def _inline_children(inline_token: Any) -> List[Any]:
    return list(inline_token.children or []) if inline_token is not None else []


def _parse_table(tokens: List[Any], start: int, doc: Document, line_offset: int) -> Tuple[Block, int]:
    rows: List[List[List[Inline]]] = []
    aligns: List[str] = []
    current_row: Optional[List[List[Inline]]] = None
    header_rows = 0
    i = start + 1
    while i < len(tokens) and tokens[i].type != "table_close":
        token = tokens[i]
        line = (token.map[0] + line_offset) if token.map else 0
        if token.type == "thead_open":
            header_rows = 1
        elif token.type in ("tr_open",):
            current_row = []
        elif token.type in ("tr_close",):
            if current_row is not None:
                rows.append(current_row)
                current_row = None
        elif token.type in ("th_open", "td_open"):
            if token.attrs:
                style = str(token.attrs.get("style") or "")
                match = re.search(r"text-align:\s*(left|center|right)", style)
                aligns.append(match.group(1) if match else "")
            else:
                aligns.append("")
            if current_row is None:
                current_row = []
            inner = tokens[i + 1] if i + 1 < len(tokens) else None
            cells = _convert_children(_inline_children(inner), doc, line) if inner and inner.type == "inline" else []
            current_row.append(cells)
        i += 1
    col_count = max([len(r) for r in rows] + [0])
    for row in rows:
        while len(row) < col_count:
            row.append([])
    while len(aligns) < col_count:
        aligns.append("")
    return Block("table", rows=rows, aligns=aligns[:col_count], line=(tokens[start].map[0] + line_offset) if tokens[start].map else 0), i + 1


def parse_markdown(source: str, source_name: str = "untitled.md", base_dir: Optional[str] = None) -> Document:
    metadata, body, body_start = split_frontmatter(source)
    doc = Document(
        metadata=metadata,
        blocks=[],
        source_name=source_name,
        base_dir=base_dir or os.getcwd(),
        body=body,
        frontmatter=dict(metadata),
    )
    md = make_markdown()
    tokens = md.parse(body)
    line_offset = body_start - 1

    def issue(level: str, message: str, map_value: Any, code: str = ""):
        line = (map_value[0] + line_offset) if map_value else 0
        doc.add_issue(level, message, line, code)

    pending_caption = ""
    pending_caption_line = 0

    def discard_pending_caption(message: str = "题注指令未紧邻可附着的图片或表格，已忽略") -> None:
        nonlocal pending_caption
        if pending_caption:
            doc.add_issue("warning", message, pending_caption_line, "caption-orphan")
            pending_caption = ""

    list_stack: List[Dict[str, Any]] = []
    blockquote_depth = 0
    i = 0
    while i < len(tokens):
        token = tokens[i]

        if pending_caption and token.type not in ("table_open", "paragraph_open", "html_block", "fence", "code_block"):
            discard_pending_caption()

        if token.type == "blockquote_open":
            blockquote_depth += 1
            if blockquote_depth > 1:
                issue("warning", "不支持嵌套引用，已按普通引用处理", token.map, "nested-quote")
            i += 1
            continue
        if token.type == "blockquote_close":
            blockquote_depth = max(0, blockquote_depth - 1)
            i += 1
            continue

        if token.type == "table_open":
            block, i = _parse_table(tokens, i, doc, line_offset)
            if pending_caption:
                block.caption = pending_caption
                pending_caption = ""
            doc.blocks.append(block)
            continue

        if token.type == "bullet_list_open" or token.type == "ordered_list_open":
            ordered = token.type == "ordered_list_open"
            start = 1
            if ordered:
                try:
                    start = int(token.attrGet("start") or 1)
                except (TypeError, ValueError):
                    start = 1
            block = Block(
                "list",
                level=len(list_stack) + 1,
                ordered=ordered,
                start=start,
                line=(token.map[0] + line_offset) if token.map else 0,
            )
            if list_stack:
                parent = list_stack[-1].get("current_item")
                if parent is not None:
                    parent.children.append(block)
                else:
                    doc.blocks.append(block)
            else:
                doc.blocks.append(block)
            list_stack.append({"block": block, "ordered": ordered, "current_item": None})
            i += 1
            continue

        if token.type in ("bullet_list_close", "ordered_list_close"):
            if list_stack:
                list_stack.pop()
            i += 1
            continue

        if token.type == "list_item_open":
            if list_stack:
                frame = list_stack[-1]
                item = ListItem(
                    level=len(list_stack),
                    ordered=frame["ordered"],
                    marker=token.markup or "",
                    line=(token.map[0] + line_offset) if token.map else 0,
                )
                frame["block"].items.append(item)
                frame["current_item"] = item
            i += 1
            continue

        if token.type == "list_item_close":
            if list_stack:
                list_stack[-1]["current_item"] = None
            i += 1
            continue

        if token.type == "heading_open":
            level = int(token.tag[1:]) if token.tag.startswith("h") else 1
            inline = tokens[i + 1] if i + 1 < len(tokens) and tokens[i + 1].type == "inline" else None
            inlines = _convert_children(_inline_children(inline), doc, (token.map[0] + line_offset) if token.map else 0)
            if level > 4:
                issue("warning", "H%d 已降级为 H4" % level, token.map, "heading-degrade")
                level = 4
            if blockquote_depth:
                doc.blocks.append(Block("quote", level=level, inlines=inlines, line=(token.map[0] + line_offset) if token.map else 0))
            else:
                doc.blocks.append(Block("heading", level=level, inlines=inlines, line=(token.map[0] + line_offset) if token.map else 0))
            i += 3
            continue

        if token.type == "paragraph_open":
            inline = tokens[i + 1] if i + 1 < len(tokens) and tokens[i + 1].type == "inline" else None
            if inline is None:
                discard_pending_caption()
                i += 1
                continue
            raw = (inline.content or "").strip()
            math_match = re.match(r"^\$\$([\s\S]*?)\$\$$", raw)
            line = (token.map[0] + line_offset) if token.map else 0
            if math_match and not list_stack:
                discard_pending_caption()
                doc.blocks.append(Block("math_block", text=math_match.group(1).strip(), line=line))
                i += 3
                continue
            children = _inline_children(inline)
            image = _extract_image(children, pending_caption)
            if image is not None and not list_stack and not blockquote_depth:
                if pending_caption:
                    pending_caption = ""
                doc.blocks.append(Block("image", image=image, caption=image.get("caption", ""), line=line))
                i += 3
                continue
            if pending_caption:
                discard_pending_caption()
            inlines = _convert_children(children, doc, line)
            if not inlines:
                i += 3
                continue
            if list_stack and list_stack[-1]["current_item"] is not None:
                item = list_stack[-1]["current_item"]
                if item.inlines:
                    item.inlines.append(Inline("break"))
                item.inlines.extend(inlines)
                first_text = plain_text(item.inlines)
                if re.match(r"^\[[ xX]\]\s", first_text):
                    issue("warning", "不支持任务列表，已按普通列表渲染", token.map, "task-list")
            elif blockquote_depth:
                doc.blocks.append(Block("quote", inlines=inlines, line=line))
            else:
                doc.blocks.append(Block("paragraph", inlines=inlines, line=line))
            i += 3
            continue

        if token.type == "fence" or token.type == "code_block":
            info = (token.info or "").strip()
            lang = info.split()[0].lower() if info else ""
            block_line = (token.map[0] + line_offset) if token.map else 0
            if token.type == "fence" and lang in _LATEX_FIGURE_LANGS:
                attrs = _parse_fence_attrs(info)
                code = token.content or ""
                raw_caption = attrs.get("caption", "") or _extract_tex_caption(code) or pending_caption
                caption = _display_tex_caption(raw_caption)
                if pending_caption:
                    pending_caption = ""
                fallback = _decode_local_image_path(attrs.get("fallback", "").strip())
                image = None
                if fallback:
                    image = {
                        "path": fallback,
                        "alt": caption,
                        "caption": caption,
                        "width": attrs.get("width", ""),
                        "align": attrs.get("align", ""),
                    }
                doc.blocks.append(Block("latex_figure", text=code, caption=caption, image=image, line=block_line))
                i += 1
                continue
            if pending_caption:
                discard_pending_caption()
            doc.blocks.append(Block("code_block", text=token.content or "", lang=lang, line=block_line))
            i += 1
            continue

        if token.type == "hr":
            doc.blocks.append(Block("hr", line=(token.map[0] + line_offset) if token.map else 0))
            i += 1
            continue

        if token.type == "html_block":
            raw = (token.content or "").strip()
            if _PAGEBREAK_RE.match(raw):
                discard_pending_caption()
                doc.blocks.append(Block("pagebreak", line=(token.map[0] + line_offset) if token.map else 0))
            else:
                caption_match = _CAPTION_RE.match(raw)
                if caption_match:
                    if pending_caption:
                        discard_pending_caption()
                    pending_caption = caption_match.group(1).strip()
                    pending_caption_line = (token.map[0] + line_offset) if token.map else 0
                else:
                    discard_pending_caption()
                    issue("warning", "不支持 HTML 块，已忽略：%s" % raw[:60].replace("\n", " "), token.map, "html-block")
            i += 1
            continue

        if token.type in ("inline", "text"):
            i += 1
            continue

        i += 1

    if pending_caption:
        doc.add_issue("warning", "题注指令后没有可附着的表格或图片", pending_caption_line, "caption-orphan")

    _post_process(doc)
    return doc


def _flatten_list_items(block: Block) -> List[List[Inline]]:
    rows: List[List[Inline]] = []
    for item in block.items:
        rows.append(item.inlines)
        for child in item.children:
            if child.type == "list":
                rows.extend(_flatten_list_items(child))
    return rows


def _post_process(doc: Document) -> None:
    reference_titles = {"参考文献", "參考文獻", "references", "bibliography"}
    ref_index = None
    for idx, block in enumerate(doc.blocks):
        if block.type == "heading" and plain_text(block.inlines).strip().lower() in reference_titles:
            ref_index = idx
            break
    if ref_index is not None:
        items: List[List[Inline]] = []
        for block in doc.blocks[ref_index + 1 :]:
            if block.type == "paragraph":
                text = plain_text(block.inlines).strip()
                if text:
                    items.append(block.inlines)
            elif block.type == "list":
                items.extend([row for row in _flatten_list_items(block) if plain_text(row).strip()])
            else:
                doc.add_issue(
                    "error",
                    "参考文献之后只能包含文献条目，不能再出现 %s" % block.type,
                    block.line,
                    "content-after-references",
                )
        new_blocks = doc.blocks[:ref_index]
        new_blocks.append(Block("bibliography", items=items or [], line=doc.blocks[ref_index].line))
        doc.blocks = new_blocks
    refs = doc.metadata.get("references")
    if refs and not any(b.type == "bibliography" for b in doc.blocks):
        lines: List[List[Inline]] = []
        if isinstance(refs, str):
            refs = [line.strip() for line in refs.splitlines() if line.strip()]
        if isinstance(refs, list):
            for ref in refs:
                if isinstance(ref, dict):
                    text = ref.get("text") or ref.get("title") or ""
                else:
                    text = str(ref)
                if text.strip():
                    lines.append([Inline("text", text.strip())])
        if lines:
            doc.blocks.append(Block("bibliography", items=lines))

    previous_level = 0
    for block in doc.blocks:
        if block.type == "heading":
            if previous_level and block.level > previous_level + 1:
                doc.add_issue("warning", "标题层级跳级：H%d → H%d" % (previous_level, block.level), block.line, "heading-skip")
            previous_level = block.level
        if block.type == "table":
            cols = max([len(row) for row in block.rows] + [0])
            if cols > 6:
                doc.add_issue("warning", "表格有 %d 列，超过建议上限 6 列" % cols, block.line, "table-columns")
