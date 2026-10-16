# ZenData（omm-data.html）JSON 文件规范

> 用途：让 AI（或任何程序）**直接生成可导入的数据文件**，用户在 ZenData 里
> 「导入 → 从文件导入」→ 选中该文件即可看到表格；也可把内容粘进
> 「导入 → 从文本导入」的文本框直接解析。
>
> 本文所有字段名、默认值、容错行为都是从 `omm-data.html` 的
> `doImportFile()` / `parseAutoText()` / `fromJSON()` / `fromDelim()` /
> `inferTypes()` / `normTable()` / `openTextIn()` / `localData()` /
> `writeLocal()` 里逐行核对出来的，不是推测。少数结论仍带不确定，已就地标注。
>
> 关键路径速记（带行号，方便复核）：
> `doImportFile` ~9039、`parseAutoText` ~9102、`fromJSON` ~5318、
> `fromDelim` ~5278、`inferTypes` ~5135、`normTable` ~5052、
> `openTextIn` ~9196、`localData` ~12009、`writeLocal` ~12210、
> localStorage 键 `zendata.v1.doc` / `zendata.v1.settings`（CONFIG ~3658）。

---

## 0. 一句话规则

**「从文件导入 / 从文本导入」只认「表数据」，顶层必须是数组，
或形如 `{ "rows": [...] }` 的对象。** 它把数据变成**一张新表**塞进工作区。

**整工作区备份**（`{ "tables": [...], "activeId": ..., "settings": {...} }`）
是另一条完全不同的路径：它只写进 `localStorage` / 走云同步，
**文件选择器根本不认它**——把这种文件丢给「从文件导入」会直接报 `not array` 失败。

所以先分清你要生成哪一种：

| 你要什么 | 顶层形状 | 走哪条路径 | AI 能否用文件生成 |
|---|---|---|---|
| 一份表格数据（推荐） | `[ {...}, ... ]` 或 `[ [...], ... ]` | 从文件 / 从文本 | ✅ 是 |
| CSV / TSV / Markdown 表 / SQL | 纯文本 | 从文件 / 从文本 | ✅ 是（非 JSON） |
| 整个工作区快照 | `{ "tables": [...], ... }` | 仅 localStorage 注入 / 云同步 | ⚠️ 不能当文件导入 |

导入的表默认名一律是 **`import`**（不是文件名）。

---

## 0.5 给 AI 的提示词模板

把下面这段连同本文一起发给 AI，让它直接产出可导入的 `.json`：

```text
你要生成一个 ZenData 可导入的数据文件（.json，纯 JSON，UTF-8）。

严格遵守配套文档《data.md》的字段、缺省值和容错规则。硬性要求：

1. 顶层必须是「表数据数组」，二选一：
   (a) 对象数组：[ {"列名": 值, ...}, ... ]（最推荐，键即列名）；
   (b) 数组的数组：[ [v, v, ...], ... ]（无表头，列名自动 A、B、C…）。
   绝不输出 { "tables": [...] } 那种整工作区外壳——文件导入不认它。
2. 每行长度可以不齐，缺失单元格一律写成 null（空字符串 "" 也会被当空）。
3. 数字就是 JSON 数字；布尔就是 true/false；日期写成 "YYYY-MM-DD" 字符串；
   其余写字符串。列类型由引擎自动推断，你无法在数据文件里指定列类型。
4. 嵌套对象/数组不会被拆开，会被原样存下并按纯文本显示——尽量别用，摊平成多列更好。
5. 只输出 JSON 本身：不要 markdown 代码块围栏，不要注释，不要尾逗号。

最后自查并简述：有几列、几行、哪些列会被判成 number/date/bool/text。
```

---

## 1. 文件外壳与分派逻辑

### 1.1 「从文件导入」按扩展名分派（照抄 `parseAutoText` / `doImportFile`）

扩展名取文件名最后一个 `.` 后的部分并**转小写**：

