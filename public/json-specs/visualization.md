# ZENVIZ 可视化文件 JSON 规范

> 用途：让 AI（或任何程序）**直接生成可被 ZENVIZ 导入的文件**。
> ZENVIZ 是 `omm-visualization.html`（图表可视化应用）。
>
> 本文所有字段名、默认值、枚举表、容错行为都是从
> `omm-visualization.html` 的 `importPropertySettings()` /
> `exportPropertySettings()` / `sanitizeTypeStates()` / `sanitizeChartProps()` /
> `validPersistValue()` / `createEnginePropertyStore()` /
> `restorePersistedState()` / `parseTextData()` / `chartDataRules` 里逐行核对出来的，
> 不是推测。行号见每节标题后的括注。

---

## 0. 一句话规则

**这个 App 真正能用「AI 生成的 JSON 文件」导入的，只有一种东西：右侧属性设置。**

```
数据表      → 只吃 CSV / TXT / XLSX / XLS / TSV（<input accept> 不含 .json，无 JSON 通道）
工作区状态  → 只读写 localStorage，开机自动恢复，无法用文件导入
右侧属性    → 吃 .json 文件，kind 必须等于 "zenviz-right-properties"   ✅ 唯一可生成的 JSON
```

所以给 AI 生成文件时，**目标就是右侧属性设置 JSON**；
而「让图能画出来」靠的是 **CSV 列的排布**（见第 6 节角色模型），不是 JSON。
（`<input id="file-input" accept=".csv,.txt,.xlsx,.xls,.tsv">` 在 2103 行；
`<input id="property-import-input" accept=".json,application/json">` 在 2104 行。）

---

## 0.5 给 AI 的提示词模板

把下面这段连同本文一起发给 AI，让它产出可导入的 `.json`：

```text
你要生成一个 ZENVIZ 右侧属性设置文件（.json，UTF-8）。

严格遵守配套文档《visualization.md》里的字段、默认值和容错规则。硬性要求：

1. 顶层必须是 { "kind": "zenviz-right-properties", "version": 1, "engines": { ... } }。
   kind 与 version 一字不差；version 必须是数字 1（不是字符串 "1"）。
2. engines 的键只能取 echarts / chartjs / apexcharts / zen 这 4 个引擎 id。
3. 每个引擎对象里写 typeStates 和 chartProps 两个子对象，键是图表类型 id（见 6.3 表）。
4. typeStates 里每个类型只写 ENGINE_PROPERTY_KEYS 白名单内的字段（3.2 表）；
   布尔字段必须是 true/false，数值字段必须是有限数字，字符串字段必须是字符串，
   palette 只能是 mono / culture / science / editorial 四选一。
5. chartProps 里每个类型只写该类型已知字段（4.2 表），字段类型要和默认值一致。
6. 缺字段没关系（引擎自动补默认值），但写错的字段类型会被整条丢弃并退回默认值，
   宁可少写也不要写错类型。
7. 只输出 JSON 本身，不要 markdown 代码块围栏，不要注释，不要尾逗号。

生成后自查：kind/version 对不对、引擎 id 在不在 4 个之内、
每个字段类型是否与默认值同型。数据列怎么排不是这个文件的事，按 6.3 用 CSV 给数据。
```

---

## 1. 文件外壳（右侧属性设置 JSON）（10358 / 10374-10384 行）

```jsonc
{
  "kind": "zenviz-right-properties",   // 必填，硬校验，值必须一字不差
  "version": 1,                         // 必填，必须 === PROPERTY_EXPORT_VERSION(=1)
  "exportedAt": "2026-01-01T00:00:00.000Z", // 可选，导入时不校验、不使用，纯给人看
  "engines": {                          // 必填，对象，缺了或不是对象直接报错
    "echarts": { "typeStates": { /*…*/ }, "chartProps": { /*…*/ } }
    /* 其余引擎见第 3、4 节 */
  }
}
```

