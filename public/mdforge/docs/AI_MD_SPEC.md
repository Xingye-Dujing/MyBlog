# MdForge · AI Markdown 写作规范

- 版本：1.2
- 适用模板：`academic`（DOCX / TeX）
- 用途：让 AI 生成可直接由 MdForge 排版为学术 DOCX / TeX / PDF 的 Markdown 纯文本。

> 你负责写 Markdown。版式、字体、页边距、目录、页眉页脚与参考文献样式由 MdForge 模板负责。平台另有「格式」微调与目录选项，不需要也不允许写进 Markdown。不要试图用空格、HTML 或手工分页模拟版式。

---

## 一、硬性输出要求

1. 只输出 **Markdown 原文**，不要解释、不要前言后记、不要“以下是文档”之类的话。
2. 不要把整篇文档包在代码围栏（```` ``` ````）里。
3. 文件第一行必须是 `---`，并以 YAML frontmatter 开头。
4. 必须包含非空 `title`，并写 `template: academic`。
5. 不要在正文中重复标题、作者、摘要、关键词；这些只放在 frontmatter。
6. 不要手写目录。目录是否生成由 `toc` 控制：DOCX 默认生成，TeX 默认不生成；可由界面或 frontmatter 开启。
7. 不要写封面、页眉页脚、页码或“第 X 页”。
8. 不要使用脚注、HTML 块、任务列表、嵌套引用、嵌套表格、远程图片、H5/H6、内联图片。
9. 不要在正文里写 LaTeX 导言区或自定义宏，只允许数学模式。
10. 标题、正文、图表题注、参考文献均使用本规范列出的语法。
11. 不要在 Markdown 中表达页边距、字号、行距、首行缩进、字体等版式微调；这些由平台「格式」面板、API 的 `format_overrides` 或 CLI 的 `--format-config` 控制。

---

## 二、Frontmatter

文件必须以如下结构开头：

```yaml
---
title: 从文本到版式
subtitle: ——Markdown 驱动的学术出版管线
author: 星野笃敬
date: "2026-10-21"
department: 数字人文实验室
version: v1.0
subject: 自动排版
abstract: "[目的/意义] 这里的摘要是一整段文字。[方法/过程] 说明方法与数据。[结果/结论] 给出结论。"
keywords: [Markdown, DOCX, LaTeX, 自动排版]
template: academic
---
```

### 字段规则

| 字段 | 必填 | 规则 |
|---|---|---|
| `title` | 是 | 单行文本，不加书名号以外的装饰；不要用 Markdown 标记 |
| `subtitle` | 否 | 通常以“——”开头；没有就省略 |
| `author` | 否 | 写入文档元信息；不会出现在正文标题下 |
| `date` | 否 | 建议加引号，格式 `YYYY-MM-DD` |
| `department` | 否 | 写入 DOCX 类别 / 可映射到模板页眉占位符 |
| `version` | 否 | 写入 DOCX 备注属性 |
| `subject` | 否 | 文档主题/PDF 属性 |
| `abstract` | 否 | 一整段，建议用双引号包成单行；不要写“摘要：”前缀 |
| `keywords` | 否 | YAML 数组；不要写“关键词：”前缀 |
| `template` | 是 | 固定写 `academic` |
| `toc` | 否 | 是否生成目录；DOCX 默认 `true`，TeX 默认 `false` |
| `toc_title` | 否 | 目录标题，默认“目录” |
| `toc_levels` | 否 | 目录包含的标题层级，取值 1–3，默认 2 |
| `toc_include_references` | 否 | 是否在目录中包含“参考文献”条目 |
| `references` | 否 | 参考文献数组；优先用正文末尾的 `# 参考文献` 写法 |

- YAML 值含冒号、方括号、引号等字符时，用双引号包裹。
- 不要使用多行折叠标量，避免上游解析差异。
- `title` 不要重复写入正文作为 `# 标题`。

---

## 三、正文结构

### 3.1 标题

只使用 `#` 到 `####`：

```markdown
# 引言

## 研究背景

### 数据来源

#### 样本说明
```

规则：

- 正文从 `# 引言` 开始（或用户指定的第一节）。
- 层级连续，不跳级；`#` 后面空一格。
- 目标模板的标题**默认不编号**。不要在标题文字里添加 `1.`、`1.1` 等编号，除非用户明确要求。
- 不使用 Setext 标题（`===` / `---` 下划线形式）。
- 不写 `# 摘要`、`# 关键词`、`# 目录`。

### 3.2 段落

- 段落之间空一行。
- 一个段落写成连续的一段中文，不要在段中随意换行；不要用两个空格制造换行。
- 不要用 `<br>`。
- 不要插入多个连续空行。
- 不要用全角空格或大量缩进模拟首行缩进，模板会自动设置。