```
if (ext === 'xlsx')                     -> 读二进制, xlsxRead          (AI 无法直接产出)
if (ext === 'db' || 'sqlite')           -> 读二进制, dbRead             (AI 无法直接产出)
if (ext === 'json')                     -> fromJSON(整个文本)
if (ext === 'jsonl' | 'ndjson')         -> 每行 JSON.parse -> 数组 -> fromJSON   (即 JSONL/NDJSON)
if (ext === 'md')                       -> fromMarkdown(文本)
if (ext === 'sql')                      -> fromSQLText(文本)   (可含多张表)
if (ext === 'xml')                      -> fromDelim(文本, '\t', 无表头)   ← 怪癖：按制表符且无表头
其它 (含无扩展名 / txt / csv / tsv ...):
    首字符是 '[' 或 '{'  -> 先试 fromJSON, 失败再往下
    开头是 CREATE TABLE / INSERT INTO -> fromSQLText
    看起来像 Markdown 管道表 -> fromMarkdown
    否则 -> detectDelim 猜分隔符(, ; \t |) -> fromDelim(有表头), 表名 'import'
```

> ⚠️ 未知/其它扩展名（包括 `.csv` `.tsv`）走的是**嗅探兜底**，不保证分类正确；
> 想稳就**用 `.json`**。`.xml` 会被当制表符无表头解析，别指望它真解析 XML。

### 1.2 「从文本导入」对话框（`openTextIn`，~9196）

弹窗里手动选：

| 选项 | 取值 | 说明 |
|---|---|---|
| 格式 `ti.format` | `auto` / `csv` / `tsv` / `json` / `md` / `sql` | `auto` 等同上面的嗅探 |
| 目标 `ti.target` | `new`（新建表） / `replace`（替换当前表） / `append`（追加到当前表） | 默认 `new` |
| 首行为列名 `ti.header` | 开 / 关 | 仅对 `csv` / `tsv` 有意义，默认「开」 |

选 `json` 时等价于 `fromJSON(text)`，规则同第 2 节。

### 1.3 顶层判别（最重要的一条）

`fromJSON` 内部只认这三种：

```
d = JSON.parse(text)
arr = Array.isArray(d) ? d
    : Array.isArray(d.rows) ? d.rows          // { "rows": [...] } 也行
    : null
if (!arr) throw new Error('not array')         // ← {tables:[...]} 在这里失败
```

所以：**顶层有数组、或有 `rows` 数组**，就能导入；其余一律 `not array`。

---

## 2. 数据集格式（三种合法 JSON 形状）

### 2.1 对象数组（最推荐）

```json
[
  { "id": 1, "name": "陈默", "dept": "编辑部", "score": 92, "joined": "2021-03-14" },
  { "id": 2, "name": "林知白", "dept": "设计部", "score": 78, "joined": "2020-07-02" }
]
```

- **列名 = 各对象的键**，按「首次出现顺序」取并集（第一个对象的键排前面）。
- 某行缺某个键 → 该格填 `null`；键值为 `""` 或 `undefined` → 也当 `null`。
- 各对象键顺序/数量不必一致，引擎会自动对齐、补空列。

### 2.2 数组的数组（无表头时用）

```json
[
  [1, "陈默", 92],
  [2, "林知白", 78]
]
```

- 列名自动为 `A`、`B`、`C`…（`idxToCol`）。
- 每行按位取；不足最长行的位置补 `null`。

### 2.3 `{ "rows": ... }` 包裹

`{"rows": <2.1 或 2.2 的数组>}` 与裸数组完全等价；`rows` 之外的一律被忽略。
（注意：这里的 `rows` 若填“数组的数组”或“对象数组”都可以，但 **不会**读你的 `cols` 字段——列名来自键或自动字母，手写 `cols` 会被丢弃。）

### 2.4 其它文本格式（AI 可直接生成的非 JSON 数据）

| 格式 | 规则要点 |
|---|---|
| CSV / TSV | 逗号/制表符分隔；双引号包字段，字段内 `""` 转义为 `"`；有表头则首行做列名 |
| JSONL / NDJSON（`.jsonl`/`.ndjson`） | 每行一个 JSON 对象（空行跳过），整体当“对象数组” |
| Markdown 表（`.md`） | `|` 分隔，第一行是列名，纯 `-`/`:` 的分隔行自动跳过 |
| SQL（`.sql`） | `CREATE TABLE` + `INSERT INTO`；一次可产**多张表**；表名即列名 |

