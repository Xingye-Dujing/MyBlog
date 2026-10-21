from pathlib import Path

import pytest

from mdforge.compiler import compile_tex, find_miktex_bin
from mdforge.parser import parse_markdown
from mdforge.template import load_template
from mdforge.tex_renderer import render_tex

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = ROOT / "examples" / "sample.md"


def test_tex_source():
    source = SAMPLE.read_text(encoding="utf-8")
    document = parse_markdown(source, "sample.md", base_dir=str(ROOT / "examples"))
    template = load_template("tex", "academic")
    result = render_tex(document, template, None)
    tex = result["tex"]
    assert "\\documentclass[a4paper]{article}" in tex
    assert "\\setCJKmainfont{FangSong}[AutoFakeBold=2.0]" in tex
    assert "\\setcounter{secnumdepth}{-1}" in tex
    assert "\\section{引言}" in tex
    assert "\\subsection{管线设计}" not in tex
    assert "\\subsection{共享解析层}" in tex
    assert "\\begin{tabularx}{\\textwidth}" in tex
    assert "\\includegraphics[width=12cm]{document-assets/images/img01.png}" in tex
    assert "\\begin{thebibliography}{99}" in tex
    assert "\\mdinlinecode{Block}" in tex
    assert "\\[ \na^2" not in tex
    assert "{\\bfseries 摘要：}" in tex
    assert "{\\bfseries 关键词：}" in tex


@pytest.mark.skipif(not find_miktex_bin(), reason="需要本机 MiKTeX")
def test_tex_compiles(tmp_path):
    source = """---
title: 编译测试
abstract: 这是一段摘要。
keywords: [测试, TeX]
---

# 引言

正文包含 **加粗**、行内公式 $a^2+b^2=c^2$ 与图片说明。

$$
\\frac{a}{b} = c
$$

| 列一 | 列二 |
| --- | --- |
| 1 | 2 |

# 参考文献

测试文献.
"""
    document = parse_markdown(source, "compile.md", base_dir=str(tmp_path))
    template = load_template("tex", "academic")
    output = tmp_path / "compile.tex"
    render_tex(document, template, str(output))
    result = compile_tex(str(output), engine="xelatex", timeout=300)
    assert result["ok"] is True
    assert Path(result["pdf"]).is_file()


def test_tex_assets_are_per_output(tmp_path):
    source = SAMPLE.read_text(encoding="utf-8")
    document = parse_markdown(source, "sample.md", base_dir=str(ROOT / "examples"))
    template = load_template("tex", "academic")
    one = tmp_path / "one.tex"
    two = tmp_path / "two.tex"
    first = render_tex(document, template, str(one))
    second = render_tex(document, template, str(two))
    assert "one-assets/images/img01.png" in first["tex"]
    assert "two-assets/images/img01.png" in second["tex"]
    assert (tmp_path / "one-assets" / "images" / "img01.png").is_file()
    assert (tmp_path / "two-assets" / "images" / "img01.png").is_file()
    assert first["asset_dir"] != second["asset_dir"]


def test_tex_ordered_list_start():
    document = parse_markdown("---\ntitle: T\n---\n\n3. 三\n4. 四\n")
    template = load_template("tex", "academic")
    tex = render_tex(document, template, None)["tex"]
    assert r"\begin{enumerate}[start=3]" in tex
