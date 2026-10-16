# ZenCorpus 语料库文件 JSON 规范（omm-corpus）

> 用途：让 AI（或任何程序）**直接生成语料库文件**，用户在 `omm-corpus.html` 里
> 点「导入」→「从 JSON 恢复」（或菜单「DATA → 导入」选文件后再点「从 JSON 恢复」）
> 即可把整套语料、分类、页面设置恢复进 App。
>
> 本文所有字段名、默认值、容错行为都是从 `omm-corpus.html` 的
> `exportData()`（第 8643 行，写出）、`importDataText()`（第 8653 行，「从 JSON 恢复」读入）、
> `DEFAULT`（第 5416 行，内置基线）、`fromRaw()`（第 6474 行，本地/云端加载）、
> `saveEditor()` / `addQuick()` / `ensureCat()` / `zbApply()`（各类写入路径）里逐行核对出来的，
> 不是推测。
>
> 兼容性：`version: 2`。当前恢复代码**不校验** `version`，但请保留它，未来版本可能用到。

---

## 0. 一句话规则

**「从 JSON 恢复」只硬性检查两件事：顶层的 `entries` 是不是数组、`categories` 是不是数组。
两者缺任意一个，就弹「导入失败：格式不正确」，什么都不改。**
其余字段全部可选；缺省值来自内置 `DEFAULT`。

恢复会**整体替换**当前语料与分类：`entries` 数组就是你恢复后看到的**全部**语料，
`categories` 数组就是你的**全部**分类——内置的 90 条考试语料和 11 个内置分类**不会自动保留**。
（这一点和第 8 节「本地/云端加载」行为不同，别混淆。）

---

## 0.5 给 AI 的提示词模板

把下面这段连同本文一起发给 AI，让它直接产出可导入的 `.json`：

```text
你要生成一个 ZenCorpus 语料库文件（JSON 格式），用于「从 JSON 恢复」导入。

严格遵守配套文档《corpus.md》里的字段、缺省值和容错规则。硬性要求：

1. 顶层必须有 "entries"(数组) 和 "categories"(数组)；再带上 "version": 2。
   这三个键缺一不可——没有 categories 数组会直接导入失败。
2. 恢复是整体替换：你想要的语料必须全部写进 entries，内置语料不会被自动保留。
   想同时保留内置的，就把它们也列进 entries。
3. 每条语料必须有非空的 "en"（英文正文），这是检索和显示的核心；
   "id" 全局唯一（建议 ex-1、ex-2… 或随机串），"categoryId" 指向 categories 里真实存在的 id。
4. "type" 只能取 sentence / template / collocation / paragraph 四个值之一。
5. "tags" 是字符串数组；"favorite" 是布尔；"source"/"notes"/"zh" 是字符串；
   "createdAt"/"updatedAt" 用 ISO 8601 字符串（如 2026-01-01T00:00:00.000Z）。
6. settings 可整体省略（会用默认值）；apiKey 除非用户明确要求，否则留空字符串。
7. 只输出 JSON 本身，不要 Markdown 代码块围栏，不要注释，不要尾逗号，UTF-8 编码。

生成后自查并简短说明：语料条数、分类数、有无 categoryId 指向不存在的分类、有无缺 en 的条目。
```

---

## 1. 文件外壳

