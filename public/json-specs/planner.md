# ZenPlan 计划本文件 JSON 规范

> 用途：让 AI（或任何程序）**直接生成计划本文件**，用户在 ZenPlan 里
> 「导入」→ 选中该 `.json` 文件，条目就会出现在日历上。
>
> 本文所有字段名、默认值、容错行为都是从 `omm-planner.html` 的
> `IO.exportJSON()`（写出）、`IO.importJSON()`（读入）、`normEvent()` /
> `normRule()` / `normSubtasks()`（归一化）以及 `Store.load()` / `Store.add()`
> 里逐行核对出来的，不是推测。
>
> 兼容性：`version: 2`。导入的硬性分派条件就是 `version === 2`（严格等于数字 2）。

---

## 0. 一句话规则

**导入只认两种外壳，且永远是「追加 + 按 id 去重」，绝不覆盖、绝不整体替换。**

- 顶层同时满足 `version === 2`（数字 2）且 `planners` 是数组 → 走**整册备份导入**
  （读 `eventsBy`、`recursBy`，按 planner 分别追加）。
- 否则 → 读 `data.events || data`，把它当作**日期→事件数组的字典**，
  **全部追加进当前激活的计划本**（不带日期以外的分组、不带重复规则）。

字段缺省都会被 `normEvent` / `normRule` 补齐，**但一条事件必须同时有 `id` 和
`title`、一条规则必须有 `title`，否则整条被静默丢弃**。

---

## 0.5 给 AI 的提示词模板

把下面这段连同本文一起发给 AI，让它直接产出可导入的 `.json`：

```text
你要生成一个 ZenPlan 计划本导入文件（JSON 格式）。

严格遵守配套文档《planner.md》里的字段、缺省值和容错规则。硬性要求：

1. 除非明确要求"极简纯事件"，一律输出整册备份外壳：
   { "app": "zenplan", "version": 2, "exportedAt": "<ISO 时间>",
     "planners": [{ "id": "...", "name": "..." }], "activeId": "...",
     "eventsBy": { "<plannerId>": { "YYYY-MM-DD": [ 事件... ] } },
     "recursBy": { "<plannerId>": [ 规则... ] } }。
2. version 必须是数字 2（不是 "2"，不是 2.0），planners 必须是数组，否则不会走整册分支。
3. eventsBy / recursBy 的键必须用某个 planner 的 id，且这些 id 要在 planners 里出现过，
   否则数据会被忽略（导入按 planners 列表遍历）。
4. 每条事件必须有唯一字符串 "id" 和非空 "title"；每个日期键必须是 YYYY-MM-DD（否则丢弃）。
5. "type" 只能取 todo / event / note；"priority" 只能取 high / mid / low；
   "color" 只能取 5 个十六进制色值之一，其它会被改成 #888888；
   "time" 要么留空字符串，要么是 HH:MM（两位小时两位分钟），其它一律清空。
6. 日期、时间都是字符串；created / order 是毫秒数字戳；done 取 true / false / "failed"。
7. 重复规则的 rrule.mode 只能取 daily/weekly/monthly/yearly/dates；
   rrule.start/end 必须是 YYYY-MM-DD 或空串；mode 为 dates 时把具体日期放进 rrule.dates 数组。
8. 只输出 JSON 本身，不要 markdown 代码块围栏，不要注释，不要尾逗号，UTF-8 编码。

最后自查并在 JSON 后附一份简短检查清单：计划本数、事件总数、规则总数、
所有 id 是否唯一、所有日期键是否合法、有没有缺 title 的条目。
```

---

## 1. 文件外壳（两种，二选一）

### 1.1 整册备份外壳（推荐，等同「JSON 备份」导出物 `zenplan-backup.json`）

