# ZenCard 通用知识卡片规范（跨产品中间格式）

> 用途：一套**最小、统一、无依赖**的中间格式，让标注 / 搜索 / 语料 / 英语 / 写作 / 数据
> 之间的内容搬运不再为每对产品写一次性转换。任何产品只要能产出或消费 `zen-card`，
> 就能与整个 OMM-ZEN 生态互通。
>
> 本规范与实现同源：`public/zen-card.js`（`create` / `validate` / `parse` / `serialize`
> 与各 `from*` / `to*` 转换函数）。字段名、默认值和容错都以该模块为准，
> `tests/test_zencard.mjs` 逐项验证，共 18 项断言。

---

## 0. 一句话规则

**一张卡片就是一个对象：`format:"zen-card"`、`v:1`、非空 `content`，`kind` 与 `source`
在枚举内，`tags` 是数组。** `create()` 会把任意输入归一化成满足这些条件的合法卡片，
`validate()` 做严格校验，二者都不抛异常（解析非法 JSON 除外）。

---

## 0.5 给 AI 的提示词模板

把下面这段连同本文一起发给 AI，让它直接产出可导入的卡片包：

```text
你要生成一个 ZenCard 知识卡片包（.json，UTF-8），用于「导入卡片包」。只输出 JSON 本身，
不要 Markdown 代码块围栏、不要注释、不要尾逗号。

顶层：
{
  "format": "zen-card-pack",
  "v": 1,
  "name": "卡片包名",
  "cards": [ <卡片>, <卡片>, ... ]
}

每张卡片：
{
  "format": "zen-card",
  "v": 1,
  "id": "zc-唯一标识",
  "kind": "quote|note|word|sentence|idea|todo|fact|image",
  "source": "manual|writer|annotate|corpus|english|search|data|web|clip",
  "ref": "出处，可空字符串",
  "content": "正文，必填非空",
  "translation": "译文/释义，可空字符串",
  "note": "我的批注，可空字符串",
  "tags": ["标签"],
  "color": "#rrggbb，可空字符串",
  "createdAt": "ISO 8601，如 2026-01-02T03:04:05.000Z",
  "updatedAt": "ISO 8601，同上"
}

硬性：
- format/v 必须一字不差（v 是数字 1，不是 "1"）。
- 每张卡片 content 必须非空；kind/source 必须在枚举内；tags 必须是数组。
- id 全局唯一；createdAt/updatedAt 用 ISO 8601。
- 可选字段 links：[{"rel":"related","id":"另一张卡片的id"}]；image：图片地址。
- 可选字段可整体省略，导入时会用默认值补全。

最小示例：
{
  "format":"zen-card-pack","v":1,"name":"最小示例",
  "cards":[
    {"format":"zen-card","v":1,"id":"zc-1","kind":"quote","source":"annotate",
     "ref":"论文 p.12","content":"知识是思考的沉淀。","translation":"",
     "note":"这句可作为写作引用","tags":["精读"],"color":"",
     "createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z"}
  ]
}
输出前自查：format/v 正确、每张卡片 content 非空、枚举取值合法、id 唯一、时间格式正确。
```

---

## 1. 字段定义

| 字段 | 类型 | 必需 | 默认 | 说明 |
|---|---|---|---|---|
| `format` | string | 是 | `zen-card` | 固定 `zen-card` |
| `v` | number | 是 | `1` | 必须是数字 `1` |
| `id` | string | 是 | 自动生成 | 唯一标识，形如 `zc-…` |
| `kind` | enum | 是 | `note` | `quote/note/word/sentence/idea/todo/fact/image` |
| `source` | enum | 是 | `manual` | `manual/writer/annotate/corpus/english/search/data/web/clip` |
| `ref` | string | 否 | `""` | 出处：页码、URL、书名、时间戳 |
| `content` | string | 是 | — | 正文核心，**非空** |
| `translation` | string | 否 | `""` | 译文 / 中文释义 / 英文对照 |
| `note` | string | 否 | `""` | 我的批注、补充说明 |
| `tags` | string[] | 是 | `[]` | 已去重、去空白 |
| `color` | string | 否 | `""` | `#rrggbb`，用于画布/卡片着色 |
| `createdAt` | ISO 8601 | 是 | 当前时间 | 非法日期回退为当前时间 |
| `updatedAt` | ISO 8601 | 是 | 当前时间 | 同上 |
| `links` | object[] | 否 | 省略 | `[{rel,id}]`，构成知识图谱的边 |
| `image` | string | 否 | 省略 | 图片地址 / data URL |