```jsonc
{
  "version": 2,                       // 建议写；当前恢复代码不参与判断
  "categories": [ /* 见第 3 节，数组，硬性必需 */ ],
  "entries":    [ /* 见第 4 节，数组，硬性必需 */ ],
  "settings":   { /* 见第 5 节，可省略 → 用内置默认 */ },
  "stats":      { "aiHits": 22 },     // 见第 6 节，可省略 → 变 {}
  "chat":         [],                 // 可选，旧版扁平对话（可省）
  "conversations": [ /* 见第 7 节，可选 */ ],
  "activeConvId": "",                 // 可选，当前打开的对话 id
  "exportedAt":   "2026-09-22T18:06:45.003Z"  // 可选，导出时间戳（仅显示/记录用）
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `entries` | **是** | 必须是数组。**缺失或不是数组 → 「格式不正确」，导入失败** |
| `categories` | **是** | 必须是数组。**缺失或不是数组 → 「格式不正确」，导入失败** |
| `version` | 建议 | 固定 `2`；当前代码不校验 |
| `settings` | 否 | 缺省用 `DEFAULT.settings` 全量默认值 |
| `stats` | 否 | 缺省 `Object.assign({}, d.stats||{})`；不给就是 `{}`（`aiHits` 视为 0） |
| `chat` | 否 | 不给时保留内置 `DEFAULT.chat`（`[]`） |
| `conversations` | 否 | 不给时保留内置 `DEFAULT.conversations`（`[]`） |
| `activeConvId` | 否 | 不给时保留内置 `DEFAULT.activeConvId`（`""`） |
| `exportedAt` | 否 | 纯元信息，不参与渲染逻辑 |

### 恢复分派逻辑（照抄代码行为，第 8653–8672 行）

```
d = JSON.parse($('#data-box').value)
if (!Array.isArray(d.entries) || !Array.isArray(d.categories))  -> 抛错「格式不正确」→ 导入失败
else
  S = Object.assign(clone(DEFAULT), d, {
        settings: Object.assign(clone(DEFAULT).settings, d.settings || {}),
        stats:    Object.assign({}, d.stats || {}),
      })
  // 然后 save() + 重渲染分类/首页/语料库
```

所以：**顶层同时有 `entries` 数组和 `categories` 数组就能成功恢复**，其余字段随便或省略。

⚠️ **两个坑**（务必理解）：

- **整体替换，不是追加**：`Object.assign(clone(DEFAULT), d, …)` 会把 `d.entries` **直接盖掉**
  内置的 90 条语料，把 `d.categories` **直接盖掉** 内置的 11 个分类。
  想让内置语料继续在，就得自己把它们也写进 `entries`。
- **未知多余字段被原样保留**：`d` 里有 `DEFAULT` 没有的键会一并合进 `S`，
  但重新导出时它们仍在（`exportData` 序列化整个 `S`），只是 App 不认识、不渲染。

---

## 2. 三条数据入口，分别吃什么格式

本 App 有**三条独立**的 JSON 入口，字段规则不完全一样。**给 AI 生成导入文件，请一律瞄准第 ① 种。**

| 入口 | 触发方式 | 处理函数 | 顶层要求 | 是否合并内置语料 |
|---|---|---|---|---|
| ① **从 JSON 恢复**（本规范主角） | 「导入」→「从 JSON 恢复」/ 选文件后点恢复 | `importDataText()` | `entries` 数组 **且** `categories` 数组 | **否，整体替换** |
| ② 本地/云端加载 | 启动读 `localStorage`；Supabase 同步 `OmmCorpusStore.replace` | `fromRaw()` | 任意（坏数据回落 `DEFAULT`） | **是，保留内置**（见 8.1） |
| ③ OMM 互通包 / 笔记导入 | 「互通」→「导入互通包」等（`#bridge-file`→`zbReadFiles`） | `OMM.normalize()`→`zbApply()` | 见第 9 节多形态识别 | **是，追加去重** |

> 注：菜单里的「导入」按钮（`#import-btn`，第 9223 行）只是打开恢复弹窗并清空文本框；
> 文件选择器 `#file-input`（第 9270 行）用 `FileReader` 把文本塞进 `#data-box`，
> 最终仍由**同一个 `importDataText()`** 处理——所以 ① 和文件导入是**同一种格式**，无需区分。

---

## 3. 分类对象 `categories`

```jsonc
{
  "id":   "study",                 // 字符串，全局唯一，被 entries.categoryId 引用
  "name": "学习",                  // 显示名；同名会在分类管理器里被拒（见 7114 行），恢复时不查重
  "desc": "学习、成长、能力提升"    // 可选，一句话说明
}
```

| 字段 | 类型 | 必需 | 缺省/容错 |
|---|---|---|---|
| `id` | string | **是** | 恢复代码不自动生成、也不校验；缺 `id` 的分类，语料将无法正确归属 |
| `name` | string | **是**（逻辑上） | 缺省渲染成空白名，列表会很难认，请始终给 |
| `desc` | string | 否 | 缺省按空字符串处理 |