```jsonc
{
  "app": "zenplan",                 // 仅人读，不参与判断
  "version": 2,                     // 必须是数字 2 —— 触发整册分支的唯一开关
  "exportedAt": "2026-10-16T05:57:46.568Z",  // 可选，ISO 字符串
  "planners": [ { "id": "p1", "name": "工作" }, { "id": "p2", "name": "生活" } ],
  "activeId": "p1",                 // 备份里记录当前页；整册导入不会切换页
  "eventsBy": {                     // plannerId -> ( "YYYY-MM-DD" -> 事件数组 )
    "p1": { "2026-01-05": [ /* 见第 3 节 */ ] }
  },
  "recursBy": {                     // plannerId -> 重复规则数组
    "p1": [ /* 见第 4 节 */ ]
  }
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `version` | **是** | 必须严格等于数字 `2`。写成 `"2"` / `2.0` / `3` 都会掉进「极简事件」分支 |
| `planners` | **是** | 必须是非空数组；每个元素必须有 `id`，否则该计划本被跳过 |
| `eventsBy` | 否 | 缺省视为 `{}`。键是 planner 的 **源 id**（与 `planners[].id` 对应） |
| `recursBy` | 否 | 缺省视为 `{}`。键同样是源 planner id |
| `app` / `exportedAt` / `activeId` | 否 | 仅记录/展示用，导入逻辑不消费 `activeId`（不切换当前页） |

**整册导入的分派逻辑（照抄代码行为）**：

```
for srcP of planners:
    if !srcP || !srcP.id: continue                       # 无 id 的计划本跳过
    pid = String(srcP.id)
    if 现有 planners 已有同名 id: pid = uid()             # 撞车 → 换一个新 id
    planners.push({ id: pid, name: srcP.name || pid })    # 追加一个新计划本
    把 eventsBy[srcP.id] 的每条事件追加到 eventsBy[pid]（按天，按 id 去重）
    把 recursBy[srcP.id] 的每条规则追加到 recursBy[pid]（按 id 去重）
```

- 源数据键用的是 `srcP.id`，落地键用的是可能被改写过的 `pid`，二者由程序自动对应。
- **永远追加**：即使 id 不撞车，也是把新计划本 push 进列表，不是合并同名计划本。

### 1.2 极简事件外壳（往当前激活计划本塞东西时用）

```jsonc
{
  "2026-01-05": [ { "id": "e1", "type": "todo", "title": "买牛奶" } ],
  "2026-01-06": [ { "id": "e2", "type": "note", "title": "灵感" } ]
}
```

或包一层 `events`：

```jsonc
{ "events": { "2026-01-05": [ /* 事件 */ ] } }
```

- 读取规则：`const incoming = data.events || data`，要求是**普通对象**（不能是数组、不能为空），
  否则抛错 → 提示「文件无效」。
- 每个**日期键**必须匹配 `^\d{4}-\d{2}-\d{2}$`，不合法的键整组丢弃。
- 该分支**只写进当前激活计划本**（`Store.add → Store.events → activeId`），
  **不支持** `recursBy` / 重复规则。
- ⚠️ 若你给顶层写了 `version: 2` 却没有数组 `planners`，会掉进这个分支，
  于是程序把 `{ app, exportedAt, activeId, eventsBy, ... }` 当成"日期字典"逐键看，
  结果所有键都不是 `YYYY-MM-DD` → **一条都导不进来**。所以要么完整走 1.1，要么干净走 1.2，别混。

---

## 2. 记录模型总览

计划本里只有两种记录：

| 记录 | 存放位置 | 归一化函数 | 是否含 `done` | 是否有 `rrule` |
|---|---|---|---|---|
| **事件 event** | `eventsBy[pid][日期] = []` | `normEvent` | 有 | 无 |
| **重复规则 rule** | `recursBy[pid] = []` | `normRule` | 无（用 `doneMap`） | 有 |

> 注意：没有独立的 `kind` 字段。代码里出现的 `kind`（如 `'chip'` / `'cell'`）是
> 拖拽/点击命中的 UI 标记，与记录无关，**不要往记录里写 `kind`**。

---

## 3. 事件对象（`normEvent`）

```jsonc
{
  "id": "mt5g8chkzz9oq",   // 字符串，必填（导入去重键）
  "type": "todo",           // todo | event | note
  "title": "买牛奶",         // 字符串，必填（无 title 整条丢弃）
  "note": "",               // 补充说明，纯文本
  "time": "09:30",          // 两位 HH:MM，或空串（event 常用）
  "color": "#888888",       // 5 个枚举色之一
  "priority": "mid",        // high | mid | low
  "tag": "",                // 标签，纯文本
  "subtasks": [],           // 子任务数组，见 3.2
  "done": false,            // true | false | "failed"（仅 todo 有意义）
  "created": 1787467892024, // 毫秒数字戳
  "order": 1787467892024    // 排序数字；缺省时回退为 created
}
```

| 字段 | 类型 | 缺省 / 容错 | 备注 |
|---|---|---|---|
| `id` | string | **缺失或为空 → 整条丢弃** | 导入用它在同一天内去重；强烈建议全局唯一 |
| `type` | string | 原样保留（无校验/缺省） | 合法值仅 `todo` / `event` / `note`；写别的不会报错但渲染会怪 |
| `title` | string | **缺失或为空 → 整条丢弃**；否则 `String()` | 这是第二个硬性必填 |
| `note` | string | 缺省 `''` | |
| `time` | string | 只有匹配 `^\d{2}:\d{2}$` 才保留，否则置 `''` | 想写 9:30 请写 `"09:30"` |
| `color` | string | 命中 5 色枚举才保留，否则 `'#888888'` | 枚举：`#888888` `#cc3333` `#3366cc` `#339933` `#cc6600` |
| `priority` | string | 命中 `high/mid/low` 才保留，否则 `'mid'` | |
| `tag` | string | 缺省 `''` | |
| `subtasks` | array | 非数组 → `[]`；逐项见 3.2 | |
| `done` | bool / `"failed"` | `'failed'` 保留，其余做布尔化（`!!`） | 仅 `type==='todo'` 时被当作完成态 |
| `created` | number | 缺省 `0` | 毫秒时间戳；也参与排序回退 |
| `order` | number | 是数字则用，否则回退为 `created` | 拖拽排序用，可省略 |

