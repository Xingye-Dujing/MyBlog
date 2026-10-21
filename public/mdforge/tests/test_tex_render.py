from pathlib import Path

import pytest

from mdforge.compiler import compile_tex, find_miktex_bin
from mdforge.parser import parse_markdown
from mdforge.template import load_template
from mdforge.tex_renderer import render_tex
from mdforge.tuning import normalize_tuning

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


def test_tex_toc_customization(tmp_path):
    source = r'''---
title: TeX 目录定制
toc: true
toc_title: 内容目录
toc_levels: 3
toc_include_references: true
---

# 一级

## 二级

### 三级

# 参考文献

文献一条.
'''
    document = parse_markdown(source, "toc.md", base_dir=str(tmp_path))
    template = load_template("tex", "academic")
    output = tmp_path / "toc-custom.tex"
    tex = render_tex(document, template, str(output))["tex"]
    assert r"\tableofcontents" in tex
    assert "内容目录" in tex
    assert r"\setcounter{tocdepth}{3}" in tex
    assert r"\addcontentsline{toc}{section}{参考文献}" in tex
    if find_miktex_bin():
        result = compile_tex(str(output), engine="xelatex", timeout=300)
        assert result["ok"] is True
        assert Path(result["pdf"]).is_file()


def test_tex_toc_is_off_by_default():
    source = SAMPLE.read_text(encoding="utf-8")
    document = parse_markdown(source, "sample.md", base_dir=str(ROOT / "examples"))
    tex = render_tex(document, load_template("tex", "academic"), None)["tex"]
    assert r"\tableofcontents" not in tex


def test_tuning_export_wrapper_is_unwrapped():
    tuning = normalize_tuning(
        {},
        "tex",
        {"kind": "format-tuning", "format": "tex", "tuning": {"body": {"font_size": 14}}},
    )
    assert tuning["body"]["font_size"] == 14
    assert tuning["body"]["font"] == "fangsong"
    assert tuning["headings"]["h1_size"] == 16


@pytest.mark.skipif(not find_miktex_bin(), reason="需要本机 MiKTeX")
def test_tex_asset_directory_supports_spaces(tmp_path):
    source = SAMPLE.read_text(encoding="utf-8")
    document = parse_markdown(source, "sample.md", base_dir=str(ROOT / "examples"))
    template = load_template("tex", "academic")
    output = tmp_path / "my paper.tex"
    result = render_tex(document, template, str(output))
    assert "%20" not in result["tex"]
    assert r"my\_paper-" in result["tex"]
    assert Path(result["asset_dir"]).is_dir()
    assert compile_tex(str(output), engine="xelatex", timeout=300)["ok"] is True


@pytest.mark.skipif(not find_miktex_bin(), reason="需要本机 MiKTeX")
def test_failed_recompile_does_not_return_stale_pdf(tmp_path):
    source = "---\ntitle: T\nauthor: A\n---\n\n# H\n\nBody.\n"
    document = parse_markdown(source, "stale.md", base_dir=str(tmp_path))
    output = tmp_path / "stale.tex"
    render_tex(document, load_template("tex", "academic"), str(output))
    compile_tex(str(output), engine="xelatex", timeout=300)
    broken = output.read_text(encoding="utf-8").replace(
        r"\end{document}", r"\undefinedcommandforaudit" + "\n" + r"\end{document}"
    )
    output.write_text(broken, encoding="utf-8")
    with pytest.raises(Exception):
        compile_tex(str(output), engine="xelatex", timeout=300)
    assert not (tmp_path / "build" / "stale.pdf").is_file()


def test_tuning_malformed_sections_fall_back():
    tuning = normalize_tuning({}, "docx", {"body": "oops", "margins": [1]})
    assert tuning["body"]["font_size"] == 10.5
    assert tuning["margins"]["top"] == 2.54


@pytest.mark.skipif(not find_miktex_bin(), reason="需要本机 MiKTeX")
def test_tex_shell_escape_is_disabled(tmp_path):
    source = r"""\documentclass{article}
\begin{document}
Shell escape probe.
\immediate\write18{echo audit > shell.txt}
\end{document}
"""
    output = tmp_path / "shell.tex"
    output.write_text(source, encoding="utf-8")
    compile_tex(str(output), engine="xelatex", timeout=300)
    assert not (tmp_path / "shell.txt").is_file()
