# Zenglish（omm-english）JSON 文件规范

> 用途：让 AI（或任何程序）**直接生成可导入文件**。Zenglish 一共有 **4 种互不相通的导入功能**，
> 每种要的 JSON 结构完全不同，**千万别混用**。
>
> 本文所有字段名、默认值、容错、去重规则都是从 `omm-english.html` 里逐行核对出来的，不是推测：
> - 词库导入：`parseVocab()` / `doImport()`（约 13884–13971）
> - 涂鸦导入：`applyDoodlesText()`（约 12653）、笔迹结构 `normalizeDrawingData()`（约 11937）、导出 `exportDoodles()`（约 12597）
> - 备份恢复：`importBackupFile()`（约 15141）、写出 `serializeS()`（约 11405）、`defaults()` / `seed()` / `load()`（约 11332–11402）
> - 互通包：`OMMBridge.normalize()`（约 6465）+ `itOf/itWord/itSent/itDoc`（约 6285–6366）+ `zbApply()`（约 14090）

---

## 0. 一句话规则（先分清你要生成哪一种）

| 代号 | 对应菜单 | 你要生成的东西 | 顶层长这样 |
|---|---|---|---|
| **A** | 导入词库 | **一堆单词**（新建一本词书） | `[{w,ph,m,ex},…]` 或 `{words:[…]}`；也吃 TSV / 每行一条 |
| **B** | 导入涂鸦 | **手画笔迹**（按单词存） | `{drawings:{ 词: {strokes:[…]} }}` |
| **C** | 恢复备份 | **整个 App 的全量状态** | `{v, set, notes, drawings, books, prog, days, …}` |
| **D** | 导入笔记 / 语料包 | **跨 App 互通包**（词+句+文） | `{omm:"bridge", v:1, items:[{t:"word"…}]}` |

**一句话记住**：
- 只想塞一批单词、建本词书 → **A**。
- 只想导入某几个词的简笔画 → **B**（而且这些词必须已在词书里，否则被跳过）。
- 想连进度、生词本、笔记、涂鸦、设置一起复原 → **C**（**会覆盖当前全部数据**）。
- 要兼容 Annotate / Corpus 发来的互通包 → **D**。

字段口径的关键区别（务必读）：一条词在内部是**数组元组**，列序固定为
`[单词, 音标, 释义, 例句, 例句翻译]`（见内置 `WORDS`）。
- **A** 最多只认前 **4 列**（第 5 列例句翻译会被丢弃）。
- **C / D** 认全部 **5 列**。

---

## 0.5 给 AI 的提示词模板

把下面这段连同本文发给 AI，让它产出对应类型的可导入文件（**先选好 A/B/C/D**）：

```text
你要生成 Zenglish（omm-english.html）的可导入 JSON 文件。严格遵守配套文档《english.md》。
先确认类型，只输出 JSON 本身：不要 markdown 代码块围栏、不要注释、不要尾逗号，UTF-8 编码。

【A 词库】顶层是数组（或 {"words": [...]}）。每个元素是对象：
  { "w":"单词", "ph":"音标", "m":"释义", "ex":"例句" }   ← 只有这 4 个字段有用，多余的会被忽略。
  或二元以上的数组 ["单词","音标","释义","例句"]。单词(w)为空的条目被丢弃。
【B 涂鸦】顶层是 {"drawings": { "小写单词": { "strokes":[...] } }}。
  strokes 每笔：{ "color":"#rrggbb", "width":4, "erase":false, "points":[{"x":100,"y":100,"p":0.7},…] }。
  画布尺寸固定 1200×800；x∈[0,1200]、y∈[0,800]、p∈[0.15,1]；每个 key 必须是当前词书里存在的单词（小写）。
【C 备份】顶层必须同时有 "books" 和 "prog" 两个对象（缺任一直接判非法）。可选带 set/notes/drawings/days/listen。
  books 里自定义词书 { "id":"u…", "name":"…", "builtin":false, "w":[[词,音标,释义,例句,例句译],…] }；内置 cet6 的 w 可写 null。
  prog 每词 { "b":0,"due":毫秒时间戳,"seen":0,"ok":0,"bad":0,"fuzzy":0,"star":false }，key 用小写单词。
【D 互通包】顶层 {"omm":"bridge","v":1,"items":[ … ]}。item 有 t 字段：
  词 {t:"word", w,ph,m,ex,exZh,note,tags,src}；句 {t:"sentence",en,zh}；文 {t:"doc",title,text}。

生成后备货：在 JSON 外附一句说明你用的是哪种类型、条目总数。
```

