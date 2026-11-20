# -*- coding: utf-8 -*-
"""The built-in OMM-ZEN plugin catalog.

Each product is a plugin: a page, its offline assets and a plugin.json manifest.
The hub framework only knows how to serve plugins; it does not hardcode the
product list. The same manifest is used by the full offline build, the online
installer, and the in-app plugin manager.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

PLUGIN_API = 1
VERSION = "1.0.25"


def version_key(value: Any) -> tuple:
    """Numeric comparison key for a dotted version string.

    ``v1.2.3`` -> ``(1, 2, 3)``.  Leading text (``v``/``release-``) and any
    suffix are ignored; all update decisions go through this helper so a
    higher version can never be compared as if it were lower.
    """
    parts = re.findall(r"\d+", str(value or ""))
    return tuple(int(part) for part in parts[:4]) or (0,)


def is_newer(latest: Any, current: Any = VERSION) -> bool:
    """True only when ``latest`` is strictly greater than ``current``.

    This is the single source of truth for "is there an update".  Being strict
    (``>``, not ``!=``) is what prevents a downgrade from ever being presented
    as an update, e.g. a 1.0.15 built-in build being told to install a 1.0.9
    artifact from a stale catalog field.
    """
    return version_key(latest) > version_key(current)

# Release asset name for each desktop program (without the platform suffix).
DESKTOP_EXE_NAMES = {
    "ai": "OMM-AI",
    "annotate": "OMM-Annotate",
    "corpus": "OMM-Corpus",
    "data": "OMM-Data",
    "english": "OMM-English",
    "latex": "OMM-LaTeX",
    "mdforge": "OMM-MdForge",
    "message": "OMM-Message",
    "planner": "OMM-Planner",
    "redact": "OMM-Redact",
    "search": "OMM-Search",
    "visualization": "OMM-Visualization",
    "writer": "OMM-Writer",
    "zencard": "OMM-ZenCard",
    "zenflow": "OMM-ZenFlow",
    "zenclip": "OMM-ZenClip",
    "zenreview": "OMM-ZenReview",
    "zenbackup": "OMM-ZenBackup",
    "hub": "OMM-ZEN",
}

# id, display name, glyph, description, page, preferred port, runtime, vendor subset
BUILTIN_PLUGINS: List[Dict[str, Any]] = [
    {
        "id": "ai",
        "name": "AI 工作区",
        "glyph": "智",
        "description": "静书房专属 Agent · 17 产品技能与最佳实践",
        "entry": "omm-ai.html",
        "port": 8328,
        "runtime": "ai",
        "vendor": [],
        "order": 5,
        "share": {
            "channels": [
                {"id": "documents", "role": "both"},
                {"id": "notes.english", "role": "both"},
                {"id": "data.tables", "role": "both"},
            ]
        },
    },
    {
        "id": "annotate",
        "name": "文本标注",
        "glyph": "标",
        "description": "PDF 标注 · 精读 · 批注",
        "version": "1.0.25",
        "entry": "omm-annotate.html",
        "port": 8311,
        "runtime": "static",
        "vendor": ["pdfjs", "supabase"],
        "order": 10,
        "share": {
            "channels": [
                {"id": "notes.english", "role": "both"},
                {"id": "documents", "role": "both"},
            ]
        },
    },
    {
        "id": "corpus",
        "name": "英语语料库",
        "glyph": "语",
        "description": "个人英语语料与检索",
        "entry": "omm-corpus.html",
        "port": 8312,
        "runtime": "static",
        "vendor": ["supabase"],
        "order": 20,
        "share": {
            "channels": [{"id": "notes.english", "role": "both"}]
        },
    },
    {
        "id": "data",
        "name": "数据工作台",
        "glyph": "数",
        "description": "数据整理 · 查询 · 导出",
        "entry": "omm-data.html",
        "port": 8313,
        "runtime": "static",
        "vendor": ["supabase"],
        "order": 30,
        "share": {
            "channels": [{"id": "data.tables", "role": "both"}]
        },
    },
    {
        "id": "english",
        "name": "六级备考",
        "glyph": "英",
        "description": "词汇 · 听力 · 训练",
        "entry": "omm-english.html",
        "port": 8314,
        "runtime": "static",
        "vendor": ["supabase"],
        "order": 40,
        "share": {
            "channels": [{"id": "notes.english", "role": "both"}]
        },
    },
    {
        "id": "latex",
        "name": "LaTeX 编译工作台",
        "glyph": "T",
        "description": "TeX 编写与实时编译",
        "entry": "omm-latex.html",
        "port": 8123,
        "runtime": "latex",
        "vendor": ["pdfjs"],
        "order": 50,
        "share": {
            "channels": [{"id": "documents", "role": "both"}]
        },
    },
    {
        "id": "mdforge",
        "name": "Markdown 铸造台",
        "glyph": "M",
        "description": "Markdown 转 DOCX / TeX",
        "entry": "omm-mdforge.html",
        "port": 8316,
        "runtime": "mdforge",
        "vendor": [],
        "order": 60,
        "share": {
            "channels": [{"id": "documents", "role": "both"}]
        },
        "examples": True,
        "apl_font": True,
    },
    {
        "id": "message",
        "name": "消息同步",
        "glyph": "信",
        "description": "多设备消息与文件同步",
        "entry": "omm-message.html",
        "port": 8317,
        "runtime": "static",
        "vendor": ["supabase"],
        "order": 70,
        "share": {
            "channels": [{"id": "documents", "role": "both"}]
        },
    },
    {
        "id": "planner",
        "name": "日程安排",
        "glyph": "日",
        "description": "日程 · 待办 · 时间线",
        "entry": "omm-planner.html",
        "port": 8318,
        "runtime": "static",
        "vendor": ["html2canvas", "supabase"],
        "order": 80,
        "share": {
            "channels": [{"id": "documents", "role": "publish"}]
        },
    },
    {
        "id": "redact",
        "name": "文档脱敏工具",
        "glyph": "脱",
        "description": "PDF / Office 脱敏导出 · 原生 DOCX / PDF 导入 · PDF 工具",
        "entry": "omm-redact.html",
        "port": 8319,
        "runtime": "static",
        "vendor": [
            "pdfjs", "pdf-lib", "jszip", "pptxviewjs", "mammoth", "docx-preview",
            "chartjs/4.4.1", "jspdf/2.5.1", "html2canvas", "mupdf",
        ],
        "order": 90,
        "share": {
            "channels": [{"id": "documents", "role": "both"}]
        },
    },
    {
        "id": "search",
        "name": "智能搜索",
        "glyph": "搜",
        "description": "免费联网搜索 · AI 摘要 · 引用溯源 · 一键导出",
        "entry": "omm-search.html",
        "port": 8322,
        "runtime": "static",
        "vendor": [],
        "order": 115,
        "share": {
            "channels": [{"id": "documents", "role": "publish"}]
        },
    },
    {
        "id": "visualization",
        "name": "可视化图表",
        "glyph": "图",
        "description": "图表与数据可视化",
        "version": "1.0.25",
        "entry": "omm-visualization.html",
        "port": 8320,
        "runtime": "static",
        "vendor": [
            "chartjs/4.5.1", "apexcharts", "echarts", "html2canvas",
            "jspdf/4.2.1", "xlsx",
        ],
        "order": 100,
        "share": {
            "channels": [
                {"id": "data.tables", "role": "consume"},
                {"id": "documents", "role": "publish"},
            ]
        },
    },
    {
        "id": "zencard",
        "name": "间隔复习",
        "glyph": "卡",
        "description": "SM-2 间隔重复 · 知识卡片",
        "entry": "omm-zencard.html",
        "port": 8323,
        "runtime": "static",
        "vendor": [],
        "order": 116,
        "share": {"channels": [{"id": "documents", "role": "both"}]},
    },
    {
        "id": "zenflow",
        "name": "自动化编排",
        "glyph": "流",
        "description": "规则引擎 · 跨产品自动化",
        "entry": "omm-zenflow.html",
        "port": 8324,
        "runtime": "static",
        "vendor": [],
        "order": 117,
        "share": {"channels": [{"id": "documents", "role": "both"}]},
    },
    {
        "id": "zenclip",
        "name": "网页剪藏",
        "glyph": "剪",
        "description": "选中即剪藏 · zen-card",
        "entry": "omm-zenclip.html",
        "port": 8325,
        "runtime": "static",
        "vendor": [],
        "order": 118,
        "share": {"channels": [{"id": "documents", "role": "publish"}]},
    },
    {
        "id": "zenreview",
        "name": "复盘报告",
        "glyph": "盘",
        "description": "时间线汇总 · 报告生成",
        "entry": "omm-zenreview.html",
        "port": 8326,
        "runtime": "static",
        "vendor": [],
        "order": 119,
        "share": {"channels": [{"id": "documents", "role": "publish"}]},
    },
    {
        "id": "zenbackup",
        "name": "统一备份",
        "glyph": "备",
        "description": "全产品备份 · 恢复与差异",
        "entry": "omm-zenbackup.html",
        "port": 8327,
        "runtime": "static",
        "vendor": [],
        "order": 120,
        "share": {"channels": [{"id": "documents", "role": "both"}]},
    },
    {
        "id": "writer",
        "name": "所思所想",
        "glyph": "写",
        "description": "长文写作与排版",
        "entry": "omm-writer.html",
        "port": 8321,
        "runtime": "static",
        "vendor": ["html2canvas", "jspdf/2.5.1", "mathjax", "supabase"],
        "order": 110,
        "share": {
            "channels": [{"id": "documents", "role": "both"}]
        },
    },
]

PLUGIN_BY_ID = {item["id"]: item for item in BUILTIN_PLUGINS}


def manifest(item: Dict[str, Any]) -> Dict[str, Any]:
    """Public manifest written into a built plugin directory."""
    return {
        "schema": PLUGIN_API,
        "id": item["id"],
        "name": item["name"],
        "version": item.get("version", VERSION),
        "description": item["description"],
        "glyph": item["glyph"],
        "entry": item["entry"],
        "runtime": item["runtime"],
        "port": item.get("port", 0),
        "order": item.get("order", 999),
        "author": "OMM-ZEN",
        "homepage": "https://github.com/Xingye-Dujing/MyBlog",
        **({"share": item["share"]} if item.get("share") else {}),
    }
