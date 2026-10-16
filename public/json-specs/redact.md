# ZenRedact 文件格式与持久化数据说明 (omm-redact.html)

> 用途：说清楚这个脱敏/打码 App **真正接受什么、能导出什么、内部把状态存成什么**。
> 让 AI 在「想生成一个能被 App 读取的 JSON 文件」时不要瞎猜。
>
> 本文所有字段名、默认值、容错行为都是从 `omm-redact.html` 的
> `loadFile()`（文档输入，~5070）、`readAsText`/`loadFileStreaming`（~5216/5256）、
> `saveSettings()` / `loadSettings()`（~3059/3091）、`makeRedact()`（~2697）、
> `undoRedact()` / `redoRedact()`（~6064/6077）逐行核对出来的，不是推测。

---

## 0. 一句话规则

**这个 App 不接受任何 JSON 文件导入。它根本没有「导入 / 恢复 / 打开项目 / 加载备份」这类入口。**

- 输入只有**文档**：`.txt / .docx / .pdf / .pptx`（外加单独的「图片 / 图片文件夹」入口，`image/*`）。
  `.json` 文件会被直接拒绝，提示「仅支持 TXT、DOCX、PDF、PPTX 文件」。
- 输出只有**视觉成品**：PDF、图片 ZIP、PPTX（还有「不可逆脱敏 PDF」）。
  **没有任何把脱敏区域 / 工程 / 设置导出成 JSON 的功能。**
- App 唯一「读」的一段 JSON，是它存在浏览器 **localStorage** 里的界面设置
  （键名 `zr-settings`，见第 3 节）。它**不是从文件读的**，也没有按钮让你贴一个文件进去。
- 脱敏记录 `S.redacts`（见第 4 节）**从不落盘、从不导出**，只在内存里 + 撤销/重做栈里活着；
  一加载新文档就被清空。

所以：**无法「生成一个 JSON 文件让 App 直接导入」。** 任何声称能导入 `.zr`/`.json` 工程文件的做法都是臆造的。

---

## 0.5 为什么无法直接生成导入文件

代码里没有任何把外部文件 `JSON.parse` 成脱敏数据 / 工程数据的路径：

- 全文里 `JSON.parse` 只出现在两处——`loadSettings()` 解析 `localStorage['zr-settings']`（~3093），
  以及 `undoRedact()`/`redoRedact()` 还原内存里的撤销/重做快照（~6071/6084）。
  两者都**不读磁盘文件**。
- 所有文件输入只走 `loadFile()` 的扩展名白名单 `{txt,docx,pdf,pptx}`，`.json` 不在其中。
- 所有 `Blob` / `a.download` 产出的都是 `application/pdf`、`application/zip` 等二进制，
  没有任何 `application/json` 的导出。

因此**本文不提供「给 AI 的导入文件提示词模板」**（没有可导入的 JSON 可言）。

AI 真正能做的只有两件事：

1. **产出一段符合第 3 节结构的 `zr-settings` JSON**，由用户用浏览器控制台
   `localStorage.setItem('zr-settings', <json 字符串>)` 手动写入后刷新页面生效——这是「还原设置」，
   **不是「导入文件」**，且是用户级操作，App 自身没有对应 UI。
2. **产出第 1 节支持的文档（尤其纯 `.txt`）**，让用户用正常的「打开文档」加载后再在 App 里手工打码。

> ⚠️ 想「批量预置脱敏区域」也走不通：`S.redacts` 没有落盘格式、没有读取入口，
> 只能由用户在 App 内框选/划选/命中敏感词来生成。

---

## 1. 真实输入格式（文档）

打开文档只有一条通道：菜单「打开文档 / 拖拽 / 文件选择框」（`#file-input`，
`accept=".txt,.docx,.pdf,.pptx"`）。

```
ext = file.name 最后一个点后的后缀（小写）
allowed = { txt: true, docx: true, pdf: true, pptx: true }
if (!allowed[ext]) -> notify('仅支持 TXT、DOCX、PDF、PPTX 文件'); 直接返回，什么都不加载
```

| 扩展名 | 读取方式 | 落到哪 |
|---|---|---|
| `txt`（及其它非上表后缀即便勉强进来也只当文本） | `readAsText`；文件 > `CHUNK_SIZE*2`（即 2 MiB）时改走分片流式读取，每片 1 MiB | `S.text` → `processText()` 分页 |
| `docx` | `loadDOCX()`（DOM 解析成 HTML 再分页） | `S.docxHtml` |
| `pdf` | `loadPDF()`（pdf.js 渲染页面为图） | `S.pdfMode = true` |
| `pptx` | `loadPPTX()`（内部临时生成 PDF 复用 PDF 管线） | `S.pptxMode = true` |
| 图片 / 图片文件夹 | 独立入口 `#image-file-input` / `#image-folder-input`（`image/*`），拼成图片 PDF | `S.pdfMode` |

