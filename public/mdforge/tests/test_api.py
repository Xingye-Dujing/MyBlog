import io
import json
import zipfile
from pathlib import Path

from docx import Document as open_docx

from mdforge.server import create_app


ROOT = Path(__file__).resolve().parents[2]
SAMPLE = ROOT / "examples" / "sample.md"
IMAGE = ROOT / "examples" / "images" / "pipeline.png"


def client():
    app = create_app()
    app.config["TESTING"] = True
    return app.test_client()


def test_api_parse_and_validate():
    c = client()
    source = SAMPLE.read_text(encoding="utf-8")
    response = c.post("/api/parse", json={"markdown": source, "format": "docx", "template": "academic"})
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["metadata"]["title"] == "从文本到版式"
    assert payload["stats"]["tables"] == 1
    assert "preview_html" in payload and "preview-title" in payload["preview_html"]
    response = c.post("/api/validate", json={"markdown": source, "format": "tex", "template": "academic"})
    assert response.status_code == 200
    assert response.get_json()["ok"] is True


def test_api_convert_docx_with_image():
    c = client()
    source = SAMPLE.read_text(encoding="utf-8")
    data = {
        "markdown": source,
        "filename": "sample.md",
        "format": "docx",
        "template": "academic",
        "metadata": json.dumps({}),
        "images": (io.BytesIO(IMAGE.read_bytes()), "pipeline.png"),
    }
    response = c.post("/api/convert", data=data, content_type="multipart/form-data")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["filename"].endswith(".docx")
    download = c.get(payload["download_url"])
    assert download.status_code == 200
    assert download.data[:2] == b"PK"


def test_api_convert_tex():
    c = client()
    source = SAMPLE.read_text(encoding="utf-8")
    data = {
        "markdown": source,
        "filename": "sample.md",
        "format": "tex",
        "template": "academic",
        "images": (io.BytesIO(IMAGE.read_bytes()), "pipeline.png"),
    }
    response = c.post("/api/convert", data=data, content_type="multipart/form-data")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert "\\documentclass" in payload["tex"]
    assert c.get(payload["download_url"]).status_code == 200


def test_api_convert_tex_with_format_overrides():
    c = client()
    source = "---\ntitle: 测试\nauthor: 作者\n---\n\n# 标题\n\n正文。\n"
    tuning = {
        "margins": {"top": 3.0, "bottom": 2.0, "left": 2.5, "right": 2.5},
        "body": {"font_size": 12, "line_spacing": 1.8, "first_line_indent": 3, "font": "kaiti"},
        "fonts": {"heading": "heiti"},
        "headings": {"title_size": 20, "h1_size": 16, "h2_size": 14, "h3_size": 12},
    }
    response = c.post(
        "/api/convert",
        json={
            "markdown": source,
            "filename": "tuned.tex",
            "format": "tex",
            "template": "academic",
            "format_overrides": tuning,
        },
    )
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    tex = payload["tex"]
    assert "left=2.5cm,right=2.5cm,top=3.0cm,bottom=2.0cm" in tex
    assert "\\setCJKmainfont{KaiTi}" in tex
    assert "\\setCJKfamilyfont{mdforgeheading}{SimHei}" in tex
    assert "\\fontsize{ 12.0 }{ 21.6 }" in tex
    assert "\\setlength{\\parindent}{ 3.0em}" in tex
    assert "\\titleformat{\\section}[block]{\\normalfont\\mdheadingfont\\bfseries\\fontsize{ 16.0 }" in tex


