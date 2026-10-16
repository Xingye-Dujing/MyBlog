# OMM-ZEN 项目 · JSON 导入规范集

> 目的：把「某个项目的导入规范」发给 AI，AI 就能依据需求直接生成**该项目能导入**的文件。
> 每份规范都是**逐行核对源码**写出的（导入/恢复函数 + 导出/备份构造函数交叉验证），
> 字段名、默认值、容错、硬性校验都以代码为准，不是推测。

---

## 0. 怎么用

1. 在下面的总表里找到目标项目。
2. 把对应的 `xxx.md` **整份**发给 AI（连同你的需求，例如「生成一张 5 节点的阅读脑图」）。
3. 让 AI **只输出该文件内容**（规范里都有「给 AI 的提示词模板」一节，可直接套用）。
4. 存成对应扩展名，在应用里走「导入 / 从 JSON 恢复 / 导入文件」即可。

> 提示：规范里的 ```json 示例块都已通过严格 JSON 解析校验，可直接复制导入做冒烟测试。

**图省事？** 直接看 [`prompts.md`](prompts.md) —— 每个项目一段**自包含的一页提示词**（含硬门槛+字段骨架+最小示例），整段复制发给 AI 即可，不必附带整份规范。

---

## 1. 总表（哪个项目导哪种文件）

| 项目 | 源文件 | 应用名 | 导入入口 | AI 该生成的东西 | 扩展名 | 顶层硬性要求（不满足就导入失败） |
|---|---|---|---|---|---|---|
| [Writer](writer.md) | `omm-writer.html` | ZenWriter | 导入文件 | 画布对象 | `.zc` | 顶层有 `nodes` 数组 |
| [Annotate](annotate.md) | `omm-annotate.html` | ZenMark | 导入（项目备份）/ 导入互通包 | 项目备份对象 | `.json` | `project.codes` 是数组（整库替换） |
| [Corpus](corpus.md) | `omm-corpus.html` | ZenCorpus | 导入 / 从 JSON 恢复 | 全量备份对象 | `.json` | **同时**有 `entries[]` 与 `categories[]` |
| [Data](data.md) | `omm-data.html` | ZenData | 从文件导入 / 从文本导入 | 数据集（数组） | `.json`/`.csv`/`.tsv` | 顶层是数组，或 `{rows:[...]}` |
| [English](english.md) | `omm-english.html` | Zenglish | 导入词库 / 导入涂鸦 / 恢复备份 / 互通包 | 见规范（4 类） | `.json`/文本 | 词库=数组或 `{words}`；恢复备份=**同时**有 `books` 与 `prog` |
| [Planner](planner.md) | `omm-planner.html` | ZenPlan | 导入（追加记录） | 计划本备份 | `.json` | `version:2` 且 `planners[]` 是数组（否则走 events 字典分支） |
| [Visualization](visualization.md) | `omm-visualization.html` | ZenViz | 导入右侧属性设置 | 属性设置对象 | `.json` | `kind:"zenviz-right-properties"` 且 `version:1` |
| [Latex](latex.md) | `omm-latex.html` | ZenLatex | 导入 .tex | **LaTeX 源码**（非 JSON） | `.tex` | 无 JSON 文件导入；只吃 `.tex` 文本 |
| [Redact](redact.md) | `omm-redact.html` | ZenRedact | 导入文本/图片 | **无** | — | 无 JSON 文件导入（仅 txt/docx/pdf/pptx/image） |
| [Message](message.md) | `omm-message.html` | ZenMessage | — | **无**（Supabase） | — | 无文件导入；消息在云端且加密 |

---

## 2. 按「能不能让 AI 生成可导入文件」分类

**✅ 支持 AI 直接生成可导入的 JSON（主力场景）**
- Writer `.zc`、Annotate 项目备份、Corpus 恢复、English 四类、Planner 备份、Data 数据集、Visualization 右侧属性。

**⚠️ 有导入但不是 JSON**
- **Data / Visualization 的图表数据**用 **CSV/TSV/XLSX**（Visualization 内部是 `{headers,rows}`，但导入通道只吃分隔符文本）。要出图就让 AI 生成符合「角色列模型」的 CSV，见 visualization.md 第 6 节。
- **Latex** 只导入 `.tex`。跨设备迁移路径是「导出 .tex → 导入 .tex」。

**⛔ 没有 JSON 文件导入（规范已如实说明）**
- **Redact**：白名单 `txt/docx/pdf/pptx + 图片`，`.json` 直接拒绝。
- **Message**：Supabase 实时消息，`FileReader`/文件输入都不存在；消息 `payload` 用本地口令派生密钥加密，AI 无法伪造。
  这两份规范改以「持久化 JSON / 数据模型参考」的形式给出，仅供理解，不可当导入文件投喂。

---

## 3. 几个最容易踩的坑（速记）

- **整体替换 vs 追加**：Corpus / Annotate 项目备份是**整库替换**（内置内容不自动保留，要留就自己写进数组）；Planner / English 词库是**追加去重**。
- **坐标用字符偏移**：Annotate 的批注/高亮按 **JS 字符下标** `start/end` 定位，`quote` 必须等于 `doc.text.slice(start,end)`，否则定位错乱。
- **别生成 PDF 版面**：Annotate 的 PDF 版面存在 IndexedDB，JSON 带不走；伪造 `kind:"pdf"` 只会显示「本机未缓存」。
- **版本号是数字**：Planner 的 `version` 必须是数字 `2`；Visualization 属性文件 `version` 必须是数字 `1`，写字符串会判定失败。
- **English 先词库后涂鸦**：涂鸦按单词短边贴合居中，键必须匹配已存在的单词，所以导入顺序是 A 词库 → B 涂鸦。
- **纯 JSON**：所有交付文件都是 **UTF-8 合法 JSON**，无注释、无尾逗号（Writer 的 `.zc` 同理）。

---

## 4. 文件清单

```
json-specs/
├── README.md          本索引
├── prompts.md         ★ 各项目「一页提示词」，复制即用（自包含，无需附整份规范）
├── writer.md          ZenWriter 画布 (.zc)         ← 亦为根目录 zencanvas-JSON-spec.md 的副本
├── annotate.md        ZenMark  项目备份 / 互通包 (.json)
├── corpus.md          ZenCorpus 恢复 / 互通包 (.json)
├── data.md            ZenData  数据集 / 文本导入 (.json)
├── english.md         Zenglish 词库/涂鸦/备份/互通包 (.json)
├── planner.md         ZenPlan  计划本备份 (.json)
├── visualization.md   ZenViz   右侧属性设置 (.json) + 数据角色模型
├── latex.md           ZenLatex 仅 .tex（含 JSON 持久化说明）
├── redact.md          ZenRedact 无 JSON 导入（数据模型参考）
└── message.md         ZenMessage 无文件导入（数据模型/加密说明）
```

> 根目录的 `zencanvas-JSON-spec.md`（Writer 画布原始规范）保留未动；`json-specs/writer.md` 是其副本，方便和本目录其它规范一起打包发给 AI。
