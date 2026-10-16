# ZenLatex 文件规范（`.tex` 导入 + localStorage 持久化 JSON）

> 用途：让 AI（或任何程序）**直接生成可被 ZenLatex 导入的 `.tex` 文件**。
> 用户在 ZenLatex 顶部菜单「文档 → 导入 .tex 文件」（快捷键 `Ctrl/⌘ + O`）
> 选中该 `.tex`，文件内容即被读入编辑器并触发编译。
>
> 本文所有结论都是从 `omm-latex.html` 的代码里逐行核对出来的，不是推测：
> - 导入处理器：`<input type="file" id="file-input" accept=".tex,.txt,.latex">`（~1884 行）
>   + `change` 监听里的 `FileReader.readAsText(f, 'utf-8')`（~4927–4947 行）
> - 编译请求：`compile()` 向 `/api/compile` POST `{tex, engine, passes, mainfile}`（~3863–3982 行）
> - 持久化：`saveCurrentDocument()` / `restoreCurrentDocument()`（~2161–2202 行）、
>   `getTemplateStore()` / `normalizeTemplate()`（~2018–2059 行）、
>   `restorePrefs()` 里的 `LS.get('editor')`（~5035–5073 行）
>
> ⚠️ **本应用没有任何「导入 JSON 文件」的入口。** 唯一的文件导入就是 `.tex` 纯文本。
> JSON 只存在于浏览器 localStorage 里，是程序**自动落盘、自动恢复**的内部状态，
> 不能从磁盘文件重新导入（详见第 6 节）。

---

## 0. 一句话结论

**能被「导入文件」的只有 `.tex`（以及 `.txt`/`.latex`）纯文本，不是 JSON。**
所以要让 AI 产出可被本应用使用的工件，正确做法是**生成一份合法的、自包含的 LaTeX 源码**，
保存为 `main.tex` 后由用户导入。JSON 形态（快照 / 模板库 / 编辑器配置）只是 localStorage
内部状态，**无法**从文件导入，本文只在第 6 节作为参考如实记录其结构。

---

## 0.5 给 AI 的提示词模板

把下面这段连同本文一起发给 AI，让它直接产出可导入的 `.tex`：

```text
你要生成一个可被 ZenLatex（omm-latex.html）「导入 .tex 文件」直接使用的 LaTeX 源文件 main.tex。

硬性要求：
1. 输出必须是单一、自包含的 LaTeX 文档：从 \documentclass 到 \end{document} 全在一行文件里。
   绝对不要用 \input{…} / \include{…} / \includeonly{…} 引用其它 .tex 文件，
   也不要用 \bibliography{…} 指向外部 .bib —— 编译时这些外部文件不存在会直接报
   “file not found”。参考文献请内联到 \begin{thebibliography}…\end{thebibliography}。
2. 需要插图时：要么改用 TikZ/pgfplots 现场绘制（推荐，纯代码不依赖图片文件），
   要么用一张可公网访问的 URL；不要假设本地有图。
3. 正文含中文时，文档类用 ctexart / ctexbeamer（XeLaTeX），并 \usepackage{ctex}；
   纯英文用 article。默认引擎是 XeLaTeX。
4. 数学：行内 $…$ 或 \(…\)，独立公式 $$…$$ 或 \[…\]；表格用 tabular + booktabs。
5. 文件是 UTF-8 纯文本；只输出 LaTeX 源码本身，不要 markdown 代码块围栏、
   不要 ``` 包裹、不要注释掉整篇骨架。
6. 编译通过为第一目标：命令拼写正确、环境成对闭合、括号平衡、每条 \\ 与 & 位置正确。

最后自查：能否单文件编译、有无外部 \input/\include/\bibliography 依赖、
中文字体依赖是否说明、是否只用 XeLaTeX 可用的包。
```

---

## 1. 「导入」到底接收什么

照抄代码行为：

```
菜单项 ['import', '导入 .tex 文件']            // ~2405
点击 → $id('file-input').click()               // ~2728, ~4680
<input accept=".tex,.txt,.latex">             // ~1884
change → FileReader.readAsText(f, 'utf-8')     // ~4945
  → saveCurrentDocument()                       // 先把旧内容落盘
  → state.tplId = ''                            // 脱离模板绑定
  → state.currentDocId = 'file:' + f.name       // 文档 ID 记为 file:名字
  → setTex(文件全文)                             // 内容进编辑器
  → scheduleCompile({ load:true, immediate:true })  // 立即编译
