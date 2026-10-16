# ZenMark 项目备份文件 JSON 规范 (`zenmark-project.json`)

> 目标应用：`omm-annotate.html`（内部代号 **ZenMark** / OMM Annotate，一款
> 质性文本编码 + 阅读批注的单文件网页应用）。
>
> 用途：让 AI（或任何程序）**直接生成一个可导入的项目备份 `.json`**，用户在
> ZenMark 里「导入」→ 选中该文件 → 确认后，**当前全部数据被这个文件替换**。
>
> 本文所有字段名、默认值、容错行为都是从 `omm-annotate.html` 的
> `Export.json()`（写出，约 10731 行）、`importFiles()` 项目备份分支
> （读入，约 10981-11016 行）、`Store.load()`（本地装载时的缺省与颜色迁移，
> 约 5931-5953 行）以及各对象构造函数（`seed()` / `saveMark()` / `addNote()`
> 等）里**逐行核对**出来的，不是推测。
>
> 兼容性：`version: 1`。当前导入代码**不校验** `version`，但请保留它。

---

## 0. 一句话规则

**导入分三条互斥路径，先看顶层有没有 `omm:"bridge"`，再看 `project.codes`
是不是数组：**

```
if (o && o.omm === 'bridge')              -> 当作「互通包」，转成笔记/材料（追加，不替换）
var pr = o && o.project ? o.project : o
if (!pr || !Array.isArray(pr.codes))      -> throw 'bad' → 提示「项目文件解析失败」，什么都不变
else                                       -> 当作「项目备份」，弹确认后整体替换 ✅ 你要走的就是这条
```

所以 AI 生成的文件要让导入器认它，**唯一的硬性要求是：能解析出 `codes` 数组**
（放在顶层，或放在 `project` 里）。其余字段全部可选，缺省见第 3-9 节。

导入永远是**整体替换**，**不是合并**：`docs/codes/anns/rels/memos/marks/notes`
六个数组会被你文件里的内容**原样接管**，旧数据全没了（导入前会弹
「检测到项目备份，导入将替换当前全部数据，确定继续？」）。

---

## 0.5 给 AI 的提示词模板

把下面这段连同本文一起发给 AI，让它直接产出可导入的 `.json`：

```text
你要生成一个 ZenMark（omm-annotate.html）项目备份文件（.json，UTF-8）。
严格遵守配套文档《annotate.md》里的字段、缺省值和容错规则。硬性要求：

1. 顶层输出 { "app":"zenmark", "version":1, "exportedAt":"YYYY-MM-DD HH:mm", "project":{...} }。
2. project 里至少要有 "codes" 数组（非空也行、空数组也行，但必须是数组），
   否则导入器判定为坏文件。
3. 每个 code 必须有唯一 "id"（格式 c+字母数字）与 "level"（open|axial|selective 之一）；
   "color" 只能用文档第 4 节列出的 12 个十六进制值之一，否则会被系统改色。
4. 每个 doc 必须有唯一 "id"（格式 d+字母数字）和 "text"（正文字符串）；
   "kind" 一律写 "text"，绝不要写 "pdf"（PDF 版面存在浏览器 IndexedDB，JSON 带不走）。
5. 每个 ann（编码片段）的 "start"/"end" 是**字符下标**，必须落在它所属 doc.text 里，
   且 quote 必须严格等于 doc.text.slice(start,end)；"code" 必须是真实存在的 code id，
   "doc" 必须是真实存在的 doc id；"status" 取 "done" 或 "review"。
6. 每个 mark（阅读批注）同理用 start/end 定位到 doc.text；"sty" 取
   note|hl|ul|st|code 之一；不写 color 时系统默认第一个高亮色。
7. 所有 id 全局唯一、绝不重复；引用类字段（ann.code/ann.doc/mark.doc/
   memo.codes[]/rel.a/rel.b/note.doc）必须指向同一文件里真实存在的 id。
8. "ts" 用 "YYYY-MM-DD HH:mm" 字符串；不要写成 epoch 毫秒。
9. 不生成 settings、不生成任何 blob:/data: 版面、不生成 PDF 专有字段。
10. 只输出 JSON 本身：UTF-8 编码、合法 JSON，不要 markdown 代码块围栏，
    不要注释，不要尾逗号。
```

