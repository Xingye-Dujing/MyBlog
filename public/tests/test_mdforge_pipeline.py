"""MdForge trust-boundary and document pipeline regressions."""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public"
if str(PUBLIC) not in sys.path:
    sys.path.insert(0, str(PUBLIC))

from mdforge import server  # noqa: E402
from mdforge.compiler import CompileError, compile_tex  # noqa: E402
from mdforge.metadata import apply_docx_metadata, core_mapping  # noqa: E402
from mdforge.parser import parse_markdown  # noqa: E402
from mdforge.template import load_template  # noqa: E402
from mdforge.tex_renderer import render_tex  # noqa: E402
from mdforge.validate import untrusted_tex, validate_document  # noqa: E402
from server import mdforge_serve  # noqa: E402


def client(monkeypatch):
    monkeypatch.setattr(server, "omm_shared", None)
    app = server.create_app(PUBLIC)
    app.config["TESTING"] = True
    return app.test_client()


@pytest.mark.parametrize(
    "headers",
    [
        {"Host": "evil.example"},
        {"Host": "127.0.0.1", "Origin": "https://evil.example"},
        {"Host": "127.0.0.1", "Origin": "http://127.0.0.1:9999"},
        {"Host": "127.0.0.1", "Sec-Fetch-Site": "cross-site"},
        {"Host": "127.0.0.1", "Origin": "http://127.0.0.1", "Sec-Fetch-Site": "cross-site"},
    ],
)
def test_independent_server_always_enforces_loopback_host_and_origin(monkeypatch, headers):
    response = client(monkeypatch).get("/api/config", headers=headers)
    assert response.status_code == 403


def test_same_origin_and_originless_clients_remain_available(monkeypatch):
    c = client(monkeypatch)
    assert c.get("/api/config", headers={"Host": "127.0.0.1", "Origin": "http://127.0.0.1"}).status_code == 200
    assert c.get("/api/config", headers={"Host": "localhost"}).status_code == 200
    response = c.post(
        "/api/convert",
        json={"markdown": "---\ntitle: T\n---\n\n正文", "format": "docx"},
        headers={"Host": "127.0.0.1"},
    )
    assert response.status_code == 200
    assert response.get_json()["ok"] is True
    multipart = c.post(
        "/api/convert",
        data={"markdown": "---\ntitle: T\n---\n\n正文", "format": "docx"},
        content_type="multipart/form-data",
        headers={"Host": "127.0.0.1", "Origin": "http://127.0.0.1"},
    )
    assert multipart.status_code == 200
    assert multipart.get_json()["ok"] is True


