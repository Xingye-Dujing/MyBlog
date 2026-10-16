# 一页提示词 · 复制即用

> 用法：找到目标项目，**整段复制**下面对应的 ```text 代码块发给 AI，并补上你的需求（例如「做一张 6 节点的阅读脑图」「导入 30 条备考语料」）。
> 每段都是**自包含**的：含硬性门槛、字段骨架和一个最小合法示例，AI 不需要再读完整规范就能产出可导入文件。
> 交付物一律 **UTF-8、合法、无注释、无尾逗号、无 markdown 代码围栏**（LaTeX 项是 `.tex` 纯文本）。

索引：[Writer 画布](#writer) · [Annotate 批注](#annotate) · [Corpus 语料](#corpus) · [Data 数据](#data) · [English 词库](#english) · [Planner 计划](#planner) · [Visualization 属性](#visualization) · [Latex 文档](#latex) · [Redact/Message 说明](#不适用)

---

<a id="writer"></a>
## Writer（omm-writer.html · ZenWriter · `.zc` 画布）

```text
你要生成一个 ZenWriter 画布文件（.zc，JSON，UTF-8），导入后只显示 JSON 本身，不要代码围栏/注释/尾逗号。

顶层：{ "format":"zenwriter-canvas", "v":2, "name":"画布名", "nodes":[...], "connections":[...] }
硬性：nodes 必须是数组（唯一硬要求）。每个节点必须有唯一 "id"（格式 node-数字，纯数字后缀，绝不重复）和 "type"。

type 取值：text / todo / group / markdown / math / image。
坐标 x、y 是世界像素，推荐 x∈[-1500,1500]、y∈[-1000,1000]，且 x、y 绝不能等于 0（0 会被当缺省变 100）。
"w"/"h" 若写必须带 px（如 "320px"）；不写就省略让引擎自动。
连线每条 {from,to,fromPort?,toPort?}：from/to 必须是真实存在的节点 id 且不相等；端口取 top/bottom/left/right。

正文规则：
- text/todo/group 的 "content" 是 HTML 片段，文本里 & < > 要转义成 &amp; &lt; &gt;；换行用 <p> 或 <br>。
- todo 勾选态：内容里用 <s>已完成</s> 会自动打勾。
- group 没有 children 字段：成员完全靠连线；"collapsed":true 会隐藏与之相连的节点。
- markdown 的 "source" 只支持：1-3 级标题、- 或 * 无序列表、1. 有序列表、> 引用、``` 代码块、行内 **粗** *斜* `码` [文字](链接)。不要用表格/图片/任务列表/4 级以上标题/嵌套。
- math 的 "source" 只写 LaTeX 本体、不带 $ 或 \(；JSON 里反斜杠写成 \\。
- image 只用 "srcMode":"url" + 一个 https 地址（或完整 data: URL）；绝对不要 "link" 模式、不写 assetId、不写 blob:。

最小示例（照此结构）：
{
  "format":"zenwriter-canvas","v":2,"name":"最小示例",
  "nodes":[
    {"id":"node-1","type":"text","x":-400,"y":-160,"w":"320px","title":"起点","content":"<p>随便写点什么。</p>"},
    {"id":"node-2","type":"text","x":80,"y":-160,"w":"320px","title":"终点","content":"<p>第二个节点。</p>"}
  ],
  "connections":[{"from":"node-1","to":"node-2","fromPort":"right","toPort":"left"}]
}
输出前自查：顶层有 nodes、每个节点有合法 type、id 唯一且 node-数字、连线两端存在且不等、x/y 非 0、w/h 带 px、HTML 已转义、图片非 link/blob。
```

---

<a id="annotate"></a>
## Annotate（omm-annotate.html · ZenMark · `.json` 项目备份，整体替换）