CSV/TSV/MD 里数字样式的单元格会被转成 JS 数字，空串转 `null`（见第 5 节）。

---

## 3. 表格对象（内部模型，`normTable` ~5052）

导入的每个数据集最终都被规整成这个结构存进工作区（`localStorage` 的 `tables` 数组）：

```jsonc
{
  "id": "a1b2c3d4",         // 字符串；缺省自动生成 uid()
  "name": "import",          // 表名；数据集导入恒为 "import"
  "cols": [                  // 见第 4 节
    { "name": "id", "type": "number" },
    { "name": "name", "type": "text" }
  ],
  "rows": [                  // 数组的数组，按位对应 cols
    [1, "陈默"],
    [2, "林知白"]
  ],
  "colW": []                 // 可选：每列显示宽度(px)，长度任意
}
```

规整规则（`normTable`，全部静默执行，不报错）：

- 列对齐：以 `cols.length` 与「最长行的单元格数」取最大值为最终列数；短行尾部补 `null`，短列补 `{name: 字母}`。
- 至少留一行：`rows` 为空时补一行全 `null`（列数不足则补空列）。
- `colW` 非数组则当 `[]`。
- `id`/`name` 会被 `String()` 化；缺省分别用 `uid()` / `'sheet'`。

> 数据集导入**不经过** `cols`（列名来自键/字母），`type` 完全靠推断（第 5 节）。
> 只有走整工作区外壳（第 6 节）时，`cols[].type` 才会被尊重（已有 type 的列不再重推）。

---

## 4. 列对象 `cols[]`

```jsonc
{ "name": "score", "type": "number" }
```

| 字段 | 必需 | 取值 / 缺省 |
|---|---|---|
| `name` | 是 | 字符串；缺省用 `idxToCol(i)`（A、B、C…AA…）。在整工作区里，一个纯字符串项也能当列名 |
| `type` | 否 | `number` / `date` / `bool` / `text`；缺省 → 交给 `inferTypes` 推断 |

- 数据集导入里你**控制不了** type；只有工作区表 `cols` 里手写的 type 会被保留（`inferTypes(t, true)` 只补没类型的列）。

---

## 5. 单元格取值与类型推断（`inferTypes` ~5135）

**单元格合法值**：JS 数字、`true`/`false`、字符串、`null`。空单元格一律用 `null`。
日期写成字符串（约定 `"YYYY-MM-DD"`，也可带时间，如 CSV 里 `"2021-3-14 08:00"`）。

每列扫描所有**非空**单元格，全票才成立，否则 `text`：

| 列类型 | 判据（所有非空值都满足） |
|---|---|
| `number` | 是数字，或匹配 `^-?\d+(\.\d+)?$`（仅整数/小数；`1e5`、千分位 `,` 不算数字，会退回 text） |
| `date` | 匹配 `^\d{4}[-/]\d{1,2}[-/]\d{1,2}` 且 `Date.parse` 可解析 |
| `bool` | 字符串恰为 `true`/`false`/`TRUE`/`FALSE` |
| `text` | 其余全部 |

- 混合列（既有数字又有文本）→ 整列判 `text`。
- 全空列 → `text`。
- 数字样式的字符串会被**主动转成数字**存下（CSV/MD 路径；JSON 数字本就是数字）。

---

## 6. 整工作区备份 / 恢复外壳（进阶，⚠️ 不是文件导入）

这是 `localStorage` 里真实存放的结构，也是**云同步**搬运的内容
（`localData()` ~12009 = 两个键合并后的对象）。把下面这份 JSON 注入
`localStorage` 的 `zendata.v1.doc`（放 `tables`+`activeId`）与 `zendata.v1.settings`
（放 `settings`），或走云同步，即可整套还原。

```jsonc
{
  "format": "zendata-workspace",   // 建议写；app 只认 tables/activeId/settings，其余键忽略
  "version": 1,                     // 建议写；当前不校验
  "activeId": "t1",                 // 打开哪张表；须等于某 tables[].id，缺省回退第一张
  "tables": [ /* 第 3 节的表格对象数组 */ ],
  "settings": { /* 见 6.1 */ }
}
```

