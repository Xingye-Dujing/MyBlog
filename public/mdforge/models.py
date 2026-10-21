"""Intermediate representation shared by the DOCX and TeX renderers."""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Inline:
    type: str  # text | strong | em | strike | code | link | math | break
    text: str = ""
    url: str = ""
    children: List["Inline"] = field(default_factory=list)


@dataclass
class ListItem:
    level: int
    ordered: bool
    marker: str = ""
    inlines: List[Inline] = field(default_factory=list)
    children: List["Block"] = field(default_factory=list)
    line: int = 0


@dataclass
class Block:
    type: str
    level: int = 0
    ordered: bool = False
    start: int = 1
    text: str = ""
    lang: str = ""
    inlines: List[Inline] = field(default_factory=list)
    items: List[ListItem] = field(default_factory=list)
    rows: List[List[List[Inline]]] = field(default_factory=list)
    aligns: List[str] = field(default_factory=list)
    image: Optional[Dict[str, Any]] = None
    caption: str = ""
    line: int = 0


@dataclass
class Document:
    metadata: Dict[str, Any]
    blocks: List[Block]
    issues: List[Dict[str, Any]] = field(default_factory=list)
    source_name: str = "untitled.md"
    base_dir: Optional[str] = None
    body: str = ""
    frontmatter: Dict[str, Any] = field(default_factory=dict)

    @property
    def headings(self) -> List[Block]:
        return [b for b in self.blocks if b.type == "heading" and b.level <= 3]

    def add_issue(self, level: str, message: str, line: int = 0, code: str = ""):
        self.issues.append(
            {
                "level": level,
                "message": message,
                "line": int(line or 0),
                "code": code or level,
            }
        )


def plain_text(inlines: List[Inline]) -> str:
    parts: List[str] = []
    for item in inlines:
        if item.type in ("text", "code", "math"):
            parts.append(item.text)
        elif item.type == "break":
            parts.append(" ")
        else:
            parts.append(plain_text(item.children))
    return "".join(parts)


def iter_inlines(inlines: List[Inline]):
    for item in inlines:
        yield item
        yield from iter_inlines(item.children)