关键点：

- **文本是唯一真正“可读的纯字符”输入**（`readAsText`，UTF-8）。
- **JSON 文件不被识别为任何文档类型**，无法打开。
- 加载新文档时会 `S.redacts = []; S.undoStack = []; S.redoStack = []; S.redactIdCounter = 0;`（~5120）——
  即**每次换文件，上一份的脱敏区域与历史全部作废**。

---

## 2. 真实输出格式（导出）

导出按钮只有三个（外加一个不可逆脱敏 PDF）；**没有「导出 JSON / 导出工程 / 导出脱敏清单」**：

| 动作 | 产物 | MIME / 实现 |
|---|---|---|
| `exportPDF` | `.pdf`（保留可编辑文字层） | `application/pdf`，jsPDF |
| `exportImage` | 图片 ZIP 压缩包 | `application/zip`（JSZip 自拼） |
| `exportPPTX` | `.pptx`（每页栅格成 JPEG 封装） | zip 结构 |
| 不可逆脱敏 PDF | 永久移除遮罩内容的 `.pdf` | `application/pdf` |

脱敏 vs 高亮由同一属性 `style.opacity` 控制（见第 4 节）：
`opacity = 100`（不透明）= **脱敏模式**，导出永久抹除；
`opacity < 100`（半透明）= **高亮模式**，导出保留原文并以透明度覆盖。

> 结论：想拿到机器可读的「脱敏结果清单」，本 App 给不了——它只吐给人看的 PDF/图片/PPTX。

---

## 3. 持久化状态之一：界面设置 `zr-settings`（localStorage）

这是 App **唯一会落盘、也唯一会被读回来的 JSON**。
`saveSettings()` 写、`loadSettings()` 读，键名固定 `'zr-settings'`。

### 3.1 写出结构（照抄 `saveSettings()` 的对象字面量）

```jsonc
{
  "theme": "light",              // "light" | "dark"
  "bg": "bg-void",               // "bg-void" | "bg-grid" | "bg-dots" | "bg-diagonal"
  "tool": "rect",                // "rect" | "select" | "move" | "eraser"
  "pinned": true,                // 布尔，菜单栏是否固定
  "radius": 0,                   // 全局 UI 圆角，取自 [0,4,8,12,16,20,24]
  "sidebarCollapsed": false,     // 左侧栏是否折叠
  "sidebarW": 270,               // 左栏宽度(px)，由 CSS 变量 --sidebar-w 反解析，缺省 270
  "rightSidebarCollapsed": false,// 右侧栏是否折叠
  "rightSidebarW": 270,          // 右栏宽度(px)，--right-sidebar-w，缺省 270
  "redactStyle": {               // 新遮罩默认样式
    "color": "#000000",          // 十六进制，#rgb 或 #rrggbb
    "radius": 0,                 // 遮罩圆角，滑块 0–24
    "opacity": 100               // 遮罩不透明度，滑块 10–100（100=脱敏，<100=高亮）
  },
  "sensitiveWords": ["张三","身份证"], // 字符串数组，自动遮罩用；写盘时非数组会写成 []
  "imageNavEnabled": true,       // 图片跳转
  "pdfImageLargeFilter": true,   // 大图过滤开关
  "pdfImageLargeRatio": 0.9      // 大图占比阈值 0.5–0.95
}
```

### 3.2 读回时的默认值与容错（照抄 `loadSettings()` 行为）

读回来后**不是**整体替换，而是逐字段带默认兜底；多余/非法字段被忽略或夹取。

| 字段 | 缺省 / 兜底 | 校验 / 夹取 |
|---|---|---|
| `theme` | `'light'` | 只判是否 `=== 'dark'`，其它一律按浅色 |
| `bg` | `'bg-void'` | 值需匹配 4 个 `bg-*` 之一才有意义（CSS 里 `bg-\S+` 替换） |
| `tool` | `'rect'` | 历史值 `mosaic`/`pixel` **强制改回 `rect`** |
| `pinned` | `true` | 只有显式 `false` 才为否（`d.pinned === false ? false : true`） |
| `radius` | `0` | `|| 0` |
| `sidebarCollapsed` / `rightSidebarCollapsed` | `false` | `|| false` |
| `sidebarW` / `rightSidebarW` | 不写（保留 CSS 默认） | 仅当为真值时写入 CSS 变量 `...W + 'px'` |
| `redactStyle.color` | `'#000000'` | `\|\| '#000000'` |
| `redactStyle.radius` | `0` | `\|\| 0`；应用时再 `Math.max(0, parseInt() \|\| 0)` |
| `redactStyle.opacity` | `100` | 非有限数→`100`，否则夹取到 **[10, 100]** |
| `sensitiveWords` | 保留内存默认 | 必须是数组，否则**不覆盖**；逐个 `String(w).trim()` 并滤空 |
| `imageNavEnabled` | `CONFIG.IMAGE_NAV_ENABLED_DEFAULT = true` | `undefined`→默认；否则 `!== false` 即算开 |
| `pdfImageLargeFilter` | `CONFIG.PDF_IMAGE_LARGE_FILTER_DEFAULT = true` | 同上 |
| `pdfImageLargeRatio` | `CONFIG.PDF_IMAGE_LARGE_RATIO_DEFAULT = 0.9` | 非有限→默认，否则夹取到 **[0.5, 0.95]** |

