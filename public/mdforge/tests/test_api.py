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
        'id="convert-btn"',
        'data-action="settings"',
        "--radius",
        "var(--radius)",
    ]:
        assert marker in html
    lowered = html.lower()
    for forbidden in ["#000", "#000000", "#1a1a1a", "black", "blue", "#fff", "#ffffff"]:
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