---

# A. 导入词库（vocab list）

入口弹窗「导入词库」：粘文本或选 `.json / .txt / .csv`。解析全在 `parseVocab()`，
产出一个 **4 元组数组**，交给 `doImport()` 新建一本词书 `S.books[id] = {id, name, builtin:false, w:元组数组}`。
**永远新建词书并切换为当前**，不覆盖内置词库；同一文件重复导入会产生新词书。

## A.1 三种格式，各自的规则

`parseVocab(text)` 的判定顺序：**先试 JSON，JSON 成且解析出条目就用 JSON；否则退回按行解析**。

### A.1.1 JSON

顶层二选一：
- **数组**：`[ item, item, … ]`
- **对象包壳**：`{ "words": [ item, … ] }`（只有 `words` 这个键被认；其它壳名如 `items`、`books` **不认**，会退回按行解析并大概率失败）

每个 `item` 两种写法：
- **数组形式**：`["单词", "音标", "释义", "例句"]`，**长度必须 ≥ 2**，否则该条丢弃。只取前 4 个下标，第 5 个（例句译）忽略。
- **对象形式**：字段有别名（取第一个非空）：

| 目标列 | 接受键（按优先级） | 说明 |
|---|---|---|
| 单词 | `w` / `word` / `en` | **必须有**，为空则整条丢弃 |
| 音标 | `ph` / `phonetic` | 可选 |
| 释义 | `m` / `meaning` / `trans` | 可选 |
| 例句 | `ex` / `example` | 可选（**注意没有 `exZh`**，例句译在此导入不了） |

所有值都会被 `String(…).trim()` 化，非字符串也能吃。

### A.1.2 TSV（制表符 / 多空格 / 逗号）与每行一条

JSON 解析失败后，按 `\r?\n` 切行，每行：
1. 行内含 **制表符 `\t`** → 按 tab 切列（列序同上：词/音标/释义/例句）。
2. 否则含 **两个及以上连续空格** → 按 `/ {2,}/` 切列。
3. 否则整行像 CSV（`^["']?[a-zA-Z][a-zA-Z\-' ]*["']?,` 开头） → 按逗号切列。
4. 否则正则 `^([a-zA-Z][a-zA-Z\-']*)\s+(.+)$`：首词当单词、余下当**释义**（即 `word 释义`）。匹配不上就把整行当单词。

每列再 `trim()` 并去掉首尾引号 `["']`。单词（第 1 列）为空的行丢弃。

## A.2 去重规则

`doImport()` 内按 `nkey(单词)` 去重：`nkey = String().trim().toLowerCase()`，
即 **大小写 / 首尾空格不敏感**，保留首次出现，后续同词丢弃。内置词库（`cet6`、`fav`）**不可覆盖**。

## A.3 最小可用示例（A，JSON，严格合法）

```json
[
  { "w": "abandon", "ph": "əˈbændən", "m": "vt. 放弃，抛弃", "ex": "He abandoned the plan." },
  ["ability", "əˈbɪləti", "n. 能力，才能", "She has the ability to solve hard problems."]
]
```

## A.4 补充示例（A，对象包壳 + 每行文本）

包壳：
```json
{ "words": [ { "word": "abolish", "meaning": "vt. 废除，取消" } ] }
```
粘贴进文本框的每行一条（单词制表符释义）：
```text
abandon	əˈbændən	vt. 放弃，抛弃	He abandoned the plan.
ability	əˈbɪləti	n. 能力	She has the ability.
```

---

# B. 导入涂鸦（doodle / 手写笔迹）

入口弹窗「导入涂鸦」：粘 JSON 或选 `.json`。解析全在 `applyDoodlesText()`。
涂鸦按 **单词 key** 存进 `S.drawings`（一词一幅）。**同名词的已有涂鸦会被覆盖。**

## B.1 文件外壳

`applyDoodlesText` 接受两种壳（都会 `JSON.parse`，**先去 BOM / 首部空白**）：
- `obj.drawings` 是对象 → 用它（推荐，本网页导出的 `zenglish_doodles_*.json` 就是这个）。
- 否则 `obj` 本身是对象且不是数组 → 整个 `obj` 当 drawings 映射。

