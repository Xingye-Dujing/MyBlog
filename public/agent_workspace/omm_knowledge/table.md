# 表格自动化（omm-table.html）工作流 JSON 规范

> 用途：让 AI（或任何程序）**直接生成可被表格自动化导入的 JSON**。
> 表格自动化是 `omm-table.html`（OMM-ZEN 表格自动化，端口 8331，节点工作流 + 本地 openpyxl 后端）。
>
> 本文与 `agent_workspace/omm_knowledge/table.md` 互补：后者面向 AI 检索，
> 本文是格式合约（字段/默认值/约束），由 `json-specs/format-registry.json` 的 table 条目声明为
> `format: "omm-table-workflow"`，并由 `agent_workspace.omm_validators` 校验。

---

## 0. 文件外壳

```json
{
  "format": "omm-table-workflow",
  "version": 1,
  "nodes": [
    { "id": "n1", "type": "file", "data": { "fileId": "", "filename": "" } }
  ],
  "connections": [
    { "from": "n1", "to": "n2", "fromPort": "right", "toPort": "left" }
  ]
}
```

| 字段 | 必需 | 校验 / 缺省行为 |
|---|---|---|
| `format` | 是 | 必须等于 `"omm-table-workflow"`（硬校验） |
| `version` | 是 | 必须是数字 `1`（硬校验） |
| `nodes` | 是 | 顶层数组；每个节点合法；必须**有且只有一个** `file` 节点 |
| `connections` | 是 | 顶层数组；可空；`from`/`to` 必须指向已存在的 id；不能成环 |

**节点对象**：`id` 全局唯一、非空；`type` 是下表的 op；`data` 必须是对象，只写要改的字段（其它用默认值）。

**连线对象**：`from`/`to` 必需；`fromPort` 默认 `"right"`，`toPort` 默认 `"left"`；
连接节点用 `toPort: "top"` 接第二张表。除 `file` / `note` 外，每个节点至少有一个上游。

---

## 1. 运行模型

- 一张“表”是行的集合，每行带 `sheet`、`src_row` 与各列的值；Excel 的逐行/逐表循环由引擎隐式完成。
- 节点是“表 → 表”的纯变换；写节点只收集写计划，`save` 时统一按表**自底向上插行**再写值，避免行号偏移。
- 同一行被多个节点写入时最后一次生效；写一个新插入的空行不会触发冲突。
- 冲突策略：`skip`（默认，跳过非空）、`overwrite`（覆盖）、`error`（遇到非空中止且不保存）。
- 试运行（`dryRun`）只计算不写文件，返回冲突清单与写入计划；`previewNode` 可只算到某个节点。
- 后端只支持 `.xlsx` / `.xlsm`；Web 部署没有后端，只能编辑/导入导出，不能运行。AI 生成时 `fileId` 必须留空。

---

## 2. 节点库（op → data 默认值）

### 输入

| op | 名称 | data 默认值 | 说明 |
|---|---|---|---|
| `file` | Excel 文件与区域 | `{fileId:"",filename:"",sheetMode:"one",sheet:"",selected:[],rangeMode:"auto",startCell:"A1",endCell:"",headerRow:0,overrides:[]}` | `sheetMode`: one/all/selected；`rangeMode`: auto/manual；`overrides` 为 `[{sheet,startCell,endCell,headerRow}]` |

### 计算

| op | 名称 | data 默认值 | 说明 |
|---|---|---|---|
| `mapCells` | 逐格计算 | `{columns:"C:AG",step:1,op:"copy",lookupKind:"time",lookup:[],defaultResult:0,sourceSkipEmpty:true}` | 对列范围每格执行同一规则 |
| `mapColumns` | 逐列批量计算 | `{targetColumns:"E:CG",step:2,sourceMode:"left",sourceOffset:-1,op:"multiply",zeroOnInvalid:true}` | 源列模式 left/same/fixed/header |
| `formula` | 计算列 | `{outputColumn:"AL",expression:"[D]*[C]"}` | 安全表达式，写到指定列 |

`mapCells` / `mapColumns` 共用的 `op` 与附加字段：

| op | 附加字段 | 说明 |
|---|---|---|
| `copy` | — | 原样复制 |
| `lastTime` | — | 取单元格最后一个时间（兼容文本/time/Excel 序列） |
| `lastTimeLookup` | `lookup`, `defaultResult`, `lookupKind:"time"` | 取最后时间后按时间区间分档 |
| `lookup` | `lookup`, `defaultResult`, `lookupKind:"numeric"|"exact"` | 数值区间或精确匹配 |
| `number` | `zeroOnInvalid` | 转成数字 |
| `multiply` | `factor:{mode:"column"|"header"|"constant",column,header,value}`, `zeroOnInvalid` | 乘以某列或常数 |
| `text` | `textOp`, `textN`, `textStart`, `textOld`, `textNew`, `pattern`, `group`, `prefix`, `suffix` | trim/upper/lower/left/right/mid/replace/regex |
| `condition` | `condition:{logic,rules:[{column,op,value}],then,else}` | 多条件分支 |
| `formula` | `expression` | 安全表达式，`value` 为当前格 |

