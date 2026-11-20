# -*- coding: utf-8 -*-
"""AUTO-GENERATED from public/json-specs/format-registry.json by public/tools/gen_formats.py.

DO NOT EDIT BY HAND. Edit the registry, then run: python public/tools/gen_formats.py
The GEN_FORMATS guard fails the build if this file drifts from the registry.
"""
from __future__ import annotations

import json

FORMAT_SCHEMA = 1
CHECKSUM = 'fnv1a-utf16-base36'
_DATA = json.loads(r'''{
  "formats": [
    {
      "product": "annotate",
      "label": "文本标注",
      "kind": "backup",
      "format": null,
      "version": 1,
      "source": "public/omm-annotate.html",
      "fields": [
        {
          "name": "app",
          "type": "string",
          "required": true
        },
        {
          "name": "version",
          "type": "number",
          "required": true
        },
        {
          "name": "exportedAt",
          "type": "string",
          "required": true
        },
        {
          "name": "project",
          "type": "object",
          "required": true
        }
      ],
      "hard": [
        "app=zenmark",
        "version 数字 1",
        "project.codes 非空"
      ],
      "template": {
        "app": "zenmark",
        "version": 1,
        "exportedAt": "2026-01-01 00:00",
        "project": {
          "docs": [
            {
              "id": "d1",
              "text": "原文…"
            }
          ],
          "codes": [
            {
              "id": "c1",
              "name": "开放编码",
              "level": "open"
            }
          ],
          "anns": [
            {
              "id": "a1",
              "doc": "d1",
              "code": "c1",
              "start": 0,
              "end": 2,
              "quote": "原文"
            }
          ],
          "rels": [],
          "memos": [],
          "marks": [],
          "notes": [],
          "cellCodes": [],
          "reliability": []
        }
      },
      "validator": "v_annotate",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "annotate",
      "label": "文本标注",
      "kind": "bridge",
      "format": "bridge",
      "version": 1,
      "source": "public/omm-annotate.html",
      "fields": [
        {
          "name": "omm",
          "type": "string",
          "required": true
        },
        {
          "name": "v",
          "type": "number",
          "required": true
        },
        {
          "name": "kind",
          "type": "string",
          "required": true
        },
        {
          "name": "items",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "omm=bridge",
        "v 数字 1",
        "items 是数组"
      ],
      "template": {
        "omm": "bridge",
        "v": 1,
        "kind": "notes",
        "items": [
          {
            "t": "sentence",
            "en": "…",
            "zh": "…"
          }
        ]
      },
      "validator": "v_annotate",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "corpus",
      "label": "英语语料库",
      "kind": "bridge",
      "format": "bridge",
      "version": 1,
      "source": "public/omm-corpus.html",
      "fields": [
        {
          "name": "omm",
          "type": "string",
          "required": true
        },
        {
          "name": "v",
          "type": "number",
          "required": true
        },
        {
          "name": "kind",
          "type": "string",
          "required": true
        },
        {
          "name": "items",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "omm=bridge",
        "v 数字 1",
        "items 是数组"
      ],
      "template": {
        "omm": "bridge",
        "v": 1,
        "kind": "notes",
        "items": [
          {
            "t": "sentence",
            "en": "…",
            "zh": "…"
          }
        ]
      },
      "validator": "v_corpus",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "corpus",
      "label": "英语语料库",
      "kind": "restore",
      "format": null,
      "version": 2,
      "source": "public/omm-corpus.html",
      "fields": [
        {
          "name": "version",
          "type": "number",
          "required": true
        },
        {
          "name": "categories",
          "type": "array",
          "required": true
        },
        {
          "name": "entries",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "entries 非空",
        "categories 非空",
        "entry.categoryId 指向真实分类"
      ],
      "template": {
        "version": 2,
        "categories": [
          {
            "id": "cat1",
            "name": "写作"
          }
        ],
        "entries": [
          {
            "id": "e1",
            "en": "A natural sentence.",
            "zh": "译文",
            "type": "sentence",
            "categoryId": "cat1",
            "tags": [
              "写作"
            ],
            "favorite": false,
            "source": "ai"
          }
        ]
      },
      "validator": "v_corpus",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "data",
      "label": "数据工作台",
      "kind": "csv",
      "format": null,
      "version": null,
      "source": "public/omm-data.html",
      "fields": [],
      "hard": [
        "每行列数一致",
        "首列表头非空"
      ],
      "template": "列一,列二\n值,1\n",
      "validator": "v_data",
      "golden": null,
      "ext": ".json/.csv",
      "enums": {}
    },
    {
      "product": "data",
      "label": "数据工作台",
      "kind": "rows",
      "format": null,
      "version": null,
      "source": "public/omm-data.html",
      "fields": [
        {
          "name": "",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "顶层数组或 {rows:[…]}",
        "禁止 tables 字段"
      ],
      "template": [
        {
          "列一": "值",
          "列二": 1
        }
      ],
      "validator": "v_data",
      "golden": null,
      "ext": ".json/.csv",
      "enums": {}
    },
    {
      "product": "english",
      "label": "六级备考",
      "kind": "backup",
      "format": null,
      "version": null,
      "source": "public/omm-english.html",
      "fields": [
        {
          "name": "books",
          "type": "object",
          "required": true
        },
        {
          "name": "prog",
          "type": "object",
          "required": true
        }
      ],
      "hard": [
        "同时有 books 与 prog 对象"
      ],
      "template": {
        "books": {
          "cet6": {
            "w": []
          },
          "u1": {
            "w": [
              [
                "word",
                "/wɜːd/",
                "单词",
                "Example",
                "例句"
              ]
            ]
          }
        },
        "prog": {}
      },
      "validator": "v_english",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "english",
      "label": "六级备考",
      "kind": "bridge",
      "format": "bridge",
      "version": 1,
      "source": "public/omm-english.html",
      "fields": [
        {
          "name": "omm",
          "type": "string",
          "required": true
        },
        {
          "name": "v",
          "type": "number",
          "required": true
        },
        {
          "name": "items",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "omm=bridge",
        "v 数字 1",
        "items 是数组"
      ],
      "template": {
        "omm": "bridge",
        "v": 1,
        "items": [
          {
            "t": "word",
            "w": "word",
            "m": "单词"
          }
        ]
      },
      "validator": "v_english",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "english",
      "label": "六级备考",
      "kind": "doodles",
      "format": null,
      "version": null,
      "source": "public/omm-english.html",
      "fields": [
        {
          "name": "drawings",
          "type": "object",
          "required": true
        }
      ],
      "hard": [
        "drawings 键小写",
        "点坐标 x∈[0,1200], y∈[0,800], p∈[0.15,1]"
      ],
      "template": {
        "drawings": {
          "word": {
            "strokes": [
              {
                "color": "#000",
                "width": 3,
                "erase": false,
                "points": [
                  {
                    "x": 100,
                    "y": 100,
                    "p": 0.8
                  }
                ]
              }
            ]
          }
        }
      },
      "validator": "v_english",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "english",
      "label": "六级备考",
      "kind": "wordbook",
      "format": null,
      "version": null,
      "source": "public/omm-english.html",
      "fields": [
        {
          "name": "",
          "type": "array",
          "required": true
        }
      ],
      "hard": [],
      "template": [
        {
          "w": "word",
          "ph": "/wɜːd/",
          "m": "单词",
          "ex": "Example sentence."
        }
      ],
      "validator": "v_english",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "hub",
      "label": "静书房",
      "kind": "ai-config",
      "format": null,
      "version": null,
      "source": "public/omm-hub.js",
      "fields": [
        {
          "name": "provider",
          "type": "string",
          "required": true
        },
        {
          "name": "apiBase",
          "type": "string",
          "required": true
        },
        {
          "name": "apiModel",
          "type": "string",
          "required": true
        },
        {
          "name": "apiKey",
          "type": "string",
          "required": true
        },
        {
          "name": "system",
          "type": "string",
          "required": true
        }
      ],
      "hard": [
        "不得包含 apiKey/密码/令牌"
      ],
      "template": {
        "provider": "deepseek",
        "apiBase": "https://api.deepseek.com",
        "apiModel": "deepseek-chat",
        "apiKey": "",
        "system": ""
      },
      "validator": "v_hub",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "latex",
      "label": "LaTeX 编译工作台",
      "kind": "tex",
      "format": null,
      "version": null,
      "source": "public/omm-latex.html",
      "fields": [],
      "hard": [
        "documentclass 存在",
        "begin/end document 成对",
        "禁止 input/include/write18"
      ],
      "template": "\\documentclass[UTF8]{ctexart}\n\\begin{document}\n标题与正文。\n\\end{document}\n",
      "validator": "v_latex",
      "golden": null,
      "ext": ".tex",
      "enums": {}
    },
    {
      "product": "mdforge",
      "label": "Markdown 铸造台",
      "kind": "markdown",
      "format": null,
      "version": null,
      "source": "public/omm-mdforge.html",
      "fields": [],
      "hard": [
        "YAML frontmatter",
        "title 非空",
        "template: academic"
      ],
      "template": "---\ntitle: 标题\ntemplate: academic\n---\n\n# 正文标题\n\n段落……\n\n# 参考文献\n",
      "validator": "v_mdforge",
      "golden": null,
      "ext": ".markdown",
      "enums": {}
    },
    {
      "product": "message",
      "label": "消息同步",
      "kind": "unsupported",
      "format": null,
      "version": null,
      "source": "public/omm-message.html",
      "fields": [
        {
          "name": "note",
          "type": "string",
          "required": true
        }
      ],
      "hard": [
        "没有文件导入入口"
      ],
      "template": {
        "note": "本产品没有文件导入；只可产出 localStorage 配置，且不含密钥"
      },
      "validator": "v_message",
      "golden": null,
      "ext": "—",
      "enums": {}
    },
    {
      "product": "planner",
      "label": "日程安排",
      "kind": "backup",
      "format": null,
      "version": 2,
      "source": "public/omm-planner.html",
      "fields": [
        {
          "name": "app",
          "type": "string",
          "required": true
        },
        {
          "name": "version",
          "type": "number",
          "required": true
        },
        {
          "name": "exportedAt",
          "type": "string",
          "required": true
        },
        {
          "name": "planners",
          "type": "array",
          "required": true
        },
        {
          "name": "activeId",
          "type": "string",
          "required": true
        },
        {
          "name": "eventsBy",
          "type": "object",
          "required": true
        },
        {
          "name": "recursBy",
          "type": "object",
          "required": true
        }
      ],
      "hard": [
        "app=zenplan",
        "version 数字 2",
        "planners 是数组"
      ],
      "template": {
        "app": "zenplan",
        "version": 2,
        "exportedAt": "2026-01-01T00:00:00Z",
        "planners": [
          {
            "id": "p1",
            "name": "默认"
          }
        ],
        "activeId": "p1",
        "eventsBy": {
          "p1": {
            "2026-01-01": [
              {
                "id": "ev1",
                "title": "任务",
                "color": "#888888",
                "time": "09:00",
                "done": false
              }
            ]
          }
        },
        "recursBy": {
          "p1": []
        }
      },
      "validator": "v_planner",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "redact",
      "label": "文档脱敏工具",
      "kind": "unsupported",
      "format": null,
      "version": null,
      "source": "public/omm-redact.html",
      "fields": [
        {
          "name": "note",
          "type": "string",
          "required": true
        }
      ],
      "hard": [
        ".json 被白名单拒绝"
      ],
      "template": {
        "note": "本产品拒绝 .json 导入；只可产出 zr-settings 用于 localStorage"
      },
      "validator": "v_redact",
      "golden": null,
      "ext": "—",
      "enums": {}
    },
    {
      "product": "search",
      "label": "智能搜索",
      "kind": "export",
      "format": null,
      "version": null,
      "source": "public/omm-search.html",
      "fields": [
        {
          "name": "settings",
          "type": "object",
          "required": true
        },
        {
          "name": "history",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "settings 是对象，history 是数组"
      ],
      "template": {
        "settings": {
          "apiBase": "https://api.deepseek.com",
          "apiModel": "deepseek-chat"
        },
        "history": []
      },
      "validator": "v_search",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "visualization",
      "label": "可视化图表",
      "kind": "csv",
      "format": null,
      "version": null,
      "source": "public/omm-visualization.html",
      "fields": [],
      "hard": [
        "角色列模型：类别列 + 数值列"
      ],
      "template": "类别,数值\nA,1\nB,2\n",
      "validator": "v_visualization",
      "golden": null,
      "ext": ".json/.csv",
      "enums": {}
    },
    {
      "product": "visualization",
      "label": "可视化图表",
      "kind": "properties",
      "format": "zenviz-right-properties",
      "version": 1,
      "source": "public/omm-visualization.html",
      "fields": [
        {
          "name": "kind",
          "type": "string",
          "required": true
        },
        {
          "name": "version",
          "type": "number",
          "required": true
        },
        {
          "name": "engines",
          "type": "object",
          "required": true
        }
      ],
      "hard": [
        "kind=zenviz-right-properties",
        "version 数字 1"
      ],
      "template": {
        "kind": "zenviz-right-properties",
        "version": 1,
        "engines": {
          "echarts": {
            "typeStates": {
              "bar": {}
            },
            "chartProps": {
              "bar": {}
            }
          }
        }
      },
      "validator": "v_visualization",
      "golden": null,
      "ext": ".json/.csv",
      "enums": {}
    },
    {
      "product": "writer",
      "label": "所思所想",
      "kind": "canvas",
      "format": "zenwriter-canvas",
      "version": 2,
      "source": "public/omm-writer.html",
      "fields": [
        {
          "name": "format",
          "type": "string",
          "required": true
        },
        {
          "name": "v",
          "type": "number",
          "required": true
        },
        {
          "name": "name",
          "type": "string",
          "required": true
        },
        {
          "name": "nodes",
          "type": "array",
          "required": true
        },
        {
          "name": "connections",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "顶层 nodes 是数组",
        "节点 id 唯一",
        "连线两端存在且不等"
      ],
      "template": {
        "format": "zenwriter-canvas",
        "v": 2,
        "name": "画布",
        "nodes": [
          {
            "id": "node-1",
            "type": "text",
            "x": 100,
            "y": 100,
            "w": "240px",
            "h": "80px",
            "content": "正文"
          }
        ],
        "connections": []
      },
      "validator": "v_writer",
      "golden": null,
      "ext": ".zc",
      "enums": {}
    },
    {
      "product": "writer",
      "label": "所思所想",
      "kind": "library",
      "format": "zenwriter-library",
      "version": null,
      "source": "public/omm-writer.html",
      "fields": [
        {
          "name": "format",
          "type": "string",
          "required": true
        },
        {
          "name": "docs",
          "type": "object",
          "required": true
        }
      ],
      "hard": [
        "format=zenwriter-library",
        "docs 是对象"
      ],
      "template": {
        "format": "zenwriter-library",
        "docs": {}
      },
      "validator": "v_writer",
      "golden": null,
      "ext": ".zc",
      "enums": {}
    },
    {
      "product": "zenbackup",
      "label": "统一备份",
      "kind": "manifest",
      "format": "zen-backup",
      "version": 1,
      "source": "public/zen-backup.js",
      "fields": [
        {
          "name": "format",
          "type": "string",
          "required": true
        },
        {
          "name": "v",
          "type": "number",
          "required": true
        },
        {
          "name": "createdAt",
          "type": "string",
          "required": true
        },
        {
          "name": "name",
          "type": "string",
          "required": true
        },
        {
          "name": "products",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "format=zen-backup",
        "v 数字 1",
        "checksum 为 data 的 FNV-1a base36"
      ],
      "template": {
        "format": "zen-backup",
        "v": 1,
        "createdAt": "2026-01-01T00:00:00Z",
        "name": "备份",
        "products": [
          {
            "id": "zen.cards.v1",
            "name": "间隔复习",
            "version": "1",
            "savedAt": "2026-01-01T00:00:00Z",
            "checksum": "w7k42t",
            "data": []
          }
        ]
      },
      "validator": "v_zenbackup",
      "golden": "zenbackup-manifest.json",
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "zencard",
      "label": "间隔复习",
      "kind": "card",
      "format": "zen-card",
      "version": 1,
      "source": "public/zen-card.js",
      "fields": [
        {
          "name": "format",
          "type": "string",
          "required": true
        },
        {
          "name": "v",
          "type": "number",
          "required": true
        },
        {
          "name": "id",
          "type": "string",
          "required": true
        },
        {
          "name": "kind",
          "type": "string",
          "required": true
        },
        {
          "name": "source",
          "type": "string",
          "required": true
        },
        {
          "name": "content",
          "type": "string",
          "required": true
        },
        {
          "name": "tags",
          "type": "array",
          "required": true
        },
        {
          "name": "createdAt",
          "type": "string",
          "required": true
        },
        {
          "name": "updatedAt",
          "type": "string",
          "required": true
        }
      ],
      "hard": [
        "format=zen-card",
        "v 数字 1",
        "content 非空",
        "kind/source 在枚举内",
        "tags 是数组"
      ],
      "template": {
        "format": "zen-card",
        "v": 1,
        "id": "zc-1",
        "kind": "note",
        "source": "manual",
        "content": "卡片正文",
        "tags": [],
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z"
      },
      "validator": "v_zencard",
      "golden": "zencard-card.json",
      "ext": ".json",
      "enums": {
        "kind": [
          "quote",
          "note",
          "word",
          "sentence",
          "idea",
          "todo",
          "fact",
          "image"
        ],
        "source": [
          "manual",
          "writer",
          "annotate",
          "corpus",
          "english",
          "search",
          "data",
          "web",
          "clip"
        ]
      }
    },
    {
      "product": "zencard",
      "label": "间隔复习",
      "kind": "pack",
      "format": "zen-card-pack",
      "version": 1,
      "source": "public/zen-card.js",
      "fields": [
        {
          "name": "format",
          "type": "string",
          "required": true
        },
        {
          "name": "v",
          "type": "number",
          "required": true
        },
        {
          "name": "name",
          "type": "string",
          "required": true
        },
        {
          "name": "cards",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "format=zen-card-pack",
        "v 数字 1",
        "cards 是数组"
      ],
      "template": {
        "format": "zen-card-pack",
        "v": 1,
        "name": "卡片包",
        "cards": [
          {
            "format": "zen-card",
            "v": 1,
            "id": "zc-1",
            "kind": "note",
            "source": "manual",
            "content": "卡片正文",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
          }
        ]
      },
      "validator": "v_zencard",
      "golden": "zencard-pack.json",
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "zenclip",
      "label": "网页剪藏",
      "kind": "pack",
      "format": "zen-card-pack",
      "version": 1,
      "source": "public/zen-card.js",
      "fields": [
        {
          "name": "format",
          "type": "string",
          "required": true
        },
        {
          "name": "v",
          "type": "number",
          "required": true
        },
        {
          "name": "name",
          "type": "string",
          "required": true
        },
        {
          "name": "cards",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "format=zen-card-pack",
        "cards 是数组"
      ],
      "template": {
        "format": "zen-card-pack",
        "v": 1,
        "name": "剪藏",
        "cards": [
          {
            "format": "zen-card",
            "v": 1,
            "id": "zc-clip-1",
            "kind": "quote",
            "source": "clip",
            "content": "摘录",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
          }
        ]
      },
      "validator": "v_zenclip",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "zenflow",
      "label": "自动化编排",
      "kind": "rules",
      "format": null,
      "version": null,
      "source": "public/zen-flow.js",
      "fields": [
        {
          "name": "",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "actions.type 在允许枚举内",
        "顶层规则数组"
      ],
      "template": [
        {
          "name": "示例规则",
          "priority": 1,
          "enabled": true,
          "when": {
            "source": "manual",
            "kind": "note",
            "tag": "待整理",
            "text": ""
          },
          "actions": [
            {
              "type": "addTag",
              "value": "已整理"
            }
          ]
        }
      ],
      "validator": "v_zenflow",
      "golden": "zenflow-rules.json",
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "zenreview",
      "label": "复盘报告",
      "kind": "inputs",
      "format": null,
      "version": null,
      "source": "public/zen-review.js",
      "fields": [
        {
          "name": "timeline",
          "type": "array",
          "required": true
        },
        {
          "name": "planner",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "timeline / planner 都是数组"
      ],
      "template": {
        "timeline": [],
        "planner": []
      },
      "validator": "v_zenreview",
      "golden": null,
      "ext": ".json",
      "enums": {}
    },
    {
      "product": "zenreview",
      "label": "复盘报告",
      "kind": "timeline",
      "format": null,
      "version": null,
      "source": "public/zen-review.js",
      "fields": [
        {
          "name": "",
          "type": "array",
          "required": true
        }
      ],
      "hard": [
        "顶层是数组"
      ],
      "template": [
        {
          "app": "writer",
          "ts": "2026-01-01T00:00:00Z",
          "title": "完成事项"
        }
      ],
      "validator": "v_zenreview",
      "golden": null,
      "ext": ".json",
      "enums": {}
    }
  ],
  "detection": {
    "annotate": [
      {
        "kind": "bridge",
        "mode": "omm",
        "value": "bridge"
      },
      {
        "kind": "backup",
        "mode": "key_dict",
        "value": "project"
      },
      {
        "kind": "text",
        "mode": "fallback"
      }
    ],
    "corpus": [
      {
        "kind": "bridge",
        "mode": "omm",
        "value": "bridge"
      },
      {
        "kind": "restore",
        "mode": "fallback"
      }
    ],
    "data": [
      {
        "kind": "rows",
        "mode": "shape",
        "value": "structured"
      },
      {
        "kind": "csv",
        "mode": "fallback"
      }
    ],
    "english": [
      {
        "kind": "bridge",
        "mode": "omm",
        "value": "bridge"
      },
      {
        "kind": "doodles",
        "mode": "key_dict",
        "value": "drawings"
      },
      {
        "kind": "backup",
        "mode": "keys",
        "value": [
          "books",
          "prog"
        ]
      },
      {
        "kind": "wordbook",
        "mode": "fallback"
      }
    ],
    "latex": [
      {
        "kind": "tex",
        "mode": "const"
      }
    ],
    "mdforge": [
      {
        "kind": "markdown",
        "mode": "const"
      }
    ],
    "message": [
      {
        "kind": "unsupported",
        "mode": "const"
      }
    ],
    "planner": [
      {
        "kind": "backup",
        "mode": "const"
      }
    ],
    "redact": [
      {
        "kind": "unsupported",
        "mode": "const"
      }
    ],
    "search": [
      {
        "kind": "export",
        "mode": "const"
      }
    ],
    "visualization": [
      {
        "kind": "properties",
        "mode": "kind",
        "value": "zenviz-right-properties"
      },
      {
        "kind": "csv",
        "mode": "fallback"
      }
    ],
    "writer": [
      {
        "kind": "library",
        "mode": "format",
        "value": "zenwriter-library"
      },
      {
        "kind": "canvas",
        "mode": "fallback"
      }
    ],
    "zencard": [
      {
        "kind": "pack",
        "mode": "format",
        "value": "zen-card-pack"
      },
      {
        "kind": "card",
        "mode": "fallback"
      }
    ],
    "zenclip": [
      {
        "kind": "pack",
        "mode": "const"
      }
    ],
    "zenflow": [
      {
        "kind": "rules",
        "mode": "const"
      }
    ],
    "zenreview": [
      {
        "kind": "timeline",
        "mode": "shape",
        "value": "array"
      },
      {
        "kind": "inputs",
        "mode": "shape",
        "value": "dict"
      },
      {
        "kind": "markdown",
        "mode": "fallback"
      }
    ],
    "zenbackup": [
      {
        "kind": "manifest",
        "mode": "const"
      }
    ],
    "hub": [
      {
        "kind": "ai-config",
        "mode": "const"
      }
    ]
  }
}''')
REGISTRY = _DATA['formats']
DETECTION = _DATA['detection']
TEMPLATES = {}
for _row in REGISTRY:
    TEMPLATES.setdefault(_row['product'], {})[_row['kind']] = _row['template']