外壳字段 `v` / `exportedAt` 仅记录用，**不参与判断**。

```jsonc
{
  "v": 1,
  "exportedAt": "2026-09-23T…Z",
  "drawings": { "abandon": { /* 见 B.2 */ } }   // 也可以直接顶层就是 { "abandon": {…} }
}
```

## B.2 一幅涂鸦（drawings 的 value）

结构即 `exportDoodles` 写出的样子（画布固定 `DRAW_W=1200` × `DRAW_H=800`，3:2）：

| 字段 | 类型 | 说明 / 容错 |
|---|---|---|
| `v` | number | 一般 `1`，不影响渲染 |
| `w` / `h` | number | 画布尺寸，**固定 1200 / 800**；渲染时按此范围裁剪 |
| `lastWidth` / `lastColor` | number / string | 上次画笔，仅记录 |
| `updatedAt` | number | 毫秒时间戳，仅记录 |
| `strokes` | **数组** | **必须存在且是数组**，否则视为无涂鸦（`getDrawing` 判定 `Array.isArray(d.strokes)`） |
| `frames` | 数组（可选） | 小程序扩展字段（一词多幅），网页不画但会保留 |

每笔（`strokes[]` 一项）由 `normalizeDrawingData` 清洗：

| 字段 | 类型 | 缺省 / 容错 |
|---|---|---|
| `color` | string | 非字符串 → `#000000` |
| `width` | number | `Math.max(1, Number||4)`（≤0 或非数 → 4） |
| `erase` | bool | `!!st.erase`，橡皮擦标志 |
| `eraseRadius` | number | 可选，有限数则 `≥0` |
| `points` | 数组 | 每点 `{x,y,p}`；**至少 1 个有效点，否则整笔丢弃** |

每个点：`x` 裁剪到 `[0,1200]`、`y` 裁剪到 `[0,800]`（`Number||0`），
`p`（压力）裁剪到 `[0.15,1]`（`Number||0.7`）；`x/y` 非有限的点被过滤掉。

## B.3 导入行为（关键坑）

- **key 必须命中现有词书里的单词**：导入前用 `collectAllWords()`（内置 `cet6` + 所有词书 + 生词本）取
  `nkey` 集合；key 不在其中的涂鸦**被跳过**并提示「跳过 N 张」。所以 **先用 A 导词、再用 B 导涂鸦**。
- 落库 `S.drawings[k] = incoming[k]` 是**原样写入**；渲染时才裁剪。
- 板面比例按**短边贴合居中**（网页 3:2 与小程序不同，形状不走样）。

## B.4 最小可用示例（B，严格合法）

```json
{
  "v": 1,
  "drawings": {
    "abandon": {
      "v": 1,
      "w": 1200,
      "h": 800,
      "lastWidth": 4,
      "lastColor": "#000000",
      "updatedAt": 1760000000000,
      "strokes": [
        {
          "color": "#000000",
          "width": 4,
          "erase": false,
          "points": [
            { "x": 200, "y": 200, "p": 0.7 },
            { "x": 240, "y": 260, "p": 0.9 },
            { "x": 300, "y": 320, "p": 0.5 }
          ]
        }
      ]
    }
  }
}
```

---

# C. 恢复备份（whole-app backup，`zenglish_backup_*.json`）

入口「恢复备份」：`importBackupFile()` 用 `FileReader` 读文本 → `JSON.parse`。
写出端是 `exportFull()`（文件名 `'zenglish_backup_' + dayKey() + '.json'`），内容 = `serializeS()`。

## C.1 硬性外壳（只校验两件事）

```
if (!obj.books || !obj.prog)  →  抛错，提示「备份文件格式不正确」
```

即：**顶层必须同时有 `books` 对象和 `prog` 对象**，其余全部可选。
通过后执行 `S = Object.assign(defaults(), obj)`（浅合并）+ `S.set = Object.assign(defaults().set, obj.set||{})`（set 深一层合并）+ `seed(S)`。

> ⚠️ **导入即覆盖全部当前数据**（弹窗「导入该备份将覆盖当前全部数据，继续？」）。

## C.2 完整信封（字段与默认值，来自 `defaults()`）