`lookup` 表格式：`[{ "min": "18:56", "max": "19:24", "result": 1 }, ...]`；
`min` 留空表示 -∞，`max` 留空表示 +∞，边界为**闭区间**，从上往下取第一个命中项。

**安全表达式**：用 `[列字母]` 引用本行，如 `[D]*[C]`；可用 `value`、`row`、`sheet`；
允许 `IF / AND / OR / NOT / ABS / ROUND / MIN / MAX / SUM / LEN / UPPER / LOWER / TRIM / LEFT / RIGHT / MID / CONTAINS / REGEX / NUMBER / TEXT / LASTTIME / ISBLANK`；
禁止属性访问、任意函数调用、闭包、推导式、`import` / `eval` / `open`。

### 整理

| op | 名称 | data 默认值 | 说明 |
|---|---|---|---|
| `filter` | 筛选行 | `{logic:"and",rules:[],keep:true}` | 条件同 `condition.rules`；比较符 `> >= < <= == != contains notContains empty notEmpty startsWith endsWith` |
| `sort` | 排序 | `{keys:[{column:"A",dir:"asc"}]}` | 多列稳定排序 |
| `dedupe` | 去重 | `{columns:"A",keep:"first"}` | keep: first/last |
| `join` | 两表连接 | `{leftKey:"A",rightKey:"A",mode:"left",prefix:"R_"}` | 主表接 left 端口，副表接 top 端口；mode: left/inner |

### 汇总

| op | 名称 | data 默认值 | 说明 |
|---|---|---|---|
| `aggregate` | 分组汇总 | `{mode:"columns",valueColumns:"E:CG",step:2,agg:"sum",groupBy:"A",nameKey:"姓名",sheetKey:"__sheet",totalKey:"合计",nameColumnOffset:-1}` | `mode:"columns"` 按列汇总（姓名取表头行）；`mode:"rows"` 按列分组；agg: sum/avg/count/min/max |
| `pivot` | 交叉汇总 | `{rowKeys:["姓名"],colKey:"__sheet",valueKey:"合计",rowTotals:true,colTotals:true,totalLabel:"合计"}` | 行转列，生成行列合计 |

### 输出

| op | 名称 | data 默认值 | 说明 |
|---|---|---|---|
| `write` | 写回单元格 | `{columns:"C:AG",rowMode:"same",offset:0,conflict:"skip",style:"asc",skipEmpty:true,skipZero:false}` | rowMode: same/next/insertBelow/offset；style: asc/inherit/keep |
| `writeFormula` | 写公式 | `{kind:"rowSum",columns:"C:AG",targetColumn:"AH",rowMode:"same",sumRow:"auto",conflict:"skip",style:"asc"}` | rowSum 横向 SUM；colSum 纵向 SUM，`sumRow:"auto"` = 每表数据末行下一行 |
| `exportTable` | 导出汇总表 | `{filename:"汇总表.xlsx",sheetName:"汇总",title:"",header:true,totals:true}` | 独立 xlsx |
| `save` | 保存工作簿 | `{filename:"结果文件.xlsx"}` | 终点节点 |
| `preview` | 节点预览 | `{rows:20}` | 只查看数据 |
| `note` | 注释 | `{text:"说明这一步做什么"}` | 仅画布说明 |

---

## 3. 最小示例

### 3.1 加班补贴：时间分档 + 插入空行