### 3.3 行内格式

| 写法 | 效果 |
|---|---|
| `**加粗**` | 加粗 |
| `*斜体*` | 斜体 |
| `~~删除~~` | 删除线 |
| `` `行内代码` `` | 等宽字体 |
| `[文字](https://example.com)` | 超链接 |
| `$E = mc^2$` | 行内公式 |

- 不要嵌套三种以上的强调格式。
- 链接必须写完整 URL；不要使用相对链接、`javascript:`、`data:`。
- 行内代码适合变量名、函数名、字段名，不要用它排版普通句子。

### 3.4 列表

最多 3 级，每级建议缩进 4 个空格：

```markdown
- 第一级
    - 第二级
        - 第三级

1. 第一项
    - 子项
2. 第二项
```

- 有序列表编号由平台/Word/LaTeX 处理，不要手工在正文写“一、二、三”。
- 不使用任务列表 `- [ ]`。
- 列表项尽量简短；复杂内容请改用段落或表格。
- 列表前后空一行。

### 3.5 代码块

必须标注语言；纯文本写 `text`：

````markdown
```python
def render(document, template):
    return template.render(body=document.body)
```
````

- 代码块不要与正文挤在同一行。
- 不要把整篇 Markdown 包进代码块。
- 代码块内的中文可以保留，但过长的行可能影响版面，建议每行不超过 90 字符。

### 3.6 引用

只使用一层引用，引用建议为单段：

```markdown
> 模板定排版，Markdown 定内容，程序定映射。
```

- 不使用嵌套引用（`> >`）。
- 引用内不要放图片、表格或代码块。

### 3.7 数学公式

行内公式：

```markdown
设样本量为 $n$，置信水平为 $1-\alpha$。
```

块级公式必须独占一段：

```markdown
$$
\mathrm{Similarity}(A,B) = \frac{|A \cap B|}{|A \cup B|}
$$
```

- 只使用 `$...$` 与 `$$...$$`，不要用 `\(...\)`、`\[...\]` 或 `\begin{equation}`。
- 只写数学内容，不要写 `\newcommand`、`\input`、`\write18` 等命令。
- TeX 输出为原生公式；DOCX 会把公式显示为 Cambria Math 文本。若最终只交付 DOCX 且公式复杂，请改用文字描述。
- 行内公式不要跨行。

### 3.8 水平线与分页

- 分页：单独一行写 `<!-- pagebreak -->`。
- 水平线：frontmatter 之后单独一行写 `---`。慎用，学术正文通常不需要。
- 不要在 `# 参考文献` 前手动分页，DOCX 模板会自动将参考文献另起一页。

---

## 四、图片

图片必须独占一个段落，使用本地路径：

```markdown
![自动化排版管线示意图](images/pipeline.png){width=12cm align=center}
```

- `alt` 文本会作为图题描述；不要写“图 1”“Figure 1”等编号，平台会自动编号。
- 路径相对于 Markdown 文件所在目录；网页端通过文件名匹配用户上传的图片。
- 图片文件名建议使用英文、数字、连字符，例如 `images/method-flow.png`。
- 支持的宽度单位：`cm`、`mm`、`in`、`px`、`%`；TeX 还支持 `0.8\textwidth`。
- `align` 可选 `left`、`center`、`right`；缺省居中。
- 仅支持 PNG / JPG；不要使用 WebP、GIF、SVG 或远程 URL（`http://`、`https://`）。
- 图片必须单独成段，前后各空一行；不要出现“文字 + 图片 + 文字”的同一段。
- 如果无法生成图片，先用占位路径写出语法，并明确告知用户需要上传同名图片。

可选：给图片单独加题注

```markdown
<!-- caption: 自动化排版管线示意图 -->
![管线示意](images/pipeline.png){width=12cm}
```

> 这里的 caption 注释也必须独占一行，并紧邻图片。

### 4.1 LaTeX 原生图表（仅 TeX 重绘时使用）

如果用户明确要求「用 LaTeX 重绘图表」，不要插入图片，改用 `latex-figure` 围栏：

````markdown
```latex-figure fallback="images/chart.png"
\begin{figure}[htbp]\centering
\resizebox{0.92\textwidth}{!}{%
\begin{tikzpicture}
\begin{axis}[cixi,width=8cm,height=5cm]
\addplot coordinates {(1,2) (2,3) (3,4)};
\end{axis}
\end{tikzpicture}
}
\caption{图表题注}
\end{figure}
```
````

规则：