| 字段 | 必需 | 校验 / 缺省行为 |
|---|---|---|
| `kind` | **是** | `!== 'zenviz-right-properties'` → 抛「不是有效的 ZENVIZ 右侧属性设置文件」，整包失败 |
| `version` | **是** | `!== 1`（数字）→ 同上整包失败。写成 `"1"` 字符串也会失败 |
| `exportedAt` | 否 | 导入端完全忽略，可给可不给 |
| `engines` | **是** | 缺失或非对象 → 抛「属性设置文件缺少引擎数据」；是对象即可 |
| `dataSelections`（顶层或引擎内） | 否 | **会被静默忽略**。导出函数根本不写它，导入函数也不读它 |

### 导入分派与容错（照抄代码行为）

```
payload = JSON.parse(文件文本)                    // 解析失败 → 报错
if payload.kind !== 'zenviz-right-properties'     → 抛，整包失败
if payload.version !== 1                          → 抛，整包失败
if !engines || typeof engines !== 'object'        → 抛，整包失败
for id of ['echarts','chartjs','apexcharts','zen']:   // 只遍历这 4 个固定 id
    incoming = engines[id]
    store = createEnginePropertyStore(id)          // 先铺满默认值
    if incoming 是对象:
        store.typeStates = sanitizeTypeStates(incoming.typeStates)   // 逐字段校验
        store.chartProps = sanitizeChartProps(incoming.chartProps)   // 逐字段校验
    否则 store 保持全默认
// 未知引擎 id（如 "highcharts"）根本不会被遍历，直接丢弃
```

- **整包原子性**：`kind`/`version`/`engines` 任一硬校验失败，**整个文件作废**，
  什么都不改，只弹「右侧属性设置导入失败」。
- 一旦过了硬校验，**单个坏字段只丢那一个字段**（退回默认值），不影响其它字段或其它引擎。

---

## 2. 三级隔离结构（8780-8781 行）

右侧属性按 **引擎 → 图表类型 → 属性** 三级隔离：

```
engines[引擎 id].typeStates[图表类型 id]  →  通用外观属性（标题/图例/字体/画布尺寸…）
engines[引擎 id].chartProps[图表类型 id]  →  该图专属参数（柱宽/饼半径/散点大小…）
```

- 引擎 id 固定 4 个：`echarts` `chartjs` `apexcharts` `zen`（8776 行 `ENGINE_IDS`）。
- 图表类型 id 固定 30 个：`line bar area scatter pie radar heatmap slope lollipop
  timeline dotplot wordfreq smallmultiples network sankey correlation parallel
  boxplot histogram errorbar bump ribbon radial poster field chord spiral swarm stream contour`
  （`chartNames` 的键，即 `CHART_TYPE_IDS`）。每个引擎都遍历这全部 30 个类型，
  **不管该引擎实际支持哪几种**（支持范围见 6.2）。

---

## 3. `engines[id].typeStates`（通用外观属性）

### 3.1 结构

```jsonc
"typeStates": {
  "line": { "palette": "science", "title": "研究结果", "width": 1000, /*…*/ },
  "bar":  { /*…*/ }
  // 只写你想改的类型；没写的类型 = 全默认。写了但不认识的类型 id 会被忽略。
}
```

`sanitizeTypeStates()`（9075 行）对 30 个类型逐个：以默认为底，
只把**既在白名单 `ENGINE_PROPERTY_KEYS` 内、又通过 `validPersistValue()` 校验**的字段覆盖上去；
其余一律用默认值。

### 3.2 字段白名单 `ENGINE_PROPERTY_KEYS`（2906 行）与类型（`validPersistValue` 9338 行）