```json
{
  "format": "omm-table-workflow",
  "version": 1,
  "nodes": [
    { "id": "file-1", "type": "file", "data": { "fileId": "", "filename": "", "sheetMode": "one", "sheet": "打卡时间", "rangeMode": "manual", "startCell": "C6", "endCell": "AG90", "headerRow": 0 } },
    { "id": "map-1", "type": "mapCells", "data": { "columns": "C:AG", "op": "lastTimeLookup", "lookupKind": "time", "defaultResult": 3, "lookup": [
      { "min": "", "max": "18:55", "result": 0 },
      { "min": "18:56", "max": "19:24", "result": 1 },
      { "min": "19:25", "max": "19:54", "result": 1.5 },
      { "min": "19:55", "max": "20:24", "result": 2 },
      { "min": "20:25", "max": "20:54", "result": 2.5 },
      { "min": "20:55", "max": "", "result": 3 }
    ] } },
    { "id": "write-1", "type": "write", "data": { "columns": "C:AG", "rowMode": "insertBelow", "conflict": "skip", "style": "asc", "skipEmpty": true, "skipZero": true } },
    { "id": "sum-1", "type": "writeFormula", "data": { "kind": "rowSum", "columns": "C:AG", "targetColumn": "AH", "rowMode": "insertBelow", "style": "asc" } },
    { "id": "save-1", "type": "save", "data": { "filename": "结果文件.xlsx" } }
  ],
  "connections": [
    { "from": "file-1", "to": "map-1" },
    { "from": "map-1", "to": "write-1" },
    { "from": "write-1", "to": "sum-1" },
    { "from": "sum-1", "to": "save-1" }
  ]
}
```

### 3.2 工资：逐列乘系数 + 列合计 + 汇总

```json
{
  "format": "omm-table-workflow",
  "version": 1,
  "nodes": [
    { "id": "file-1", "type": "file", "data": { "fileId": "", "filename": "", "sheetMode": "all", "rangeMode": "auto", "startCell": "A1", "headerRow": 1 } },
    { "id": "map-1", "type": "mapColumns", "data": { "targetColumns": "E:CG", "step": 2, "sourceMode": "left", "sourceOffset": -1, "op": "multiply", "factor": { "mode": "column", "column": "C" }, "zeroOnInvalid": true } },
    { "id": "write-1", "type": "write", "data": { "columns": "E:CG", "step": 2, "rowMode": "same", "conflict": "skip", "style": "asc" } },
    { "id": "sum-1", "type": "writeFormula", "data": { "kind": "colSum", "columns": "E:CG", "step": 2, "sumRow": "auto", "style": "asc" } },
    { "id": "agg-1", "type": "aggregate", "data": { "mode": "columns", "valueColumns": "E:CG", "step": 2, "agg": "sum", "nameKey": "姓名", "sheetKey": "__sheet", "totalKey": "合计", "nameColumnOffset": -1 } },
    { "id": "pivot-1", "type": "pivot", "data": { "rowKeys": ["姓名"], "colKey": "__sheet", "valueKey": "合计", "rowTotals": true, "colTotals": true, "totalLabel": "合计" } },
    { "id": "export-1", "type": "exportTable", "data": { "filename": "工资汇总表.xlsx", "sheetName": "工资汇总", "title": "工资表", "header": true, "totals": true } },
    { "id": "save-1", "type": "save", "data": { "filename": "工资计算结果.xlsx" } }
  ],
  "connections": [
    { "from": "file-1", "to": "map-1" },
    { "from": "map-1", "to": "write-1" },
    { "from": "write-1", "to": "sum-1" },
    { "from": "sum-1", "to": "agg-1" },
    { "from": "agg-1", "to": "pivot-1" },
    { "from": "pivot-1", "to": "export-1" },
    { "from": "export-1", "to": "save-1" }
  ]
}
```

---

## 4. 给 AI 的提示词模板

```text
你要生成一个 OMM-ZEN 表格自动化（omm-table.html）的工作流 JSON 文件（UTF-8）。

硬性要求：
1. 顶层必须是 { "format": "omm-table-workflow", "version": 1, "nodes": [...], "connections": [...] }。
2. nodes[] 里每个 { "id": "唯一短串", "type": "<节点op>", "data": {...} }；data 只写本文给出的
   默认值中要改的字段，字段类型与默认值同型；不要另造字段。
3. connections[] 里每个 { "from": <上游id>, "to": <下游id>, "fromPort": "right", "toPort": "left" }；
   连接节点的副表用 toPort:"top"。必须有一个 file 节点且只有一个；除 file/note 外都要有上游；不能成环。
4. fileId 留空（AI 无法上传文件），由用户在工作台导入后手动运行。
5. 只输出 JSON 本身，不要 markdown 代码块围栏、不要注释、不要尾逗号。

翻译规则：
- “按打卡时间算补贴并插行” → file → mapCells(lastTimeLookup) → write(insertBelow) → writeFormula(rowSum) → save。
- “每列乘系数并汇总” → file(all) → mapColumns(multiply) → write → writeFormula(colSum) → aggregate(columns) → pivot → exportTable → save。
- “筛选/去重/排序/连接” → 对应 filter / dedupe / sort / join（join 副表接 top 端口）。
- 先生成 JSON，再自检：每个 id 唯一、每条连线端点存在、没有环、文件名以 .xlsx 结尾。
```