- `loadSettings()` 整体包在 `try{}catch(_){}` 里：JSON 解析失败就**静默用全默认**，不报错。
- 读完后立刻 `applyTheme()/applyBg()/applyRadius()/applyRedactStyle()` 应用界面。

### 3.3 最小合法示例（可直接作为 localStorage 值）

```json
{
  "theme": "dark",
  "bg": "bg-void",
  "tool": "rect",
  "pinned": true,
  "radius": 8,
  "sidebarCollapsed": false,
  "sidebarW": 270,
  "rightSidebarCollapsed": false,
  "rightSidebarW": 270,
  "redactStyle": { "color": "#000000", "radius": 0, "opacity": 100 },
  "sensitiveWords": [],
  "imageNavEnabled": true,
  "pdfImageLargeFilter": true,
  "pdfImageLargeRatio": 0.9
}
```

### 3.4 完整示例（高亮 + 敏感词）

```json
{
  "theme": "light",
  "bg": "bg-grid",
  "tool": "select",
  "pinned": false,
  "radius": 16,
  "sidebarCollapsed": true,
  "sidebarW": 240,
  "rightSidebarCollapsed": false,
  "rightSidebarW": 300,
  "redactStyle": { "color": "#c96a2e", "radius": 6, "opacity": 35 },
  "sensitiveWords": ["张三", "13800000000", "身份证号"],
  "imageNavEnabled": true,
  "pdfImageLargeFilter": false,
  "pdfImageLargeRatio": 0.85
}
```

> 上面两段是**给 localStorage 用的设置数据**，不是「可导入文件」。
> 用法只能：控制台执行 `localStorage.setItem('zr-settings', JSON.stringify(<对象>))` 后刷新。

---

## 4. 持久化状态之二：脱敏记录 `S.redacts`（内存，永不落盘）

每个脱敏区域是一个对象，由 `makeRedact(nx1,ny1,nx2,ny2,type,pageIdx,wordMatch)` 创建。
**它是 App 的核心数据，但没有任何文件导入/导出通道**——记录在这里只为让你理解 App 内部状态、
或将来若加入导出时参照。

### 4.1 单条结构（照抄 `makeRedact()`）

```jsonc
{
  "id": "r1",                    // 由 genId() 生成：'r' + (++redactIdCounter)，如 r1、r2、r3
  "pageIdx": 0,                  // 页索引，0-based 整数
  "nx1": 0.10,                   // 归一化左上 x，范围 [0,1]（已 min(nx1,nx2) 归一）
  "ny1": 0.20,
  "nx2": 0.55,                   // 归一化右下 x/y（已 max 归一）
  "ny2": 0.28,
  "type": "rect",                // 当前所有创建点固定传 'rect'（mosaic/pixel 已从工具里移除）
  "wordMatch": null,             // 自动敏感词命中时记录命中词；手动框选/划选为 null
  "applied": false,              // 创建时 false，需「应用」或点击遮罩才转 true
  "timestamp": 1760000000000,    // Date.now() 毫秒
  "style": {                     // 从当时的 S.redactStyle 拷贝而来
    "color": "#000000",
    "radius": 0,
    "opacity": 100               // 100=脱敏(不透明)；<100=高亮(半透明)
  }
}
```

### 4.2 关键约束

| 项 | 规则（来自代码） |
|---|---|
| `id` 格式 | 固定 `'r' + 递增整数`，全局唯一；加载新文档时计数器归 0 |
| 坐标 | `clamp01` 夹到 `[0,1]`；`nx1<=nx2`、`ny1<=ny2`（创建时用 min/max 保证） |
| 坐标含义 | 相对**该页内容盒**的**比例**，非绝对像素；渲染时 `* 页宽/页高` |
| `type` | 现状恒为 `'rect'` |
| `wordMatch` | 自动遮罩：传入命中词的**原始字符串**（`word.raw`）；手动：`null`。文本类不可逆 PDF 读取时按对象 `.word` 取词，字符串取不到属实现细节 |
| `applied` | 未应用=虚线预览；已应用才在导出中生效 |
| 撤销/重做 | `S.undoStack`/`S.redoStack` 里存的是 `JSON.stringify(S.redacts)` 整份快照；上限 `CONFIG.UNDO_LIMIT = 80`。这是**内存里**的临时 JSON，不写盘 |