| 字段 | 类型 | 合法取值 / 约束 |
|---|---|---|
| `palette` | string | 只能 `mono` / `culture` / `science` / `editorial` |
| `engine` | string | 只能是已知引擎 id（一般不写在 typeStates 里） |
| `type` | string | 只能是已知图表 id |
| `category` | string | 只能是 `论文` / `人文` / `艺术` |
| `xCol` | int | `≥ 0` 整数（列索引，一般归 dataSelections，属性文件不导出它） |
| `targetCol` `y1Col` `y2Col` | int\|null | `null` 或 `≥ 0` 整数 |
| `yCols` | int[] | 每个元素都是 `≥ 0` 整数 |
| `title` `subtitle` `titlePosition` `titleOrientation` `legendPosition` `legendOrientation` `xTitle` `yTitle` `artMode` `pdfOrientation` `fontFamily` `xAxisFontFamily` `yAxisFontFamily` `tooltipFontFamily` `legendFontFamily` `titleFontFamily` | string | 任意字符串 |
| `stacked` `normalize` `annotations` `showValues` `showTitle` `border` `showLegend` `showGrid` `smooth` `showPoints` `exportTransparent` | boolean | 必须 `true`/`false` |
| `fontSize` `axisSize` `rotateLabels` `tension` `width` `height` `exportScale` `paddingTop` `paddingRight` `paddingBottom` `paddingLeft` `positionTop` `positionRight` `positionBottom` `positionLeft` `contentScale` `pointSize` `lineWidth` `opacity` | number | 必须有限数字（`NaN`/`Infinity` 判失败） |
| 白名单外的其它字段 | — | `validPersistValue` 对未列出的键返回 `true`（放行），但 `sanitizeTypeStates` 只遍历 `ENGINE_PROPERTY_KEYS`，**所以白名单外的键根本不会被读取，写了也没用** |

**默认值参照**（`RIGHT_PROPERTY_DEFAULTS`，2954 行起，以 echarts · line 为例，8790 行会补 `exportTransparent:false`）：

```jsonc
{
  "palette": "culture", "title": "研究结果", "subtitle": "",
  "titlePosition": "top-left", "titleOrientation": "horizontal",
  "legendPosition": "top", "legendOrientation": "horizontal",
  "paddingTop": 4, "paddingRight": 4, "paddingBottom": 0, "paddingLeft": 4,
  "positionTop": 0, "positionRight": 0, "positionBottom": 22, "positionLeft": 8,
  "contentScale": 100, "xTitle": "指标", "yTitle": "数值",
  "fontSize": 12, "axisSize": 10, "rotateLabels": 0, "tension": 0.25,
  "stacked": false, "normalize": false, "width": 1000, "height": 620,
  "exportScale": 3, "pdfOrientation": "landscape", "artMode": "editorial",
  "annotations": true, "showLegend": true, "showGrid": true,
  "smooth": false, "showPoints": true, "pointSize": 5, "lineWidth": 2,
  "opacity": 0.9, "fontFamily": "simsun", "xAxisFontFamily": "simsun",
  "yAxisFontFamily": "simsun", "tooltipFontFamily": "simsun",
  "legendFontFamily": "simsun", "titleFontFamily": "simsun"
}
```

> 各引擎 / 各类型的默认值不完全相同（如 `paddingBottom`：line=0、bar=4；
> `positionBottom`：line=22、bar=20、scatter=23）。你**不需要**复刻整份默认，
> 省略即拿默认，只有想改的字段才写。

---

## 4. `engines[id].chartProps`（该图专属参数）

### 4.1 结构

```jsonc
"chartProps": {
  "line": { "lineWidth": 2, "smooth": false, "showPoints": true, "yMin": "", "yMax": "" },
  "bar":  { "barWidth": 46, "stacked": false }
}
```

`sanitizeChartProps()`（9033 行）对每个类型：以 `CHART_PROP_DEFAULTS`（2817 行起）为底，
**只接受该类型默认对象里已存在的键**，且要求类型和默认值同型：
- 默认是 number → 传入必须是有限 number；
- 默认是 `''`（空串）→ 传入可以是 `''` **或**有限 number（这是 9060-9066 行专门放宽的「数字 vs 字符串」坑：
  `yMin/yMax`、热图 `min/max` 这类默认空串、用户实际填数字的字段，两种都收）；