`create()` 接受的别名：`text`/`en` → `content`，`zh` → `translation`，`notes` → `note`。

---

## 2. 卡片包（批量）

让 AI 一次产出多张卡片时用外层 `zen-card-pack`：顶层 `format:"zen-card-pack"`、`v:1`、
可选的 `name`、以及 `cards` 数组（每张是第 1 节的合法卡片）。`parsePack()` 会把每张
卡片过一遍 `create()` 归一化。

---

## 3. 去重与合并

- `fingerprint(card)`：基于 `kind + content + translation` 的稳定哈希，
  同一段内容即使 `id` 不同也得到相同指纹。
- `merge(cards, { byFingerprint:true, sort:true })`：先按 `id` 去重，再按指纹去重，
  最后按 `createdAt` 升序排列。这是跨产品汇总时避免重复条目的标准入口。

---

## 4. 与其他产品格式的转换

`zen-card.js` 提供纯函数双向转换，全部通过 `tests/test_zencard.mjs` 验证：

| 方向 | 函数 | 目标格式 |
|---|---|---|
| 语料 → 卡 / 卡 → 语料 | `fromCorpusEntry` / `toCorpusEntry` | `{en,zh,categoryId,type,tags,…}` |
| 批注 → 卡 / 卡 → 批注 | `fromAnnotateMark` / `toAnnotateMark` | `{quote,start,end,sty,note}` |
| 英语桥接包 → 卡 / 卡 → 桥接包 | `fromEnglishBridge` / `toEnglishBridge` | `{t:"word"|"sentence"|"doc",…}` |
| 卡 → 画布节点 / 整张画布 | `toWriterNode` / `toWriterCanvas` | `.zc` 的 `text` 节点 |
| 卡 → Writer 实际插入 | Writer 右键「插入知识卡片…」 | 带出处与批注的 `text` 节点，节点带 `data-zen-card-id` |

Writer 还可通过右键「插入图表…」把 CSV 渲染成自包含 SVG（data URL）作为 `image` 节点，
通过「时间机器…」列出工作台存档并二次确认后恢复。
| 卡 → 数据表行 / 行 → 卡 | `toDataRow` / `fromDataRow` | ZenData 行对象 |
| 数据表 → 图表数据 | `DataViz.toPayload` / `VizBridge.send` | 数据工作台「一键出图」→ ZenViz |
| 搜索结果 → 卡 | `fromSearchResult` | 搜索摘要对象 |
| 搜索历史 → 卡 / 卡 → 历史 | `SearchLibrary.toCard` / `fromCard` | 智能搜索知识库（全文检索、置顶、卡片包导入导出） |
| 网页选中 → 卡 | `fromWebSelection` | 选区 / 剪藏 |
| 卡 → Markdown | `toMarkdown` | 引用块 + 来源脚注 |

---

## 5. Hub 知识图谱

静书房 Hub 工具栏的「知识图谱」按钮会收集生态内的卡片并绘制关系图：

- Hub 读取自身域名下的 `zen.cards.v1`、`zen.inbox.v1`、`zen.clip.v1`；
- 同时向每个已打开产品的 iframe 发送 `omm:zen-card-request`，产品端通过
  `zen-link.js` 回传 `omm:zen-card-reply`（携带自己的同类 localStorage 数据）；
- 卡片按 `id` 去重，最多显示 120 个节点；`links` 形成引用边，共享 `tags` 形成同标签边；
- 跨 iframe 请求一律用该 iframe 自身 URL 推导的 origin（`frameTargetOrigin`），
  产品端回信用 `omm_hub_origin` 参数或 referrer 推导的明确 origin，不使用通配符。

Hub 工具栏的「数据流」面板读取插件清单的 `share.channels`，按通道列出发布 / 消费 / 双向
角色，并记录近期共享与卡片流转事件，便于观察内容如何在产品间移动。

## 6. 常见坑

- **v 是数字**：`v:"1"` 会被判非法。
- **content 不能只有空白**：`create()` 不去 trim 正文，但 `validate()` 要求 trim 后非空。
- **字段别名只在 create 生效**：`validate()` 看的是规范化后的字段，直接手写对象要用正式字段名。
- **图片节点**：`kind:"image"` 时把地址放 `image`，画布节点生成仍按文本处理，避免 blob/link 模式。