### 4.3 数组示例（纯参考，非导入用途）

```json
[
  {
    "id": "r1", "pageIdx": 0,
    "nx1": 0.10, "ny1": 0.20, "nx2": 0.55, "ny2": 0.28,
    "type": "rect", "wordMatch": null, "applied": true,
    "timestamp": 1760000000000,
    "style": { "color": "#000000", "radius": 0, "opacity": 100 }
  },
  {
    "id": "r2", "pageIdx": 1,
    "nx1": 0.05, "ny1": 0.60, "nx2": 0.40, "ny2": 0.66,
    "type": "rect", "wordMatch": "13800000000", "applied": false,
    "timestamp": 1760000001000,
    "style": { "color": "#c96a2e", "radius": 6, "opacity": 35 }
  }
]
```

> 再次强调：**没有把上面这个数组喂回 App 的入口。** 它只存在于内存与撤销栈。

---

## 5. 默认值速查（CONFIG / S）

| 常量 | 值 | 出处 |
|---|---|---|
| `CONFIG.CHUNK_SIZE` | `1048576`（1 MiB） | 流式文本分片；`> 2*CHUNK_SIZE` 才走流式 |
| `CONFIG.UNDO_LIMIT` | `80` | 撤销栈上限 |
| `CONFIG.IMAGE_NAV_ENABLED_DEFAULT` | `true` | 设置缺省 |
| `CONFIG.PDF_IMAGE_LARGE_FILTER_DEFAULT` | `true` | 设置缺省 |
| `CONFIG.PDF_IMAGE_LARGE_RATIO_DEFAULT` | `0.9` | 设置缺省 |
| `S.redactStyle` 初值 | `{color:'#000000',radius:0,opacity:100}` | |
| 工具集 | `rect / select / move / eraser` | |
| 主题 | `light / dark` | |
| 背景 | `bg-void / bg-grid / bg-dots / bg-diagonal` | |
| 遮罩圆角滑块 | `min 0 / max 24` | `#redact-radius` |
| 遮罩不透明度滑块 | `min 10 / max 100` | `#redact-opacity` |
| 全局 UI 圆角档 | `[0,4,8,12,16,20,24]` 循环 | |

---

## 6. 给生成方的硬性检查清单

1. **不要**声称能生成 `.json/.zr` 让 App「导入脱敏工程/备份」——本 App 无此功能。
2. 若目标是「还原界面设置」：产出第 3 节结构的对象即可，并**明确告诉用户**
   这是写入 `localStorage['zr-settings']`（控制台执行后刷新），**不是导入文件**。
   校验：`theme∈{light,dark}`、`bg∈{4 个 bg-*}`、`tool∈{rect,select,move,eraser}`、
   `redactStyle.opacity∈[10,100]`、`pdfImageLargeRatio∈[0.5,0.95]`、
   `sensitiveWords` 为**字符串数组**。
3. 若目标是「给用户一段可脱敏的文本」：产出**纯 `.txt`**（UTF-8）即可，让用户正常「打开文档」。
   别包装成 JSON。
4. 若需要「脱敏区域清单」：如实说明**无法生成导入文件**，只能在 App 内手工/自动遮罩，
   结果只能导出 PDF/图片/PPTX（非 JSON）。
5. 任何 JSON 必须是 **UTF-8 合法 JSON**：无注释、无尾逗号；写进 localStorage 时再 `JSON.stringify`。

---

## 7. 行为速查

| 情况 | 结果 |
|---|---|
| 拖入/选择 `.json` | 拒绝，提示「仅支持 TXT、DOCX、PDF、PPTX 文件」 |
| 打开任意新文档 | 清空 `S.redacts`、撤销/重做栈、id 计数器 |
| 找不到「导入 / 恢复 / 打开工程 / 加载备份」 | 正常——这些功能不存在 |
| 想找「导出 JSON / 导出工程」 | 没有——只有 PDF / 图片 ZIP / PPTX / 不可逆脱敏 PDF |
| 篡改 `zr-settings`（localStorage） | 下次打开读回；非法字段按第 3.2 节兜底，整体解析失败则全用默认 |
| `redactStyle.opacity < 100` 的遮罩 | 高亮模式，导出保留原文（半透明覆盖） |
| `redactStyle.opacity = 100` 的遮罩 | 脱敏模式，导出永久抹除 |
| 想批量预置脱敏区域 | 做不到：无导入通道 |