```text
你要生成一个 ZenMark 项目备份文件（.json，UTF-8），走「导入 → 项目备份」路径（会替换当前全部数据）。只输出 JSON，不要代码围栏/注释/尾逗号。

顶层：{ "app":"zenmark","version":1,"exportedAt":"YYYY-MM-DD HH:mm","project":{ ... } }
硬性：project 里必须有 "codes" 数组（可空），否则判坏文件。project 七个数组：docs / codes / anns / rels / memos / marks / notes，按需给、缺省即空。

- codes[]：每个 code 需唯一 "id"（c+字母数字）、"level"（open|axial|selective）、"color"（只能用这 12 个十六进制之一：#e0913b 等系统色板值，写别的会被改色）。其余 no/name/parent/def/incl/excl/eg/memo 可选。
- docs[]：每个 doc 需唯一 "id"（d+字母数字）和 "text" 正文字符串；"kind" 一律写 "text"，绝不要写 "pdf"（PDF 版面在 IndexedDB，JSON 带不走）。
- anns[]：语义编码，按 "doc" 与 "code"（都必须是真实 id）；"start"/"end" 是字符下标、必须落在 doc.text 内，且 "quote" 严格等于 doc.text.slice(start,end)；"status" 取 done|review。
- marks[]：阅读批注，同样用 start/end 定位 doc.text；"sty" 取 note|hl|ul|st|code。
- memos[]/notes[]/rels[]：可选；引用类字段（memo.codes[]、rel.a/rel.b、note.doc）必须指向同文件真实 id。
- 时间字段 "ts" 一律用 "YYYY-MM-DD HH:mm" 字符串，不要 epoch 毫秒。不要生成 settings、不要 blob:/data: 版面。

最小示例（照此结构；注意 quote=doc.text.slice(9,27)）：
{
  "app":"zenmark","version":1,"exportedAt":"2026-09-27 12:00",
  "project":{
    "title":"最小示例","desc":"",
    "docs":[{"id":"dmin0001","title":"示例材料","source":"","type":"其他","date":"","note":"","text":"这是一段示例文本。算法连续给我推了三条同一个事件的视频，情绪一次比一次强烈。","kind":"text"}],
    "codes":[{"id":"cmin0001","no":"01","name":"情感动员","level":"open","parent":"","def":"诉诸情绪的表达方式。","incl":"","excl":"","eg":"","color":"#e0913b","memo":""}],
    "anns":[{"id":"amin0001","doc":"dmin0001","start":9,"end":27,"quote":"算法连续给我推了三条同一个事件的视频","code":"cmin0001","memo":"","status":"done","ts":"2026-09-27 12:00"}],
    "rels":[],"memos":[],"marks":[],"notes":[]
  }
}
自查：project.codes 是数组；所有 id 唯一；每个 quote==doc.text.slice(start,end)；每个 code.color 在 12 色板内；kind 全为 text；引用字段都指向存在的 id。
```

---

<a id="corpus"></a>
## Corpus（omm-corpus.html · ZenCorpus · `.json`「从 JSON 恢复」，整体替换）

```text
你要生成一个 ZenCorpus 语料库文件（JSON，UTF-8），走「从 JSON 恢复」导入。只输出 JSON，不要代码围栏/注释/尾逗号。

顶层必须同时有 "entries"(数组) 和 "categories"(数组)——这是唯一硬校验，缺任一直接失败；建议再加 "version":2。
恢复是整体替换：你要的全部写进 entries，内置语料不会自动保留。
settings/stats/conversations 可整体省略（用默认）；apiKey 除非明确要求否则留空串。

- categories[]：{ "id", "name", "desc"(可选) }。
- entries[]：每条必须有非空 "en"（核心）；"id" 全局唯一；"categoryId" 指向 categories 里真实 id；"type" 只能 sentence|template|collocation|paragraph；"tags" 是字符串数组；"favorite" 布尔；"source"/"notes"/"zh" 字符串；"createdAt"/"updatedAt" 用 ISO 8601（如 2026-01-01T00:00:00.000Z）。

最小示例（照此结构）：
{
  "version":2,
  "categories":[{"id":"study","name":"学习","desc":"学习、成长、能力提升"}],
  "entries":[{"id":"ex-1","type":"sentence","categoryId":"study",
    "en":"Practice deliberately today so that the exam feels familiar tomorrow.",
    "zh":"今天刻意练习，考场才会觉得熟悉。","tags":["备考","方法"],
    "source":"示例","notes":"演示最小可用格式。","favorite":false,
    "createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]
}
自查：顶层有 entries+categories 两数组；每条 entry 的 en 非空；type 在四值内；categoryId 都指向存在分类；id 唯一。
```

---

<a id="data"></a>
## Data（omm-data.html · ZenData · `.json` 数据集，「从文件/从文本导入」）