def test_api_convert_docx_with_format_overrides(tmp_path):
    c = client()
    source = SAMPLE.read_text(encoding="utf-8")
    tuning = {
        "margins": {"top": 3.0, "bottom": 2.0, "left": 2.5, "right": 2.5},
        "body": {"font_size": 12, "line_spacing": 1.8, "first_line_indent": 3, "font": "kaiti"},
        "fonts": {"heading": "heiti"},
        "headings": {"title_size": 20, "h1_size": 16, "h2_size": 14, "h3_size": 12},
    }
    response = c.post(
        "/api/convert",
        data={
            "markdown": source,
            "filename": "tuned.docx",
            "format": "docx",
            "template": "academic",
            "images": (io.BytesIO(IMAGE.read_bytes()), "pipeline.png"),
            "format_overrides": json.dumps(tuning),
        },
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    target = tmp_path / "tuned.docx"
    target.write_bytes(c.get(payload["download_url"]).data)
    doc = open_docx(str(target))
    section = doc.sections[0]
    assert round(section.top_margin.cm, 2) == 3.0
    assert round(section.bottom_margin.cm, 2) == 2.0
    assert round(section.left_margin.cm, 2) == 2.5
    body = doc.styles["ZEN Body"]
    assert body.font.size.pt == 12
    assert body.paragraph_format.line_spacing == 1.8
    assert round(body.paragraph_format.first_line_indent.pt, 1) == 36.0
    assert doc.styles["Heading 1"].font.size.pt == 16
    assert doc.styles["ZEN Title"].font.size.pt == 20


def test_api_missing_title():
    c = client()
    response = c.post("/api/convert", json={"markdown": "---\ntitle: ''\n---\n\n正文", "format": "docx"})
    assert response.status_code == 400
    payload = response.get_json()
    assert payload["ok"] is False
    assert any(issue.get("code") == "metadata-required" for issue in payload["issues"])


def test_frontend_contract():
    html = (ROOT / "omm-mdforge.html").read_text(encoding="utf-8")
    for marker in [
        'id="top-menu"',
        'id="status-bar"',
        'id="opt-strict"',
        'id="opt-toc"',
        'id="opt-toc-title"',
        'id="opt-toc-levels"',
        'id="opt-toc-refs"',
        'id="convert-btn"',
        'data-tab="tuning"',
        'id="tuning-context"',
        'id="tuning-file"',
        'data-action="tuning-export"',
        'data-action="tuning-import"',
        'data-action="tuning-reset"',
        'data-tune="body.font_size"',
        'data-tune="margins.top"',
        'format_overrides',
        'mdforge.tuning.v1',
        '--pv-body-size',
        'data-action="settings"',
        'data-ai-spec-kind="figure"',
        "--radius",
        "var(--radius)",
    ]:
        assert marker in html
    lowered = html.lower()
    assert "--bg: #ffffff" in lowered
    assert "--bg: #1a1a1a" in lowered
    assert "--active-bg: #1a1a1a" in lowered
    assert "--active-bg: #e8e8e8" in lowered
    for forbidden in ["blue", "#0000ff", "#657047", "#525c38", "#a9b27f", "#bcc594", "olive"]:
        assert forbidden not in lowered


def test_job_metadata_edit(tmp_path):
    c = client()
    source = SAMPLE.read_text(encoding="utf-8")
    data = {
        "markdown": source,
        "filename": "meta.md",
        "format": "docx",
        "template": "academic",
        "images": (io.BytesIO(IMAGE.read_bytes()), "pipeline.png"),
    }
    response = c.post("/api/convert", data=data, content_type="multipart/form-data")
    payload = response.get_json()
    assert response.status_code == 200 and payload["ok"] is True
    job_id = payload["job_id"]
    edited = c.post(
        "/api/jobs/%s/meta" % job_id,
        json={"metadata": {"title": "新属性标题", "author": "李四"}},
    )
    assert edited.status_code == 200
    assert edited.get_json()["ok"] is True
    downloaded = c.get(edited.get_json()["download_url"])
    target = tmp_path / "edited.docx"
    target.write_bytes(downloaded.data)
    doc = open_docx(str(target))
    assert doc.core_properties.title == "新属性标题"
    assert doc.core_properties.author == "李四"
    assert doc.core_properties.keywords


def test_job_metadata_edit_tex_without_recompile():
    c = client()
    source = SAMPLE.read_text(encoding="utf-8")
    data = {
        "markdown": source,
        "filename": "meta.md",
        "format": "tex",
        "template": "academic",
        "images": (io.BytesIO(IMAGE.read_bytes()), "pipeline.png"),
    }
    response = c.post("/api/convert", data=data, content_type="multipart/form-data")
    payload = response.get_json()
    job_id = payload["job_id"]
    edited = c.post(
        "/api/jobs/%s/meta" % job_id,
        json={"metadata": {"title": "新 PDF 标题"}, "recompile": False},
    )
    edited_payload = edited.get_json()
    assert edited.status_code == 200
    assert edited_payload["pdf_url"] is None
    tex = c.get(edited_payload["download_url"]).data.decode("utf-8")
    assert "pdftitle={新 PDF 标题}" in tex


def test_md_spec_endpoint():
    c = client()
    response = c.get("/api/md-spec")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert "AI_MD_SPEC" in payload["filename"]
    assert "frontmatter" in payload["content"].lower()


def test_tex_bundle_contains_source_and_assets():
    c = client()
    source = SAMPLE.read_text(encoding="utf-8")
    data = {
        "markdown": source,
        "filename": "sample.md",
        "format": "tex",
        "template": "academic",
        "images": (io.BytesIO(IMAGE.read_bytes()), "pipeline.png"),
    }
    response = c.post("/api/convert", data=data, content_type="multipart/form-data")
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["bundle_url"]
    bundle = c.get(payload["bundle_url"])
    assert bundle.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(bundle.data))
    names = set(archive.namelist())
    assert "sample.tex" in names
    assert "sample-assets/images/img01.png" in names
    assert "README-MdForge.txt" in names


def test_figure_spec_endpoint():
    c = client()
    response = c.get("/api/figure-spec")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["filename"] == "AI_LATEX_FIGURE_SPEC.md"
    assert "latex-figure" in payload["content"]
    assert "pgfplots" in payload["content"]


def test_toc_template_defaults():
    c = client()
    docx = c.get("/api/templates/docx/academic").get_json()["template"]["toc"]
    tex = c.get("/api/templates/tex/academic").get_json()["template"]["toc"]
    assert docx["enabled"] is True
    assert docx["include_references"] is True
    assert tex["enabled"] is False
    assert tex["levels"] == 2


def test_tuning_template_defaults():
    c = client()
    docx = c.get("/api/templates/docx/academic").get_json()["template"]["tuning"]
    tex = c.get("/api/templates/tex/academic").get_json()["template"]["tuning"]
    assert docx["body"] == {
        "font_size": 10.5,
        "line_spacing": 1.5,
        "first_line_indent": 2,
        "font": "songti",
    }
    assert docx["fonts"]["heading"] == "heiti"
    assert tex["body"]["font"] == "fangsong"
    assert tex["fonts"]["heading"] == "fangsong"
    assert tex["margins"]["left"] == 3.18
