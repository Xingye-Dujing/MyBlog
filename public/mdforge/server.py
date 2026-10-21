"""Flask API for the MdForge web console."""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from werkzeug.utils import secure_filename

from . import __version__
from .compiler import compile_tex, environment_info
from .convert import convert_text
from .errors import CompileError, MdForgeError, TemplateError, ValidationError
from .metadata import edit_metadata
from .models import Document
from .parser import parse_markdown
from .preview import document_stats, render_preview, toc_payload
from .template import default_template_name, list_templates, load_template
from .validate import validate_document

PUBLIC_ROOT = Path(__file__).resolve().parent.parent
FRONTEND = "omm-mdforge.html"
JOB_ROOT = Path(tempfile.gettempdir()) / "mdforge-jobs"
JOBS: Dict[str, Dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
MAX_MARKDOWN = 2 * 1024 * 1024
JOB_TTL = 24 * 3600


def _cleanup_jobs() -> None:
    now = time.time()
    with JOBS_LOCK:
        stale = [job_id for job_id, job in JOBS.items() if now - job.get("created", now) > JOB_TTL]
        for job_id in stale:
            job = JOBS.pop(job_id, None)
            if job:
                shutil.rmtree(job.get("dir", ""), ignore_errors=True)


def _new_job() -> Tuple[str, str]:
    _cleanup_jobs()
    JOB_ROOT.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4().hex[:16]
    directory = tempfile.mkdtemp(prefix=job_id + "-", dir=str(JOB_ROOT))
    with JOBS_LOCK:
        JOBS[job_id] = {"id": job_id, "dir": directory, "created": time.time(), "files": {}}
    return job_id, directory


def _job(job_id: str) -> Dict[str, Any]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job:
        abort(404, description="任务不存在或已过期")
    return job


def _safe_filename(name: str, fallback: str = "document") -> str:
    name = os.path.basename(str(name or "")).strip()
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", name)
    name = name.strip(". ")
    return (name or fallback)[:120]


def _stem(filename: str, fallback: str = "document") -> str:
    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    return _safe_filename(stem, fallback)


def _metadata_from_request() -> Dict[str, Any]:
    raw = request.form.get("metadata") or request.values.get("metadata")
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _stage_images(directory: str, source: str, uploads) -> Dict[str, str]:
    staging = os.path.join(directory, "_uploads")
    os.makedirs(staging, exist_ok=True)
    saved: Dict[str, str] = {}
    for upload in uploads or []:
        if not upload or not getattr(upload, "filename", ""):
            continue
        name = _safe_filename(upload.filename)
        if not name:
            continue
        dest = os.path.join(staging, name)
        stem, ext = os.path.splitext(dest)
        counter = 1
        while os.path.exists(dest):
            dest = "%s-%d%s" % (stem, counter, ext)
            counter += 1
        upload.save(dest)
        saved[os.path.basename(dest)] = dest
    try:
        parsed = parse_markdown(source, source_name="source.md", base_dir=directory)
    except Exception:
        parsed = None
    if parsed is not None:
        for block in parsed.blocks:
            if block.type != "image":
                continue
            raw_path = str((block.image or {}).get("path") or "")
            if not raw_path or re.match(r"^[a-z]+://", raw_path, re.I):
                continue
            relative = raw_path.replace("\\", "/").lstrip("/")
            if os.path.isabs(raw_path):
                continue
            basename = os.path.basename(relative)
            upload_path = saved.get(basename)
            if not upload_path:
                continue
            target = os.path.abspath(os.path.join(directory, relative))
            if not target.startswith(os.path.abspath(directory) + os.sep):
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            try:
                shutil.copy2(upload_path, target)
            except Exception:
                pass
    fallback_dir = os.path.join(directory, "images")
    os.makedirs(fallback_dir, exist_ok=True)
    for name, path in saved.items():
        target = os.path.join(fallback_dir, name)
        if not os.path.exists(target):
            try:
                shutil.copy2(path, target)
            except Exception:
                pass
    return saved


def _template_info(fmt: str, name: str) -> Dict[str, Any]:
    template = load_template(fmt, name)
    config = template.config
    meta = config.get("metadata") or {}
    return {
        "format": fmt,
        "name": template.name,
        "title": config.get("title") or template.name,
        "description": template.description,
        "version": template.version,
        "required": list(meta.get("required") or []),
        "optional": list(meta.get("optional") or []),
        "features": list(config.get("features") or []),
        "engine": config.get("engine") or "",
        "toc": config.get("toc") or {},
        "image": config.get("image") or {},
    }


def _parse_payload(payload: Dict[str, Any]) -> Tuple[Document, Any, Dict[str, Any]]:
    source = payload.get("markdown")
    if not isinstance(source, str):
        raise ValidationError("缺少 markdown 字段")
    if len(source.encode("utf-8")) > MAX_MARKDOWN:
        raise ValidationError("Markdown 超过 2 MB 限制")
    fmt = str(payload.get("format") or "docx")
    fmt = fmt if fmt in ("docx", "tex") else "docx"
    template_name = str(payload.get("template") or "").strip()
    document = parse_markdown(source, source_name=str(payload.get("filename") or "untitled.md"), base_dir=None)
    overrides = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    for key, value in overrides.items():
        if value is not None:
            document.metadata[key] = value
    if not template_name:
        template_name = str(document.metadata.get("template") or "").strip() or default_template_name(fmt)
    template = load_template(fmt, template_name)
    document.metadata["template"] = template_name
    issues = validate_document(document, template.config, check_images=False)
    return document, template, {"issues": issues, "format": fmt, "template": template_name}


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024
    app.config["JSON_AS_ASCII"] = False

    @app.get("/")
    @app.get("/omm-mdforge.html")
    def index():
        return send_from_directory(str(PUBLIC_ROOT), FRONTEND)

    @app.get("/icon.ico")
    def icon():
        return send_from_directory(str(PUBLIC_ROOT), "icon.ico")

    @app.get("/APL385.ttf")
    def apl_font():
        return send_from_directory(str(PUBLIC_ROOT), "APL385.ttf")

    @app.get("/api/env")
    def api_env():
        env = environment_info()
        env.update(
            {
                "ok": True,
                "app": "MdForge",
                "version": __version__,
                "python": ".".join(str(part) for part in os.sys.version_info[:3]),
                "templates": list_templates(),
            }
        )
        return jsonify(env)

    @app.get("/api/templates")
    def api_templates():
        fmt = request.args.get("format")
        return jsonify({"ok": True, "templates": list_templates(fmt)})

    @app.get("/api/templates/<fmt>/<name>")
    def api_template_detail(fmt: str, name: str):
        try:
            return jsonify({"ok": True, "template": _template_info(fmt, name)})
        except TemplateError as exc:
            return jsonify({"ok": False, "error": exc.message}), 404

    @app.get("/api/sample")
    def api_sample():
        path = PUBLIC_ROOT / "examples" / "sample.md"
        if not path.is_file():
            return jsonify({"ok": False, "error": "示例文件不存在"}), 404
        return jsonify({"ok": True, "markdown": path.read_text(encoding="utf-8"), "filename": "sample.md"})

    @app.get("/samples/<path:filename>")
    def sample_asset(filename: str):
        allowed = PUBLIC_ROOT / "examples"
        target = (allowed / filename).resolve()
        if allowed.resolve() not in target.parents or not target.is_file():
            abort(404)
        return send_from_directory(str(allowed), filename)

    @app.post("/api/parse")
    def api_parse():
        payload = request.get_json(silent=True) or {}
        try:
            document, template, info = _parse_payload(payload)
        except ValidationError as exc:
            return jsonify({"ok": False, "error": exc.message, "line": exc.line, "issues": getattr(exc, "issues", [])}), 400
        except TemplateError as exc:
            return jsonify({"ok": False, "error": exc.message, "line": exc.line}), 400
        return jsonify(
            {
                "ok": True,
                "format": info["format"],
                "template": _template_info(info["format"], info["template"]),
                "metadata": document.metadata,
                "issues": info["issues"],
                "stats": document_stats(document),
                "toc": toc_payload(document),
                "preview_html": render_preview(document),
            }
        )

    @app.post("/api/validate")
    def api_validate():
        payload = request.get_json(silent=True) or {}
        try:
            document, template, info = _parse_payload(payload)
        except (ValidationError, TemplateError) as exc:
            return jsonify({"ok": False, "error": exc.message, "line": exc.line, "issues": getattr(exc, "issues", [])}), 400
        return jsonify(
            {
                "ok": True,
                "issues": info["issues"],
                "stats": document_stats(document),
                "toc": toc_payload(document),
                "metadata": document.metadata,
                "template": _template_info(info["format"], info["template"]),
            }
        )

    @app.post("/api/convert")
    def api_convert():
        started = time.time()
        job_id, directory = _new_job()
        try:
            if request.is_json:
                payload = request.get_json(silent=True) or {}
                source = payload.get("markdown") or ""
                filename = _safe_filename(payload.get("filename") or "document.md")
                fmt = str(payload.get("format") or "docx")
                template_name = str(payload.get("template") or "").strip() or None
                overrides = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
                strict = bool(payload.get("strict"))
                compile_pdf = bool(payload.get("compile_pdf"))
                keep_anchor = bool(payload.get("keep_anchor"))
                engine = payload.get("engine")
                uploads = []
            else:
                source = request.form.get("markdown") or ""
                filename = _safe_filename(request.form.get("filename") or "document.md")
                fmt = str(request.form.get("format") or "docx")
                template_name = str(request.form.get("template") or "").strip() or None
                overrides = _metadata_from_request()
                strict = _bool(request.form.get("strict"))
                compile_pdf = _bool(request.form.get("compile_pdf"))
                keep_anchor = _bool(request.form.get("keep_anchor"))
                engine = request.form.get("engine")
                uploads = request.files.getlist("images")
            if not source.strip():
                raise ValidationError("Markdown 内容为空")
            if len(source.encode("utf-8")) > MAX_MARKDOWN:
                raise ValidationError("Markdown 超过 2 MB 限制")
            _stage_images(directory, source, uploads)
            fmt = fmt if fmt in ("docx", "tex") else "docx"
            stem = _stem(filename, "document")
            output_name = stem + ("." + fmt)
            output_path = os.path.join(directory, output_name)
            result = convert_text(
                source,
                output=output_path,
                fmt=fmt,
                template=template_name,
                base_dir=directory,
                strict=strict,
                compile_pdf=compile_pdf,
                engine=engine if isinstance(engine, str) and engine else None,
                overrides=overrides if isinstance(overrides, dict) else {},
                keep_anchor=keep_anchor,
                source_name=filename,
            )
            files = {"source": os.path.join(directory, "source-" + filename), fmt: output_path}
            with open(files["source"], "w", encoding="utf-8", newline="\n") as handle:
                handle.write(source)
            if result.get("pdf"):
                files["pdf"] = result["pdf"]
            with JOBS_LOCK:
                if job_id in JOBS:
                    JOBS[job_id]["files"] = files
                    JOBS[job_id]["output_name"] = output_name
                    JOBS[job_id]["format"] = fmt
                    JOBS[job_id]["template"] = result.get("template") or template_name or "academic"
                    JOBS[job_id]["metadata"] = result.get("metadata") or overrides
            result.update(
                {
                    "ok": True,
                    "job_id": job_id,
                    "download_url": "/api/download/%s/%s" % (job_id, fmt),
                    "source_url": "/api/download/%s/source" % job_id,
                    "pdf_url": "/api/download/%s/pdf" % job_id if result.get("pdf") else None,
                    "elapsed_ms": int((time.time() - started) * 1000),
                    "filename": output_name,
                }
            )
            return jsonify(result)
        except ValidationError as exc:
            issues = getattr(exc, "issues", [])
            return jsonify(
                {
                    "ok": False,
                    "error": exc.message,
                    "line": exc.line,
                    "issues": issues,
                    "job_id": job_id,
                    "elapsed_ms": int((time.time() - started) * 1000),
                }
            ), 400
        except TemplateError as exc:
            return jsonify({"ok": False, "error": exc.message, "line": exc.line, "job_id": job_id}), 400
        except CompileError as exc:
            return jsonify({"ok": False, "error": exc.message, "log": exc.log, "job_id": job_id}), 500
        except MdForgeError as exc:
            return jsonify({"ok": False, "error": exc.message, "line": exc.line, "job_id": job_id}), 500
        except Exception as exc:
            app.logger.exception("conversion failed")
            return jsonify({"ok": False, "error": "服务器内部错误：%s" % exc, "job_id": job_id}), 500

    @app.get("/api/download/<job_id>/<kind>")
    def api_download(job_id: str, kind: str):
        job = _job(job_id)
        files = job.get("files") or {}
        path = files.get(kind)
        if not path or not os.path.isfile(path):
            abort(404, description="文件不存在或尚未生成")
        name = job.get("output_name") or os.path.basename(path)
        if kind == "pdf":
            name = os.path.splitext(name)[0] + ".pdf"
        elif kind == "source":
            name = "source-" + (name if name.endswith(".md") else name.split(".")[0] + ".md")
        return send_file(path, as_attachment=True, download_name=name)

    @app.post("/api/meta")
    def api_meta():
        upload = request.files.get("file")
        if not upload or not upload.filename:
            return jsonify({"ok": False, "error": "请选择 DOCX 或 TEX 文件"}), 400
        name = _safe_filename(upload.filename)
        lower = name.lower()
        if not (lower.endswith(".docx") or lower.endswith(".tex")):
            return jsonify({"ok": False, "error": "仅支持 .docx 或 .tex"}), 400
        fmt = "docx" if lower.endswith(".docx") else "tex"
        template_name = str(request.form.get("template") or "").strip()
        job_id, directory = _new_job()
        source_path = os.path.join(directory, name)
        upload.save(source_path)
        try:
            updates = _metadata_from_request()
            header_raw = request.form.get("header_placeholders")
            header_placeholders = None
            if header_raw:
                try:
                    header_placeholders = json.loads(header_raw)
                except Exception:
                    header_placeholders = None
            config = {}
            if not template_name and fmt == "tex":
                template_name = "academic"
            if template_name:
                config = load_template(fmt, template_name).config
            output = edit_metadata(source_path, updates, header_placeholders=header_placeholders, output=source_path, template_config=config)
            with JOBS_LOCK:
                if job_id in JOBS:
                    JOBS[job_id]["files"] = {"docx" if fmt == "docx" else "tex": output}
                    JOBS[job_id]["output_name"] = name
            return jsonify({"ok": True, "job_id": job_id, "filename": name, "download_url": "/api/download/%s/%s" % (job_id, fmt)})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.get("/api/md-spec")
    def api_md_spec():
        path = Path(__file__).resolve().parent / "docs" / "AI_MD_SPEC.md"
        if not path.is_file():
            return jsonify({"ok": False, "error": "AI Markdown 规范不存在"}), 404
        return jsonify({"ok": True, "filename": path.name, "content": path.read_text(encoding="utf-8")})

    @app.post("/api/jobs/<job_id>/meta")
    def api_job_meta(job_id: str):
        job = _job(job_id)
        files = job.get("files") or {}
        fmt = job.get("format") or ("tex" if files.get("tex") else "docx")
        path = files.get(fmt)
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "生成文件不存在"}), 404
        payload = request.get_json(silent=True) or {}
        updates = payload.get("metadata")
        if not isinstance(updates, dict) or not updates:
            return jsonify({"ok": False, "error": "缺少 metadata"}), 400
        template_name = str(payload.get("template") or job.get("template") or ("academic" if fmt == "tex" else "")).strip()
        try:
            config = load_template(fmt, template_name).config if template_name else {}
        except TemplateError as exc:
            return jsonify({"ok": False, "error": exc.message}), 400
        headers = payload.get("header_placeholders") if isinstance(payload.get("header_placeholders"), dict) else None
        merged_metadata = dict(job.get("metadata") or {})
        merged_metadata.update(updates)
        try:
            edit_metadata(path, merged_metadata, header_placeholders=headers, output=path, template_config=config)
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        result: Dict[str, Any] = {
            "ok": True,
            "format": fmt,
            "filename": job.get("output_name") or os.path.basename(path),
            "download_url": "/api/download/%s/%s?v=%d" % (job_id, fmt, int(time.time() * 1000)),
            "metadata": merged_metadata,
        }
        compile_info = None
        if fmt == "tex":
            recompile = _bool(payload.get("recompile"))
            if recompile:
                engine = str(payload.get("engine") or config.get("engine") or "xelatex")
                try:
                    compiled = compile_tex(path, engine=engine)
                    files["pdf"] = compiled["pdf"]
                    result["pdf_url"] = "/api/download/%s/pdf?v=%d" % (job_id, int(time.time() * 1000))
                    compile_info = {
                        "ok": True,
                        "ms": compiled["ms"],
                        "engine": compiled["engine"],
                        "log": compiled["log"],
                        "errors": compiled["errors"],
                    }
                except CompileError as exc:
                    files.pop("pdf", None)
                    result["pdf_url"] = None
                    compile_info = {"ok": False, "error": exc.message, "log": exc.log, "errors": [{"line": exc.line, "message": exc.message}]}
            else:
                files.pop("pdf", None)
                result["pdf_url"] = None
            result["compile"] = compile_info
            try:
                result["tex"] = Path(path).read_text(encoding="utf-8")
            except Exception:
                pass
        with JOBS_LOCK:
            if job_id in JOBS:
                JOBS[job_id]["files"] = files
                JOBS[job_id]["metadata"] = merged_metadata
        return jsonify(result)

    @app.errorhandler(413)
    def too_large(_error):
        return jsonify({"ok": False, "error": "上传内容超过 32 MB 限制"}), 413

    @app.errorhandler(404)
    def not_found(error):
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": getattr(error, "description", "未找到")}), 404
        return jsonify({"ok": False, "error": "未找到"}), 404

    @app.after_request
    def no_cache_api(response):
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    return app


app = create_app()