- 其它情况 → `typeof 传入 === typeof 默认` 才收。
不认识的键、类型不符的键，**单条丢弃、保留默认**，不影响同类型其它键。

### 4.2 各类型已知字段（`chartProps` 默认表，2817 行起，节选）

| 类型 | 字段（= 默认键，多写不认） |
|---|---|
| `line` | `lineWidth`(2) `lineType`('solid') `lineMode`('single') `pointSize`(5) `smooth`(false) `showPoints`(true) `showLegend`(true) `showGrid`(true) `rotateLabels`(0) `yMin`('') `yMax`('') |
| `bar` | `barWidth`(46) `gap`(24) `stacked`(false) `showValues`(false) `showLegend`(true) `showGrid`(true) `rotateLabels`(0) |
| `area` | `lineWidth`(2) `pointSize`(4) `smooth`(true) `fillOpacity`(0.18) `stacked`(false) `showPoints`(true) `showGrid`(true) |
| `scatter` | `pointSize`(7) `opacity`(0.72) `showLegend`(true) `showGrid`(true) `showTrend`(false) `rotateLabels`(0) |
| `pie` | `innerRadius`(32) `outerRadius`(62) `showLabels`(false) `rose`('none') `showLegend`(true) |
| `radar` | `radius`(58) `fillOpacity`(0.12) `lineWidth`(2) `pointSize`(5) `showPoints`(true) `shape`('polygon') `showLegend`(true) `showGrid`(true) |
| `heatmap` | `cellGap`(1) `showValues`(false) `showGrid`(true) `min`('') `max`('') |
| `network` | `repulsion`(120) `edgeLength`(100) `nodeSize`(16) `lineWidth`(1) `showLabels`(true) |
| `sankey` | `nodeWidth`(18) `nodeGap`(10) `edgeOpacity`(0.22) `showLabels`(true) |
| `parallel` | `lineWidth`(1) `lineOpacity`(0.18) `axisFont`(8) `showGrid`(true) |
| `boxplot` | `boxWidth`(34) `lineWidth`(1.5) `showGrid`(true) `showMean`(true) |
| `contour` | `resolution`(14) `contrast`(1) `showLabels`(false) `showGrid`(true) |
| `slope` | `lineWidth`(2) `pointSize`(5) `showValues`(true) `labelCount`(12) |
| `lollipop` | `pointSize`(6) `stemWidth`(1) `opacity`(0.85) `sort`('原顺序') |
| `timeline` | `pointSize`(4) `stemLength`(90) `showValues`(true) `alternate`(true) |
| `dotplot` | `pointSize`(5) `rowGap`(30) `opacity`(0.9) `baseline`(true) |
| `wordfreq` | `minFont`(12) `maxFont`(44) `maxWords`(48) `rotation`(0) `spacing`(32) |
| `smallmultiples` | `columns`(3) `gap`(25) `lineWidth`(2) `showFrame`(true) |
| `correlation` | `cellSize`(62) `precision`(2) `mode`('全部') `intensity`(1) `showGrid`(true) |
| `histogram` | `bins`(9) `barGap`(2) `opacity`(0.8) `showValues`(false) `showGrid`(true) |
| `errorbar` | `pointSize`(5) `errorSize`(15) `lineWidth`(1.2) `showGrid`(true) |
| `bump` | `maxLines`(5) `rowGap`(70) `lineWidth`(2) `showLabels`(true) |
| `ribbon` | `bands`(5) `width`(14) `amplitude`(35) `opacity`(0.35) |
| `radial` | `radius`(190) `spokeWidth`(1.5) `nodeSize`(4) |
| `poster` | `barCount`(8) `barWidth`(52) `barHeight`(160) `headlineSize`(64) |
| `field` | `count`(180) `size`(2) `opacity`(0.25) |
| `chord` | `radius`(205) `lineWidth`(5) `nodeSize`(5) `opacity`(0.55) `showLabels`(true) |
| `spiral` | `turns`(3.2) `lineWidth`(2) `pointSize`(4) `showLabels`(true) `opacity`(0.82) |
| `swarm` | `maxRadius`(28) `spread`(360) `jitter`(70) `opacity`(0.72) `showLabels`(true) |
| `stream` | `bands`(5) `amplitude`(72) `width`(18) `opacity`(0.34) `showLabels`(false) |