| 顶层键 | 必需 | 类型 | 缺省 | 含义 |
|---|---|---|---|---|
| `v` | 否 | number | `1` | 版本 |
| `books` | **是** | object | `{}` | 词书表，见 C.3 |
| `prog` | **是** | object | `{}` | 每词学习进度，见 C.4 |
| `set` | 否 | object | 见下 | 设置，与默认逐键合并 |
| `notes` | 否 | object | `{}` | 每词笔记，key=nkey(词)，值 `{ex,zh,story,exZh}` |
| `drawings` | 否 | object | `{}` | 涂鸦，结构同 B.2 |
| `activeBook` | 否 | string | `cet6` | 当前词书 id；指向不存在的书会被重置为 `cet6` |
| `view` | 否 | string | `home` | 只能是 `home/words/flash/quiz/listen/typing` 之一，否则回 `home` |
| `words` | 否 | object | `{q:"",filter:"all"}` | filter ∈ `all/new/learning/mastered/star` |
| `days` | 否 | object | `{}` | 每日统计，key=`YYYY-MM-DD`，值 `{l,qa,qo,r}` |
| `listen` | 否 | array | `[]` | 听力材料列表，见 C.6 |

`set` 默认逐键（可只写你要改的键）：
`theme:"light"`, `bg:"bg-dots"`, `fscale:1`, `radius:0`, `pinned:false`, `statusbar:true`,
`dailyNew:20`, `autoSpeak:true`, `showPhon:true`, `showEx:true`, `showNote:true`,
`seenGuide:false`, `ttsVoice:""`, `ttsRate:0.95`, `examDate:"2026-12-12"`, `tySound:true`, `tySoundVol:60`。

## C.3 `books`（词书表）

`books` 是 `{ 书id: 书对象 }`。书对象：`{ id, name, builtin, w }`，`w` 是 **词元组数组**，
每条元组列序 `[单词, 音标, 释义, 例句, 例句翻译]`（第 5 列可选，比 A 多这一列）。

- `seed()` 会保证两本内置书存在：`cet6`（名「六级核心高频词」，`w` 非数组时用内置 `WORDS` 回填）、
  `fav`（「我的生词本」，`w` 非数组时置 `[]`）。
- **导出的备份里内置书 `cet6.w` 被 `serializeS` 置为 `null`**（不重复存整本高频词）；恢复时 `seed` 自动补回。
  所以你自己生成备份时，`cet6` 的 `w` 写 `null` 或直接省略都安全。
- 自定义书必须给完整 `w` 数组。书 id 建议 `u` + 时间戳（如 `u1760000000000`），且 `activeBook` 若要指向它，须同名存在。

## C.4 `prog`（学习进度，状态/★难点就在这里）

`prog` 是 `{ nkey(单词): 进度对象 }`。进度对象字段（`ensureProg` 默认 + `gradeWord` 写入）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `b` | number 0–5 | SRS 盒子/步骤，**`b≥5` 即「已掌握」** |
| `due` | number | 下次复习的毫秒时间戳 |
| `seen` | number | 被学习/复习的总次数 |
| `ok` / `bad` | number | 记住 / 记错次数 |
| `fuzzy` | number | 模糊（「有点印象」）次数 |
| `star` | bool | **★难点标记** |

状态推断（`mastery`）：无 prog 或 `seen===0` → **未学(new)**；`b>=5` → **已掌握(mastered)**；否则 → **学习中(learning)**。
**书签/生词本** = 该词被放进 `books.fav.w`（不是 prog 字段）。
> 注意：`status/star/书签/笔记` **都不能通过 A 导入**，只能靠本备份（C）或界面操作产生。

## C.5 最小可用示例（C，严格合法，仅满足硬性校验）

```json
{
  "v": 1,
  "books": {
    "cet6": { "id": "cet6", "name": "六级核心高频词", "builtin": true, "w": null },
    "fav": { "id": "fav", "name": "我的生词本", "builtin": true, "w": [] }
  },
  "prog": {}
}
```

## C.6 完整示例（C，含自定义词书 / 进度 / 笔记 / 涂鸦 / 听力 / 设置）