## 1. 文件外壳

```jsonc
{
  "app": "zenmark",                 // 仅人读用；导入代码不检查它，但建议写
  "version": 1,                     // 格式版本；当前导入不校验，建议保留
  "exportedAt": "2026-09-27 17:55", // 字符串时间戳（非 epoch）；不参与导入判断
  "project": { /* 见第 2 节，真正被导入的内容 */ }
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `app` | 否 | 固定 `"zenmark"`（导出时写死；导入器**不读它**，纯元数据） |
| `version` | 否 | 固定 `1`（导入器**不校验**） |
| `exportedAt` | 否 | `nowStr()` 格式的字符串，导入器**不读** |
| `project` | **是** | 真正的数据容器。**也可以把 project 里的字段直接摊到顶层**——导入器用 `var pr = o.project ? o.project : o` 兜底 |

> ⚠️ **三种 `.json` 别搞混**（都在同一个「导入」入口，但语义完全不同）：
>
> | 格式 | 顶层判别键 | 行为 | AI 该生成哪个 |
> |---|---|---|---|
> | **项目备份**（本文） | 能解析出 `codes` 数组，且**无** `omm:"bridge"` | 弹确认后**整体替换**全部数据 | ✅ **就是这个** |
> | 互通包 bridge | `"omm": "bridge"` | 追加成学习笔记/材料，不替换 | ❌ 不是（那是给 English/Corpus 互通的） |
> | 纯文本/Markdown 材料 | —（根本不是 JSON，走 `.txt`/`.md` 分支） | 追加为新 doc | ❌ 不是 |
>
> 本文只规范**项目备份**这一条路径。AI 只要别写 `omm:"bridge"`，
> 并提供合法的 `codes`，就会命中整体替换分支。

---

## 2. project 对象（外壳内层）

这是被逐个字段接管的部分。**没有 `settings`**——界面设置是另一套云端同步
概念（`SETTINGS_KEY`），项目备份文件既不写、也不读它。

```jsonc
"project": {
  "title": "我的研究项目",   // 缺省则保留当前标题（不覆盖为空）
  "desc": "",               // 缺省 ""
  "docs":  [ /* 第 3 节 材料 */ ],
  "codes": [ /* 第 4 节 码表 */ ],   // ← 唯一硬性要求：必须是数组
  "anns":  [ /* 第 5 节 编码片段 */ ],
  "rels":  [ /* 第 6 节 片段关联 */ ],
  "memos": [ /* 第 7 节 备忘录 */ ],
  "marks": [ /* 第 8 节 阅读批注 */ ],
  "notes": [ /* 第 9 节 学习笔记 */ ]
}
```

| 字段 | 必需 | 缺省（导入分支 `pr.x || []`） | 备注 |
|---|---|---|---|
| `title` | 否 | 保留当前项目标题 | `pr.title \|\| P.title` |
| `desc` | 否 | `""` | |
| `docs` | 否 | `[]`（没有材料，只有空码表） | |
| `codes` | **是** | —— | **缺了它、或不是数组 → 整个文件被判为坏文件，导入中止** |
| `anns` | 否 | `[]` | |
| `rels` | 否 | `[]` | |
| `memos` | 否 | `[]` | |
| `marks` | 否 | `[]` | |
| `notes` | 否 | `[]` | |

导入后 `S.docId` 自动指向 `docs[0]`（有材料的话）。

---

## 3. 材料 `docs[]`

一篇可编码/可批注的文本。正文是**纯文本**（`\n` 分段），编码与批注都用
字符下标定位到这段 `text`。

```jsonc
{
  "id": "dabc123xy0",     // 字符串，全局唯一，建议前缀 d
  "title": "受访者 A 访谈",  // 列表/标题显示
  "source": "深度访谈 · 2026 年 3 月", // 出处，可空
  "type": "访谈转录",       // 体裁标签，自由文本（缺显示 "其他"）
  "date": "2026-03-14",    // 可空
  "note": "示例材料",       // 材料备注，可空
  "text": "第一段\n\n第二段", // ★ 正文，编码/批注都按它的下标定位
  "kind": "text"           // "text" | "pdf"；缺省时载入会被补成 "text"
}
```

| 字段 | 类型 | 缺省行为 | 备注 |
|---|---|---|---|
| `id` | string | 无（不写会导致引用错位） | **必须给**且唯一；导出用 `uid('d')`，形如 `d+base36` |
| `title` | string | 显示为空 | |
| `source` | string | 空 | |
| `type` | string | 空（列表处显示「—」/「其他」） | 自由文本，非枚举 |
| `date` | string | 空 | |
| `note` | string | 空 | |
| `text` | string | —— | **核心字段**，缺了它材料没内容 |
| `kind` | string | 载入时缺省补 `"text"` | ⚠️ 见下方红线 |

> 🚫 **红线：AI 只能生成 `kind:"text"` 的材料，绝不要生成 `kind:"pdf"`。**
> `isPdf(d)` 判据就是 `d.kind === 'pdf'`。PDF 的**版面/原始字节存在本机浏览器
> IndexedDB**，项目备份 JSON **根本不含版面**（应用帮助原文：「原始文件存在本机
> 浏览器数据库，因此备份 JSON 里不含版面」）。AI 凭空写 `kind:"pdf"` 会得到一个
> 「说自己是 PDF 但没有任何版面数据」的坏材料，阅读视图会报「本机未缓存该文件，
> 请重新导入」。**要 PDF 就让用户走原生「导入 PDF」，不要在 JSON 里造。**

---

## 4. 码表 `codes[]`（质性编码的码号）

这是**必须非空数组才有意义**的部分（且它是导入的硬性判据）。三层编码：
`open`（开放式）/ `axial`（轴心式）/ `selective`（选择式）。

```jsonc
{
  "id": "cabc123xy0",     // 字符串，全局唯一，建议前缀 c
  "no": "01",            // 码号编号，显示排序用；自由字符串
  "name": "议题属性",      // 码名
  "level": "open",       // ★ "open" | "axial" | "selective" 之一
  "parent": "",          // 上级码 id（axial 可挂到 open；无则空串）
  "def": "文本讨论的公共议题…",  // 定义
  "incl": "出现明确议题指称",   // 纳入标准
  "excl": "仅作背景交代",      // 排除标准
  "eg": "",              // 例证
  "color": "#4a86d4",    // ★ 必须取自第 4.1 节 12 色板，否则被系统改色
  "memo": ""             // 码号备注
}
```

| 字段 | 类型 | 缺省 / 容错 | 备注 |
|---|---|---|---|
| `id` | string | 无 | **必须给**且唯一 |
| `no` | string | 显示为空 | 建议给，用于排序与 CSV 导出 |
| `name` | string | 空 | |
| `level` | string | 无兜底 | **务必**写三值之一；其它值不会报错但角标/排序错乱 |
| `parent` | string | 空 | 应为真实存在的 code id 或空串 |
| `def`/`incl`/`excl`/`eg`/`memo` | string | 空 | 缺字段=空 |
| `color` | string | **不在 12 色板内 → 被改成 `COLORS[i % 12]`**（按数组下标自动分配） | 见 4.1 |

### 4.1 合法颜色（只有这 12 个十六进制值能保留）

`Store.load()` 会执行 `if (!c.color || COLORS.indexOf(c.color) === -1) c.color = COLORS[i%12]`。
导入后首次刷新即套用此迁移。因此 **`color` 要么不用（让系统自动分配），
要么必须逐字取自下表**，写别的会被悄悄换掉：

```
#4a86d4  #3aa6a0  #5aa45a  #d7b13e  #e0913b  #cf5b54
#c76b9e  #8f74c4  #5b6fc4  #9c7a52  #6b7a8f  #8a8f98
```

---

## 5. 编码片段 `anns[]`（语义编码，挂在文本下标上）

把某段原文（`doc.text` 的 `[start,end)`）标注给某个码号（`code.id`）。

```jsonc
{
  "id": "aabc123xy0",     // 唯一，前缀 a
  "doc": "dabc123xy0",    // ★ 所属材料 id（必须存在）
  "start": 36,            // ★ doc.text 字符下标（含）
  "end": 54,              // ★ doc.text 字符下标（不含）
  "quote": "算法连续给我推了三条同一个事件的视频", // 应= doc.text.slice(start,end)
  "code": "cabc123xy0",   // ★ 码号 id（必须存在）
  "memo": "",             // 片段备注
  "status": "done",       // "done" | "review"
  "ts": "2026-09-27 00:31"
}
```

| 字段 | 类型 | 缺省 / 容错 | 备注 |
|---|---|---|---|
| `id` | string | 无 | **必须给**且唯一 |
| `doc` | string | —— | 指向不存在的 doc：渲染时 `docById` 返回空，出处显示「—」，片段可能画不出来 |
| `start` / `end` | number | —— | **JS 字符串下标**，非字节、非行号；见第 5.1 节 |
| `quote` | string | —— | 描述性存档；**真正定位靠 start/end**（渲染从 `text` 切片）。尽量与切片一致 |
| `code` | string | —— | 指向不存在的 code：该片段无法归到码号（CSV/报告会丢这行） |
| `memo` | string | 空 | |
| `status` | string | 非 `"review"` 一律当作「已确认」 | 二值：`"done"` 或 `"review"` |
| `ts` | string | 空 | `"YYYY-MM-DD HH:mm"` 字符串 |

### 5.1 坐标/偏移规则（关键，务必看懂）

- `start` / `end` 是 **`doc.text` 里的 JavaScript 字符下标**（UTF-16 code unit，
  `String.slice` 的口径），**不是**字节数、不是行号、不是页码、不是 PDF 坐标。
- 分段口径：应用按 `text.split('\n')` 切段，段偏移累加 `len + 1`（换行符也算一格）。
- **`quote` 必须等于 `doc.text.slice(start, end)`**。虽然定位只读下标，但
  一旦二者不一致，列表里显示的引文会和正文高亮错位，且重新编码时体验错乱。
  最稳妥：**先定好 text，再用 `indexOf` 反查 start，end = start + quote.length**。
- `start < end` 才有意义；越界（>text.length）的片段在渲染中会被裁掉、可能不显示。

---

## 6. 片段关联 `rels[]`（可选，多为空数组）

把两个**编码片段**连起来（如「A 导致 B」）。

```jsonc
{ "id": "rabc123xy0", "a": "a片段id1", "b": "a片段id2", "type": "因果" }
```

| 字段 | 必需 | 取值 / 缺省 |
|---|---|---|
| `id` | 是 | 唯一 |
| `a` / `b` | 是 | 真实存在的 **ann id**（不是 doc/code） |
| `type` | 否 | 六选一：`因果 / 对立 / 递进 / 例证 / 条件 / 并列`（缺省 `因果`） |

> 大多数项目 `rels` 就是 `[]`。不确定就别造，造错只会显示一条指向空片段的坏关联。

---

## 7. 备忘录 `memos[]`（理论备忘，可关联多个码号）

```jsonc
{
  "id": "mabc123xy0",     // 唯一，前缀 m
  "title": "关于「情绪先行」的想法",
  "type": "理论备忘录",    // 自由文本标签
  "body": "受访者反复强调…",  // 正文（纯文本/含换行）
  "codes": ["c码id1", "c码id2"], // ★ 关联的 code id 数组（可为空）
  "ts": "2026-09-27 00:31"
}
```

| 字段 | 类型 | 缺省 / 容错 |
|---|---|---|
| `id` | string | **必须给**且唯一 |
| `title` / `type` / `body` | string | 空（`type` 非枚举，自由写） |
| `codes` | array | `[]`；元素必须是真实 code id，指向不存在的会被忽略 |
| `ts` | string | 空 |

---

## 8. 阅读批注 `marks[]`（高亮/下划线/删除线/旁注，按文本下标定位）

**与「编码片段 anns」是两套独立机制**：anns 是语义编码（关联码号），
marks 是阅读时随手画的高亮/旁注（不关联码号）。二者互不干扰，可同时存在。

```jsonc
{
  "id": "kabc123xy0",     // 唯一，前缀 k
  "doc": "dabc123xy0",    // ★ 所属材料 id
  "start": 36,            // ★ doc.text 下标（含）
  "end": 54,              // ★ doc.text 下标（不含）
  "quote": "被标记的那段文字", // 应= doc.text.slice(start,end)
  "sty": "hl",            // ★ note|hl|ul|st|code 之一（缺省按 hl）
  "color": "#f6dd8a",     // 取自第 8.1 节 8 色板；缺省按第一格
  "text": "旁注内容",       // 批注文字（sty:"note" 时用；其它可空）
  "ts": "2026-09-27 00:31"
}
```

| 字段 | 类型 | 缺省 / 容错 |
|---|---|---|
| `id` | string | **必须给**且唯一 |
| `doc` | string | 指向不存在的 doc 则画不出 |
| `start` / `end` | number | 同第 5.1 节，字符下标，`start<end` 才有效 |
| `quote` | string | 描述性；定位仍靠下标 |
| `sty` | string | 缺省 `'hl'`。合法值：`note`(批注)/`hl`(高亮)/`ul`(下划线)/`st`(删除线)/`code`(编码) |
| `color` | string | 缺省 `#f6dd8a`（色板第 1 格）。**不强制**校验色板（与 codes 不同），但请从下表选 |
| `text` | string | 空 |
| `ts` | string | 空 |