### 3.1 关于 `type`

- `todo`：待办，显示复选框，`done` 控制打勾/失败态。
- `event`：日程/事件，通常带 `time`。
- `note`：备注。

### 3.2 子任务对象（`normSubtasks`）

```jsonc
{ "id": "s1", "title": "步骤一", "done": false }
```

| 字段 | 类型 | 容错 |
|---|---|---|
| `id` | string | 缺失则自动生成 |
| `title` | string | 缺省 `''` |
| `done` | bool / `"failed"` | `'failed'` 保留，其余布尔化 |

- `subtasks` 数组里 falsy 的项（`null` / `''` 等）会被过滤掉。

---

## 4. 重复规则对象（`normRule`）

规则不是普通事件，多了 `renderPast`、`doneMap`、`rrule`，且**没有 `done`**（完成态记在 `doneMap` 里，按日期键存）。

```jsonc
{
  "id": "mtx40uphuny8v",
  "type": "event",
  "title": "周末作业必须用 AI",   // 必填：无 title 整条丢弃
  "note": "",
  "time": "",
  "color": "#888888",
  "priority": "high",
  "tag": "",
  "subtasks": [],
  "created": 1789129528821,
  "order": -1,
  "renderPast": false,
  "doneMap": {},
  "rrule": {
    "mode": "weekly",           // daily | weekly | monthly | yearly | dates
    "start": "2026-09-12",      // YYYY-MM-DD 或空串
    "end": "2027-03-01",        // YYYY-MM-DD 或空串
    "dates": []                 // mode==="dates" 时放具体 YYYY-MM-DD
  }
}
```

| 字段 | 类型 | 缺省 / 容错 | 备注 |
|---|---|---|---|
| `id` | string | 缺失则自动生成（规则 id 非必填，靠自动值去重） | |
| `title` | string | **为空 → 整条丢弃** | |
| `type` | string | 非 `todo/event/note` → `'todo'` | |
| `note` `tag` `color` `priority` `time` `subtasks` | 同事件 | 同事件容错 | |
| `created` | number | 缺省 `0` | |
| `order` | number | 是数字则用，否则回退为 **`-1`**（注意与事件不同） | |
| `renderPast` | bool | 字段存在则布尔化，缺省 **`true`** | 是否也渲染过去实例 |
| `doneMap` | object | 非对象 → `{}` | 一般留空 `{}` |
| `rrule.mode` | string | 非 5 枚举之一 → `'daily'` | `daily/weekly/monthly/yearly/dates` |
| `rrule.start` | string | 匹配 `^\d{4}-\d{2}-\d{2}$` 才保留，否则 `''` | |
| `rrule.end` | string | 同上 | |
| `rrule.dates` | array | 非数组 → `[]`；逐项过滤只留合法 `YYYY-MM-DD` | |