FORMAT_TOKENS = sorted({row['format'] for row in REGISTRY if row['format']})
HARD_GATES = {(row['product'], row['kind']): row['hard'] for row in REGISTRY}


def _matches(rule: dict, obj, text: str) -> bool:
    """Interpret one declarative detection rule from the registry."""
    mode = rule['mode']
    value = rule.get('value')
    if mode == 'const':
        return True
    if mode == 'fallback':
        return True
    if mode == 'format':
        return isinstance(obj, dict) and obj.get('format') == value
    if mode == 'omm':
        return isinstance(obj, dict) and obj.get('omm') == value
    if mode == 'kind':
        return isinstance(obj, dict) and obj.get('kind') == value
    if mode == 'key_dict':
        return isinstance(obj, dict) and isinstance(obj.get(value), dict)
    if mode == 'keys':
        return isinstance(obj, dict) and all(key in obj for key in value)
    if mode == 'shape':
        if value == 'array':
            return isinstance(obj, list)
        if value == 'dict':
            return isinstance(obj, dict)
        if value == 'structured':
            return isinstance(obj, (dict, list))
    return False


def detect_kind(product: str, obj, text: str = '') -> str:
    """Deterministically classify a payload using registry detection rules."""
    for rule in DETECTION.get(product, []):
        if _matches(rule, obj, text):
            return rule['kind']
    return 'auto'