```json
{
  "v": 1,
  "set": { "theme": "dark", "bg": "bg-void", "radius": 14, "dailyNew": 30, "examDate": "2026-12-12" },
  "notes": {
    "abandon": { "ex": "He abandoned the plan.", "zh": "", "story": "联想：a-band-on，脱离乐队", "exZh": "他在最后一刻放弃了计划。" }
  },
  "drawings": {
    "abandon": {
      "v": 1,
      "w": 1200,
      "h": 800,
      "lastWidth": 4,
      "lastColor": "#000000",
      "updatedAt": 1760000000000,
      "strokes": [
        { "color": "#000000", "width": 4, "erase": false, "points": [ { "x": 200, "y": 200, "p": 0.7 }, { "x": 260, "y": 300, "p": 0.9 } ] }
      ]
    }
  },
  "books": {
    "cet6": { "id": "cet6", "name": "六级核心高频词", "builtin": true, "w": null },
    "fav": { "id": "fav", "name": "我的生词本", "builtin": true, "w": [ [ "abandon", "əˈbændən", "vt. 放弃", "He abandoned the plan.", "他放弃了计划。" ] ] },
    "u1760000000000": {
      "id": "u1760000000000",
      "name": "雅思核心",
      "builtin": false,
      "w": [
        [ "abandon", "əˈbændən", "vt. 放弃，抛弃；n. 放纵", "He abandoned the plan.", "他在最后一刻放弃了计划。" ],
        [ "ability", "əˈbɪləti", "n. 能力，才能", "She has the ability to solve hard problems.", "她有解决难题的能力。" ]
      ]
    }
  },
  "activeBook": "u1760000000000",
  "view": "home",
  "words": { "q": "", "filter": "all" },
  "prog": {
    "abandon": { "b": 4, "due": 1760100000000, "seen": 4, "ok": 4, "bad": 0, "fuzzy": 0, "star": false },
    "ability": { "b": 0, "due": 1760000600000, "seen": 1, "ok": 0, "bad": 1, "fuzzy": 1, "star": true }
  },
  "days": {
    "2026-09-23": { "l": 20, "qa": 30, "qo": 25, "r": 12 }
  },
  "listen": [
    { "id": "u1760000000001L", "title": "示例材料", "type": "文本", "audioName": "", "segs": [ { "s": null, "e": null, "text": "He abandoned the plan." } ], "zh": [ "他放弃了计划。" ] }
  ]
}
```

---

# D. 导入笔记 / 语料包（OMM 互通包 bridge pack）

入口「导入笔记 / 语料包」：`zbReadFiles()` 选 `.json` → `zbIngestTexts()` →
对每段文本调 `OMMBridge.normalize(text)` 得到 items 数组，确认后 `zbApply(items)` 落库。
落库规则：**词→新词书**（5 元组，并顺带写 notes）；**doc→听力材料**；**句/模板/搭配→听力材料**。

## D.1 文件外壳（`normalize` 认这几种，命中即止）

1. **标准互通包**（推荐）：`{ "omm":"bridge", "v":1, "items":[ … ] }`
2. Annotate 项目备份：`{ "project": { "notes":[ … ] } }`
3. 裸笔记数组：`{ "notes":[ {kind/en,…} ] }`
4. Corpus 导出：`{ "entries":[ {type,en,zh,…} ] }`
5. 词表：`{ "words":[ … ] }` 或**顶层就是数组** `[ … ]`
6. Zenglish 全量备份：`{ "books":{ … } }`（把各词书里的词收成一个词包）

> 顶层是数组时走 `wordish`（宽松）；走标准包时每个 item 走 `itOf`。两种都能被 AI 用，但**建议生成标准包**。

## D.2 item 对象（按 `t` 分三类）

**词**（`t:"word"`）：
```jsonc
{ "t":"word", "w":"单词", "ph":"音标", "m":"释义", "ex":"例句", "exZh":"例句翻译",
  "note":"笔记", "tags":["tag1","tag2"], "src":"来源" }
```
落库：写入词书 5 元组 `[w, ph, m, ex, exZh]`；`note`→notes.story、`zh`→notes.zh、`ex/exZh`→notes（仅当该词 notes 未填时补）。**`tags` / `src` 不入库**（src 仅在整包解析时作来源显示）。词按 `nkey(w)` 去重，空词丢弃。

