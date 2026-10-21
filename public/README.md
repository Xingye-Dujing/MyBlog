# MDFORGE · Markdown 铸造台

把一份 Markdown 文稿，稳定地铸造为与参考版式严格对应的 **DOCX** 或 **TeX / PDF**。

- 前端：`omm-mdforge.html`，完全沿用 OMM-ZEN 的滑出菜单、底部状态栏、细线分栏、黑白选中态与统一圆角体系；浅色主题纯白、深色主题纯黑，复选框为 omm-planner 同款黑框绿勾。
- 后端：`mdforge_serve.py`（Flask），提供解析、校验、转换、下载、模板与元信息编辑接口。
- 排版参考：`格式模板参考.docx` 与 `格式模板参考.tex`。
- 本机 MiKTeX 已检测到，可直接编译 PDF。

---

## 1. 快速开始

项目内已经创建了虚拟环境 `.venv`，并安装了运行依赖。

```bash
# 在 public/ 目录
.venv/Scripts/python.exe mdforge_serve.py --open
```

默认地址：<http://127.0.0.1:8140/omm-mdforge.html>

也可以指定端口：

```bash
.venv/Scripts/python.exe mdforge_serve.py --port 8150
```

如需在新机器/新虚拟环境安装：

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-mdforge.txt
.venv/Scripts/python.exe mdforge_serve.py
```

> 页面必须通过 Python 服务打开，不能直接双击 HTML，否则 `/api/*` 与 `/samples/*` 不可用。

### MiKTeX

服务会自动检测：

- 环境变量 `MIKTEX_BIN`
- `D:\MiKTeX\miktex\bin\x64`
- `C:\Program Files\MiKTeX\miktex\bin\x64`
- PATH 中的 `xelatex` / `lualatex` / `pdflatex`

PDF 编译使用 `xelatex`，缺宏包时会设置 `MIKTEX_AUTOINSTALL=1` 让 MiKTeX 自动安装。首次编译可能较慢。

---

## 2. 界面

- 顶部菜单：文件 / 视图 / 输出 / 铸造 / 界面。默认固定，可点右侧箭头按钮收起；未固定时鼠标靠近顶部 8px 滑出。
- 状态栏：`READY · 字数 · 块数 · 格式`，右侧 `MDFORGE`。
- 左栏：Markdown 编辑器，支持软换行、视觉行号与拖入图片。
- 右栏：预览 / 元信息 / 格式 / 输出。
- 偏好面板：白/夜主题、五种背景（默认纯白空白）、**统一圆角滑杆（0–14px，默认 4px）**、界面字号、状态栏、行号、自动解析。所有可见圆角统一使用 `--radius`。
- 格式微调：「格式」标签可在模板基础上调整页边距、正文/标题字体与字号、行距、首行缩进；按「格式 + 模板」自动存入 Local Storage，实时反映到预览；支持「另存为」JSON 与「导入」配置，也可一键恢复模板默认值。
- 生成文件元信息：转换完成后可在结果卡点击「编辑元信息」，修改 DOCX 核心属性或 TeX/PDF 属性；TeX 可选重新编译 PDF。
- 目录定制：「元信息 → 转换选项」可控制是否生成目录、目录标题、1–3 级标题层级、是否包含参考文献；DOCX 默认生成，TeX 默认不生成。
- TeX 交付：结果卡提供「下载素材包」，ZIP 内含 `.tex`、独立素材目录与编译说明；每个输出使用独立的 `<stem>-assets/`，不会覆盖其它文稿的图片。
- 结果状态：修改源文稿或 frontmatter 后，旧结果会标记为「源文稿已修改」，避免误下载过期文件。
- 写作便利：附件图片可一键插入图片语法；每个图片附件还可以点「LaTeX」一键替换为 `latex-figure` 图表代码，原图自动作为 DOCX/预览回退图；校验问题可点击跳转到对应源码行；支持拖入 `.md` 导入、粘贴剪贴板图片自动附加并插入语法。
- AI 规范：顶部「AI 规范」打开写作规范，「图表重绘规范」标签提供从图片生成 LaTeX 图表的专用规范；附件下拉也提供快捷入口，可一键复制全部或下载 `.md`。
- 选中态、主按钮使用 omm-planner 的黑底白字（深色模式自动反转为白底黑字）；复选框为黑框绿色勾选，不使用橄榄色。
- 元信息表单会直接写回 YAML frontmatter。
- 快捷键：`Ctrl+Enter` 转换，`Ctrl+Shift+V` 校验，`Ctrl+S` 存为 MD，`Esc` 关闭浮层。

---

## 3. Markdown 规范

### 3.1 Frontmatter（必须）

```yaml
---
title: 从文本到版式
subtitle: ——Markdown 驱动的学术出版管线
author: 星野笃敬
abstract: "[目的/意义] 摘要正文……"
keywords: [Markdown, DOCX, LaTeX]
date: 2026-10-21
department: 数字人文实验室
version: v1.0
subject: 自动排版
template: academic
---
```

- `title` 为当前模板的必填字段；其余字段按模板 `metadata.optional` 选用。
- `template` 指定模板名；界面选择和 frontmatter 会双向同步。
- 摘要、关键词会进入 DOCX 的标题下段落，以及 TeX 的标题下段落。
- 目录相关可选字段：`toc`、`toc_title`、`toc_levels`、`toc_include_references`，详见 3.2。

### 3.2 目录与定制

```yaml
toc: true                 # 是否生成目录；DOCX 默认 true，TeX 默认 false
toc_title: 目录           # 目录标题
toc_levels: 2             # 1–3 级标题
toc_include_references: true
```

- 关闭目录：`toc: false`；也可以在界面「转换选项」中取消勾选。
- DOCX 默认生成目录，使用 Word 目录域 + 静态缓存条目；正文重新编号。
- TeX 默认不生成目录（保持参考版式），勾选后使用 `\tableofcontents`，并可按需加入“参考文献”条目。
- 目录标题、层级与参考文献条目均可在界面中实时调整。
- 不要手写目录；手工目录不会获得正确页码。

### 3.3 支持语法

| Markdown | DOCX | TeX |
|---|---|---|
| `#` ~ `####` | Heading 1 ~ 4（无编号） | section / subsection / subsubsection / paragraph |
| 段落 | ZEN Body，首行缩进 2 字 | 正文五号，首行缩进 2em |
| `**粗**` `*斜*` `~~删~~` | Run 级 bold / italic / strike | textbf / textit / sout |
| 行内代码 | Consolas | mdinlinecode（Consolas） |
| 链接 | 下划线超链接，无蓝色 | href，hidelinks |
| 无序 / 有序列表 | 最多 3 级，缩进悬挂 | 递归 itemize / enumerate |
| 围栏代码块 | 等宽代码段，保留换行 | fancyvrb Verbatim |
| 引用 | Quote 样式 | quote 环境 |
| GFM 表格 | 三线表，首行加粗 | tabularx + booktabs 三线表 |
| 图片 | 等比缩放，居中/左/右对齐 | figure + includegraphics |
| `latex-figure` 围栏 | 使用 fallback 图片 | 原样嵌入 LaTeX 图表代码 |
| `<!-- pagebreak -->` | 分页符 | `\newpage` |
| 水平线 | 下边框空段落 | `\rule` |
| `$...$` | Cambria Math 文本 | 原生数学模式 |
| `$$...$$` | 居中文本 | `\[...\]` |
| `# 参考文献` 段落 | 居中参考文献标题 + 条目 | thebibliography |

### 3.4 图片

```markdown
![管线示意图](images/pipeline.png){width=12cm align=center}
![logo](images/logo.png){width=40%}
```

- 路径相对 Markdown 文件所在目录；网页端上传后按**文件名**与路径匹配。
- 宽度支持 `cm / mm / in / px / %`；TeX 额外支持 `0.8\textwidth`、`0.9\linewidth`。
- 网页端仅接受 PNG / JPG；图片必须独占一个段落。
- 缺省超宽会按模板的 `image.max_width_cm` 等比缩放。

### 3.5 版式微调

版式不写进 Markdown。模板给出默认版式，网页端「格式」标签在此基础上微调：

- 页边距：上、下、左、右（cm）。
- 正文：中文字体（宋体/仿宋/黑体/楷体）、字号（pt）、行距、首行缩进（字符）。
- 标题：标题中文字体、文档标题 / 一级 / 二级 / 三级标题字号（pt）。

微调配置按 `格式:模板` 自动保存在浏览器 Local Storage，修改立即应用到预览与下一次转换。配置区提供：

- **另存为**：下载 `mdforge-format-<format>-<template>.json`。
- **导入**：读取上述 JSON（也接受只含 `margins/body/fonts/headings` 的裸对象），应用到当前格式与模板。
- **恢复模板**：删除当前模板的本地微调，回到模板默认值。

API 与 CLI 使用同一套结构，见第 5、6 节。

### 3.6 表格题注

在表格前放置一条 HTML 注释：

```markdown
<!-- caption: 各阶段主题挖掘结果 -->
| 阶段 | 主题 |
| --- | --- |
| 发酵期 | Topic-1 |
```

图题使用图片的 `alt` 或 `<!-- caption: ... -->`。DOCX 和 TeX 都会自动编号：`表 1　…` / `图 1　…`。

### 3.7 LaTeX 原生图表

如果希望 TeX 输出像参考文件一样由 LaTeX 绘制图表，可使用 `latex-figure` 围栏：

````markdown
```latex-figure fallback="images/chart.png"
\begin{figure}[htbp]\centering
\begin{tikzpicture}
\begin{axis}[cixi,width=8cm,height=5cm]
\addplot coordinates {(1,2) (2,3) (3,4)};
\end{axis}
\end{tikzpicture}
\caption{图表题注}
\end{figure}
```
````

- 代码会原样插入 TeX；可给完整 `figure` 环境，也可只给内部 `tikzpicture` / `pgfplots` 代码（平台自动补 `figure` 与题注）。
- `fallback` 是 DOCX 输出和网页预览回退图，建议提供本地 PNG/JPG。
- 模板已加载 `pgfplots`、`tikz`、`arrows.meta`、`calc`、`positioning`、`backgrounds`，并带有参考文件的 `cA`–`cJ` 配色与 `cixi` 坐标轴样式。
- 网页端在附件列表中点击「LaTeX」即可把已有图片替换成该围栏，原图保留为 fallback。
- 普通图片继续使用 PNG/JPG；LaTeX 代码仅用于 TeX 输出。

### 3.8 不支持的语法

HTML 块、脚注、任务列表、嵌套引用、嵌套表格会被忽略或降级并给出带行号的告警。`严格模式` 会把任一告警视为失败；普通模式只阻止错误级问题（例如缺标题、缺图片）。

---

## 4. 参考版式

### 4.1 DOCX

严格对照 `格式模板参考.docx`（下为模板默认值，可在「格式」标签微调）：

- A4，上下 2.54cm，左右 3.175cm。
- 正文五号（10.5pt）宋体 / Times New Roman，1.5 倍行距，首行缩进 2 字。
- 标题页：15pt 黑体居中；副标题同字号。
- 摘要、关键词：10.5pt，标签黑体，正文宋体。
- 一级标题：12pt 黑体；二级及以下：10.5pt 加粗；全部不编号。
- 目录页：`目录` 15pt 黑体，条目 10.5pt 宋体，点线引导；正文从第 1 页重新编号。
- 目录以 Word 域包裹，并设置 `updateFields=true`；Word 打开时会提示更新目录，静态页码为估算值。
- 参考文献标题居中加粗，条目另起一页。
- 页脚为空，与参考文件一致。
- 表格三线表；图题居中。

模板文件只读加载，不会在转换时被修改。

### 4.2 TeX

严格对照 `格式模板参考.tex`（下为模板默认值，可在「格式」标签微调）：

- `ctex` + `article`，XeLaTeX。
- 全文字体 FangSong（AutoFakeBold=2.0）；正文 10.5pt / 13.1pt。
- 页边距左右 3.18cm、上下 2.54cm。
- 标题 16pt 粗体居中；一级标题 16pt 粗体、二级标题 10.5pt 粗体，均不编号、左对齐。
- 图题 `图N`、表题 `表N`，标签加粗，条目 10.5pt。
- 参考文献使用 `thebibliography`，标题为「参考文献」。
- 默认不生成目录（与参考 TeX 一致）；可在目录选项中开启 `\tableofcontents`，并自定义标题、层级和参考文献条目。
- 导言区加载 `pgfplots` / `tikz` 及参考配色与 `cixi` 样式，支持 `latex-figure` 原生图表。
- 表格 `tabularx` + `booktabs`，表题在上；图片复制到输出目录的 `<stem>-assets/images/`，并可随 TeX 一起打包为 ZIP。

---

## 5. CLI

```bash
# 校验
.venv/Scripts/python.exe -m mdforge.cli validate examples/sample.md -t academic

# DOCX
.venv/Scripts/python.exe -m mdforge.cli convert examples/sample.md -t academic -o out.docx

# TeX + PDF
.venv/Scripts/python.exe -m mdforge.cli convert examples/sample.md -t academic -o out.tex --pdf

# 套用格式微调 JSON
.venv/Scripts/python.exe -m mdforge.cli convert examples/sample.md -t academic -o out.docx --format-config mdforge-format-docx-academic.json

# 列表 / 查看模板
.venv/Scripts/python.exe -m mdforge.cli templates list
.venv/Scripts/python.exe -m mdforge.cli templates show academic --format tex

# 编辑已有 DOCX 元信息
.venv/Scripts/python.exe -m mdforge.cli meta out.docx --set title="新标题" --set author="李四"

# 编辑已有 TeX 元信息（PDF 属性）
.venv/Scripts/python.exe -m mdforge.cli meta out.tex --set title="新标题" -t academic

# 查看 MiKTeX
.venv/Scripts/python.exe -m mdforge.cli env
```

Python API：

```python
from mdforge import convert_file, compile_tex, edit_metadata

result = convert_file("examples/sample.md", output="out.tex", template="academic", compile_pdf=True)
pdf = result["pdf"]

tuning = {
    "margins": {"top": 2.54, "bottom": 2.54, "left": 3.18, "right": 3.18},
    "body": {"font_size": 12, "line_spacing": 1.4, "first_line_indent": 2, "font": "fangsong"},
    "fonts": {"heading": "heiti"},
    "headings": {"title_size": 18, "h1_size": 16, "h2_size": 12, "h3_size": 10.5},
}
convert_file("examples/sample.md", output="out-tuned.docx", template="academic", tuning=tuning)

edit_metadata("out.docx", {"title": "新标题", "author": "李四"})
```

---

## 6. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/env` | Python、MiKTeX、引擎、模板 |
| GET | `/api/templates?format=docx` | 模板列表 |
| GET | `/api/templates/<format>/<name>` | 模板详情 |
| GET | `/api/sample` | 示例 Markdown |
| GET | `/api/md-spec` | 给 AI 的完整 Markdown 规范 |
| GET | `/api/figure-spec` | 给 AI 的图片重绘 LaTeX 图表规范 |
| POST | `/api/parse` | `{markdown, format, template}` → metadata、预览 HTML、统计、告警 |
| POST | `/api/validate` | 结构与模板校验 |
| POST | `/api/convert` | JSON 或 multipart；fields：`markdown`、`filename`、`format`、`template`、`strict`、`compile_pdf`、`images[]`、`format_overrides`（JSON 字符串或对象，格式微调） |
| GET | `/api/download/<job_id>/<kind>` | `docx` / `tex` / `pdf` / `source` / `bundle`（TeX 素材 ZIP） |
| POST | `/api/meta` | multipart：上传 DOCX/TEX，`metadata` JSON + `header_placeholders` JSON |
| POST | `/api/jobs/<job_id>/meta` | 编辑已生成文件的元信息；TeX 可传 `recompile: true` |

转换返回：下载地址、PDF 地址（若编译成功）、统计、目录、告警、TeX 源码、MiKTeX 日志。

---

## 7. 目录结构

```text
public/
├── omm-mdforge.html              # OMM-ZEN 风格前端（根目录，与 omm-*.html 一致）
├── mdforge_serve.py              # Flask 启动器
├── pyproject.toml
├── requirements-mdforge.txt
├── README.md
├── .gitignore
├── examples/
│   ├── sample.md                 # 覆盖全部语法的示例
│   └── images/pipeline.png
└── mdforge/
    ├── __init__.py
    ├── server.py                 # Flask API / 任务与下载
    ├── cli.py                    # convert / validate / templates / meta
    ├── convert.py                # 高层转换入口
    ├── tuning.py                 # 格式微调默认值、校验与字体映射
    ├── parser.py                 # Markdown → 语义树
    ├── docx_renderer.py          # DOCX 渲染
    ├── docx_template.py          # 生成内置 DOCX 模板
    ├── tex_renderer.py           # TeX 渲染
    ├── compiler.py               # MiKTeX / latexmk
    ├── docx_utils.py             # run 级占位符与域
    ├── metadata.py               # 核心属性、页眉页脚、TeX PDF 属性
    ├── preview.py                # 网页预览、统计、目录
    ├── validate.py               # 结构 / 图片 / 模板校验
    ├── errors.py
    ├── docs/
    │   ├── AI_MD_SPEC.md         # 给 AI 的完整 Markdown 规范
    │   └── AI_LATEX_FIGURE_SPEC.md # 给 AI 的图表重绘规范
    ├── templates/
    │   ├── docx/academic/template.docx
    │   ├── docx/academic/template.yaml
    │   ├── tex/academic/template.tex.j2
    │   └── tex/academic/template.yaml
    └── tests/
        ├── test_parser.py
        ├── test_docx_render.py
        ├── test_tex_render.py
        ├── test_metadata.py
        └── test_api.py
```

`.venv/`、构建产物、运行日志、`mdforge-jobs/` 与两份 `格式模板参考.*` 原件不进入版本控制；模板已稳定落在 `mdforge/templates/` 中。

---

## 8. 给 AI 的 Markdown 规范

平台对 MD 有明确的结构约束。给上游 AI 使用的完整规范位于：

- 文件：[`mdforge/docs/AI_MD_SPEC.md`](mdforge/docs/AI_MD_SPEC.md)
- 网页入口：顶部菜单「AI 规范」→ 复制全部 / 下载 `.md`
- 接口：`GET /api/md-spec`

规范分为两部分：

- **Markdown 写作规范**：frontmatter、H1–H4、行内格式、列表、代码块、公式、图片、表格、分页、参考文献；并明确版式微调与目录由平台控制，不写入 Markdown；
- **图表重绘规范**：把图片交给 AI，要求其输出可粘贴的 TikZ / pgfplots `latex-figure` 代码，包含配色、尺寸、图例、数据读图和自检清单；说明图表不受格式微调影响，宽度使用相对值。

两份规范都包含可直接粘贴给 AI 的系统提示词。核心 Markdown 要求是：

1. AI 只输出 Markdown 纯文本，不要解释，不要用代码围栏包裹全文。
2. 必须以 YAML frontmatter 开头，包含 `title` 与 `template: academic`。
3. 标题、作者、摘要、关键词只放在 frontmatter；正文不要重复。
4. 图片独占段落，路径使用 `images/...`；表格不超过 6 列；标题不超过 H4。
5. 文末用一次 `# 参考文献` 结尾，之后不再写内容。
6. 不要手写目录；目录由 `toc` 字段或界面控制；不使用封面、页码、脚注、任务列表、HTML 块、嵌套引用、嵌套表格、远程图片。

转换前可点「校验」查看全部告警；严格模式下任一降级都会中止。

## 9. 新增模板

在 `mdforge/templates/docx/<name>/` 或 `mdforge/templates/tex/<name>/` 增加目录，页面会自动列出。

### DOCX 模板

- 必须包含 `template.docx` 与 `template.yaml`。
- `template.docx` 内需要样式：`Heading 1~4`、`ZEN Body`、`ZEN Title`、`ZEN Abstract`、`ZEN Keywords`、`ZEN Code`、`ZEN Quote`、`ZEN Caption`、`ZEN Table Text`、`ZEN Image`、`ZEN Math`、`ZEN Reference`、`ZEN Reference Title` 等，或通过 YAML `styles` 映射到你自己的英文样式名。
- 必须有一个独立的 `{{CONTENT}}` 段落作为锚点；目录锚点为 `{{TOC}}`。
- 版式集中放在样式里；渲染器只在「格式」微调时覆盖正文/标题字号、行距、缩进、中文字体与页边距。`template.yaml` 的 `tuning:` 块定义该模板的默认微调值，界面会据此初始化。
- 模板可重建：

```bash
.venv/Scripts/python.exe -m mdforge.docx_template
```

### TeX 模板

- 必须包含 `template.tex.j2` 与 `template.yaml`。
- Jinja2 使用 `autoescape=False`；正文变量 `{{ body }}`，参考文献 `{{ bibliography }}`。
- 可用变量：`title_tex`、`subtitle_tex`、`abstract_tex`、`keywords_tex`、`author_tex`、`subject_tex`；目录 `toc_enabled`、`toc_title_tex`、`toc_levels`、`toc_include_references`；格式微调 `margin_top/bottom/left/right`、`body_size`、`body_line`、`par_indent`、`body_font_tex`、`heading_font_tex`、`title_size/title_line`、`h1_size/h1_line`、`h2_size/h2_line`、`h3_size/h3_line`。
- 图、表、公式、列表由渲染器输出完整环境，模板只需配置导言区。
- `template.yaml` 的 `tuning:` 块提供该模板的默认页边距、字体与字号，界面可在此基线上微调。
- 引擎建议 `xelatex`（中文）。

---

## 10. 测试

```bash
.venv/Scripts/python.exe -m pytest mdforge/tests -q
```

测试覆盖：解析、嵌套列表、图片属性、公式、参考文献、DOCX 结构、样式、目录域、页边距、分页、格式微调、TeX 源码、真实 MiKTeX 编译、跨 run 占位符、元信息、API、前端禁用色契约。

当前结果：**47 passed**。

---

## 11. 已知边界

- DOCX 中的数学公式是 Cambria Math 文本，不是 OMML 原生公式；需要原生公式时请使用 TeX 输出。
- DOCX 目录页使用 Word 域 + 静态缓存条目；首次打开请允许 Word 更新域，以获得准确页码。
- 网页端图片按文件名匹配 Markdown 路径，仅支持 PNG/JPG；绝对路径与 `..` 越界路径会被校验器拒绝。
- 服务为本地开发服务；不要直接暴露到公网。启动器会检测端口占用，避免多个实例同时监听。
- `pip install` 适合使用 CLI 与库；Web 界面、示例和 `mdforge_serve.py` 仍从仓库目录运行。
- UI 对齐 omm-planner 的黑白体系，不使用蓝色与橄榄色；导出的文档使用标准黑色印刷色。
- 生成文件的「编辑元信息」只修改 DOCX 核心属性或 TeX/PDF 属性，不改变正文标题；TeX 需要重新编译后新 PDF 才会同步。