- 围栏语言必须是 `latex-figure`。
- 代码会**原样嵌入 TeX 文件**，平台不转义、不改写。
- 可以给完整 `figure` 环境（推荐，参考格式即如此），也可以只给内部的 `tikzpicture` / `pgfplots` 代码；只有内部代码时平台会自动补 `figure`、`centering` 和 `\caption{}`。
- 题注优先从代码中的 `\caption{...}` 读取；未找到时可以使用围栏属性 `caption="..."`。
- `fallback="images/foo.png"` 是可选的回退图，用于 DOCX 输出和网页预览；TeX 输出不会使用它。推荐始终提供，且保证是本地 PNG/JPG。
- 不要把 `\documentclass`、`\begin{document}`、`\end{document}` 放进围栏。
- 不要使用 `\input`、`\include`、`\write18`、`\openin`、`\openout`、`\read`、`\usepackage`、`\directlua`、`\latelua` 等读取外部文件或执行命令的指令；服务端会拒绝这些图表代码。
- 图表代码必须自包含；平台编译时禁用 shell escape。
- `\includegraphics` 同样属于外部文件依赖，会被服务端拒绝；用 `fallback` 提供 DOCX 回退图，用 TikZ/pgfplots 原生绘图。
- 模板已加载 `pgfplots`、`tikz`、`arrows.meta,calc,positioning,backgrounds` 等图表库，并定义了参考文件的 `cA`–`cJ` 配色与 `cixi` 坐标轴样式。
- 如果用户是从一张图片出发要求重绘图表，请配合 `AI_LATEX_FIGURE_SPEC.md` 使用专用图表规范。
- 仅当用户要求 TeX 重绘时使用；普通图片仍使用 PNG/JPG。

---

## 五、表格

只使用 GFM 表格，最多 6 列：

```markdown
<!-- caption: 各阶段主题挖掘结果 -->
| 阶段 | 主题 | 特征词 |
| --- | --- | --- |
| 发酵期 | Topic-1 | 遗弃罪、法律、起诉 |
| 爆发期 | Topic-2 | 媒体、网暴、追责 |
```

规则：

- 表格题注用 `<!-- caption: ... -->` 放在表格上一行；平台自动加“表 N”编号。
- 首行是表头，平台自动加粗。
- 分隔行至少三个短横线。
- 单元格内不要换行、不要放列表、图片或代码块。
- 单元格中的竖线写成 `\|`。
- 列数 ≤ 6；表格过长时请拆分或精简。
- 不支持嵌套表格、纵向合并、横向合并、彩色单元格。

---

## 六、参考文献

在正文末尾使用一次：

```markdown
# 参考文献

王强. 结构化写作与自动排版[J]. 数字出版, 2026, 12(3): 45-58.

李明. 文档模板的语义映射方法研究[D]. 北京: 清华大学, 2025.
```

规则：

- `# 参考文献` 必须是最后一个一级标题，且只出现一次。
- 每条文献单独成段；推荐 GB/T 7714 格式。
- 不要使用 `[1]`、`[2]` 手动编号，平台/模板负责编号与列表样式。
- 不要在参考文献之后继续写正文或附录。
- 不要使用脚注、BibTeX、`\cite`、`[@key]`。
- 也可以把文献放进 frontmatter 的 `references:` 数组，但正文末尾写法更直观。

---

## 七、明确不支持

以下语法会被忽略、降级或导致校验错误：

- H5 / H6（降级为 H4）
- 超过 3 层的列表（截断到 3 层）
- 超过 6 列的表格
- 图片与文字混排、远程图片、SVG
- HTML 块（除 `<!-- pagebreak -->` 与 `<!-- caption: ... -->`）
- 脚注、任务列表
- 嵌套引用、嵌套表格
- 代码围栏外的 LaTeX 命令
- 手工目录、封面、页码、页眉页脚
- 在 `# 参考文献` 之后继续写内容

在平台的“严格模式”下，任何降级或告警都会终止转换；普通模式会尽量降级并给出带行号的提示。

---

## 八、推荐文档骨架

```markdown
---
title: 论文标题
subtitle: ——副标题（可选）
author: 作者
date: "2026-10-21"
department: 机构
version: v1.0
subject: 主题
abstract: "[目的/意义] …… [方法/过程] …… [结果/结论] ……"
keywords: [关键词一, 关键词二, 关键词三]
template: academic
---

# 引言

研究背景与问题。

# 研究设计

## 数据与方法

正文。

<!-- caption: 样本结构 -->
| 类别 | 数量 | 占比 |
| --- | --- | --- |
| 甲 | 120 | 40% |
| 乙 | 180 | 60% |

![研究框架](images/framework.png){width=12cm align=center}

# 结果

行内公式 $E = mc^2$；块级公式如下：

$$
\mathrm{Score} = \frac{a}{b}
$$

# 讨论

结论与局限。

# 参考文献

王强. 结构化写作与自动排版[J]. 数字出版, 2026, 12(3): 45-58.
```

