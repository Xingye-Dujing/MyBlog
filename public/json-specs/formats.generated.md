# OMM-ZEN 格式骨架（自动生成）

> 本文件由 `public/tools/gen_formats.py` 从 `json-specs/format-registry.json` 生成，
> **请勿手改**。改契约请编辑注册表后运行 `python public/tools/gen_formats.py`。
> 机器可读真源：`public/json-specs/format-registry.json`（schema 1）。
> 校验器绑定与深度语义规则见 `omm_validators.py`；本骨架给人和 AI 直接复制使用。

交付物一律 UTF-8、合法 JSON、无注释、无尾逗号、无代码围栏（Latex/MDFORGE 是纯文本）。

## 目录

- [annotate · 文本标注](#annotate)
  - backup（.json）
  - bridge（.json）
- [corpus · 英语语料库](#corpus)
  - bridge（.json）
  - restore（.json）
- [data · 数据工作台](#data)
  - csv（.json/.csv）
  - rows（.json/.csv）
- [english · 六级备考](#english)
  - backup（.json）
  - bridge（.json）
  - doodles（.json）
  - wordbook（.json）
- [hub · 静书房](#hub)
  - ai-config（.json）
- [lambda · Lambda 演算计算器](#lambda)
  - session（.json）
  - share（.json）
- [latex · LaTeX 编译工作台](#latex)
  - tex（.tex）
- [mdforge · Markdown 铸造台](#mdforge)
  - markdown（.markdown）
- [message · 消息同步](#message)
  - unsupported（—）
- [planner · 日程安排](#planner)
  - backup（.json）
- [redact · 文档脱敏工具](#redact)
  - unsupported（—）
- [search · 智能搜索](#search)
  - export（.json）
- [video · 视频工作台](#video)
  - workflow（.json）
- [table · 表格自动化](#table)
  - workflow（.json）
- [visualization · 可视化图表](#visualization)
  - csv（.json/.csv）
  - properties（.json/.csv）
- [writer · 所思所想](#writer)
  - canvas（.zc）
  - library（.zwlib）
- [zenbackup · 统一备份](#zenbackup)
  - manifest（.json）
- [zencard · 间隔复习](#zencard)
  - card（.json）
  - pack（.json）
- [zenclip · 网页剪藏](#zenclip)
  - pack（.json）
- [zenflow · 自动化编排](#zenflow)
  - rules（.json）
- [zenreview · 复盘报告](#zenreview)
  - inputs（.json）
  - timeline（.json）

---

<a id="annotate"></a>

## annotate · 文本标注

### `backup` · .json

- 契约：version=`1`
- 实现源码：`public/omm-annotate.html`
- 深度校验器：`v_annotate`
- 硬门槛：app=zenmark；version 数字 1；project.codes 非空

| 字段 | 类型 | 必需 |
|---|---|---|
| `app` | string | 是 |
| `version` | number | 是 |
| `exportedAt` | string | 是 |
| `project` | object | 是 |

最小示例：

```json
{
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
}
```

### `bridge` · .json

- 契约：format=`bridge`，version=`1`
- 实现源码：`public/omm-annotate.html`
- 深度校验器：`v_annotate`
- 硬门槛：omm=bridge；v 数字 1；items 是数组

| 字段 | 类型 | 必需 |
|---|---|---|
| `omm` | string | 是 |
| `v` | number | 是 |
| `kind` | string | 是 |
| `items` | array | 是 |

最小示例：

```json
{
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
}
```

---

<a id="corpus"></a>

## corpus · 英语语料库

### `bridge` · .json

- 契约：format=`bridge`，version=`1`
- 实现源码：`public/omm-corpus.html`
- 深度校验器：`v_corpus`
- 硬门槛：omm=bridge；v 数字 1；items 是数组

| 字段 | 类型 | 必需 |
|---|---|---|
| `omm` | string | 是 |
| `v` | number | 是 |
| `kind` | string | 是 |
| `items` | array | 是 |

最小示例：

```json
{
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
}
```

### `restore` · .json

- 契约：version=`2`
- 实现源码：`public/omm-corpus.html`
- 深度校验器：`v_corpus`
- 硬门槛：entries 非空；categories 非空；entry.categoryId 指向真实分类

| 字段 | 类型 | 必需 |
|---|---|---|
| `version` | number | 是 |
| `categories` | array | 是 |
| `entries` | array | 是 |

最小示例：

```json
{
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
}
```

---

<a id="data"></a>

## data · 数据工作台

### `csv` · .json/.csv

- 契约：无固定 token
- 实现源码：`public/omm-data.html`
- 深度校验器：`v_data`
- 硬门槛：每行列数一致；首列表头非空

最小示例：

```json
"列一,列二\n值,1\n"
```

### `rows` · .json/.csv

- 契约：无固定 token
- 实现源码：`public/omm-data.html`
- 深度校验器：`v_data`
- 硬门槛：顶层数组或 {rows:[…]}；禁止 tables 字段

| 字段 | 类型 | 必需 |
|---|---|---|
| `—` | array | 是 |

最小示例：

```json
[
  {
    "列一": "值",
    "列二": 1
  }
]
```

---

<a id="english"></a>

## english · 六级备考

### `backup` · .json

- 契约：无固定 token
- 实现源码：`public/omm-english.html`
- 深度校验器：`v_english`
- 硬门槛：同时有 books 与 prog 对象

| 字段 | 类型 | 必需 |
|---|---|---|
| `books` | object | 是 |
| `prog` | object | 是 |

最小示例：

```json
{
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
}
```

### `bridge` · .json

- 契约：format=`bridge`，version=`1`
- 实现源码：`public/omm-english.html`
- 深度校验器：`v_english`
- 硬门槛：omm=bridge；v 数字 1；items 是数组

| 字段 | 类型 | 必需 |
|---|---|---|
| `omm` | string | 是 |
| `v` | number | 是 |
| `items` | array | 是 |

最小示例：

```json
{
  "omm": "bridge",
  "v": 1,
  "items": [
    {
      "t": "word",
      "w": "word",
      "m": "单词"
    }
  ]
}
```

### `doodles` · .json

- 契约：无固定 token
- 实现源码：`public/omm-english.html`
- 深度校验器：`v_english`
- 硬门槛：drawings 键小写；点坐标 x∈[0,1200], y∈[0,800], p∈[0.15,1]

| 字段 | 类型 | 必需 |
|---|---|---|
| `drawings` | object | 是 |

最小示例：

```json
{
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
}
```

### `wordbook` · .json

- 契约：无固定 token
- 实现源码：`public/omm-english.html`
- 深度校验器：`v_english`

| 字段 | 类型 | 必需 |
|---|---|---|
| `—` | array | 是 |

最小示例：

```json
[
  {
    "w": "word",
    "ph": "/wɜːd/",
    "m": "单词",
    "ex": "Example sentence."
  }
]
```

---

<a id="hub"></a>

## hub · 静书房

### `ai-config` · .json

- 契约：无固定 token
- 实现源码：`public/omm-hub.js`
- 深度校验器：`v_hub`
- 硬门槛：不得包含 apiKey/密码/令牌

| 字段 | 类型 | 必需 |
|---|---|---|
| `provider` | string | 是 |
| `apiBase` | string | 是 |
| `apiModel` | string | 是 |
| `apiKey` | string | 是 |
| `system` | string | 是 |

最小示例：

```json
{
  "provider": "deepseek",
  "apiBase": "https://api.deepseek.com",
  "apiModel": "deepseek-chat",
  "apiKey": "",
  "system": ""
}
```

---

<a id="lambda"></a>

## lambda · Lambda 演算计算器

### `session` · .json

- 契约：format=`omm-lambda-session`，version=`1`
- 实现源码：`public/index.html`
- 深度校验器：`v_lambda`
- 硬门槛：format="omm-lambda-session"；version 数字 1；sid 非空字符串；code 顶层非空数组，元素均为字符串

| 字段 | 类型 | 必需 |
|---|---|---|
| `sid` | string | 是 |
| `name` | string | 否 |
| `lang` | string | 否 |
| `code` | array | 是 |

最小示例：

```json
{
  "format": "omm-lambda-session",
  "version": 1,
  "sid": "l-sess-0001",
  "name": "示例会话",
  "lang": "both",
  "code": [
    "?num = 3",
    "PLUS ONE TWO"
  ]
}
```

### `share` · .json

- 契约：format=`omm-lambda-share`，version=`1`
- 实现源码：`public/json-specs/lambda.md`
- 深度校验器：`v_lambda`
- 硬门槛：format="omm-lambda-share"；version 数字 1；id 非空字符串

| 字段 | 类型 | 必需 |
|---|---|---|
| `id` | string | 是 |

最小示例：

```json
{
  "format": "omm-lambda-share",
  "version": 1,
  "id": "ab12cd34ef"
}
```

---

<a id="latex"></a>

## latex · LaTeX 编译工作台

### `tex` · .tex

- 契约：无固定 token
- 实现源码：`public/omm-latex.html`
- 深度校验器：`v_latex`
- 硬门槛：documentclass 存在；begin/end document 成对；禁止 input/include/write18

最小示例：

```json
"\\documentclass[UTF8]{ctexart}\n\\begin{document}\n标题与正文。\n\\end{document}\n"
```

---

<a id="mdforge"></a>

## mdforge · Markdown 铸造台

### `markdown` · .markdown

- 契约：无固定 token
- 实现源码：`public/omm-mdforge.html`
- 深度校验器：`v_mdforge`
- 硬门槛：YAML frontmatter；title 非空；template: academic

最小示例：

```json
"---\ntitle: 标题\ntemplate: academic\n---\n\n# 正文标题\n\n段落……\n\n# 参考文献\n"
```

---

<a id="message"></a>

## message · 消息同步

### `unsupported` · —

- 契约：无固定 token
- 实现源码：`public/omm-message.html`
- 深度校验器：`v_message`
- 硬门槛：没有文件导入入口

| 字段 | 类型 | 必需 |
|---|---|---|
| `note` | string | 是 |

最小示例：

```json
{
  "note": "本产品没有文件导入；只可产出 localStorage 配置，且不含密钥"
}
```

---

<a id="planner"></a>

## planner · 日程安排

### `backup` · .json

- 契约：version=`2`
- 实现源码：`public/omm-planner.html`
- 深度校验器：`v_planner`
- 硬门槛：app=zenplan；version 数字 2；planners 是数组

| 字段 | 类型 | 必需 |
|---|---|---|
| `app` | string | 是 |
| `version` | number | 是 |
| `exportedAt` | string | 是 |
| `planners` | array | 是 |
| `activeId` | string | 是 |
| `eventsBy` | object | 是 |
| `recursBy` | object | 是 |

最小示例：

```json
{
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
}
```

---

<a id="redact"></a>

## redact · 文档脱敏工具

### `unsupported` · —

- 契约：无固定 token
- 实现源码：`public/omm-redact.html`
- 深度校验器：`v_redact`
- 硬门槛：.json 被白名单拒绝

| 字段 | 类型 | 必需 |
|---|---|---|
| `note` | string | 是 |

最小示例：

```json
{
  "note": "本产品拒绝 .json 导入；只可产出 zr-settings 用于 localStorage"
}
```

---

<a id="search"></a>

## search · 智能搜索

### `export` · .json

- 契约：无固定 token
- 实现源码：`public/omm-search.html`
- 深度校验器：`v_search`
- 硬门槛：settings 是对象，history 是数组

| 字段 | 类型 | 必需 |
|---|---|---|
| `settings` | object | 是 |
| `history` | array | 是 |

最小示例：

```json
{
  "settings": {
    "apiBase": "https://api.deepseek.com",
    "apiModel": "deepseek-chat"
  },
  "history": []
}
```

---

<a id="video"></a>

## video · 视频工作台

### `workflow` · .json

- 契约：format=`omm-video-workflow`，version=`1`
- 实现源码：`public/lib/zen-video.js`
- 深度校验器：`v_video`
- 硬门槛：format="omm-video-workflow"；version 数字 1；nodes 顶层数组；connections 顶层数组

| 字段 | 类型 | 必需 |
|---|---|---|
| `nodes` | array | 是 |
| `connections` | array | 是 |

最小示例：

```json
{
  "format": "omm-video-workflow",
  "version": 1,
  "nodes": [
    {
      "id": "n-input-1",
      "type": "input",
      "title": "视频输入",
      "data": {
        "fileId": "",
        "filename": ""
      }
    },
    {
      "id": "n-trim-1",
      "type": "trim",
      "title": "片段裁剪",
      "data": {
        "start": 0,
        "duration": 10
      }
    },
    {
      "id": "n-format-1",
      "type": "format",
      "title": "编码与格式",
      "data": {
        "format": "mp4",
        "crf": 23,
        "preset": "medium"
      }
    },
    {
      "id": "n-export-1",
      "type": "export",
      "title": "导出文件",
      "data": {
        "filename": "output.mp4",
        "format": "mp4"
      }
    }
  ],
  "connections": [
    {
      "from": "n-input-1",
      "to": "n-trim-1",
      "fromPort": "right",
      "toPort": "left"
    },
    {
      "from": "n-trim-1",
      "to": "n-format-1",
      "fromPort": "right",
      "toPort": "left"
    },
    {
      "from": "n-format-1",
      "to": "n-export-1",
      "fromPort": "right",
      "toPort": "left"
    }
  ]
}
```

---

<a id="table"></a>

## table · 表格自动化

### `workflow` · .json

- 契约：format=`omm-table-workflow`，version=`1`
- 实现源码：`public/lib/zen-table.js`
- 深度校验器：`v_table`
- 硬门槛：format="omm-table-workflow"；version 数字 1；nodes 顶层数组；connections 顶层数组；有且只有一个 file 节点

| 字段 | 类型 | 必需 |
|---|---|---|
| `nodes` | array | 是 |
| `connections` | array | 是 |

最小示例：

```json
{
  "format": "omm-table-workflow",
  "version": 1,
  "nodes": [
    {
      "id": "n-file",
      "type": "file",
      "title": "Excel 文件与区域",
      "data": {
        "fileId": "",
        "filename": "",
        "sheetMode": "one",
        "sheet": "",
        "selected": [],
        "rangeMode": "auto",
        "startCell": "A1",
        "endCell": "",
        "headerRow": 0,
        "overrides": []
      }
    },
    {
      "id": "n-map",
      "type": "mapCells",
      "title": "时间分档",
      "data": {
        "columns": "C:AG",
        "step": 1,
        "op": "lastTimeLookup",
        "lookupKind": "time",
        "lookup": [
          {
            "min": "",
            "max": "18:55",
            "result": 0
          },
          {
            "min": "18:56",
            "max": "19:24",
            "result": 1
          },
          {
            "min": "19:25",
            "max": "19:54",
            "result": 1.5
          },
          {
            "min": "19:55",
            "max": "20:24",
            "result": 2
          },
          {
            "min": "20:25",
            "max": "20:54",
            "result": 2.5
          },
          {
            "min": "20:55",
            "max": "",
            "result": 3
          }
        ],
        "defaultResult": 3,
        "sourceSkipEmpty": true
      }
    },
    {
      "id": "n-write",
      "type": "write",
      "title": "写回（插入空行）",
      "data": {
        "columns": "C:AG",
        "rowMode": "insertBelow",
        "conflict": "skip",
        "style": "asc",
        "skipEmpty": true,
        "skipZero": true
      }
    },
    {
      "id": "n-sum",
      "type": "writeFormula",
      "title": "行合计",
      "data": {
        "kind": "rowSum",
        "columns": "C:AG",
        "targetColumn": "AH",
        "rowMode": "insertBelow",
        "style": "asc"
      }
    },
    {
      "id": "n-save",
      "type": "save",
      "title": "保存",
      "data": {
        "filename": "结果文件.xlsx"
      }
    }
  ],
  "connections": [
    {
      "from": "n-file",
      "to": "n-map",
      "fromPort": "right",
      "toPort": "left"
    },
    {
      "from": "n-map",
      "to": "n-write",
      "fromPort": "right",
      "toPort": "left"
    },
    {
      "from": "n-write",
      "to": "n-sum",
      "fromPort": "right",
      "toPort": "left"
    },
    {
      "from": "n-sum",
      "to": "n-save",
      "fromPort": "right",
      "toPort": "left"
    }
  ]
}
```

---

<a id="visualization"></a>

## visualization · 可视化图表

### `csv` · .json/.csv

- 契约：无固定 token
- 实现源码：`public/omm-visualization.html`
- 深度校验器：`v_visualization`
- 硬门槛：角色列模型：类别列 + 数值列

最小示例：

```json
"类别,数值\nA,1\nB,2\n"
```

### `properties` · .json/.csv

- 契约：format=`zenviz-right-properties`，version=`1`
- 实现源码：`public/omm-visualization.html`
- 深度校验器：`v_visualization`
- 硬门槛：kind=zenviz-right-properties；version 数字 1

| 字段 | 类型 | 必需 |
|---|---|---|
| `kind` | string | 是 |
| `version` | number | 是 |
| `engines` | object | 是 |

最小示例：

```json
{
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
}
```

---

<a id="writer"></a>

## writer · 所思所想

### `canvas` · .zc

- 契约：format=`zenwriter-canvas`，version=`2`
- 实现源码：`public/omm-writer.html`
- 深度校验器：`v_writer`
- 硬门槛：顶层 nodes 是数组；节点 id 唯一；连线两端存在且不等

| 字段 | 类型 | 必需 |
|---|---|---|
| `format` | string | 是 |
| `v` | number | 是 |
| `name` | string | 是 |
| `nodes` | array | 是 |
| `connections` | array | 是 |

最小示例：

```json
{
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
      "zenCardId": "zc-1",
      "content": "正文"
    }
  ],
  "connections": []
}
```

### `library` · .zwlib

- 契约：format=`zenwriter-library`
- 实现源码：`public/omm-writer.html`
- 深度校验器：`v_writer`
- 硬门槛：format=zenwriter-library；docs 是对象；docs 中每张画布有 nodes 数组

| 字段 | 类型 | 必需 |
|---|---|---|
| `format` | string | 是 |
| `docs` | object | 是 |

最小示例：

```json
{
  "format": "zenwriter-library",
  "v": 2,
  "docs": {
    "doc-a": {
      "name": "第一张",
      "nodes": [
        {
          "id": "node-1",
          "type": "text",
          "x": 100,
          "y": 100,
          "zenCardId": "zc-1",
          "content": "正文"
        }
      ]
    }
  }
}
```

---

<a id="zenbackup"></a>

## zenbackup · 统一备份

### `manifest` · .json

- 契约：format=`zen-backup`，version=`1`
- 实现源码：`public/lib/zen-backup.js`
- 深度校验器：`v_zenbackup`
- Golden fixture：`zenbackup-manifest.json`
- 硬门槛：format=zen-backup；v 数字 1；checksum 为 data 的 FNV-1a base36

| 字段 | 类型 | 必需 |
|---|---|---|
| `format` | string | 是 |
| `v` | number | 是 |
| `createdAt` | string | 是 |
| `name` | string | 是 |
| `products` | array | 是 |

最小示例：

```json
{
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
}
```

---

<a id="zencard"></a>

## zencard · 间隔复习

### `card` · .json

- 契约：format=`zen-card`，version=`1`
- 实现源码：`public/lib/zen-card.js`
- 深度校验器：`v_zencard`
- Golden fixture：`zencard-card.json`
- 硬门槛：format=zen-card；v 数字 1；content 非空；kind/source 在枚举内；tags 是数组

| 字段 | 类型 | 必需 |
|---|---|---|
| `format` | string | 是 |
| `v` | number | 是 |
| `id` | string | 是 |
| `kind` | string | 是 |
| `source` | string | 是 |
| `content` | string | 是 |
| `tags` | array | 是 |
| `createdAt` | string | 是 |
| `updatedAt` | string | 是 |

枚举：
- `kind`：quote/note/word/sentence/idea/todo/fact/image
- `source`：manual/writer/annotate/corpus/english/search/data/web/clip

最小示例：

```json
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
```

### `pack` · .json

- 契约：format=`zen-card-pack`，version=`1`
- 实现源码：`public/lib/zen-card.js`
- 深度校验器：`v_zencard`
- Golden fixture：`zencard-pack.json`
- 硬门槛：format=zen-card-pack；v 数字 1；cards 是数组；cards[] 每张通过 zen-card 校验

| 字段 | 类型 | 必需 |
|---|---|---|
| `format` | string | 是 |
| `v` | number | 是 |
| `name` | string | 是 |
| `cards` | array | 是 |

最小示例：

```json
{
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
}
```

---

<a id="zenclip"></a>

## zenclip · 网页剪藏

### `pack` · .json

- 契约：format=`zen-card-pack`，version=`1`
- 实现源码：`public/lib/zen-card.js`
- 深度校验器：`v_zenclip`
- 硬门槛：format=zen-card-pack；cards 是数组；cards[] 每张通过 zen-card 校验

| 字段 | 类型 | 必需 |
|---|---|---|
| `format` | string | 是 |
| `v` | number | 是 |
| `name` | string | 是 |
| `cards` | array | 是 |

最小示例：

```json
{
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
}
```

---

<a id="zenflow"></a>

## zenflow · 自动化编排

### `rules` · .json

- 契约：format=`zen-flow`，version=`1`
- 实现源码：`public/lib/zen-flow.js`
- 深度校验器：`v_zenflow`
- Golden fixture：`zenflow-rules.json`
- 硬门槛：format=zen-flow；v 数字 1；actions.type 在允许枚举内；rules[] 每项通过 validateRule

| 字段 | 类型 | 必需 |
|---|---|---|
| `format` | string | 是 |
| `v` | number | 是 |
| `rules` | array | 是 |

最小示例：

```json
{
  "format": "zen-flow",
  "v": 1,
  "rules": [
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
  ]
}
```

---

<a id="zenreview"></a>

## zenreview · 复盘报告

### `inputs` · .json

- 契约：无固定 token
- 实现源码：`public/lib/zen-review.js`
- 深度校验器：`v_zenreview`
- 硬门槛：timeline / planner 都是数组

| 字段 | 类型 | 必需 |
|---|---|---|
| `timeline` | array | 是 |
| `planner` | array | 是 |

最小示例：

```json
{
  "timeline": [],
  "planner": []
}
```

### `timeline` · .json

- 契约：无固定 token
- 实现源码：`public/lib/zen-review.js`
- 深度校验器：`v_zenreview`
- 硬门槛：顶层是数组

| 字段 | 类型 | 必需 |
|---|---|---|
| `—` | array | 是 |

最小示例：

```json
[
  {
    "app": "writer",
    "ts": "2026-01-01T00:00:00Z",
    "title": "完成事项"
  }
]
```

---