> 表里未列的类型：`pie/bar/...` 之外若还有，规则一致——**只认默认对象里有的键**。
> 想稳妥就照本表写键名。

---

## 5. 数据表不是 JSON —— 它走 CSV / TSV / XLSX（2103 行）

- 「导入」按钮打开的 `#file-input` 只接受 `.csv,.txt,.xlsx,.xls,.tsv`；
  **没有 `.json`**。粘贴框 `#parse-paste` 调 `parseTextData()`（14739 行），也是**分隔符文本**，不是 JSON。
- 数据被读成内部对象 `{ headers: [列名…], rows: [[单元格…], …] }`（`sample` 结构，2798 行）。
  XLSX 走 `aoaToData()`（14797 行），文本走 `parseTextData()`（14739 行）。
- 分隔符自动识别：`\t` > `,` > `;` > 连续空格 > 单空格；首行是表头，其后每行一条记录，
  列数不足会补 `列N` / 空串对齐。
- 因此 **AI 要生成「能画出图的数据」时，产出的是 CSV，不是 JSON**。第 6 节告诉你每种图要哪些列。

### 单元格类型判定（`numeric()` 9547 行 / `columnStats()` 9563 行）

- 数值判定：`Number(值去掉所有逗号)` 且有限 → 视为数值。即 `1,234` 会被认成 `1234`。
- 一列是「数值列」(`isNumeric`)：该列**所有非空单元格**都能转成有限数字。
- 一列是「完整数值列」(`isCompleteNumeric`)：行数=非空数且全部数值（**不允许空白**）。
- 「类别列」只要有非空文本即可。

---

## 6. 角色模型：每种图需要什么样的列（`chartDataRules` 2357-2764 行）

这是给 AI **生成正确 CSV** 的核心。每个图表类型声明：`x`（首列用途）、`target`、
数值列数量上下限 `minY`/`maxY`，以及若干约束标记。角色（role）：

| role key | 中文标签 | 列类型 kind | 说明 |
|---|---|---|---|
| `x-col` | 分类列 / 来源列 / … | category | 横轴或关系来源 |
| `y-cols` | 系列列 / 权重列 / 变量列 / … | numeric | 数值，`multiple:true` 表示可多选 |
| `target-col` | 去向列 | category | 关系目标（network/sankey/chord） |
| `y1-col` / `y2-col` | 起点/终点、中心/误差 | numeric | 成对图（slope/errorbar）专用 |

约束标记（`validateDataMapping` 9667 行会据此报错）：
`positiveY`（数值列不得有负数且至少一个 >0）、`nonNegativeY`（不得有负数）、
`completeY`（数值列必须完整无空白）、`pairY`（用 y1/y2 两列而非多选）、
`aggregateX`（同名类别合并，pie）、`nonNegativeError`（误差列非负）、`legend`（series/category/none）。

### 6.1 完整角色 / 列数表（照 `chartDataRules` 逐条核对）

