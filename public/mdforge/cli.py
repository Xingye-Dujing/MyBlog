"""Command line entry point."""
from __future__ import annotations

import json
import os
import sys
from typing import Dict

import click

from .compiler import environment_info
from .convert import convert_file
from .errors import MdForgeError
from .metadata import edit_metadata
from .parser import parse_markdown
from .template import list_templates, load_template


def _kv_pairs(values) -> Dict[str, str]:
    result = {}
    for value in values or ():
        if "=" not in value:
            raise click.BadParameter("应为 key=value：%s" % value)
        key, val = value.split("=", 1)
        result[key.strip()] = val.strip()
    return result


@click.group()
@click.version_option("1.0.0", prog_name="mdforge")
def cli():
    """MdForge — Markdown to reference-grade DOCX / TeX."""


@cli.command()
@click.argument("input_path", type=click.Path(exists=True, dir_okay=False))
@click.option("-t", "--template", default=None, help="模板名，缺省读取 frontmatter.template")
@click.option("-o", "--output", default=None, help="输出 .docx 或 .tex")
@click.option("--format", "fmt", type=click.Choice(["docx", "tex"]), default=None)
@click.option("--pdf", "compile_pdf", is_flag=True, help="TeX 生成后调用 MiKTeX 编译 PDF")
@click.option("--engine", type=click.Choice(["xelatex", "lualatex", "pdflatex"]), default=None)
@click.option("--strict", is_flag=True, help="遇到任一告警即失败")
@click.option("--keep-anchor", is_flag=True, help="保留 DOCX 内容锚点（调试）")
def convert(input_path, template, output, fmt, compile_pdf, engine, strict, keep_anchor):
    """把 Markdown 转换为 DOCX 或 TeX。"""
    try:
        result = convert_file(
            input_path,
            output=output,
            fmt=fmt,
            template=template,
            strict=strict,
            compile_pdf=compile_pdf,
            engine=engine,
            keep_anchor=keep_anchor,
        )
    except MdForgeError as exc:
        click.echo("[错误] %s" % exc.message, err=True)
        if exc.line:
            click.echo("       第 %s 行" % exc.line, err=True)
        sys.exit(1)
    click.echo("[完成] %s" % result["output"])
    if result.get("pdf"):
        click.echo("[PDF ] %s" % result["pdf"])
    compile_failed = result.get("compile", {}).get("ok") is False
    if compile_failed:
        click.echo("[编译失败] %s" % result["compile"].get("error"), err=True)
    for issue in result.get("issues", []):
        if issue.get("level") == "warning":
            click.echo("[告警] 第 %s 行：%s" % (issue.get("line") or "-", issue.get("message")), err=True)
    if compile_failed:
        sys.exit(1)


@cli.command()
@click.argument("input_path", type=click.Path(exists=True, dir_okay=False))
@click.option("-t", "--template", default=None)
@click.option("--format", "fmt", type=click.Choice(["docx", "tex"]), default="docx")
def validate(input_path, template, fmt):
    """校验 Markdown 与模板，不生成文件。"""
    from .template import default_template_name
    from .validate import validate_document

    source = open(input_path, "r", encoding="utf-8-sig").read()
    document = parse_markdown(source, source_name=os.path.basename(input_path), base_dir=os.path.dirname(os.path.abspath(input_path)))
    try:
        template_obj = load_template(fmt, template or str(document.metadata.get("template") or "") or default_template_name(fmt))
    except MdForgeError as exc:
        click.echo("[错误] %s" % exc.message, err=True)
        sys.exit(1)
    issues = validate_document(document, template_obj.config, check_images=True)
    if not issues:
        click.echo("[通过] 未发现问题")
        return
    for issue in issues:
        click.echo("[%s] 第 %s 行：%s" % (issue["level"], issue.get("line") or "-", issue.get("message")))
    if any(issue["level"] == "error" for issue in issues):
        sys.exit(1)


@cli.group()
def templates():
    """列出与查看模板。"""


@templates.command("list")
def templates_list():
    for item in list_templates():
        click.echo("%-4s %-12s %-8s %s" % (item["format"], item["name"], item["version"], item["description"]))


@templates.command("show")
@click.argument("name")
@click.option("--format", "fmt", type=click.Choice(["docx", "tex"]), default="docx")
def templates_show(name, fmt):
    try:
        template = load_template(fmt, name)
    except MdForgeError as exc:
        click.echo("[错误] %s" % exc.message, err=True)
        sys.exit(1)
    click.echo(json.dumps(template.config, ensure_ascii=False, indent=2))


@cli.command()
@click.argument("target", type=click.Path(exists=True, dir_okay=False))
@click.option("--set", "settings", multiple=True, help="字段，例如 --set title=新标题")
@click.option("--header", "headers", multiple=True, help="占位符替换，例如 --header {{TITLE}}=新标题")
@click.option("-t", "--template", default=None)
@click.option("-o", "--output", default=None)
def meta(target, settings, headers, template, output):
    """编辑已有 DOCX / TeX 的元信息。"""
    updates = _kv_pairs(settings)
    header_map = _kv_pairs(headers)
    fmt = "tex" if target.lower().endswith(".tex") else "docx"
    config = {}
    try:
        template_name = template or ("academic" if fmt == "tex" else "")
        if template_name:
            config = load_template(fmt, template_name).config
        result = edit_metadata(target, updates, header_placeholders=header_map, output=output, template_config=config)
        click.echo("[完成] %s" % result)
    except MdForgeError as exc:
        click.echo("[错误] %s" % exc.message, err=True)
        sys.exit(1)


@cli.command()
def env():
    """显示 MiKTeX 环境。"""
    click.echo(json.dumps(environment_info(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    cli()