```

**要点**

- 导入的**永远是整段文本**，文件被原样塞进编辑器；不解析任何结构、不校验是否为合法 LaTeX。
  合法性由后面的 MiKTeX 编译决定，导入这一步永远成功。
- 只取 `e.target.files[0]`，**一次一个文件**；无多选、无拖拽、无文件夹。
- 扩展名只过滤 `.tex/.txt/.latex`，内容是纯文本读取，**不是** JSON 解析。
  （代码里出现的 `.json` 全是 `await r.json()` 读编译服务响应，与文件导入无关。）

### 编译管线对源码的要求（决定 .tex 好不好用）

`compile()` 送出去的请求体（~3938 / ~3971）：

```js
{
  tex: <编辑器里的全部源码字符串>,
  engine: 'xelatex' | 'pdflatex' | 'lualatex',   // 默认 xelatex
  passes: 1 | 2 | 3,                              // 默认 2
  mainfile: 'main.tex'                            // 固定写死
}
```

- **单文件语义**：整个源码作为字符串塞进 `tex`，`mainfile` 固定 `main.tex`。
  应用侧**没有**任何多文件 / 附件上传入口。
- ⚠️ **坑（关键）**：编译器报“找不到被引用的文件”时，界面提示原文是
  *“请检查文件名、路径以及上传/导入的附件”*（~4106）。这暗示后端服务本身支持附件，
  但**这个网页应用不会上传任何附件**。因此凡是 `\input{}` / `\include{}` / `\includeonly{}` /
  `\bibliography{}` / 本地 `graphicx` 图片路径，**只要不在那一份 `main.tex` 文本里，就必然编译失败**。
  → AI 生成的 `.tex` 必须**自包含**：参考文献内联 `thebibliography`、图用 TikZ/pgfplots 现画或公网 URL。
- **依赖本地服务**：必须先在本机跑 MiKTeX 编译服务（默认 `http://127.0.0.1:8123`，
  菜单「编译 → 服务地址」配置，持久化键 `zentex.api`）。服务没起来时导入照常成功，但编译显示“等待本地服务”。
- **引擎与中文**：默认 XeLaTeX。内置模板的中文文档类是 `ctexart` / `ctexbeamer`（需 `ctex` 宏包与系统中文字体）。

---

## 2. 给 AI 的 `.tex` 模板骨架

下面这份是**可直接保存为 `main.tex` 导入并编译**的最小合法骨架（中文，XeLaTeX）：

```tex
\documentclass[11pt,a4paper]{ctexart}
\usepackage{geometry}
\geometry{left=2.6cm,right=2.6cm,top=2.8cm,bottom=2.8cm}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{enumitem}
\usepackage{tikz}
\usetikzlibrary{arrows.meta,positioning,calc}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\usepackage[hidelinks]{hyperref}
\usepackage{setspace}
\setstretch{1.35}

\title{文档标题}
\author{作者\\单位}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
这里是摘要。所有正文文本直接写在本文件内，不要引用外部文件。
\end{abstract}

\section{引言}
第一段正文。行内公式 $E=mc^2$，独立公式：
\[
  \int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
\]

\section{方法}
\begin{enumerate}[label=(\arabic*)]
  \item 第一个要点
  \item 第二个要点
\end{enumerate}

\begin{table}[htbp]
  \centering
  \caption{示例表格}
  \begin{tabular}{lcr}
    \toprule
    列一 & 列二 & 列三 \\
    \midrule
    A & B & C \\
    \bottomrule
  \end{tabular}
\end{table}

\section{图（用 TikZ 现画，不依赖图片文件）}
\begin{figure}[htbp]
  \centering
  \begin{tikzpicture}
    \node[draw] (a) {开始};
    \node[draw,right=of a] (b) {结束};
    \draw[->] (a) -- (b);
  \end{tikzpicture}
  \caption{流程示意。}
\end{figure}

\section{结论}
这里是结论。

% 参考文献内联，绝不用 \bibliography{external}
\begin{thebibliography}{9}
\bibitem{ref1} 作者. 书名. 出版地: 出版社, 年份.
\bibitem{ref2} 作者. 文章题目. 期刊, 年份(期): 页码.
\end{thebibliography}

\end{document}
```