**句 / 模板 / 搭配**（`t:"sentence" | "template" | "phrase"`）：
```jsonc
{ "t":"sentence", "en":"整句", "zh":"翻译", "note":"", "tags":[], "src":"" }
```
`en`（或 `text` / `sentence`）为空则丢弃；并入一条听力材料的 segs。

**文章**（`t:"doc"`）：
```jsonc
{ "t":"doc", "title":"标题", "text":"正文", "lang":"en", "zh":"" }
```
`title` 与 `text` 都空则丢弃；`text` 会被 `parseSubs` 拆成 segs 并入听力材料。
`kindMap` 会把 `vocab/vocabulary→word`、`pattern→template`、`collocation→phrase`，其余归 `sentence`。

## D.3 最小可用示例（D，标准包，严格合法）

```json
{
  "omm": "bridge",
  "v": 1,
  "items": [
    { "t": "word", "w": "abandon", "ph": "əˈbændən", "m": "vt. 放弃", "ex": "He abandoned the plan.", "exZh": "他放弃了计划。", "note": "脱离乐队", "tags": ["CET6"], "src": "真题" },
    { "t": "sentence", "en": "She has the ability to solve hard problems.", "zh": "她有解决难题的能力。" },
    { "t": "doc", "title": "一段材料", "text": "Reading is fun. Practice every day.", "lang": "en", "zh": "" }
  ]
}
```

---

## 给生成方的硬性检查清单

按类型逐条自查：

**通用**
1. UTF-8、**合法 JSON**：无注释、无尾逗号、无 markdown 围栏。
2. 别把 A/B/C/D 混在一个文件里 —— 选错入口 = 解析失败或被当成另一种。

**A 词库**
3. 顶层是数组，或 `{"words":[…]}`；JSON 解析失败会退回按行解析（大概率报「没有解析到有效词条」）。
4. 每条**单词非空**（`w`/`word`/`en` 之一）；数组形式长度 ≥ 2。
5. 只有 4 列有用（`exZh` 会被丢）；`status/star/书签/笔记` 这里导不进去。
6. 大小写/空格不敏感去重；内置 `cet6`/`fav` 不可覆盖。

**B 涂鸦**
7. `drawings` 的每个 key = **小写单词**，且该词**已在当前词书**（否则被跳过）。先 A 导词、后 B 导涂鸦。
8. 每幅必须有 `strokes` 数组；每笔至少 1 个有效点。坐标 `x∈[0,1200]`、`y∈[0,800]`、`p∈[0.15,1]`。

**C 备份**
9. 顶层**同时有 `books` 和 `prog`**（缺任一被判非法）。
10. `books.*.w` 每条元组 `[词,音标,释义,例句,例句译]`；内置 `cet6.w` 可 `null`/省略（自动补），自定义书给全。
11. `activeBook` 要指向 `books` 里真实存在的 id，否则回 `cet6`；`view`/`words.filter` 用合法枚举值。
12. `prog` key 用小写单词，`b∈[0,5]`，时间戳是 number 毫秒。
13. 这会**覆盖全部数据**——只在用户要整库恢复时生成。

**D 互通包**
14. 推荐 `{omm:"bridge",v:1,items:[…]}`；每个 item 有 `t`；词按 `nkey(w)` 去重、空词/空句/空文会被丢。
15. `tags`/`src` 不落库（别指望它们出现在词书里）。

---

## 行为速查表

| 类型 | 覆盖还是新增 | 去重键 | 缺失/非法后果 |
|---|---|---|---|
| **A 词库** | 新建一本词书并切为当前 | `nkey(词)`（大小写空格不敏感） | 解析不出条目→「没有解析到有效词条」；空词条目静默丢 |
| **B 涂鸦** | 同名词涂鸦**覆盖** | 无（按词 key 覆盖） | 词不在词书→该张跳过；非 JSON→「涂鸦文件格式不正确」 |
| **C 备份** | **覆盖全部数据** | 无（整体替换 S） | 缺 `books` 或 `prog`→「备份文件格式不正确」 |
| **D 互通包** | 词→新词书；句/文→新听力材料 | 词按 `nkey(w)` | 无有效 item→「没有识别到可导入的内容」；用户取消→「已取消导入」 |

补充：涂鸦画布固定 **1200×800（3:2）**，按短边贴合居中；词元组列序 `[词, 音标, 释义, 例句, 例句译]`
是贯穿 C/D 的权威口径，A 只取前 4 列。