### 8.1 批注色板（8 个柔和色，推荐用这些）

```
#f6dd8a  #b6e2a6  #a8cdee  #f2b1c5  #cbb6ea  #f7c28d  #a4dcd4  #c6cfd8
```

---

## 9. 学习笔记 `notes[]`（单词/句子/模板/搭配，用于跨应用互通）

阅读时「收进笔记」的词条。`start`/`end` 记录来源位置（可选，`-1` 表示无来源）。

```jsonc
{
  "id": "nabc123xy0",     // 唯一，前缀 n
  "kind": "word",         // ★ word|sentence|template|phrase
  "en": "abandon",        // 原文/词
  "zh": "抛弃；放弃",       // 释义/译文
  "phon": "/əˈbændən/",   // 音标（仅 word 用）
  "ex": "They had to abandon the car.", // 例句
  "exZh": "他们只能弃车回家。", // 例句译文
  "note": "语境/记忆点",     // 自由备注
  "tags": ["六级", "学术"], // 字符串数组
  "doc": "dabc123xy0",    // 来源材料 id（可空串）
  "src": "材料标题",        // 来源标题（冗余显示用）
  "start": 10,            // 来源下标；无则 -1
  "end": 16,              // 来源下标；无则 -1
  "ts": "2026-09-27 00:31"
}
```