- `id` 可以随便起（不必是 `study` 这类内置名），只要在本文件内唯一、且被对应 `entries.categoryId` 命中。
- 内置分类共 11 个：`study` 学习、`education` 教育、`society` 社会、`technology` 科技、
  `environment` 环境、`health` 健康、`work` 工作、`culture` 文化、`communication` 交流、
  `argument` 观点、`template` 高频模板。用这些 id 可与内置语料天然对齐。

---

## 4. 语料条目对象 `entries`

```jsonc
{
  "id":         "cet6-01",             // 字符串，全局唯一（内置用 cet6-NN；用户项用 base36 随机串）
  "type":       "sentence",            // sentence | template | collocation | paragraph
  "categoryId": "argument",            // 指向某 categories.id；找不到则显示「未分类」，条目仍保留
  "en":         "It is widely believed that ...",  // 英文正文（核心必填）
  "zh":         "人们普遍认为……",        // 中文释义
  "tags":       ["六级写作", "观点"],    // 字符串数组
  "source":     "CET-6 / IELTS 常用语料",// 来源说明
  "notes":      "适合引出社会现象。",     // 备注/用法
  "favorite":   true,                   // 布尔，「设为重点语料」
  "createdAt":  "2026-01-01T00:00:00.000Z",  // ISO 8601
  "updatedAt":  "2026-01-01T00:00:00.000Z"   // ISO 8601
}
```

| 字段 | 类型 | 必需 | 缺省/容错 |
|---|---|---|---|
| `id` | string | **是**（逻辑上） | 恢复不自动生成也不查重；建议全局唯一，供编辑/删除定位 |
| `en` | string | **是**（核心） | 检索、卡片、AI 上下文都读它；**空 `en` 的条目会显示成空壳**，互通导入则直接丢弃（见 9.3） |
| `type` | string | 建议 | 缺省或非法值：`typeText()` 回落显示原始值本身，不会崩；请只用四个合法值 |
| `categoryId` | string | 建议 | 指向不存在的 `id`：条目照常存在，归属显示为「未分类」 |
| `zh` | string | 否 | 缺省按空字符串 |
| `tags` | string[] | 否 | 缺省按空数组；非数组会破坏标签筛选，请给数组 |
| `source` | string | 否 | 缺省按空字符串（内置语料多为 `CET-6 / IELTS 常用语料`；互通导入为来源 App 名） |
| `notes` | string | 否 | 缺省按空字符串 |
| `favorite` | boolean | 否 | 缺省按 falsy 处理；请给真正的布尔值 |
| `createdAt` / `updatedAt` | string(ISO) | 否 | 缺省不补（时间线排序可能不准）；建议给 |

**`type` 取值表**（`#ed-type` 下拉，第 4451 行；与 `typeText()` 第 6608 行一致）：

| `type` | 显示 | 含义 |
|---|---|---|
| `sentence` | 句子 | 完整英文句子（默认） |
| `template` | 模板 | 可套用句型/框架 |
| `collocation` | 搭配 | 词组/固定搭配 |
| `paragraph` | 段落 | 成段范文 |

**关于 `id`**：内置项是 `cet6-01`… 这种；App 里新建用 `uid()`（`base36` 随机串）。
恢复不做 id 查重、不自动补 id，因此**重复 id 不会报错**，但会导致编辑/删除误命中。
**请保证 `id` 在本文件内唯一**；多余未知字段会被原样带入 `S`（可放自定义元数据，但不渲染）。

**没有 `aiUsage` 之类字段**（任务提示里猜的）：语料条目上**不存在**逐条 AI 使用计数。
「AI 使用统计」是全局的 `stats.aiHits`（第 6 节），不在单条语料里。

---

## 5. 页面设置 `settings`（可整体省略）

