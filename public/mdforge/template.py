"""Template discovery and configuration."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import yaml
from jinja2 import Environment, FileSystemLoader, StrictUndefined

from .errors import TemplateError
from .escape import escape, escape_url


TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
FORMATS = ("docx", "tex")


@dataclass
class Template:
    format: str
    name: str
    directory: Path
    config: Dict[str, Any]

    @property
    def description(self) -> str:
        return str(self.config.get("description") or self.name)

    @property
    def version(self) -> str:
        return str(self.config.get("version") or "1.0")

    def path_for(self, filename: str) -> Path:
        return self.directory / filename

    def jinja_env(self) -> Environment:
        env = Environment(
            loader=FileSystemLoader(str(self.directory)),
            autoescape=False,
            undefined=StrictUndefined,
            keep_trailing_newline=True,
        )
        env.filters["tex"] = escape
        env.filters["texurl"] = escape_url
        return env


def _load_yaml(path: Path) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
    except Exception as exc:
        raise TemplateError("读取模板配置失败：%s (%s)" % (path, exc))
    if not isinstance(data, dict):
        raise TemplateError("模板配置必须是 YAML 映射：%s" % path)
    return data


def validate_template_config(fmt: str, config: Dict[str, Any]) -> None:
    required = ["name", "description", "version"]
    for key in required:
        if not config.get(key):
            raise TemplateError("template.yaml 缺少字段：%s" % key)
    if fmt == "docx":
        for key in ("content_anchor", "styles"):
            if not config.get(key):
                raise TemplateError("DOCX 模板缺少字段：%s" % key)
        styles = config.get("styles") or {}
        for key in ("h1", "h2", "paragraph"):
            if not styles.get(key):
                raise TemplateError("DOCX 模板 styles 缺少：%s" % key)
    elif fmt == "tex":
        if not config.get("file"):
            raise TemplateError("TeX 模板缺少 file 字段")


def load_template(fmt: str, name: str) -> Template:
    if fmt not in FORMATS:
        raise TemplateError("未知格式：%s" % fmt)
    directory = TEMPLATES_DIR / fmt / name
    if not directory.is_dir():
        raise TemplateError("模板不存在：%s/%s" % (fmt, name))
    config = _load_yaml(directory / "template.yaml")
    validate_template_config(fmt, config)
    if str(config.get("name")) != name:
        raise TemplateError("模板目录名与 template.yaml name 不一致：%s" % name)
    if fmt == "docx":
        if not (directory / "template.docx").is_file():
            raise TemplateError("模板缺少 template.docx：%s" % directory)
    else:
        if not (directory / str(config.get("file"))).is_file():
            raise TemplateError("模板缺少 %s：%s" % (config.get("file"), directory))
    return Template(format=fmt, name=name, directory=directory, config=config)


def list_templates(fmt: Optional[str] = None) -> List[Dict[str, Any]]:
    formats = [fmt] if fmt in FORMATS else list(FORMATS)
    result: List[Dict[str, Any]] = []
    for current in formats:
        root = TEMPLATES_DIR / current
        if not root.is_dir():
            continue
        for child in sorted(root.iterdir()):
            if not child.is_dir():
                continue
            yaml_path = child / "template.yaml"
            if not yaml_path.is_file():
                continue
            try:
                config = _load_yaml(yaml_path)
                validate_template_config(current, config)
            except TemplateError:
                continue
            meta = config.get("metadata") or {}
            result.append(
                {
                    "format": current,
                    "name": config.get("name") or child.name,
                    "title": config.get("title") or config.get("name") or child.name,
                    "description": config.get("description") or "",
                    "version": str(config.get("version") or "1.0"),
                    "required": list(meta.get("required") or []),
                    "optional": list(meta.get("optional") or []),
                    "engine": config.get("engine") or "",
                    "features": list(config.get("features") or []),
                }
            )
    return result


def default_template_name(fmt: str) -> str:
    templates = list_templates(fmt)
    if templates:
        return str(templates[0]["name"])
    raise TemplateError("没有任何可用模板")