| 字段 | 类型 | 缺省 / 容错 |
|---|---|---|
| `id` | string | **必须给**且唯一 |
| `kind` | string | 合法值：`word`(单词)/`sentence`(句子)/`template`(模板)/`phrase`(搭配) |
| `en` | string | 空 |
| `zh` / `phon` / `ex` / `exZh` / `note` | string | `""` |
| `tags` | array | `[]`（元素是字符串） |
| `doc` | string | `''`；指向不存在的 doc，在阅读区不会画底纹（`!(start>=0)||end<=start` 即跳过） |
| `src` | string | 空 |
| `start` / `end` | number | `-1` 表示无定位 |
| `ts` | string | 空 |

---

## 10. 关于 `id` 的约定（全类型通用）

- 导出器用 `uid(prefix)` 生成：`prefix + Date.now().toString(36) + 随机4位base36`。
  例：`d`+`muilx7yo20ph` = `dmuilx7yo20ph`。
- **应用不会解析你的 id**（不像 ZenWriter 靠 `id.split('-')` 推计数器），
  所以格式相对宽松，但仍强烈建议：
  - **前缀用约定字母**：`d`材料 / `c`码号 / `a`片段 / `m`备忘 / `k`批注 / `n`笔记 / `r`关联。
  - **全局唯一、绝不重复**。同 id 会让 `docById`/`codeById`/引用指向错误。
  - 只用 `[a-z0-9]`，别带 `-`、空格、特殊符号（避免与内部选择器冲突）。