读取硬条件：`Storage.doc()` 要求 `Array.isArray(v.tables)`，否则当空文档。
`writeLocal()` 会把 `settings` 拆出来单独落盘，其余（tables/activeId）进 `doc` 键。

### 6.1 `settings` 字段表（`Settings.save` ~4742 / `applyFrom` ~4800）

全部可选，缺省取下列值；越界值会被 `clamp` 夹回。

| 键 | 类型 | 缺省 | 取值 / 容错 |
|---|---|---|---|
| `lang` | string | `zh` | `zh` / `en` |
| `theme` | string | `light` | `light` / `dark` |
| `bg` | string | `bg-void` | `bg-void`/`bg-grid`/`bg-dots`/`bg-cross`/`bg-diagonal` |
| `zoom` | number | `1` | clamp `[0.7,1.6]` |
| `radius` | number | `0` | clamp `[0,12]` |
| `fontSize` | number | `13` | clamp `[11,20]` |
| `cellFont` | number | `13` | clamp `[11,22]` |
| `colW` | number | `150` | clamp `[80,340]`（默认列宽） |
| `rowH` | number | `30` | clamp `[24,52]` |
| `statusBarVisible` | bool | `true` | |
| `menuPinned` | bool | `true` | |
| `view` | string | `grid` | `grid` / `sql` / `schema` |
| `autoGrow` | bool | `true` | 仅显式 `false` 才关 |
| `trimEmpty` | bool | `true` | 仅显式 `false` 才关 |
| `filter` | obj | `{on:false,...}` | `{ on, mode:'and'/'or', cs, conds:[{col:number,op:string,val:string}] }`；派生的命中行不入库、加载时重算 |
| `find` | obj/null | `null` | `{ q, rep, regex, cs, whole }` |
| `sort` | obj | 见下 | `{ dim:'row'/'col', by:number, crit, crit2, dir:'asc'/'desc', nulls:'first'/'last' }` |
| `sortMark` | obj/null | `null` | `{ dim, by:number, dir }` |
| `sql` | string | `''` | 查询页输入框内容 |
| `sqlHist` / `findHist` / `repHist` | array | `[]` | 各截取前 20 条 |
| `lastResult` | obj/null | `null` | `{ cols:[...], rows:[...], msg:string }`，须有非空 `cols` 才保留 |

> `filter`/`sort`/`find`/`sql` 这些属于**工作台状态**（筛选/排序/查找/查询），
> 只有走工作区外壳才能带上；「从文件/从文本」的数据集导入不涉及它们，
> 且导入会把筛选临时关闭（`addTables` 重置 `S.filter.on=false`）。

---

## 7. 最小可用示例（数据集，可直接当 `.json` 导入）

以下两个代码块是**完整严格合法的 JSON**，无注释、无尾逗号，可保存为 `data.json` 用「从文件导入」，或粘进「从文本导入」选 `JSON`。

```json
[
  { "id": 1, "name": "陈默", "score": 92 },
  { "id": 2, "name": "林知白", "score": 78 }
]
```

```json
[
  [1, "陈默", 92, "2021-03-14"],
  [2, "林知白", 78, "2020-07-02"]
]
```

---

## 8. 完整示例（涵盖多类型 + 空值 + 工作区外壳）

### 8.1 数据集文件（对象数组，混合列类型，含 null）

```json
[
  { "id": 1, "name": "陈默", "dept": "编辑部", "score": 92, "active": true, "joined": "2021-03-14", "note": null },
  { "id": 2, "name": "林知白", "dept": "设计部", "score": 78, "active": false, "joined": "2020-07-02", "note": "远程" },
  { "id": 3, "name": "苏晚", "dept": "编辑部", "score": 85, "active": true, "joined": "2022-01-19", "note": "" }
]
```

推断结果：`id`/`score` → `number`，`name`/`dept`/`note` → `text`，`active` → `bool`，`joined` → `date`。`""` 与 `null` 都当空格。