```text
你要生成一个 ZenData 可导入的数据文件（.json，纯 JSON，UTF-8），走「从文件导入 / 从文本导入」。只输出 JSON，不要代码围栏/注释/尾逗号。

顶层是「表数据」，二选一：
(a) 对象数组：[ {"列名":值, ...}, ... ]（最推荐，键即列名）；
(b) 数组的数组：[ [v, v, ...], ... ]（无表头，列名自动 A、B、C…）。
绝不输出 { "tables":[...] } 那种整工作区外壳——文件导入不认它。
每行长度可不齐，缺失单元格写 null（空串 "" 也算空）。
数字就是 JSON 数字；布尔 true/false；日期写 "YYYY-MM-DD" 字符串；其余字符串。列类型由引擎自动推断，数据文件里无法指定列类型。嵌套对象/数组会原样存、按纯文本显示——尽量摊平成多列。

最小示例（照此结构）：
[
  { "id":1, "name":"陈默", "dept":"编辑部", "score":92, "joined":"2021-03-14" },
  { "id":2, "name":"林知白", "dept":"设计部", "score":78, "joined":"2020-07-02" }
]
自查：顶层是数组或 {rows}；没有 {tables} 外壳；空位用 null；简述哪几列会被判 number/date/bool/text。
```

---

<a id="english"></a>
## English（omm-english.html · Zenglish · `.json`，先选类型）

```text
你要生成 Zenglish 的可导入 JSON（UTF-8）。先确认类型（A/B/C/D），只输出 JSON，不要代码围栏/注释/尾逗号。

【A 词库】走「导入词库」。顶层是数组（或 {"words":[...]}）。每元素：
  对象 { "w":"单词","ph":"音标","m":"释义","ex":"例句" }（只有这 4 字段有用），或二元以上数组 ["单词","音标","释义","例句"]。w 为空则丢弃。永远新建一本词书。
【B 涂鸦】走「导入涂鸦」。顶层 {"drawings": { "小写单词": { "strokes":[...] } }}。每笔 { "color":"#rrggbb","width":4,"erase":false,"points":[{"x":100,"y":100,"p":0.7}, ...] }。画布 1200×800；x∈[0,1200]、y∈[0,800]、p∈[0.15,1]。key 必须是当前词书里已存在的单词（小写）→ 所以先导 A 再导 B。
【C 备份】走「恢复备份」，整体覆盖。顶层必须同时有 "books" 和 "prog" 两对象（缺任一判非法）。books 里自定义词书 { "id":"u…","name":"…","builtin":false,"w":[[词,音标,释义,例句,例句译], ...] }（内置 cet6 的 w 可 null）；prog 每词 { "b":0,"due":毫秒,"seen":0,"ok":0,"bad":0,"fuzzy":0,"star":false }，key 小写。
【D 互通包】顶层 {"omm":"bridge","v":1,"items":[...]}。item 有 "t"：词 {t:"word",w,ph,m,ex,exZh,note,tags,src}；句 {t:"sentence",en,zh}；文 {t:"doc",title,text}。

最小示例（A，照此结构）：
[
  { "w":"abandon","ph":"əˈbændən","m":"vt. 放弃，抛弃","ex":"He abandoned the plan." },
  ["ability","əˈbɪləti","n. 能力，才能","She has the ability to solve hard problems."]
]
自查：说明用的是 A/B/C/D 哪种；A 的 w 非空；C 同时有 books+prog；B 的 drawings key 已存在于词书。
```

---

<a id="planner"></a>
## Planner（omm-planner.html · ZenPlan · `.json` 整册备份，追加去重）

```text
你要生成一个 ZenPlan 计划本导入文件（JSON，UTF-8），走「导入」（永远追加 + 按 id 去重，绝不覆盖）。只输出 JSON，不要代码围栏/注释/尾逗号。

默认用整册外壳：
{ "app":"zenplan","version":2,"exportedAt":"<ISO 时间>",
  "planners":[{"id":"p1","name":"计划"}],"activeId":"p1",
  "eventsBy":{ "<plannerId>":{ "YYYY-MM-DD":[事件...] } },
  "recursBy":{ "<plannerId>":[规则...] } }
硬性：version 必须是数字 2（不是 "2"、不是 2.0）且 planners 是数组，否则不走整册分支；eventsBy/recursBy 的键必须是 planners 里出现过的 id，否则数据被忽略。

- 事件：必须有唯一字符串 "id" 和非空 "title"；日期键必须 YYYY-MM-DD（否则丢弃）。"type" 只能 todo|event|note；"priority" 只能 high|mid|low；"color" 只能那 5 个十六进制色值之一（其它改 #888888）；"time" 要么空串、要么 HH:MM（两位小时两位分钟）；created/order 是毫秒数字；done 取 true|false|"failed"。
- 规则：必须有 "title"；rrule.mode 只能 daily|weekly|monthly|yearly|dates；rrule.start/end 是 YYYY-MM-DD 或空串；mode=dates 时把具体日期放进 rrule.dates 数组。

最小示例（照此结构）：
{
  "app":"zenplan","version":2,"exportedAt":"2026-01-05T00:00:00.000Z",
  "planners":[{"id":"p1","name":"计划"}],"activeId":"p1",
  "eventsBy":{"p1":{"2026-01-05":[{"id":"e1","type":"todo","title":"买牛奶"}]}},
  "recursBy":{}
}
自查：version=数字 2；planners 是数组；eventsBy/recursBy 键在 planners 内；每事件有 id+title；日期键 YYYY-MM-DD；type/priority/color/time 全在合法取值内。
```