- **多余未知字段会被静默忽略**（可加你自己的元数据，但重新导出时会丢）。

---

## 11. 最小可用示例（可直接导入）

下面第 11、12 节的代码块是**完整严格合法的 JSON**，可复制存成
`zenmark-project.json` 导入。其余 ```jsonc 代码块带注释，只是字段说明。
最小集：一个 doc + 一个 code，即可通过导入判据。

```json
{
  "app": "zenmark",
  "version": 1,
  "exportedAt": "2026-09-27 12:00",
  "project": {
    "title": "最小示例",
    "desc": "",
    "docs": [
      {
        "id": "dmin0001",
        "title": "示例材料",
        "source": "",
        "type": "其他",
        "date": "",
        "note": "",
        "text": "这是一段示例文本。算法连续给我推了三条同一个事件的视频，情绪一次比一次强烈。",
        "kind": "text"
      }
    ],
    "codes": [
      {
        "id": "cmin0001",
        "no": "01",
        "name": "情感动员",
        "level": "open",
        "parent": "",
        "def": "诉诸情绪的表达方式。",
        "incl": "带明显情绪色彩的表述。",
        "excl": "中性事实描述。",
        "eg": "",
        "color": "#e0913b",
        "memo": ""
      }
    ],
    "anns": [
      {
        "id": "amin0001",
        "doc": "dmin0001",
        "start": 9,
        "end": 27,
        "quote": "算法连续给我推了三条同一个事件的视频",
        "code": "cmin0001",
        "memo": "",
        "status": "done",
        "ts": "2026-09-27 12:00"
      }
    ],
    "rels": [],
    "memos": [],
    "marks": [],
    "notes": []
  }
}
```

> 说明：`start:9` / `end:27` / `quote` 三者与 `text` 自洽
> （`"这是一段示例文本。"` 共 9 个字符，第 9 格起正好是「算法…」，
> `slice(9,27)` 恰为该 18 字短句）。这是你生成时**必须照做的定位纪律**。

## 12. 较完整示例（涵盖 anns/codes/memos/marks/notes）

```json
{
  "app": "zenmark",
  "version": 1,
  "exportedAt": "2026-09-27 12:30",
  "project": {
    "title": "质性编码演示",
    "desc": "涵盖全部对象类型的导入示例",
    "docs": [
      {
        "id": "ddoc1",
        "title": "访谈节选",
        "source": "深度访谈",
        "type": "访谈转录",
        "date": "2026-03-14",
        "note": "示例材料",
        "text": "我最早是在刷短视频的时候看到这件事的。\n我承认我当时第一反应是愤怒，而不是怀疑。",
        "kind": "text"
      }
    ],
    "codes": [
      {
        "id": "c1",
        "no": "01",
        "name": "媒介呈现",
        "level": "open",
        "parent": "",
        "def": "材料以何种媒介形态呈现。",
        "incl": "出现媒介形态描述。",
        "excl": "仅涉及主题无形态。",
        "eg": "",
        "color": "#5aa45a",
        "memo": ""
      },
      {
        "id": "c2",
        "no": "02",
        "name": "情感倾向",
        "level": "axial",
        "parent": "c1",
        "def": "对对象的态度取向。",
        "incl": "可判断态度方向。",
        "excl": "纯事实、无态度。",
        "eg": "",
        "color": "#8a8f98",
        "memo": ""
      }
    ],
    "anns": [
      {
        "id": "a1",
        "doc": "ddoc1",
        "start": 5,
        "end": 9,
        "quote": "刷短视频",
        "code": "c1",
        "memo": "",
        "status": "done",
        "ts": "2026-09-27 12:30"
      },
      {
        "id": "a2",
        "doc": "ddoc1",
        "start": 26,
        "end": 33,
        "quote": "第一反应是愤怒",
        "code": "c2",
        "memo": "情绪先于核实",
        "status": "review",
        "ts": "2026-09-27 12:30"
      }
    ],
    "rels": [
      { "id": "r1", "a": "a1", "b": "a2", "type": "因果" }
    ],
    "memos": [
      {
        "id": "m1",
        "title": "关于情绪先行",
        "type": "理论备忘录",
        "body": "受访者先愤怒后核实，提示分发在核查前完成情感动员。",
        "codes": ["c2"],
        "ts": "2026-09-27 12:30"
      }
    ],
    "marks": [
      {
        "id": "k1",
        "doc": "ddoc1",
        "start": 0,
        "end": 19,
        "quote": "我最早是在刷短视频的时候看到这件事的。",
        "sty": "hl",
        "color": "#f6dd8a",
        "text": "",
        "ts": "2026-09-27 12:30"
      },
      {
        "id": "k2",
        "doc": "ddoc1",
        "start": 26,
        "end": 33,
        "quote": "第一反应是愤怒",
        "sty": "note",
        "color": "#a8cdee",
        "text": "关键情绪句",
        "ts": "2026-09-27 12:30"
      }
    ],
    "notes": [
      {
        "id": "n1",
        "kind": "sentence",
        "en": "I felt anger before doubt.",
        "zh": "我先是愤怒，而非怀疑。",
        "phon": "",
        "ex": "",
        "exZh": "",
        "note": "",
        "tags": ["观点"],
        "doc": "ddoc1",
        "src": "访谈节选",
        "start": -1,
        "end": -1,
        "ts": "2026-09-27 12:30"
      }
    ]
  }
}
```

---

## 13. 给生成方的硬性检查清单

生成 `zenmark-project.json` 后，逐条自查：

1. 顶层是合法 JSON（UTF-8，无注释、无尾逗号、无代码块围栏），
   且有 `project`（或把字段摊在顶层），其中 **`codes` 是数组**——否则导入判坏。
2. **没有** `"omm": "bridge"`（有它会被当互通包走追加逻辑，不是你要的整体替换）。
3. 所有 `id` 全局唯一、只用 `[a-z0-9]`、带约定前缀（d/c/a/m/k/n/r）。
4. 每个 `code` 有唯一 `id` + `level`∈{open,axial,selective}；
   `color` 要么不写、要么逐字等于第 4.1 节的 12 色之一。
5. 每个 `doc` 有唯一 `id` + `text`；`kind` **只写 `"text"`，绝不写 `"pdf"`**。
6. 每个 `ann`：`doc` 和 `code` 都指向真实存在的 id；`start`<`end` 且不越界；
   **`quote === doc.text.slice(start,end)`**；`status`∈{done,review}。
7. 每个 `mark`：`doc` 真实存在，`start`<`end` 定位到该 text，`sty`∈{note,hl,ul,st,code}，
   `color` 建议取自第 8.1 节 8 色。
8. 每个 `memo` 的 `codes[]` 元素是真实 code id；`rel` 的 `a`/`b` 是真实 ann id，
   `type` 取自六个中文关联词。
9. 每个 `note` 的 `kind`∈{word,sentence,template,phrase}；`tags` 是字符串数组。
10. 所有 `ts` 是 `"YYYY-MM-DD HH:mm"` 字符串，**不是** epoch 毫秒数字。
11. **不要**在 JSON 里放 `settings`、blob/data URL、PDF 版面、IndexedDB 引用。

只要 1-3 满足，导入就一定会**成功并整体替换**；4-11 决定「数据是否被正确显示」，
其中 5、6 是能否看见高亮/编码的关键。

---

## 14. 行为速查

| 情况 | 结果 |
|---|---|
| 文件里有 `omm:"bridge"` | 走互通包分支（追加成笔记/材料），**不替换** |
| 解析后没有 `codes` 数组 | 抛错 → 提示「项目文件解析失败」，什么都不变 |
| 缺 `memos`/`marks`/`notes`/`anns`/`rels`/`docs` | 该项按 `[]` 处理，其余照常 |
| 缺 `title` | 保留当前项目标题 |
| `codes[].color` 不在 12 色板 / 缺省 | 刷新时被改成 `COLORS[i%12]`（按数组下标） |
| `docs[].kind` 缺省 | 载入时补 `"text"`（正常） |
| `docs[].kind === "pdf"` 但无版面数据 | 阅读视图报「本机未缓存该文件，请重新导入」——**别造** |
| ann 的 `quote` 与 slice(start,end) 不一致 | 定位仍按 start/end；引文显示会错位 |
| ann 的 `start/end` 越界或重叠其它段 | 渲染时被裁剪，可能不显示，不报错 |
| `ann.code` / `ann.doc` 指向不存在 id | 该片段无法正确归码/定位，CSV/报告丢这行 |
| `mark.sty` 缺省 / 非法 | 缺省按 `hl`；`color` 缺省 `#f6dd8a` |
| 导入确认弹窗点「取消」 | 不替换，直接结束（保留当前数据） |
| 文件里塞未知字段 | 静默忽略；重新导出时丢失 |
| 设置 / 界面偏好 | **不在**项目备份内（属另一套云端同步 `SETTINGS_KEY`），导入不读它 |