### 生成 `.tex` 的硬性注意事项

| 事项 | 规则 |
|---|---|
| 编码 | UTF-8 纯文本（导入按 `readAsText(...,'utf-8')` 读，含中文需 UTF-8） |
| 单文件 | 一份从 `\documentclass` 到 `\end{document}` 的完整文档；无 `\input`/`\include`/外部 `.bib` |
| 文档类 | 中文 `ctexart`/`ctexbeamer`（配 XeLaTeX）；英文 `article`/`beamer` |
| 公式 | 行内 `$…$` 或 `\(…\)`；独立 `$$…$$` 或 `\[…\]`；成对闭合 |
| 图 | 优先 TikZ/pgfplots 现画，或公网 https 图床 URL；勿写本机相对路径图片 |
| 表格 | `tabular` 列数与 `&`/`\\` 数量一致；建议 `booktabs` |
| 引擎 | 默认 XeLaTeX，所用宏包需该引擎可用；切换引擎见菜单 |
| 编译 | 以「能一次编译通过」为第一目标，避免未定义命令 |

---

## 3. 内置模板（可仿照其结构）

`BUILTIN_TEMPLATES`（~1954）内置 7 个模板，AI 可参照其文档类与包组合产出对应题材。
模板的 JSON 形态见第 6.2 节，但**内置模板不可被文件替换**，只能由用户在「模板 → 新建/编辑」里另存。

| `id` | 名称 | 说明 | 文档类 / 关键包 |
|---|---|---|---|
| `paper` | 中文学术论文 | ctexart 人文社科写作 | `ctexart`、amsmath、booktabs、hyperref、enumitem |
| `report` | 读书报告 | 阅读·摘要·评议 | `ctexart`、enumitem、setspace |
| `english` | 英文 Term Paper | article·English | `article`、fontenc、mathptmx、graphicx |
| `tikz` | 通用结构图 | 时间线·关系图·矩阵·网络 | `ctexart`、tikz（大量库）、xcolor |
| `slides` | 幻灯片 | Beamer 16:9 | `ctexbeamer`、aspectratio=169 |
| `blank` | 空白文档 | 最小骨架 | `ctexart`、geometry |
| `drawing` | 理工科研绘图集 | 电路·化学·生物 | `ctexart`、tikz、circuitikz、chemfig |

> 另有一个隐藏 id `humanities`（~1997，「统计与数据可视化」，pgfplots 全套），存在于数据中但
> 不在主菜单快捷列出；其骨架同样可参照。

「文档 → 新建：中文学术论文」直接载入 `paper`；「清空为空白文档」载入 `blank`。

---

## 4. 导出（写文件）行为

应用能**写出**的只有三类，**没有任何 JSON 备份/导出**：

| 菜单项 | 实现 | 产物 |
|---|---|---|
| 导出 .tex 源码 `export`（~2868） | `Blob([state.tex], 'text/x-tex;charset=utf-8')` | `main.tex`（纯文本） |
| 下载 PDF `download` | 取最近一次编译结果 URL | `main.pdf` |
| 导出 PNG `export-png` / `export-png1` | 按 `zentex.pngDpi` 渲染整页/当前页 | `page-<i>.png` |
| 复制源码到剪贴板 `copy` | `copyText(state.tex)` | 剪贴板文本 |

所以「导出 → .tex」是往返通道：导出的 `main.tex` 可被另一个浏览器/设备再次「导入 .tex」。
**这是唯一可靠的跨设备迁移方式。**

---

## 5. 没有 JSON 文件导入（再次明确）

代码里所有“导入/restore”路径核对结果：

- 「导入」= 仅 `.tex/.txt/.latex` 文本（第 1 节）。
- 模板的新建/编辑/删除/恢复原版（`saveTemplateDefinition` / `deleteCustomTemplate` /
  `resetTemplateOverride`，~2091–2157，UI 处理 ~4820–4899）**只读写 localStorage**，
  **没有**「从文件载入模板」的按钮或读取逻辑。
