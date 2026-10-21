from pathlib import Path

import pytest
from docx import Document as open_docx

from mdforge.compiler import compile_tex, find_miktex_bin
from mdforge.docx_renderer import render_docx
from mdforge.parser import parse_markdown
from mdforge.preview import render_preview
from mdforge.template import load_template
from mdforge.tex_renderer import render_tex

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "examples"

FULL_FIGURE = r'''---
title: LaTeX 图表
---

# 图表

```latex-figure fallback="images/pipeline.png"
\begin{figure}[htbp]\centering
\begin{tikzpicture}
\draw (0,0) rectangle (2,1);
\end{tikzpicture}
\caption{测试 \& 图表}
\end{figure}
```

正文。
'''

INNER_FIGURE = r'''---
title: 内部图表
---

# 图表

```latex-figure caption="内部图表"
\begin{tikzpicture}
\draw (0,0) rectangle (2,1);
\end{tikzpicture}
```
'''


def test_parser_latex_figure():
    doc = parse_markdown(FULL_FIGURE, "figure.md", base_dir=str(EXAMPLES))
    block = doc.blocks[1]
    assert block.type == "latex_figure"
    assert block.caption == "测试 & 图表"
    assert block.image["path"] == "images/pipeline.png"
    assert "\\caption{测试 \\& 图表}" in block.text
    preview = render_preview(doc)
    assert "latex-badge" in preview
    assert 'data-image-path="images/pipeline.png"' in preview


def test_tex_latex_figure_full_and_inner(tmp_path):
    template = load_template("tex", "academic")
    full = parse_markdown(FULL_FIGURE, "figure.md", base_dir=str(EXAMPLES))
    full_tex = render_tex(full, template, str(tmp_path / "full.tex"))["tex"]
    assert "\\begin{figure}[htbp]" in full_tex
    assert "\\draw (0,0) rectangle (2,1);" in full_tex
    assert "\\includegraphics" not in full_tex

    inner = parse_markdown(INNER_FIGURE, "inner.md", base_dir=str(tmp_path))
    inner_tex = render_tex(inner, template, str(tmp_path / "inner.tex"))["tex"]
    assert "\\begin{figure}[htbp]" in inner_tex
    assert "\\begin{tikzpicture}" in inner_tex
    assert "\\caption{内部图表}" in inner_tex


def test_docx_latex_figure_fallback_and_placeholder(tmp_path):
    template = load_template("docx", "academic")
    with_fallback = parse_markdown(FULL_FIGURE, "figure.md", base_dir=str(EXAMPLES))
    output = tmp_path / "figure.docx"
    render_docx(with_fallback, template, str(output))
    doc = open_docx(str(output))
    assert len(doc.inline_shapes) == 1
    captions = [p.text for p in doc.paragraphs if p.style.name == "ZEN Caption"]
    assert any(text.startswith("图 1") and "测试 & 图表" in text for text in captions)

    no_fallback = parse_markdown(INNER_FIGURE, "inner.md", base_dir=str(tmp_path))
    no_fallback.metadata["title"] = "无回退图"
    output2 = tmp_path / "inner.docx"
    render_docx(no_fallback, template, str(output2))
    doc2 = open_docx(str(output2))
    assert len(doc2.inline_shapes) == 0
    assert any("DOCX 占位" in p.text for p in doc2.paragraphs)
    assert any(issue["code"] == "latex-figure-docx" for issue in no_fallback.issues)


@pytest.mark.skipif(not find_miktex_bin(), reason="需要本机 MiKTeX")
def test_latex_figure_compiles(tmp_path):
    source = r'''---
title: LaTeX 图表编译
---

# 图表

```latex-figure
\begin{figure}[htbp]\centering
\begin{tikzpicture}
\begin{axis}[cixi,width=8cm,height=5cm]
\addplot coordinates {(1,2) (2,3) (3,4)};
\end{axis}
\end{tikzpicture}
\caption{测试图表}
\end{figure}
```
'''
    document = parse_markdown(source, "compile-figure.md", base_dir=str(tmp_path))
    template = load_template("tex", "academic")
    output = tmp_path / "compile-figure.tex"
    render_tex(document, template, str(output))
    result = compile_tex(str(output), engine="xelatex", timeout=300)
    assert result["ok"] is True
    assert Path(result["pdf"]).is_file()


def test_latex_fallback_outside_base_is_error(tmp_path):
    from mdforge.validate import validate_document

    base = tmp_path / "base"
    base.mkdir()
    outside = tmp_path / "secret.png"
    outside.write_bytes((EXAMPLES / "images" / "pipeline.png").read_bytes())
    source = r"""---
title: T
---

```latex-figure fallback="../secret.png"
\begin{figure}\centering\rule{2cm}{1cm}\caption{X}\end{figure}
```
"""
    document = parse_markdown(source, "fallback.md", base_dir=str(base))
    issues = validate_document(document, check_images=False)
    assert any(issue["code"] == "latex-fallback-outside-base" and issue["level"] == "error" for issue in issues)


def test_dangerous_latex_figure_commands_are_rejected():
    from mdforge.validate import validate_document

    source = r"""---
title: T
---

```latex-figure
\begin{figure}\centering\input{secret}\caption{X}\end{figure}
```
"""
    document = parse_markdown(source, "danger.md")
    issues = validate_document(document, check_images=False)
    assert any(issue["code"] == "latex-figure-dangerous" and issue["level"] == "error" for issue in issues)