恢复时 `settings` 与内置默认**浅合并**：只覆盖你给了的键，没给的键用下表默认值。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `theme` | string | `"light"` | 主题 |
| `bg` | string | `"void"` | 背景 |
| `fontScale` | number | `1` | 字号缩放 |
| `pinned` | boolean | `false` | 顶栏固定 |
| `radius` | number | `0` | 圆角 |
| `borderWidth` | number | `1` | 边框宽度 |
| `borderStyle` | string | `"solid"` | `solid`/`dashed`… |
| `borderAlpha` | number | `15` | 边框透明度 |
| `provider` | string | `"deepseek"` | AI 服务商 |
| `apiBase` | string | `"https://api.deepseek.com"` | API 地址 |
| `apiModel` | string | `"deepseek-flash"` | 模型名 |
| `apiKey` | string | `""` | **密钥，默认为空**；AI 生成时除非用户要求，否则别填 |
| `aiContextLimit` | number | `20` | 注入 AI 的语料条数上限 |
| `wordLimit` | number | `180` | 字数限制 |
| `aiSelectionMode` | string | `"auto"` | `auto`/`manual` |
| `aiThinkingEnabled` | boolean | `true` | 思考开关 |
| `aiMainWidth` | number | `0.58` | 主栏宽比例（**仅 `fromRaw` 路径会 clamp 到 [0.3,0.78]；恢复路径不 clamp**） |
| `chatSystemPrompt` | string | `""` | 对话系统提示（覆盖 `system` 的额外项） |
| `chatExtraPrompt` | string | `""` | 对话附加提示 |
| `system` | string | （通用助手长文本，见第 6463 行） | 主系统提示词 |

---

## 6. AI 使用统计 `stats`

```jsonc
"stats": { "aiHits": 22 }
```

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `aiHits` | number | 恢复路径无默认（省略则 `{}`，显示按 0） | 全局累计「被 AI 检索命中」次数；首页「已用」计数读它 |

⚠️ 恢复路径是 `Object.assign({}, d.stats || {})`——**不并入内置默认**，
省略 `stats` 会得到空对象（`updateHead()` 里 `S.stats.aiHits || 0` 显示 0）。

---

## 7. 对话 `conversations` / `chat` / `activeConvId`（可选）

一般 AI 生成语料文件**无需关心对话**，省略即可（会保留内置的空数组/空串）。
若要恢复对话，形状如下（来自 `newConversation()` 第 7608 行、`fromRaw` 迁移第 6510 行）：

```jsonc
"conversations": [
  {
    "id": "mu6oqqfixvs71f",           // 唯一 id
    "title": "未命名对话",              // 缺省取首条用户消息前 40 字
    "messages": [                       // 消息数组
      { "role": "user", "content": "……", "model": "" }   // role: user | assistant
    ],
    "createdAt": "2026-09-20T09:00:00.000Z",
    "updatedAt": "2026-09-20T09:05:00.000Z"
  }
],
"activeConvId": "mu6oqqfixvs71f"
```

- `chat` 是**旧版扁平消息数组**（`[{role,content,…}]`）。恢复路径**不做** chat→conversations 迁移
  （迁移只在 `fromRaw` 里，第 6510 行）；用新格式 `conversations`，不要用 `chat`。

---

## 8. 最小可用示例