---

## 九、交付前自检

- [ ] 第一行是 `---`，frontmatter 正常闭合。
- [ ] `title` 非空，`template: academic`。
- [ ] 正文没有重复标题、作者、摘要、关键词。
- [ ] 没有手写目录、封面、页码、页眉页脚。
- [ ] 没有用 Markdown / HTML / LaTeX 模拟页边距、字号、行距、缩进或字体。
- [ ] 标题层级连续，只使用 H1–H4。
- [ ] 图片独占段落，路径是本地 `images/...`，格式为 PNG/JPG，无远程图片。
- [ ] 若使用 `latex-figure`，代码是合法 LaTeX，且只包含图表代码，不包含文档导言区。
- [ ] 表格 ≤ 6 列，题注在表格上一行，单元格无换行。
- [ ] 列表 ≤ 3 级，未使用任务列表。
- [ ] 公式只使用 `$...$` / `$$...$$`。
- [ ] `# 参考文献` 是最后一个一级标题，之后没有内容。
- [ ] 全文没有代码围栏包裹；代码块都标注了语言。
- [ ] 没有 HTML（除两个指令注释）、脚注、嵌套引用、嵌套表格。
- [ ] 输出只有 Markdown 原文，没有解释性文字。

---

## 十、版式微调（不在 Markdown 中表达）

页边距、正文字体/字号/行距/首行缩进、标题字体与字号属于**平台格式微调**，不写入 Markdown，也不写入 frontmatter。

- 网页端：「格式」标签在模板默认值上微调，按「格式 + 模板」自动保存到 Local Storage；支持「另存为」JSON、「导入」与「恢复模板」。
- API：`POST /api/convert` 接受 `format_overrides`（对象，或 multipart 中的 JSON 字符串）。
- CLI：`convert ... --format-config <file.json>`。
- Python：`convert_file(..., tuning={...})`。

配置结构（所有字段可省略，省略项继承模板）：

```json
{
  "margins": {"top": 2.54, "bottom": 2.54, "left": 3.18, "right": 3.18},
  "body": {"font_size": 10.5, "line_spacing": 1.25, "first_line_indent": 2, "font": "fangsong"},
  "fonts": {"heading": "fangsong"},
  "headings": {"title_size": 16, "h1_size": 16, "h2_size": 10.5, "h3_size": 10.5}
}
```

- `font` 取值：`songti`、`fangsong`、`heiti`、`kaiti`，控制中文正文/标题字体；西文仍按模板。`body.font` 为正文，`fonts.heading` 为标题。
- 单位：页边距 `cm`，字号 `pt`，行距为倍数，首行缩进为字符数。
- 如果用户提出版式要求，仍然只输出合格的 Markdown 正文；提醒用户在平台「格式」面板中调整，不要用空格、全角空格、HTML 或 LaTeX 命令模拟。
- 目录由 `toc`、`toc_title`、`toc_levels`、`toc_include_references` 控制，不属于微调配置。

---

## 十一、可直接使用的系统提示词

```text
你是 MdForge 学术文稿的 Markdown 生成器。请严格遵循以下规范生成内容：

1. 只输出 Markdown 纯文本；不要解释，不要把全文包进代码围栏。
2. 文件必须以 YAML frontmatter 开头，必填 title，写 template: academic。
3. 标题、作者、摘要、关键词只放在 frontmatter；正文不要重复。
4. 正文只使用 #~#### 标题、普通段落、**粗**、*斜*、~~删~~、行内代码、链接、最多 3 级列表、围栏代码块、一层引用、GFM 表格、独占段落的图片、行内 $...$ 与块级 $$...$$、<!-- pagebreak -->。
5. 图片写成 ![描述](images/文件名.png){width=12cm align=center}，独占段落；仅使用 PNG/JPG。
6. 表格最多 6 列，题注写成 <!-- caption: 题注 --> 放在表格上一行。
7. 文末用 # 参考文献 结尾，每条文献单独成段；其后不要再写内容。
8. 不要手写目录；由 toc 控制；不使用封面、页码、脚注、任务列表、HTML 块、嵌套引用、嵌套表格、远程图片、H5/H6。
9. 标题层级连续不跳级；标题默认不编号。
10. 如果用户没有提供图片文件，请仍然写出确定性的 images/ 路径，并提醒用户上传同名图片。
11. 只有用户明确要求 LaTeX 重绘图表时，才使用 latex-figure 围栏；普通图片继续使用 PNG/JPG。
12. 不要在 Markdown 中写页边距、字号、行距、缩进或字体；这些由平台的「格式」微调负责。

输出仅包含 Markdown 原文。
```