| 图表 id | 名称 | x 用途 | target | 数值列数 | 关键约束 |
|---|---|---|---|---|---|
| `line` | 折线 | category | — | 1–8 | legend=series |
| `bar` | 柱状 | category | — | 1–8 | legend=series |
| `area` | 面积 | category | — | 1–8 | legend=series |
| `scatter` | 散点 | category | — | 1–8 | legend=series |
| `pie` | 饼图 | category | — | **1** | positiveY, completeY, aggregateX |
| `radar` | 雷达 | category | — | 1–8 | completeY |
| `heatmap` | 热图 | category | — | 1–8 | — |
| `slope` | 斜率图 | category | — | **2**（pairY） | completeY；y1=起点、y2=终点 |
| `lollipop` | 棒棒糖 | category | — | **1** | — |
| `timeline` | 时间线 | category | — | **1** | — |
| `dotplot` | 点图 | category | — | **1** | — |
| `wordfreq` | 词频 | category | — | **1** | nonNegativeY |
| `smallmultiples` | 小倍图 | category | — | 1–8 | — |
| `network` | 网络关系 | category（来源） | category（去向） | **1**（权重） | positiveY, completeY |
| `sankey` | 桑基 | category（来源） | category（去向） | **1**（流量） | positiveY, completeY |
| `correlation` | 相关矩阵 | **none** | — | 2–8 | completeY；每列=一个变量 |
| `parallel` | 平行坐标 | **none** | — | 2–8 | completeY |
| `boxplot` | 箱线 | **none** | — | 1–8 | 每列=一个分布组 |
| `histogram` | 直方 | **none** | — | **1** | 该列需 ≥2 个有效数值 |
| `errorbar` | 误差棒 | category | — | **2**（pairY） | completeY, nonNegativeError；y1=中心、y2=误差 |
| `bump` | 排名变化 | category | — | 2–6 | completeY |
| `contour` | 等值矩阵 | category | — | 2–8 | — |
| `ribbon` | 带状艺术 | category | — | 1–8 | — |
| `radial` | 径向 | category | — | **1** | nonNegativeY |
| `poster` | 海报统计 | category | — | **1** | nonNegativeY |
| `field` | 粒子场 | **none** | — | **1** | — |
| `chord` | 弦线艺术 | category（来源） | category（去向） | **1**（权重） | positiveY, completeY |
| `spiral` | 螺旋构图 | category | — | **1** | nonNegativeY |
| `swarm` | 蜂群艺术 | category | — | **1** | nonNegativeY |
| `stream` | 流带艺术 | category | — | 1–8 | legend=series |

### 6.2 引擎 / 实际支持类型（`engineInfo` 2252 行起，6.2 只影响 App 里能否切换，不影响属性文件的合法性）

| 引擎 | 支持的图表类型 |
|---|---|
| `echarts` | line bar area scatter pie radar heatmap network sankey parallel boxplot contour |
| `chartjs` | line bar area scatter pie radar |
| `apexcharts` | line bar area scatter pie radar |
| `zen` | slope lollipop timeline dotplot wordfreq smallmultiples network correlation histogram errorbar bump ribbon radial poster field chord spiral swarm stream |

### 6.3 四类典型 CSV 模板（AI 按图所属类别套表头）

**A. 类别 + 多/单数值列**（line/bar/area/scatter/radar/heatmap/contour/smallmultiples/bump/stream、
以及只取 1 列的 pie/lollipop/timeline/dotplot/wordfreq/radial/poster/spiral/swarm）：
```csv
类别,甲,乙,丙
一月,42,37,28
二月,51,41,32
```
（数值列数要落在该图 `minY`–`maxY` 区间；带 `completeY` 的列不能留空，带 `positiveY`/`nonNegativeY` 的列不能出现负数。）

**B. 关系三列**（network/sankey/chord）——默认列映射**跳过第 0 列**，
`来源列=第2列 / 去向列=第3列 / 权重列=第4列`（`createDataSelectionState` 8814 行：xCol:1,targetCol:2,yCols:[3]）：
```csv
备注,来源,去向,权重
,论文A,概念B,5
,论文A,概念C,3
```
（权重必须正数且完整无空。）

**C. 无类别列，纯数值变量**（correlation/parallel/boxplot/histogram/field）：
```csv
身高,体重,血压
170,65,120
175,70,118
```
（correlation/parallel 需 2–8 列且完整数值；boxplot 1–8 列；histogram/field 只需 1 列数值。）