def test_cross_site_multipart_is_rejected_before_job_or_conversion(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("cross-site request reached job creation or conversion")

    monkeypatch.setattr(server, "_new_job", forbidden)
    monkeypatch.setattr(server, "convert_text", forbidden)
    response = client(monkeypatch).post(
        "/api/convert",
        data={"markdown": "---\ntitle: T\n---\n\n正文", "format": "docx"},
        content_type="multipart/form-data",
        headers={"Host": "127.0.0.1", "Sec-Fetch-Site": "cross-site"},
    )
    assert response.status_code == 403


@pytest.mark.parametrize(
    "payload",
    [
        r"\csname input\endcsname{secret}",
        r"\csname openin\endcsname=15=secret",
        r"^^5cinput{secret}",
    ],
)
def test_web_rejects_all_raw_latex_figures_without_regex_blacklist(payload, tmp_path):
    source = "---\ntitle: T\n---\n\n```latex-figure\n%s\n```\n" % payload
    document = parse_markdown(source, "untrusted.md", base_dir=str(tmp_path))
    issues = validate_document(document, allow_raw_tex=False, check_images=False)
    assert any(item["code"] == "latex-figure-disabled" and item["level"] == "error" for item in issues)
    assert not any(item["code"] == "latex-figure-dangerous" for item in issues)
    with untrusted_tex():
        tex = render_tex(document, load_template("tex", "academic"), str(tmp_path / "blocked.tex"))["tex"]
    assert payload not in tex
    assert "禁用原始 TeX 图表" in tex


def test_csname_canary_is_rejected_before_conversion_or_compile(monkeypatch, tmp_path):
    canary = tmp_path / "canary-secret.txt"
    canary.write_text("MDFORGE_CANARY_DO_NOT_READ", encoding="utf-8")
    source = (
        "---\ntitle: T\n---\n\n```latex-figure\n"
        + r"\begin{figure}\csname input\endcsname{%s}\end{figure}\n```\n" % canary.as_posix()
    )

    def forbidden(*_args, **_kwargs):
        raise AssertionError("raw TeX reached conversion/compiler")

    monkeypatch.setattr(server, "convert_text", forbidden)
    response = client(monkeypatch).post(
        "/api/convert",
        json={"markdown": source, "format": "tex", "compile_pdf": True, "strict": False},
        headers={"Host": "127.0.0.1"},
    )
    assert response.status_code == 400
    payload = response.get_json()
    assert any(item["code"] == "latex-figure-disabled" for item in payload["issues"])
    assert canary.read_text(encoding="utf-8") == "MDFORGE_CANARY_DO_NOT_READ"


def test_untrusted_math_uses_allowlisted_subset_and_literal_fallback(tmp_path):
    source = r"""---
title: T
---

Safe $\frac{a}{b}$ and unsafe $\csname input\endcsname{secret}$.

$$
\write18{canary}
$$
"""
    document = parse_markdown(source, "math.md", base_dir=str(tmp_path))
    template = load_template("tex", "academic")
    with untrusted_tex():
        issues = validate_document(document, template.config, check_images=False)
        tex = render_tex(document, template, str(tmp_path / "math.tex"))["tex"]
    assert any(item["code"] == "math-sanitized" for item in issues)
    assert r"\frac{a}{b}" in tex
    assert r"\csname input\endcsname" not in tex
    assert r"\write18{canary}" not in tex
    assert r"\textbackslash{}csname" in tex


def test_uploaded_raw_tex_cannot_be_recompiled(monkeypatch, tmp_path):
    canary = tmp_path / "canary.txt"
    canary.write_text("CANARY", encoding="utf-8")
    raw = rf"""\documentclass{{article}}
\begin{{document}}
\csname input\endcsname{{{canary.as_posix()}}}
\end{{document}}
"""
    c = client(monkeypatch)
    uploaded = c.post(
        "/api/meta",
        data={
            "file": (io.BytesIO(raw.encode("utf-8")), "raw.tex"),
            "template": "academic",
            "metadata": json.dumps({"title": "Raw"}),
        },
        content_type="multipart/form-data",
        headers={"Host": "127.0.0.1"},
    )
    assert uploaded.status_code == 200
    job_id = uploaded.get_json()["job_id"]

    def forbidden(*_args, **_kwargs):
        raise AssertionError("uploaded raw TeX reached compiler")

    monkeypatch.setattr(server, "compile_tex", forbidden)
    recompiled = c.post(
        "/api/jobs/%s/meta" % job_id,
        json={"metadata": {"title": "Changed"}, "recompile": True},
        headers={"Host": "127.0.0.1"},
    )
    assert recompiled.status_code == 400
    assert "不能重新编译" in recompiled.get_json()["error"]
    assert canary.read_text(encoding="utf-8") == "CANARY"


def test_generated_tex_job_is_marked_safe_for_recompile(monkeypatch):
    c = client(monkeypatch)
    converted = c.post(
        "/api/convert",
        json={"markdown": "---\ntitle: T\n---\n\n正文", "format": "tex"},
        headers={"Host": "127.0.0.1"},
    )
    assert converted.status_code == 200
    job_id = converted.get_json()["job_id"]
    calls = []

    def fake_compile(path, engine="xelatex", trusted=True):
        calls.append((path, engine, trusted))
        return {"pdf": str(Path(path).with_suffix(".pdf")), "ms": 1, "engine": engine, "log": "", "errors": []}

    monkeypatch.setattr(server, "compile_tex", fake_compile)
    response = c.post(
        "/api/jobs/%s/meta" % job_id,
        json={"metadata": {"title": "Updated"}, "recompile": True},
        headers={"Host": "127.0.0.1"},
    )
    assert response.status_code == 200
    assert calls and calls[0][2] is True


def test_compiler_refuses_untrusted_source_before_engine_lookup(monkeypatch):
    def forbidden():
        raise AssertionError("engine lookup")

    monkeypatch.setattr("mdforge.compiler.find_miktex_bin", forbidden)
    with pytest.raises(CompileError, match="不可信"):
        compile_tex("does-not-exist.tex", trusted=False)


def test_academic_core_property_mapping_is_field_to_property():
    config = load_template("docx", "academic").config
    mapping = core_mapping(config)
    assert mapping["version"] == "comments"
    assert mapping["department"] == "category"
    from docx import Document

    document = Document()
    apply_docx_metadata(document, {"version": "2.0", "department": "传播学"}, config)
    assert document.core_properties.comments == "2.0"
    assert document.core_properties.category == "传播学"


def test_standalone_launcher_only_accepts_loopback_binds():
    assert mdforge_serve.is_loopback_bind("127.0.0.1") is True
    assert mdforge_serve.is_loopback_bind("::1") is True
    assert mdforge_serve.is_loopback_bind("localhost") is True
    assert mdforge_serve.is_loopback_bind("0.0.0.0") is False
    assert mdforge_serve.is_loopback_bind("::") is False
    assert mdforge_serve.is_loopback_bind("example.com") is False