---

## 5. 去重、限制与丢弃行为（务必自查）

- **追加不覆盖**：两种导入分支都是把记录 push 进现有数据，从不清空、从不整体替换。
  真正的"整体恢复"是程序启动时从 `localStorage` 自动载入，**不是**通过导入文件完成的。
- **事件去重键 = `id`**：
  - 整册分支：在**每一天**的数组内按 id 去重。
  - 极简分支：在**当前激活计划本的全部天**范围内按 id 去重（先收集现有 id）。
- **规则去重键 = `id`**：同一天计划本内按 id 去重。
- **被静默丢弃**的情况（不报错，只是不计入 `added`）：
  - 事件缺 `id` 或缺 `title`。
  - 规则缺 `title`。
  - 整册分支里 `planners` 元素缺 `id`。
  - 极简分支里日期键不匹配 `YYYY-MM-DD`，或其值不是数组。
- **硬错误 → 提示「文件无效」**：JSON 解析失败；或走极简分支时顶层不是普通对象（如数组/null）。
- **完成提示**：`added > 0` → 「已导入 {0} 条记录」；否则 → 「没有新内容可导入」。
  `{0}` 统计的是**实际新增**的事件+规则条数（被去重丢弃的不计）。
- 代码里**没有**条数上限或体积上限；但文件会被一次性读入并 `Store.persist()`，过大可能卡顿。

---

## 6. 最小可用示例

下面第 6、7 节代码块都是**完整严格合法 JSON**，可直接存成 `.json` 导入。
其余带注释的 `jsonc` 块只是字段说明。

整册（一个计划本一天一条待办）：

```json
{
  "app": "zenplan",
  "version": 2,
  "exportedAt": "2026-01-05T00:00:00.000Z",
  "planners": [{ "id": "p1", "name": "计划" }],
  "activeId": "p1",
  "eventsBy": {
    "p1": {
      "2026-01-05": [
        { "id": "e1", "type": "todo", "title": "买牛奶" }
      ]
    }
  },
  "recursBy": {}
}
```

极简事件（往当前激活计划本追加）：

```json
{
  "2026-01-05": [
    { "id": "e1", "type": "todo", "title": "买牛奶" },
    { "id": "e2", "type": "note", "title": "灵感一现", "tag": "idea" }
  ]
}
```

---

## 7. 完整示例（覆盖事件、子任务、日程、备注、规则）