### 8.2 整工作区备份（多表 + settings；仅供 localStorage 注入 / 云同步，**不要**当文件导入）

```json
{
  "format": "zendata-workspace",
  "version": 1,
  "activeId": "t1",
  "tables": [
    {
      "id": "t1",
      "name": "员工",
      "cols": [
        { "name": "id", "type": "number" },
        { "name": "name", "type": "text" },
        { "name": "dept", "type": "text" },
        { "name": "score", "type": "number" },
        { "name": "joined", "type": "date" }
      ],
      "rows": [
        [1, "陈默", "编辑部", 92, "2021-03-14"],
        [2, "林知白", "设计部", 78, "2020-07-02"]
      ],
      "colW": []
    },
    {
      "id": "t2",
      "name": "预算",
      "cols": [
        { "name": "项目", "type": "text" },
        { "name": "金额", "type": "number" },
        { "name": "已批", "type": "bool" }
      ],
      "rows": [
        ["服务器", 12000, true],
        ["外包", 8000, false]
      ],
      "colW": [200, 150, 100]
    }
  ],
  "settings": {
    "lang": "zh",
    "theme": "light",
    "view": "grid",
    "zoom": 1,
    "statusBarVisible": true,
    "filter": { "on": false, "mode": "and", "cs": false, "conds": [] },
    "sort": { "dim": "row", "by": 0, "crit": "text", "crit2": "auto", "dir": "asc", "nulls": "last" },
    "sql": "",
    "sqlHist": [],
    "lastResult": null
  }
}
```

---

## 9. 给生成方的硬性检查清单

生成**可导入的数据文件**时逐条自查：

1. 顶层是**数组**（对象数组或数组的数组），或 `{ "rows": [...] }`。**绝不能**是 `{ "tables": [...] }`——那会被判 `not array` 而失败。
2. 每个单元格只用：数字、`true`/`false`、字符串、`null`；空格写 `null`（`""` 也会被当空）。
3. 日期写成 `"YYYY-MM-DD"` 字符串；需要科学计数/千分位请当文本（否则可能被误判类型）。
4. 别塞嵌套对象/数组：它们不会被拆开，只会按纯文本显示；要分层就摊平成多列。
5. 各行键数/顺序不必一致，引擎自动对齐补空——但仍建议保持一致，便于阅读。
6. 文件是 **UTF-8 合法 JSON**：无注释、无尾逗号、无 markdown 围栏。
7. 若目标是整工作区：确认走的是 localStorage / 云同步，而非文件导入；并保证有 `tables` 数组与有效 `activeId`。

只要 1–2 条满足，「从文件/从文本导入」就一定成功建表；3–6 条决定类型准不准、好不好看。

---

## 10. 行为速查表

| 情况 | 结果 |
|---|---|
| 顶层是 `{tables:[...]}` 且当文件导入 | 报 `not array`，什么都不变 |
| 顶层空数组 `[]` | 建一张只有列 `A`、一行空的表 |
| 对象数组里某行缺某键 | 该格填 `null` |
| 单元格为 `""` | 视作 `null`（空格） |
| 数字样式字符串（CSV/MD/JSON） | 自动转成 JS 数字（`number` 列） |
| `1e5` / `1,000` | 不匹配整数/小数正则 → 当 `text` |
| 列内值类型混合 | 整列判 `text` |
| 各行长度不齐 | 以最长行/列数为准，短行补 `null`，短列补字母列 |
| 表名 | 数据集导入恒为 `import`；多张同名不会自动去重 |
| 「从文本」目标=替换 | 覆盖当前表的 cols/rows，colW 清空后重推类型 |
| 「从文本」目标=追加 | 追加行到当前表，列数取两者最大后补齐 |
| `.xml` 文件 | 按制表符、**无表头**解析（怪癖，别用） |
| `.xlsx` / `.db` / `.sqlite` | 二进制，AI 无法直接产出对应 JSON |
| `cols[].type`（工作区表） | 显式 type 被保留，不再重推；缺省才推断 |
| 单次数据量 | 代码无行数/列数硬上限；实际受 localStorage 配额（约 5MB）约束 |