下面第 8、9 节的 ` ```json ` 代码块是**完整严格合法的 JSON**，可直接复制成 `.json` 走「从 JSON 恢复」。
其余带注释的代码块只是字段说明，不能直接导入。

> 记住：恢复是**整体替换**。这个最小示例恢复后，库里面**只有**这 1 条语料和 1 个分类。

```json
{
  "version": 2,
  "categories": [
    { "id": "study", "name": "学习", "desc": "学习、成长、能力提升" }
  ],
  "entries": [
    {
      "id": "ex-1",
      "type": "sentence",
      "categoryId": "study",
      "en": "Practice deliberately today so that the exam feels familiar tomorrow.",
      "zh": "今天刻意练习，考场才会觉得熟悉。",
      "tags": ["备考", "方法"],
      "source": "示例",
      "notes": "演示最小可用格式。",
      "favorite": false,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

## 9. 完整示例（覆盖全部主要子对象）

```json
{
  "version": 2,
  "exportedAt": "2026-09-22T18:06:45.003Z",
  "categories": [
    { "id": "argument", "name": "观点", "desc": "论证、让步、因果" },
    { "id": "education", "name": "教育", "desc": "学校、教学、考试、培养" }
  ],
  "entries": [
    {
      "id": "cet6-01",
      "type": "template",
      "categoryId": "argument",
      "en": "It is widely believed that ...",
      "zh": "人们普遍认为……",
      "tags": ["六级写作", "观点", "开头"],
      "source": "CET-6 / IELTS 常用语料",
      "notes": "适合引出社会现象或普遍观点。",
      "favorite": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "id": "col-01",
      "type": "collocation",
      "categoryId": "argument",
      "en": "a growing concern",
      "zh": "日益增长的关注",
      "tags": ["搭配"],
      "source": "自己总结",
      "notes": "",
      "favorite": false,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "id": "para-01",
      "type": "paragraph",
      "categoryId": "education",
      "en": "Educational equity does not mean giving every student the same resources; it means allocating support according to individual needs.",
      "zh": "教育公平不是给每个学生相同的资源，而是按需分配支持。",
      "tags": ["教育公平", "议论文"],
      "source": "AI 生成",
      "notes": "适合 equity vs equality 类话题。",
      "favorite": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "settings": {
    "theme": "light",
    "pinned": true,
    "radius": 14,
    "borderStyle": "dashed",
    "provider": "openrouter",
    "apiBase": "https://openrouter.ai/api/v1",
    "apiModel": "openrouter/free",
    "apiKey": "",
    "aiContextLimit": 20,
    "wordLimit": 180,
    "aiSelectionMode": "auto"
  },
  "stats": { "aiHits": 22 },
  "chat": [],
  "conversations": [
    {
      "id": "conv-1",
      "title": "未命名对话",
      "messages": [
        { "role": "user", "content": "帮我润色这句", "model": "" }
      ],
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "activeConvId": "conv-1"
}
```

---

## 10. 给生成方的硬性检查清单

生成 `.json` 后，逐条自查：

1. 顶层同时有 `"entries"` **数组**和 `"categories"` **数组**——这是恢复的**唯一硬性要求**，缺一即失败。
2. 建议带 `"version": 2`；不要再加 `{omm:'bridge', …}` 那种互通包外壳（那是第 11 节的另一入口）。
3. 每条语料都有**非空 `en`**；`type` 取自 `sentence/template/collocation/paragraph` 四个值。
4. 所有 `entries.id`、`categories.id` **在本文件内唯一**（恢复不查重、不自动补 id）。
5. 每条语料的 `categoryId` **确实存在**于 `categories`（否则会显示「未分类」，条目仍在）。
6. `tags` 是字符串数组；`favorite` 是真布尔；时间是 ISO 8601 字符串。
7. 理解**整体替换**语义：恢复后库里的内容 = 你 `entries`/`categories` 里写的全部内容；
   内置 90 条语料、11 个分类**不会自动保留**，需要就自己写进去。
8. `settings` 可省略（用默认）；`apiKey` 除非用户要求否则留空。
9. 不写逐条 `aiUsage`（不存在该字段）；AI 统计只有全局 `stats.aiHits`。
10. 文件是 **UTF-8** 编码的**合法 JSON**：无注释、无尾逗号、无 ` ``` ` 围栏、无表达式。

只要 1–2 条满足，恢复就一定成功；3–10 条决定「能不能正确归属、好不好看、语义对不对」。

---

## 11. 另一条路：OMM 互通包 / 笔记导入（进阶，一般别用这个做交付）

用户在「互通」面板里导入 Annotate / English 发来的**互通包**（或把文件当笔记导入）时，
走的是 `zbReadFiles → OMM.normalize → zbApply`（第 8819–8848 行），格式和恢复**完全不同**：

**标准互通包外壳**（第 4856 行）：

```jsonc
{
  "omm": "bridge",           // 必须
  "v": 1,                    // 版本
  "app": "omm-corpus",       // 来源 App
  "kind": "...",             // 可选
  "exportedAt": "...",       // 可选
  "meta": { "sourceAppName": "OMM Corpus" },  // 可选，决定新分类名/来源
  "items": [                 // 必须数组，元素用紧凑键
    { "t": "sentence", "en": "...", "zh": "...", "note": "...", "tags": [], "src": "..." },
    { "t": "template", "en": "...", "zh": "...", "note": "...", "tags": [], "src": "..." },
    { "t": "word",     "w": "...", "ph": "...", "m": "...", "ex": "...", "exZh": "...", "note": "...", "tags": [] },
    { "t": "doc",      "title": "...", "text": "...", "lang": "...", "zh": "..." }
  ]
}
```

`OMM.normalize()`（第 5123 行）还会**顺带识别**这些非标准形态（任一即可被吸收为 items）：

| 形态 | 判定条件 | 结果 |
|---|---|---|
| 标准互通包 | `o.omm==='bridge' && Array.isArray(o.items)` | 直接用 `items` |
| Annotate 项目备份 | `o.project.notes[]` | notes→items |
| 裸笔记数组 | `o.notes[]` 且首项有 `kind`/`en` | notes→items |
| **Corpus 导出/状态** | `Array.isArray(o.entries) && o.entries.length` | entries→items（复用本规范第 4 节的条目） |
| 词表 | `o.words[]` 或裸数组 | →word items |
| English 全量 | `o.books` | 汇总所有词书为 items |

`zbApply()`（第 8757 行）落库规则与恢复**不同**：

- **追加、不覆盖**：新条目 `unshift` 进现有 `S.entries`，内置/已有语料**保留**。
- **去重**：用 `norm(en)`（小写去标点）建索引，**与现有语料重复的英文会被跳过**，提示「没有新增内容（可能重复）」。
- **自动建分类**：`categoryId` 由 `ensureCat()` 按 `meta.docTitle||meta.title||it.src||'笔记导入'` 取/建，**不要求你提供 `categories`**。
- **字段映射**：`word`→`type:'collocation'`、`doc`→`type:'paragraph'`、`template`→`'template'`、`phrase`→`'collocation'`、其它→`'sentence'`；`tags` 截断到 8 个；`favorite` 恒为 `false`；`id`/时间由 App 生成。

**给 AI 的建议**：要「整套语料原样呈现 + 分类可控」，**用第 1–10 节的恢复格式（① 路）**；
互通包（③ 路）适合把语料**增量喂进**已有库、且不在乎分类归属的场景，交付时不优先推荐。

---

## 12. 行为速查（「从 JSON 恢复」路径）

| 情况 | 结果 |
|---|---|
| 顶层缺 `entries` 或 `categories`（或非数组） | 弹「导入失败：格式不正确」，**当前数据完全不变** |
| JSON 解析失败 | 弹「导入失败：<具体报错>」，数据不变 |
| 恢复成功 | 弹「数据已恢复」；`S` 被替换，立即 `save()` 到 `localStorage` 并重渲染首页/语料库/分类 |
| `entries` 里的条目缺 `type`/`source`/`notes` 等 | 该条目仍入库，渲染时按空/回落处理，**不会**被丢弃（与互通导入不同） |
| `entries` 里有条目缺 `en` | 仍入库，但显示为空壳、检索命中不到；建议别提交空 `en` |
| `categoryId` 指向不存在的分类 | 条目照常显示，归属栏显示「未分类」 |
| 省略 `settings` | 用内置默认；给了的键才覆盖 |
| 省略 `stats` | `stats` 变成 `{}`（`aiHits` 显示 0） |
| 省略 `conversations`/`chat`/`activeConvId` | 保留内置默认（空）；恢复路径**不**做旧 chat 迁移 |
| 内置的 90 条语料 / 11 个分类 | **不会自动保留**；要留就自己写进 `entries`/`categories` |
| 重复导入同一文件 | 每次都整体覆盖为文件内容，结果一致（不像互通导入那样叠加） |
| 超大语料库 | 无条数上限，但受浏览器 `localStorage` 配额限制；超限保存失败会弹「保存失败：浏览器存储空间不足」 |
</content>
</invoke>