- 启动恢复 `boot()`（~5086）只调用 `restorePrefs()` + `restoreCurrentDocument()`，
  二者**只从 localStorage 读**，不接收任何文件。
- 没有 `readAsDataURL`、没有 `.json` 文件选择、没有 `FileReader`+`JSON.parse` 组合。

结论：**不存在可被本应用消费的 JSON 文件。** 不要给 AI 布置“生成可导入 JSON”的任务。

---

## 6. localStorage 持久化 JSON 形态（参考，只读不导入）

下列 JSON 是程序在**同一浏览器**里自动落盘、自动恢复的内部状态。
键名前缀统一为 `zentex.`（`LS` 包装器，~1937）。它们的结构如实记录，
**仅供理解/调试**，**不能**作为文件导入恢复（恢复只发生在 `boot()` 读 LS 时）。
以下示例是程序**真正会产生/消费**的合法 JSON。

### 6.1 当前文档快照 `zentex.document`

写出见 `saveCurrentDocument()`（~2161）；读入见 `restoreCurrentDocument()`（~2187）。

```json
{
  "id": "file:main.tex",
  "name": "main.tex",
  "tplId": "",
  "source": "\\documentclass[11pt]{ctexart}\n\\begin{document}\n正文\n\\end{document}",
  "savedAt": 1760000000000
}
```

| 字段 | 必需 | 说明 / 容错 |
|---|---|---|
| `id` | 否 | 缺省时按 `tplId ? 'template:'+tplId : 'scratch'` 推断；导入文件时为 `'file:'+文件名` |
| `name` | 否 | 编辑器标签名，缺省 `'main.tex'` |
| `tplId` | 否 | 关联模板 id；只有 `templateById(tplId)` 命中才保留，否则清空 |
| `source` | **是（类型）** | **必须是字符串**，否则整份快照被判定无效并放弃恢复（~2189） |
| `savedAt` | 否 | `Date.now()` 毫秒，仅作记录 |

- 恢复判定（~2189–2190）：`source` 不是 `string` → 不恢复；
  且 `source`/`name`/`tplId` 全为空 → 也不恢复。
- 恢复后若没有快照，`boot()` 回退到 `LS.get('tpl','paper')` 即最近使用的模板（~5092）。

### 6.2 模板库 `zentex.templates`

写出见 `saveTemplateStore()`（~2046）；读入见 `getTemplateStore()`/`restoreTemplateCatalog()`
（~2035–2085）。结构是 `{ overrides, custom }`：