def declarative_errors(product: str, kind: str, obj) -> list:
    """Check the machine-declarable contract: format, version, field shapes, enums.

    Deep semantic rules (referential integrity, checksum, cross-field slices)
    stay in the hand-written validators bound by ``validator``; this layer makes
    the common contract drift-proof because it comes straight from the registry.
    """
    errors = []
    rows = [row for row in REGISTRY if row['product'] == product and row['kind'] == kind]
    if not rows:
        return errors
    row = rows[0]
    if not isinstance(obj, dict):
        # Text / array / unsupported formats have their own deep validators.
        return errors
    token = row.get('format')
    if token and token != 'bridge' and row.get('kind') not in ('properties',):
        if obj.get('format') != token:
            errors.append('%s.format 必须是 %r' % (kind, token))
    version = row.get('version')
    if version is not None and 'version' in obj and obj['version'] != version:
        errors.append('%s.version 必须是 %r' % (kind, version))
    for field in row.get('fields', []):
        name = field.get('name')
        if not name or not field.get('required'):
            continue
        if name not in obj:
            errors.append('%s.%s 缺失' % (kind, name))
            continue
        expected = field.get('type')
        value = obj[name]
        ok = True
        if expected == 'string':
            ok = isinstance(value, str)
        elif expected == 'number':
            ok = isinstance(value, (int, float)) and not isinstance(value, bool)
        elif expected == 'boolean':
            ok = isinstance(value, bool)
        elif expected == 'array':
            ok = isinstance(value, list)
        elif expected == 'object':
            ok = isinstance(value, dict)
        if not ok:
            errors.append('%s.%s 类型应为 %s' % (kind, name, expected))
    for name, values in (row.get('enums') or {}).items():
        if name in obj and obj[name] not in values:
            errors.append('%s.%s 必须是 %s 之一' % (kind, name, '/'.join(values)))
    return errors