---

<a id="visualization"></a>
## Visualization（omm-visualization.html · ZenViz · `.json` 右侧属性设置；数据另走 CSV）

```text
你要生成一个 ZENVIZ 右侧属性设置文件（.json，UTF-8），走「导入右侧属性设置」。只输出 JSON，不要代码围栏/注释/尾逗号。
注意：图表「数据」不走 JSON，走 CSV/TSV/XLSX（表头列名按图型角色排：分类列/数值列/来源去向权重等）。本文件只设外观与图参。

顶层硬性：{ "kind":"zenviz-right-properties","version":1,"engines":{...} }，kind 与 version 一字不差，version 必须是数字 1。
engines 的键只能取 echarts / chartjs / apexcharts / zen。每个引擎里写 "typeStates" 和 "chartProps" 两个子对象，键是图表类型 id（如 line/bar/pie…）。
- typeStates[type]：只写白名单字段（palette/title/showLegend/width/height 等）；布尔必须 true/false、数值必须有限数字、字符串必须字符串；palette 只能 mono|culture|science|editorial。
- chartProps[type]：只写该类型已知字段，类型与默认值一致。缺字段没事（自动补默认），写错类型会整条丢弃退回默认——宁可少写别写错。

最小示例（照此结构）：
{
  "kind":"zenviz-right-properties","version":1,
  "engines":{"echarts":{
    "typeStates":{"line":{"palette":"science","title":"季度趋势","showLegend":true,"width":1200,"height":700}},
    "chartProps":{"line":{"lineWidth":3,"smooth":true,"showPoints":false}}
  }}
}
自查：kind/version 正确；engine id 在 4 个内；每个字段类型与默认同型；数据列另用 CSV 给，不放这个文件里。
```

---

<a id="latex"></a>
## Latex（omm-latex.html · ZenLatex · `.tex`，不是 JSON）

```text
你要生成一个可直接「导入 .tex」并一次编译通过的 LaTeX 文档（纯文本 .tex，UTF-8），只输出 .tex 内容本身。

单文件：一份从 \documentclass 到 \end{document} 的完整文档。绝对不要用 \input / \include / \bibliography{external} / 本机相对路径图片（会报 file not found）；参考文献用 thebibliography 内联；图用 TikZ/pgfplots 现画，或公网 https 图床 URL。
文档类：中文用 ctexart（配 XeLaTeX 默认引擎），英文用 article。公式行内 $…$、独立 $$…$$ 或 \[…\]，成对闭合。表格 tabular 列数与 &/\\ 数量一致，建议 booktabs。

最小骨架（照此结构，只替换内容）：
\documentclass[11pt,a4paper]{ctexart}
\usepackage{geometry}\geometry{left=2.6cm,right=2.6cm,top=2.8cm,bottom=2.8cm}
\usepackage{amsmath,amssymb}\usepackage{booktabs}\usepackage{tikz}\usepackage{pgfplots}\pgfplotsset{compat=1.18}
\usepackage[hidelinks]{hyperref}
\title{文档标题}\author{作者}\date{\today}
\begin{document}
\maketitle
\begin{abstract}{这里是摘要。所有正文写在本文件内。}\end{abstract}
\section{引言}
第一段。行内 $E=mc^2$，独立 \[ \int_0^\infty e^{-x^2}\,dx=\frac{\sqrt{\pi}}{2} \]
\section{结论}
这里是结论。
\begin{thebibliography}{9}
\bibitem{r1} 作者. 书名. 出版社, 年份.
\end{thebibliography}
\end{document}
自查：无 \input/\include/\bibliography{}；无本机图片路径；公式环境成对；中文用 ctexart。
```

---

<a id="不适用"></a>
## Redact / Message（无法生成导入文件）

- **ZenRedact（omm-redact.html）**：没有 JSON 文件导入，导入白名单只有 `txt/docx/pdf/pptx` + 图片，`.json` 直接拒绝。无法让 AI 生成导入文件。详见 `redact.md`（仅数据模型参考）。
- **ZenMessage（omm-message.html）**：Supabase 云端消息，无任何文件导入接口；消息 `payload` 用本地口令派生密钥加密，AI 无法伪造。不可生成导入文件。详见 `message.md`。
