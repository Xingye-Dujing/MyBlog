from mdforge.models import plain_text
from mdforge.parser import parse_markdown, split_frontmatter


def test_frontmatter_and_body_offset():
    source = "---\ntitle: 测试\nauthor: 作者\nkeywords: [a, b]\n---\n\n# 引言\n"
    metadata, body, line = split_frontmatter(source)
    assert metadata["title"] == "测试"
    assert metadata["keywords"] == ["a", "b"]
    assert body.startswith("\n# 引言")
    assert line == 6


def test_full_structure():
    source = """---
title: 测试文稿
author: 测试作者
abstract: 摘要
keywords: [Alpha, Beta]
---

# 一级标题

正文包含 **加粗**、*斜体*、~~删除~~、`code` 与 [链接](https://example.com)，以及行内公式 $x^2$。

- 第一项
  - 第二级
    1. 第三级

> 一段引用。

<!-- caption: 样本数据 -->
| 列一 | 列二 |
| --- | --- |
| A | B |

![示意图](images/demo.png){width=40% align=right}

<!-- pagebreak -->

$$
a^2 + b^2 = c^2
$$

# 参考文献

[1] 测试文献.
"""
    doc = parse_markdown(source, "sample.md", base_dir=".")
    types = [block.type for block in doc.blocks]
    assert types == [
        "heading",
        "paragraph",
        "list",
        "quote",
        "table",
        "image",
        "pagebreak",
        "math_block",
        "bibliography",
    ]
    paragraph = doc.blocks[1]
    assert any(item.type == "strong" for item in paragraph.inlines)
    assert any(item.type == "em" for item in paragraph.inlines)
    assert any(item.type == "strike" for item in paragraph.inlines)
    assert any(item.type == "code" for item in paragraph.inlines)
    assert any(item.type == "link" and item.url == "https://example.com" for item in paragraph.inlines)
    assert any(item.type == "math" and item.text == "x^2" for item in paragraph.inlines)
    list_block = doc.blocks[2]
    assert list_block.items[0].level == 1
    assert list_block.items[0].children[0].items[0].level == 2
    assert list_block.items[0].children[0].items[0].children[0].items[0].level == 3
    table = doc.blocks[4]
    assert table.caption == "样本数据"
    assert len(table.rows) == 2
    image = doc.blocks[5]
    assert image.image["width"] == "40%"
    assert image.image["align"] == "right"
    assert image.caption == "示意图"
    assert doc.blocks[8].type == "bibliography"
    assert plain_text(doc.blocks[8].items[0]) == "[1] 测试文献."


def test_heading_degrade_and_skip_warning():
    source = "---\ntitle: T\n---\n\n# 一级\n\n##### 五级\n"
    doc = parse_markdown(source)
    headings = [block for block in doc.blocks if block.type == "heading"]
    assert headings[-1].level == 4
    codes = {issue["code"] for issue in doc.issues}
    assert "heading-degrade" in codes
    assert "heading-skip" in codes


def test_ordered_list_nested():
    source = "---\ntitle: T\n---\n\n1. 一\n   1. 一之一\n2. 二\n"
    doc = parse_markdown(source)
    block = doc.blocks[0]
    assert block.type == "list"
    assert block.ordered is True
    assert len(block.items) == 2
    assert block.items[0].children[0].ordered is True


def test_ordered_list_start():
    doc = parse_markdown("---\ntitle: T\n---\n\n3. 三\n4. 四\n")
    block = doc.blocks[0]
    assert block.type == "list"
    assert block.start == 3


def test_image_path_and_format_validation():
    from mdforge.validate import validate_document

    absolute = parse_markdown("---\ntitle: T\n---\n\n![x](C:/secret.png)\n")
    codes = {issue["code"] for issue in validate_document(absolute, check_images=False)}
    assert "image-absolute" in codes

    outside = parse_markdown("---\ntitle: T\n---\n\n![x](../secret.png)\n", base_dir=".")
    codes = {issue["code"] for issue in validate_document(outside, check_images=False)}
    assert "image-outside-base" in codes

    wrong_format = parse_markdown("---\ntitle: T\n---\n\n![x](images/foo.webp)\n")
    codes = {issue["code"] for issue in validate_document(wrong_format, check_images=False)}
    assert "image-format" in codes


def test_image_content_validation(tmp_path):
    from mdforge.validate import validate_document

    fake = tmp_path / "fake.png"
    fake.write_bytes(b"not an image")
    doc = parse_markdown("---\ntitle: T\n---\n\n![x](fake.png)\n", base_dir=str(tmp_path))
    codes = {issue["code"] for issue in validate_document(doc, check_images=True)}
    assert "image-invalid" in codes


def test_local_image_paths_are_url_decoded():
    doc = parse_markdown(
        "---\ntitle: T\n---\n\n![x](<images/my image.png>)\n\n![y](<images/图表.png>)\n",
        "paths.md",
    )
    assert doc.blocks[0].image["path"] == "images/my image.png"
    assert doc.blocks[1].image["path"] == "images/图表.png"


def test_caption_does_not_cross_intervening_blocks():
    source = """---
title: T
---

<!-- caption: 迟到题注 -->

普通段落。

| A | B |
| --- | --- |
| 1 | 2 |
"""
    doc = parse_markdown(source, "caption.md")
    assert doc.blocks[-1].type == "table"
    assert doc.blocks[-1].caption == ""
    assert any(issue["code"] == "caption-orphan" for issue in doc.issues)


def test_content_after_references_is_an_error():
    source = """---
title: T
---

# 参考文献

文献一

# 附录

正文
"""
    doc = parse_markdown(source, "refs.md")
    assert [block.type for block in doc.blocks] == ["bibliography"]
    assert any(issue["code"] == "content-after-references" and issue["level"] == "error" for issue in doc.issues)