```json
{
  "overrides": {
    "paper": {
      "name": "中文学术论文（改）",
      "hint": "我修改过的内置模板",
      "body": "\\documentclass{ctexart}\n...",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  },
  "custom": [
    {
      "id": "custom_m3k9x2_a1b2c3",
      "name": "我的模板",
      "hint": "自定义模板",
      "body": "\\documentclass{article}\n...",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

- `overrides`：以内置模板 id 为键，记录用户对内置版的修改；恢复原版即 `delete store.overrides[id]`。
- `custom`：自定义模板数组。id 由程序生成 `custom_<base36时间>_<随机>`（~2105），编辑时不可手填。
- 单条模板经 `normalizeTemplate`（~2018）校验：
  **`id`、`name`、`body` 三者去空白后必须非空**，否则整条被丢弃（`hint` 缺省 `'自定义模板'`）。
- 内置模板（`BUILTIN_TEMPLATES`）每次启动重新铺底，再叠加 `overrides` 与 `custom`；
  与内置 id 冲突的 custom 会被去重跳过（~2083）。

### 6.3 编辑器外观配置 `zentex.editor`

写出见 `saveEditorPrefs()`（~3034）；读入校验见 `restorePrefs()`（~5054–5063）。
每个字段都用**白名单**严格校验，非法值直接忽略用默认：

```json
{ "font": "mono", "size": 11, "line": 1.64, "letter": 0 }
```

| 字段 | 合法取值 | 默认 |
|---|---|---|
| `font` | `mono` / `literata` / `song` / `times` | `mono` |
| `size` | `10,11,12,13,14,15,16`（数字） | `11` |
| `line` | `1.45,1.6,1.64,1.75,1.9,2.1`（数字） | `1.64` |
| `letter` | `-0.2,0,0.2,0.4,0.6`（数字，单位 px） | `0` |

> 注意：`restorePrefs` 里用的是裸 `JSON.parse`（~5055），不是 `safeJson`；
> 解析异常被 `try/catch` 吞掉后维持默认值。

### 6.4 其余标量键（`LS.set` 存的是 `String(v)`，非 JSON）

| 键 | 含义 | 合法值 / 默认 |
|---|---|---|
| `zentex.engine` | 编译引擎 | `xelatex`/`pdflatex`/`lualatex`，默认 `xelatex` |
| `zentex.passes` | 编译遍数 | `1`/`2`/`3`，默认 `2` |
| `zentex.auto` | 改动后自动编译 | `'1'`/`'0'`，默认 `'1'` |
| `zentex.autoLoad` | 载入/导入后立即编译 | `'1'`/`'0'`，默认 `'1'` |
| `zentex.autoDelay` | 防抖延时 ms | `300/600/900/1500/2500`，默认 `900` |
| `zentex.pngDpi` | 导出 PNG 分辨率 | `96/150/200/300/600`，默认 `300` |
| `zentex.radius` | 圆角 | `0..12`，默认 `0` |
| `zentex.bg` | 背景样式 | `plain/body-grid/body-dots/body-cross/body-diagonal` |
| `zentex.split` | 编辑器占比 | `0.15..0.85`，默认 `0.46` |
| `zentex.flip` | 编辑器在右 | `'1'`/`'0'` |
| `zentex.menuPinned` | 菜单置顶 | `'1'`/`'0'` |
| `zentex.tpl` | 最近使用的模板 id | 默认 `paper` |
| `zentex.api` | 本地编译服务地址 | 空串（探测后写入，默认 `http://127.0.0.1:8123`） |

---

## 7. 给生成方的硬性检查清单

要产出「能被 ZenLatex 导入」的工件，逐条自查：

1. **只生成 `.tex` 纯文本**（或 `.latex`/`.txt`），UTF-8 编码，保存为 `main.tex`。
2. **单文件自包含**：从 `\documentclass` 到 `\end{document}` 完整；**绝不用**
   `\input`/`\include`/`\includeonly`，**绝不用**外部 `\bibliography{}`（用内联 `thebibliography`）。
3. 图片：用 TikZ/pgfplots 现画，或公网 https 图床；**不要**写本机相对/绝对路径图片。
4. 中文：文档类 `ctexart`/`ctexbeamer` 且 XeLaTeX 引擎；英文用 `article`/`beamer`。
5. 公式/环境成对闭合、括号平衡、表格 `&`/`\\` 与列数一致；命令拼写正确（避免未定义命令）。
6. **不要**尝试产出 `.json` 让本应用导入——它没有 JSON 文件导入入口。
7. 第 6 节的 JSON 形态仅在你想理解 localStorage 内部状态或调试时才参考；
   它们由程序自己写、自己在同浏览器读，**不接受文件恢复**。

满足 1–5 条，导入这一步一定成功（导入只读文本不校验），能否出 PDF 取决于 LaTeX 本身与本地服务。

---

## 8. 行为速查

| 情况 | 结果 |
|---|---|
| 导入 `.tex`/`.txt`/`.latex` | 全文进编辑器，立即触发编译；旧内容先落盘 |
| 导入非文本（如 `.json`） | 文件选择器已按 accept 过滤掉，正常无法选中；若强行选入也只当文本塞进去 |
| 导入含中文但非 UTF-8 | 读入乱码（`readAsText(...,'utf-8')` 假设 UTF-8） |
| `\input`/外部 `.bib`/本机图片 | 导入成功，但编译报 “file not found”（应用不上传附件） |
| 本地服务未启动 | 导入/编辑照常，仅编译显示“等待本地服务” |
| 刷新页面 | 自动恢复上次编辑（读 `zentex.document`），无需任何文件 |
| 换浏览器/设备 | 用「导出 .tex」再「导入 .tex」迁移；模板需在本机重新建立 |
| 想要“导入模板文件” | 不支持；只能在「模板 → 新建/编辑」里粘贴 LaTeX 内容另存 |