```json
{
  "app": "zenplan",
  "version": 2,
  "exportedAt": "2026-01-05T00:00:00.000Z",
  "planners": [
    { "id": "p1", "name": "工作" },
    { "id": "p2", "name": "生活" }
  ],
  "activeId": "p1",
  "eventsBy": {
    "p1": {
      "2026-01-05": [
        {
          "id": "e1", "type": "todo", "title": "季度汇报",
          "note": "准备 PPT", "time": "", "color": "#cc3333",
          "priority": "high", "tag": "汇报",
          "subtasks": [
            { "id": "s1", "title": "收集数据", "done": true },
            { "id": "s2", "title": "写大纲", "done": false },
            { "id": "s3", "title": "做图表", "done": "failed" }
          ],
          "done": false, "created": 1767571200000, "order": 1
        },
        {
          "id": "e2", "type": "event", "title": "评审会",
          "note": "", "time": "14:00", "color": "#3366cc",
          "priority": "mid", "tag": "会议", "subtasks": [],
          "done": false, "created": 1767571201000, "order": 2
        }
      ],
      "2026-01-06": [
        {
          "id": "e3", "type": "note", "title": "记录一条备注",
          "note": "正文写这里", "time": "", "color": "#888888",
          "priority": "low", "tag": "", "subtasks": [],
          "done": false, "created": 1767657600000, "order": 0
        }
      ]
    },
    "p2": {
      "2026-01-07": [
        {
          "id": "e4", "type": "todo", "title": "晨跑",
          "note": "", "time": "07:00", "color": "#339933",
          "priority": "mid", "tag": "健康", "subtasks": [],
          "done": false, "created": 1767744000000, "order": 0
        }
      ]
    }
  },
  "recursBy": {
    "p1": [
      {
        "id": "r1", "type": "event", "title": "每周站会",
        "note": "", "time": "10:00", "color": "#3366cc",
        "priority": "mid", "tag": "会议", "subtasks": [],
        "created": 1767571200000, "order": -1,
        "renderPast": false, "doneMap": {},
        "rrule": { "mode": "weekly", "start": "2026-01-05", "end": "2026-06-30", "dates": [] }
      },
      {
        "id": "r2", "type": "todo", "title": "指定日期打卡",
        "note": "", "time": "", "color": "#cc6600",
        "priority": "high", "tag": "", "subtasks": [],
        "created": 1767571200000, "order": -1,
        "renderPast": true, "doneMap": {},
        "rrule": { "mode": "dates", "start": "", "end": "", "dates": ["2026-02-01", "2026-02-15"] }
      }
    ],
    "p2": []
  }
}
```

---

## 8. 给生成方的硬性检查清单

生成文件后逐条自查：

1. **决定走哪条分支**：要带规则/多计划本 → 用整册外壳，顶层必须有**数字** `version: 2`
   且 `planners` 为数组；只是往当前页塞事件 → 用日期→事件字典，**不要**带 `version:2`。
2. 整册时 `eventsBy` / `recursBy` 的键**必须**是 `planners` 里出现过的源 id。
3. 每条事件都有唯一字符串 `id` 和非空 `title`（两者缺一整条被丢）。
4. 所有日期键形如 `YYYY-MM-DD`（如 `2026-01-05`）。
5. `type ∈ {todo,event,note}`，`priority ∈ {high,mid,low}`，
   `color ∈ {#888888,#cc3333,#3366cc,#339933,#cc6600}`，其它值会被改写但别依赖。
6. `time` 留空串或写成两位 `HH:MM`。
7. `created` / `order` 是数字（毫秒戳/排序数），不是字符串。
8. `done` 取 `true` / `false` / `"failed"`。
9. 规则的 `rrule.mode ∈ {daily,weekly,monthly,yearly,dates}`，
   `start` / `end` 是 `YYYY-MM-DD` 或空串，`mode==="dates"` 才用 `dates` 数组。
10. 没有往任何记录里写 `kind`（它不是字段）。
11. 文件是 **UTF-8** 合法 JSON，无注释、无尾逗号、无 markdown 围栏。

满足 1–4 导入就一定成功；5–11 决定显示是否正确、规则能否生效。

---

## 9. 行为速查

| 情况 | 结果 |
|---|---|
| `version: 2` 但无数组 `planners` | 掉进极简分支，把整个对象当日期字典 → **几乎导不进任何东西** |
| 顶层既无 `version:2` 又无合法日期键字典 | 报「文件无效」 |
| 事件缺 `id` 或缺 `title` | 该条静默丢弃 |
| 规则缺 `title` | 该条静默丢弃 |
| planner 元素缺 `id` | 该计划本跳过 |
| 日期键不是 `YYYY-MM-DD` | 该组整批丢弃 |
| 事件 `id` 已存在（同一天/激活页） | 跳过，不计入 `added` |
| `color` 不在枚举内 | 改成 `#888888` |
| `time` 不是 `HH:MM` | 清空为 `''` |
| `priority` 非法 | 改成 `'mid'` |
| 规则 `order` 缺失 | 回退 `-1`（事件回退 `created`） |
| 重复导入同一文件 | 第二次 `added=0` → 提示「没有新内容可导入」 |
| 导入成功 | 提示「已导入 N 条记录」并刷新日历 |