**D. 成对两列**（slope/errorbar）：
```csv
对象,起点,终点
品牌A,40,68
品牌B,55,49
```

---

## 7. 最小可用示例（右侧属性 JSON，严格合法，可直接存为 `.json` 导入）

下面第 7、8 节代码块是**完整合法 JSON**（无注释、无尾逗号、UTF-8），可直接导入。
其余 ```jsonc 块带注释，只作字段说明。

```json
{
  "kind": "zenviz-right-properties",
  "version": 1,
  "engines": {
    "echarts": {
      "typeStates": {
        "line": {
          "palette": "science",
          "title": "季度趋势",
          "showLegend": true,
          "width": 1200,
          "height": 700
        }
      },
      "chartProps": {
        "line": { "lineWidth": 3, "smooth": true, "showPoints": false }
      }
    }
  }
}
```

---

## 8. 完整示例（多引擎、多类型、含空串数值放宽、含关系图）

```json
{
  "kind": "zenviz-right-properties",
  "version": 1,
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "engines": {
    "echarts": {
      "typeStates": {
        "line": {
          "palette": "culture",
          "title": "研究结果",
          "subtitle": "",
          "titlePosition": "top-left",
          "titleOrientation": "horizontal",
          "legendPosition": "top",
          "legendOrientation": "horizontal",
          "paddingTop": 4,
          "paddingRight": 4,
          "paddingBottom": 0,
          "paddingLeft": 4,
          "positionTop": 0,
          "positionRight": 0,
          "positionBottom": 22,
          "positionLeft": 8,
          "contentScale": 100,
          "xTitle": "指标",
          "yTitle": "数值",
          "fontSize": 12,
          "axisSize": 10,
          "rotateLabels": 0,
          "tension": 0.25,
          "stacked": false,
          "normalize": false,
          "width": 1000,
          "height": 620,
          "exportScale": 3,
          "exportTransparent": false,
          "pdfOrientation": "landscape",
          "artMode": "editorial",
          "annotations": true,
          "showLegend": true,
          "showGrid": true,
          "smooth": false,
          "showPoints": true,
          "pointSize": 5,
          "lineWidth": 2,
          "opacity": 0.9,
          "fontFamily": "simsun",
          "xAxisFontFamily": "simsun",
          "yAxisFontFamily": "simsun",
          "tooltipFontFamily": "simsun",
          "legendFontFamily": "simsun",
          "titleFontFamily": "simsun"
        },
        "pie": { "palette": "mono", "title": "构成占比", "showLegend": true }
      },
      "chartProps": {
        "line": {
          "lineWidth": 2,
          "lineType": "solid",
          "lineMode": "single",
          "pointSize": 5,
          "smooth": false,
          "showPoints": true,
          "showLegend": true,
          "showGrid": true,
          "rotateLabels": 0,
          "yMin": "",
          "yMax": 100
        },
        "pie": { "innerRadius": 0, "outerRadius": 62, "showLabels": false, "rose": "none", "showLegend": true }
      }
    },
    "zen": {
      "typeStates": {
        "network": { "palette": "science", "title": "引用网络", "showGrid": false }
      },
      "chartProps": {
        "network": { "repulsion": 160, "edgeLength": 120, "nodeSize": 18, "lineWidth": 1.5, "showLabels": true }
      }
    }
  }
}
```

> 说明：`line.yMax` 写数字 `100`、`yMin` 写空串 `""` 都合法（第 4 节放宽）；
> `pie.innerRadius` 写成 `0` 合法（默认键存在且是 number）。
> 只给了 echarts 的 `line/pie` 和 zen 的 `network`，其余类型自动取默认——
> 这正是设计意图：**别复刻全表，只写你要改的**。

---

## 9. 给生成方的硬性检查清单

生成右侧属性 `.json` 后逐条自查：

1. 顶层 `"kind"` 精确等于 `"zenviz-right-properties"`；`"version"` 是**数字** `1`；`"engines"` 是对象。
2. `engines` 的键只用 `echarts` / `chartjs` / `apexcharts` / `zen`，别自造。
3. `typeStates` / `chartProps` 的键只用第 6.1 表里的 30 个图表 id；写错 id 会被静默忽略。
4. `typeStates` 里字段名必须在 `ENGINE_PROPERTY_KEYS`（3.2 表）内，且类型对：
   布尔是 `true`/`false`，数值是有限 number，字符串是字符串，`palette` 四选一。
5. `chartProps` 里字段名必须是该类型已知字段（4.2 表），类型和默认值同型
   （number→number、bool→bool、字符串→字符串；默认空串的字段允许 `""` 或 number）。
6. 不确定的字段就**省略**（引擎补默认），不要凭猜填错类型——错类型只会退回默认，等于白写。
7. `exportedAt`、`dataSelections` 可给可不给（导入端忽略）。
8. 文件是 **UTF-8 合法 JSON**：无注释、无尾逗号、无 markdown 围栏。
9. 想「让图有数据」请生成 **CSV**（按 6.1 的列数与 6.3 的表头模板），
   **不要**指望用 JSON 喂数据。

只要 1–3 条满足，导入就成功且不报错；4–5 条决定你的属性是否真的生效；
第 9 条决定图能不能画出来。

---

## 10. 行为速查表

| 情况 | 结果 |
|---|---|
| `kind` 不对 或 `version` ≠ 1 | 抛「不是有效的 ZENVIZ 右侧属性设置文件」，整包失败，UI 不变 |
| 缺 `engines` 或 `engines` 不是对象 | 抛「属性设置文件缺少引擎数据」，整包失败 |
| 文件不是合法 JSON（解析抛错） | 「右侧属性设置导入失败」，整包失败 |
| `engines` 里有未知引擎 id | 被忽略（只遍历固定 4 个 id） |
| `typeStates` 里未知图表类型 id | 该类型被忽略（只遍历 30 个已知 id） |
| `typeStates` 字段类型不符 / `palette` 非法值 | 单字段丢弃、退回默认，其余照常 |
| `chartProps` 写了默认对象里没有的键 | 单键丢弃 |
| `chartProps` 空串数值字段填了数字（yMin/yMax/min/max） | **接受**（9060 行放宽） |
| 某引擎在文件里完全缺失 | 该引擎铺满默认值，不报错 |
| 导入成功 | 重渲染属性面板与图表、写 localStorage，状态栏「右侧属性设置已导入 · 文件名」 |
| 想用 JSON 导入数据表 | **不支持**；数据只能 CSV/TXT/XLSX/XLS/TSV 或粘贴分隔文本 |
| 数值列里混入非数字 / 空白 | 校验报「不是纯数值列」「要求完整数值列」（9700/9702 行），图会给出警告 |
| `positiveY` 图出现负数或全 ≤0 | 报错「不能包含负数」「必须至少包含一个大于 0 的值」 |

---

## 11. 附：工作区 / 引擎存储在 localStorage（仅自动恢复，不能文件导入）

代码里的这两份 JSON **只在浏览器 localStorage 读写**，没有对应的文件导入入口；
本节仅供理解，不要当作可生成文件。

- 工作区键 `zenviz.workspace.v2`（`saveWorkspaceState` 9145 行）：
  ```json
  { "version": 4, "state": { "engine": "echarts", "type": "line", "category": "论文" } }
  ```
  开机 `restorePersistedState()`（9171 行）读取；接受 `version` 为 2 或 4，且字段过 `validPersistValue`。
- 每引擎键 `zenviz.engine.v4.<id>`（`saveEngineStore` 9127 行）：
  ```json
  { "version": 4, "typeStates": { }, "chartProps": { }, "dataSelections": { } }
  ```
  这里才有 `dataSelections`（列映射）；**注意导出/导入的右侧属性文件不含、也不读它**（第 1 节）。
  还兼容 v1/v2/v3 旧键做一次性迁移，不会删旧数据。
