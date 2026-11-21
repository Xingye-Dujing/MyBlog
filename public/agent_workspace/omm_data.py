# -*- coding: utf-8 -*-
"""OMM-ZEN（静书房）产品知识库 —— AI 工作区的领域事实来源。

这里不是产品简介的罗列，而是给 AI Agent 使用的“可执行知识”：每个产品都包含
用途、工作流、数据落点、导入导出格式、已有 AI 能力、跨产品通道、最佳实践与
常见坑。上下文构建器、领域工具、每个产品的 skill 都从这里取数，保证三处一致。

新增/升级产品时只需要维护这里的条目和 ``omm_knowledge/`` 下的规范文档。
"""
from __future__ import annotations

from typing import Any, Dict, List

VERSION = '1.0.0'

#: 静书房（工作台）本身，不是 BUILTIN_PLUGINS 中的产品，但 AI 需要知道它。
HUB: Dict[str, Any] = {
    'id': 'hub',
    'name': '静书房',
    'glyph': '静',
    'purpose': 'OMM-ZEN 工作台外壳：插件管理、标签与分屏、Dock、全局搜索、时间线、共享空间与全产品统一的 AI 服务配置。',
    'port': 8300,
    'entry': 'omm-hub.html',
    'runtime': 'framework',
    'order': 0,
    'channels': ['documents', 'notes.english', 'data.tables'],
    'features': [
        '顶部标签页与左右/上下分屏、布局预设、命名工作区、标签休眠与状态恢复。',
        'Ctrl+K 命令面板、Ctrl+Shift+F 跨产品全文搜索、Ctrl+Shift+N 通知、最近动态时间线。',
        '插件面板：在线安装/更新/卸载、导入本地 zip、查看详情与版本回滚。',
        '设置 → AI 服务（全产品共用）：服务商 / Base URL / 模型 / API Key / 系统提示词。',
        '外观（圆角、强调色、动效、字号、高对比度）、静心专注模式、全量备份与恢复。',
        '存档与跨产品共享：保存目录、快照、共享目录、连接规则（用户最终授权）。',
    ],
    'storage': [
        'localStorage：omm.hub.appearance.v1 / pins.v1 / recent.v1 / workspaces.v1 / usage.v1 / screen-layout.v1.<id>。',
        '磁盘：%LOCALAPPDATA%/OMM-ZEN/shared.json 的 ai 段保存统一 AI 配置（密钥不随设置备份导出）。',
        '磁盘：share/（index.json、policy.json、files/、records/、inbox/）与 snapshots/<产品>/。',
    ],
    'formats': [
        'AI 配置：{provider, apiBase, apiModel, apiKey, system}，通过 OMMDesktop.aiConfig()/setAIConfig() 读写。',
        '设置备份：settings-only JSON；全量备份：schema 2 / kind omm-zen-full-backup 的 base64 ZIP。',
    ],
    'ai': '统一 AI 配置中心。AI 工作区插件通过 OMMDesktop.aiConfig() 继承配置，密钥只在请求期间留在内存。',
    'best_practices': [
        '先确认用户已在“设置 → AI 服务”配置密钥；密钥不得出现在任何生成文件、对话导出或备份里。',
        '用户说“打开/切到某产品”时，用 OMMShare.openApp(产品id)，不要让用户自己找标签。',
        '跨产品传递内容优先用 ZenCard（format: zen-card），并通过共享频道发送，而不是假设能读别的 origin 的 localStorage。',
        '提到“搜索我的文档”时，用工作台的 /__omm/fs/search 或 AI 工作区的 omm_workspace_status 工具，不要虚构搜索结果。',
        '文档时间线、通知与快照都可以作为复盘材料，但要先读取再引用，禁止编造时间戳。',
    ],
    'pitfalls': [
        '产品页各自独立 origin，localStorage/IndexedDB 互不相通；跨端口通信必须走 OMMShare 共享空间。',
        '导入的第三方插件只能是 static 运行时；AI 工作区是官方内置、带 Python 后端的产品。',
    ],
    'suggested': ['静书房有哪些产品？', '帮我配置统一 AI 服务', '打开语料库并把这张卡片发过去'],
}

PRODUCTS: Dict[str, Dict[str, Any]] = {
    'annotate': {
        'id': 'annotate', 'name': '文本标注', 'glyph': '标', 'purpose': 'PDF / 文本的质性编码与精读批注（ZenMark）。',
        'port': 8311, 'entry': 'omm-annotate.html', 'runtime': 'static', 'order': 10,
        'channels': ['notes.english', 'documents'],
        'features': [
            '导入 PDF（PDF.js）或 .txt/.md 长文逐段编码与阅读批注；CSV 表格按列逐行编码，原文存 IndexedDB，可分页或聚焦模式快速过。',
            '三级编码本：open / axial / selective，建立父子范畴、纳入排除标准与片段关联。',
            '多轮次编码（开放式→轴心式）：新一轮新增记录不覆盖旧轮次，用上级码归并范畴。',
            '编码者信度：导入第二编码者 CSV，算观察一致率 Po、Cohen’s κ 与多编码项 Jaccard，按 Landis & Koch 解释。',
            '典型引文标记与精确定位（PDF 页码 / 表格行号与列名 / 文本段落号与字符区间）。',
            '论文附录导出：方法数据、材料清单、码表、Mermaid 编码树、信度结果、典型引文；也可单独导出引文清单与编码树。',
            '面向 AI 工作区：实时只读快照（window.ZenAnnotateAI）+“互通→发送到 AI 工作区”走共享文档频道。',
        ],
        'storage': [
            'localStorage：zencode.settings.v1、zencode.project.v1（docs/codes/anns/rels/memos/marks/notes/cellCodes/reliability）。',
            'IndexedDB：zenmark-files（PDF 版面 blob；表格原文以 table:<docId> 为键，不随 JSON 备份迁移）。',
            '共享收件箱：omm.bridge.inbox.v1；共享频道 documents 用于把编码摘要发给 AI 工作区。',
        ],
        'formats': [
            '备份：{app:"zenmark",version:1,exportedAt,project:{docs[],codes[],anns[],rels[],memos[],marks[],notes[],cellCodes[],reliability[]}}。',
            'cellCode：{id,table,row,col,code,round,memo,status,star,ts}；table 指向 kind:"table" 的 doc id，row 是 0 基行号。',
            'reliability：{id,ts,source,round,col,stat:{N,po,pe,kappa},disagreements[],...}。',
            'star 布尔字段可出现在 ann / mark / cellCode 上；缺省按 false。',
            '第二编码者校验文本：每行“项目编号,码号编号或名称”（表格用原表行号，文本用片段 ID）。',
            'AI 快照：window.ZenAnnotateAI.snapshot() / snapshotMarkdown()；桥接：{omm:"bridge",...}。',
        ],
        'ai': '页面内无生成式 AI，但有完整 AI 桥：响应工作台 zen-card-request 回传只读编码摘要；window.ZenAnnotateAI 提供结构化/ Markdown 快照；“互通→发送到 AI 工作区”通过共享频道 documents。json-specs/annotate.md 提供生成提示词，omm_validators 校验含新数组的备份。',
        'best_practices': [
            '生成项目备份必须包含 codes[]，这是导入的硬门槛；id 用 c…/d…/a…/rl… 且全局唯一。',
            '所有引用都要指向同一文件内真实存在的 id（含 cellCode.table/code、reliability 中的码号），否则标注会丢失。',
            'quote 必须严格等于 doc.text.slice(start, end)，字符下标不能按字节或按行计算。',
            '系统色只有 12 种，从产品内置色板中取，不要自造颜色值。',
            '导出时间用 "YYYY-MM-DD HH:mm" 字符串，不要用 Unix 时间戳。',
            '只输出 kind:"text" 或 kind:"table" 的文档；PDF 布局与表格原文在 IndexedDB 里，不要伪造 PDF/表格原文数据。',
            '表格编码必须交代 round 与 col，同一行不同轮次是不同记录，不要覆盖。',
            '信度结果应保留 stat.kappa / po / N；κ < .60 时提示用户先修订码号的操作性定义。',
            '典型引文用 star:true 标记；论文附录与 AI 快照只收这些，能显著减少上下文噪声。',
            '向 AI 工作区发送时只给编码摘要（码表+结构+信度+引文），不要把整份访谈原文灌进上下文。',
            '用户想把精读笔记变成卡片时，先整理成 ZenCard 再发送，不要直接写别的产品的 localStorage。',
        ],
        'pitfalls': [
            '备份导入是“替换”语义：导入前提醒用户先导出当前项目。',
            '不要把 PDF 页面布局或表格原文写进 JSON；换设备后需重新导入同名 PDF/CSV 才能恢复版面与原文。',
            '把 kind:"pdf" 或 kind:"table" 写进 JSON 却没有本机文件，阅读/表格视图会提示原文缺失。',
        ],
        'suggested': ['为这份文本生成三级编码本', '生成表格逐行编码的 cellCodes 数组', '根据我的码表出一份论文附录', '把典型引文发给 AI 工作区'],
    },
    'corpus': {
        'id': 'corpus', 'name': '英语语料库', 'glyph': '语', 'purpose': '个人英语表达语料库，带检索增强的 AI 语料助手（ZenCorpus）。',
        'port': 8312, 'entry': 'omm-corpus.html', 'runtime': 'static', 'order': 20,
        'channels': ['notes.english'],
        'features': [
            '分类与词条管理：sentence / template / collocation / paragraph，支持收藏与标签。',
            '全文与本地语义检索，AI 命中会提升排序。',
            'AI 语料助手：自动检索相关个人表达作为 CONTEXT，可预览/手动挑选发送内容。',
            '作文任务构建器：三段式英语作文、词数限制，附中文“语料使用说明”。',
        ],
        'storage': [
            'localStorage：omm-corpus-v1（含 entries/categories/settings/chat/conversations）。',
            'Supabase 云同步配置：omm-corpus-supabase-config-v1、omm-corpus-sync-meta-v1。',
            '共享收件箱：omm.bridge.inbox.v1。',
        ],
        'formats': [
            '恢复 JSON 必须同时有 entries[] 与 categories[]（推荐 version:2）。',
            'entry：{id, en(必填), zh, type, categoryId, tags[], favorite, source, notes, createdAt, updatedAt}。',
            '可带 settings / stats{aiHits} / chat[] / conversations[] / activeConvId / exportedAt。',
        ],
        'ai': '内置 DeepSeek/OpenAI/OpenRouter/智谱/自定义预设；键为空时继承静书房 OMMDesktop.aiConfig()。系统提示词强调“个人语料不是外部来源”。',
        'best_practices': [
            '恢复是“替换”语义：要保留内置词条就必须手动把它们写进 entries。',
            'en 字段非空、categoryId 必须指向已有分类；apiKey 保持空字符串，让密钥留在静书房统一配置里。',
            '为 AI 使用场景生成语料时，优先多样、自然、贴合考试的句式，并给足标签，便于相关性检索。',
            '绝不能告诉 AI 个人语料来自外部网页或权威来源；它是用户自己的表达素材。',
            '用户想练习写作时，用作文任务构建器的格式（三段式 + 词数 + 语料使用说明）。',
            '桥接包导入是“追加”，适合把标注笔记里的句子送进语料库。',
        ],
        'pitfalls': ['不要把 apiKey 写进语料库备份。', '缺少 categories[] 的恢复文件会被拒绝。'],
        'suggested': ['帮我生成 20 条考研英语自然句式', '把这段精读笔记中的好句加入语料库', '用我的语料写一篇 150 词作文'],
    },
    'data': {
        'id': 'data', 'name': '数据工作台', 'glyph': '数', 'purpose': '表格化的数据清洗、查看与导出工作台（ZenData）。',
        'port': 8313, 'entry': 'omm-data.html', 'runtime': 'static', 'order': 30,
        'channels': ['data.tables'],
        'features': [
            '导入 .json/.csv/.tsv 或粘贴文本；网格编辑、撤销、九种对齐与缩放。',
            '自动推断列类型（number/date/bool/text），支持按表设置。',
            '导出表数据；Supabase 云同步。',
        ],
        'storage': [
            'localStorage：zendata.v1.doc（tables + activeId）、zendata.v1.settings、zendata.v1.seed、zendata.v1.rev。',
            'Supabase：zendata-supabase-config-v1、zendata-sync-meta-v1。',
        ],
        'formats': [
            '文件导入：行对象数组 [{"col":value,…}]，或二维数组 [[v,…]]，或 {rows:[…]}。',
            '内部表：{name, headers/rows, columns, settings}。',
            '{tables:[…]} 整库结构只在 localStorage/云同步里存在，不能作为文件导入。',
        ],
        'ai': '无内置 AI；json-specs/data.md 给出导入格式规范，可让 AI 生成干净的表格数据。',
        'best_practices': [
            '生成可导入文件时直接用行对象数组，不要包一层 {tables:[…]}。',
            '嵌套对象要拍平成列，嵌套值以纯文本保存；缺失值用 null。',
            '日期统一 "YYYY-MM-DD"；文件导入阶段无法强制列类型，类型由内容推断。',
            '用户要图表时，把数据按可视化产品的“角色列”模型整理成 CSV，再走共享频道 data.tables。',
            '跨产品发送表格数据应通过 OMMShare 的 data.tables 频道，不要尝试直接读目标产品的存储。',
        ],
        'pitfalls': ['数组里混用对象与数组会导致导入失败。', '不要把浏览器专用字段写进导入文件。'],
        'suggested': ['把这份 CSV 清洗成规范表格', '生成 10 行示例订单数据', '把这个表发给可视化图表'],
    },
    'english': {
        'id': 'english', 'name': '六级备考', 'glyph': '英', 'purpose': 'CET-6 词汇、涂鸦记忆与间隔复习（Zenglish）。',
        'port': 8314, 'entry': 'omm-english.html', 'runtime': 'static', 'order': 40,
        'channels': ['notes.english'],
        'features': [
            '多词库（内置 cet6 + 自定义），按 b/due/seen/ok/bad/fuzzy/star 追踪进度。',
            '在 1200×800 画布上手写单词涂鸦。',
            '导入词库、涂鸦、完整备份或桥接包；Supabase 同步。',
        ],
        'storage': [
            'localStorage：zenglish_v1；同步配置 zenglish-supabase-config-v2 / -v1、zenglish-sync-meta-v2。',
            '共享收件箱：omm.bridge.inbox.v1。',
        ],
        'formats': [
            'A 词库：数组或 {words:[…]}，元素 {w,ph,m,ex} 或 ["word","ph","meaning","example"]。',
            'B 涂鸦：{drawings:{"小写单词":{strokes:[{color,width,erase,points:[{x,y,p}]}]}}}，x∈[0,1200]，y∈[0,800]，p∈[0.15,1]。',
            'C 完整备份：必须同时有 books 与 prog 两个对象（自定义书 id:"u…"）。',
            'D 桥接：{omm:"bridge", v:1, items:[{t:"word"|"sentence"|"doc",…}]}。',
        ],
        'ai': '无内置 AI；json-specs/english.md 给出四类导入的精确骨架，适合让 AI 生成词表。',
        'best_practices': [
            '导入顺序必须是 A 词库 → B 涂鸦；涂鸦的键要小写且对应当前词库中的词。',
            '完整备份同时包含 books 与 prog，否则会被当成其他类型而失败。',
            '词库导入是“追加 + 去重”，不会覆盖原词库；需要替换时先提醒用户。',
            '空 w 的条目会被丢弃；生成例句 ex 时保持简洁、可朗读。',
            '涂鸦坐标与压强要落在合法区间，否则笔画渲染异常。',
            '从语料库/标注送来的句子用桥接包（D 类），不要伪装成完整备份。',
        ],
        'pitfalls': ['不要把涂鸦的键写成大写。', '词库 A 与涂鸦 B 分开导入，不能合并在一个文件里。'],
        'suggested': ['生成 30 个六级高频词', '给这些单词配涂鸦笔画', '把语料库句子里的生词加入词库'],
    },
    'latex': {
        'id': 'latex', 'name': 'LaTeX 编译工作台', 'glyph': 'T', 'purpose': '编写 TeX 并由本地服务实时编译 PDF、预览与排错（ZenLatex）。',
        'port': 8123, 'entry': 'omm-latex.html', 'runtime': 'latex', 'order': 50,
        'channels': ['documents'],
        'features': [
            '内置模板起步；编辑 .tex 后自动/手动编译（xelatex/pdflatex/lualatex，1–3 遍）。',
            'PDF.js 预览、错误日志、导出 PDF/PNG；可指定 MiKTeX 路径。',
        ],
        'storage': [
            'localStorage 前缀 zentex.：document、templates、editor、engine、passes、auto、api、radius 等。',
            '配置：%LOCALAPPDATA%/OMM-ZEN/miktex.json（TeX 可执行目录）。',
        ],
        'formats': [
            '文件导入仅 .tex 纯文本；没有 JSON 导入。',
            '导出 main.tex 或逐页 PNG。',
        ],
        'ai': 'json-specs/latex.md 给出单文件 .tex 的提示词：中文用 ctexart、英文用 article，原生 TikZ/pgfplots 图表，不引用外部文件。',
        'best_practices': [
            '输出完整、自包含的单文件 .tex，不要 \\input / \\include / \\bibliography{}，不要引用本机图片路径。',
            '中文文档用 ctexart，英文用 article；数学环境成对闭合。',
            '参考文献用内置 thebibliography 环境手写，不依赖 BibTeX。',
            '图表优先用 TikZ/pgfplots 原生绘制，保证离线可编译。',
            '跨设备迁移靠“导出 .tex → 导入 .tex”，不要伪造 JSON 快照。',
            '遇到编译错误先看日志定位行号，再局部修改，不要整篇重写。',
        ],
        'pitfalls': ['不要生成需要 shell escape 或外部宏包下载的复杂文档。', '不要把图片写成绝对路径。'],
        'suggested': ['写一份中文课程论文 TeX 模板', '把这张图改写成 TikZ 代码', '修复这段 TeX 的编译错误'],
    },
    'mdforge': {
        'id': 'mdforge', 'name': 'Markdown 铸造台', 'glyph': 'M', 'purpose': '把 AI 写的 Markdown 稳定铸造为严格版式的 DOCX / TeX / PDF（MDFORGE）。',
        'port': 8316, 'entry': 'omm-mdforge.html', 'runtime': 'mdforge', 'order': 60,
        'channels': ['documents'],
        'features': [
            '粘贴/导入 Markdown → 选 academic 模板 → 格式微调 → 校验 → 转换 → 下载。',
            'AI 规范与图表重绘规范可在应用内下载；严格模式遇到降级即中止。',
            '结果卡可编辑元信息、下载 TeX 素材包（含本地 fallback 图片）。',
        ],
        'storage': [
            'localStorage：mdforge.settings.v2、mdforge.draft.v1、mdforge.tuning.v1。',
            '服务端任务目录 mdforge-jobs/；模板位于 mdforge/templates/。',
        ],
        'formats': [
            'Markdown 必须 YAML frontmatter 开头，含 title 与 template: academic。',
            '图片：![alt](images/x.png){width=12cm align=center}，仅 PNG/JPG 本地图片。',
            '原生图表：```latex-figure fallback="images/x.png" … ```；题注用 <!-- caption: … -->。',
        ],
        'ai': '内置两份完整 AI 规范（AI_MD_SPEC.md、AI_LATEX_FIGURE_SPEC.md），并有 /api/md-spec 与 /api/figure-spec 接口。',
        'best_practices': [
            '只输出 Markdown 纯文本，不用代码围栏包住全文，不写解释。',
            '标题、作者、摘要、关键词只放 frontmatter；正文不重复。',
            'H1–H4、列表最多三级、GFM 表格不超过 6 列；文末用一次 # 参考文献 结束。',
            '不手写目录、封面、页码、脚注、任务列表、HTML 块、远程图片；目录由平台控制。',
            '图片必须独占段落；中文/空格文件名可用但建议简单英文名。',
            '需要原生图表时用 latex-figure 围栏，配色用 cA–cJ，宽度用 0.90–0.95\\textwidth 等相对值，并提供本地 PNG fallback。',
            'latex-figure 内禁止 \\input / \\include / \\write18 / \\usepackage 等文件与执行类命令。',
            '转换前先校验；严格模式下任何降级都会中止，必须修正后再转换。',
        ],
        'pitfalls': ['版式属于平台，不要试图用空格或 HTML 控制排版。', 'Markdown 本身是唯一允许“不包代码围栏”的交付物。'],
        'suggested': ['按学术模板写一篇 Markdown 论文', '把这个柱状图改写成 latex-figure', '先校验再转换这篇文稿'],
    },
    'message': {
        'id': 'message', 'name': '消息同步', 'glyph': '信', 'purpose': '跨设备的端到端加密消息与文件同步（ZenMessage）。',
        'port': 8317, 'entry': 'omm-message.html', 'runtime': 'static', 'order': 70,
        'channels': ['documents'],
        'features': [
            '配置 Supabase 与本机密码 → 实时频道 → 收 messages / 文件、置顶收藏、设备管理。',
        ],
        'storage': [
            'localStorage：zmsg-supabase-config-v1、zmsg-ui-v1、zmsg-message-cache-v1（最近 250 条）、zmsg-device-v1。',
            'Supabase 表：zmessage_messages、zmessage_message_meta。',
        ],
        'formats': [
            '没有文件导入入口；消息 payload 由本机密码派生的密钥加密。',
        ],
        'ai': '无内置 AI；json-specs/message.md 只是数据模型参考。',
        'best_practices': [
            '永远不要说“我可以给你生成一个可导入的消息文件”——本产品没有文件导入。',
            'AI 只能产出配置/UI/缓存类 JSON 供手动写入 localStorage，且不得包含密码或 API Key。',
            '消息密文不能伪造；要发消息就引导用户在界面里操作。',
            '跨产品共享走 documents 频道，而不是伪装成消息记录。',
            '设备列表与置顶/收藏状态只反映本机缓存（最近 250 条），不要把缓存当作完整历史。',
        ],
        'pitfalls': ['不要输出密钥或密码。', '不要把加密消息当作可读文本处理。'],
        'suggested': ['检查我的消息同步配置', '把这份报告发给另一台设备（引导界面操作）'],
    },
    'planner': {
        'id': 'planner', 'name': '日程安排', 'glyph': '日', 'purpose': '日历、待办、笔记与重复规则的日程本（ZenPlan）。',
        'port': 8318, 'entry': 'omm-planner.html', 'runtime': 'static', 'order': 80,
        'channels': ['documents'],
        'features': [
            '多本日程；事件类型 todo / event / note，按日期组织。',
            '重复规则 daily / weekly / monthly / yearly / dates；时间线视图。',
            '整本导出 / 导入（追加 + 去重）；Supabase 同步。',
        ],
        'storage': [
            'localStorage：zp-events-v1、zp-settings-v1、zp-data-v2、zp-count-v1。',
            'Supabase：zp-supabase-config-v2、zp-sync-meta-v2。',
        ],
        'formats': [
            '备份：{app:"zenplan", version:2（数字）, exportedAt, planners:[{id,name}], activeId, eventsBy:{<plannerId>:{"YYYY-MM-DD":[events]}}, recursBy:{<plannerId>:[rules]}}。',
            '事件需 id 与非空 title；color 取 5 个内置色值；time 为 "" 或 "HH:MM"；done 为 true/false/"failed"。',
        ],
        'ai': '无内置 AI；json-specs/planner.md 提供完整备份骨架，适合让 AI 生成计划。',
        'best_practices': [
            'version 必须是数字 2，写成字符串 "2" 会走旧版兼容分支。',
            'eventsBy / recursBy 的键必须是 planners 中声明的 id，否则数据会被静默丢弃。',
            '导入是“追加 + 按 id 去重”，不会覆盖现有日程；生成前先确认目标日程本。',
            '重复规则与具体事件分开写，避免把重复实例误写成独立事件。',
            '复盘时可从这里导出已完成事项，交给复盘报告产品生成 Markdown。',
        ],
        'pitfalls': ['不要手写 events 旧字典结构。', '颜色不要自造十六进制值。'],
        'suggested': ['生成一周的复习计划', '把这些待办写成日程备份', '汇总本月已完成事项做复盘'],
    },
    'redact': {
        'id': 'redact', 'name': '文档脱敏工具', 'glyph': '脱', 'purpose': 'PDF / Office 文档的脱敏、清理与导出（ZenRedact）。',
        'port': 8319, 'entry': 'omm-redact.html', 'runtime': 'static', 'order': 90,
        'channels': ['documents'],
        'features': [
            '导入 txt/docx/pdf/pptx 与图片；标记脱敏区域并导出净化后的 PDF/DOCX。',
            'PDF 工具：图片提取、拆分/合并等；A4 预览。',
        ],
        'storage': ['localStorage：zr-settings（仅 UI 设置）。无云同步。'],
        'formats': ['没有 JSON 文件导入，.json 在白名单里被明确拒绝；只有 zr-settings 可供手动注入。'],
        'ai': '无内置 AI；json-specs/redact.md 是数据模型参考，不是导入规范。',
        'best_practices': [
            '不要请求 AI 生成“可导入的脱敏文件”——本产品不接受 JSON 导入。',
            '输出只能是 zr-settings 这类 UI 配置；未知字段会回退默认值。',
            '涉及隐私时，先在本地完成脱敏，不要把原文发给任何在线模型。',
            '脱敏结果通过 documents 频道共享时，提醒用户再次检查敏感字段。',
            '用户要处理的是 Office 文档时，先说明支持的格式范围（txt/docx/pdf/pptx 与图片），不要承诺处理未知格式。',
        ],
        'pitfalls': ['绝不把原文档正文贴给云端 AI 做脱敏。', '不要伪造 PDF 结构数据。'],
        'suggested': ['检查这份文档还有哪些敏感字段', '给我一份脱敏操作清单'],
    },
    'search': {
        'id': 'search', 'name': '智能搜索', 'glyph': '搜', 'purpose': '联网搜索 + AI 摘要 + 引用溯源，并可一键导出或发送结果。',
        'port': 8322, 'entry': 'omm-search.html', 'runtime': 'static', 'order': 115,
        'channels': ['documents'],
        'features': [
            '输入问题 → DeepSeek 联网搜索 → 带 [n] 引用的中文分点回答。',
            '来源按相关性/时间排序、筛选已引用/未引用、时间范围过滤；知识库收藏。',
            '导出 Markdown/CSV/HTML；通过 OMMShare 发送 ZenCard 到其他产品。',
        ],
        'storage': ['localStorage：omm-search-v1 = {settings:{theme,bg,fontScale,apiBase,apiModel,apiKey,thinking,forceWeb,timeRange,filter,sort}, history:[]}。'],
        'formats': ['导出 Markdown / CSV / HTML，没有导入 schema。'],
        'ai': '内置 SYS_PROMPT（严谨搜索、分点、同一来源只引用一次、不编造来源）；键为空时继承静书房 OMMDesktop.aiConfig()。',
        'best_practices': [
            '保持 SYS_PROMPT 不变；只有需要强制联网时才追加 forceWeb 条款。',
            '每条引用只对应一个来源，绝不编造 URL 或来源编号。',
            '思考模式用 thinking:{type:"enabled"|"disabled"}；密钥留空以继承统一配置。',
            '搜索结果需要留存时导出 ZenCard（format: zen-card）再发送，让其他产品可直接导入。',
            '回答要分点、简洁、中文；事实后紧跟来源引用。',
        ],
        'pitfalls': ['不要把摘录的长文直接当作自己的回答。', '引用标记使用产品内部的控制字符，不要手改成普通 [n] 文本。'],
        'suggested': ['联网查一下最近的研究进展', '把这条搜索结果发给所思所想', '导出本次搜索为 Markdown'],
    },
    'video': {
        'id': 'video', 'name': '视频工作台', 'glyph': '视',
        'purpose': '节点工作流编排的视频分析与处理台（工作流画布 + 内置轻量 ffmpeg）。',
        'port': 8329, 'entry': 'omm-video.html', 'runtime': 'video', 'order': 121,
        'channels': ['documents'],
        'features': [
            '节点库：视频输入、媒体信息、场景检测、静音检测、黑场检测、批量缩略图、片段裁剪、画面裁切、尺寸缩放、旋转翻转、播放速度、音量调整、去除音轨、淡入淡出、叠加文字、提取音频、视频拼接、编码与格式、导出文件。',
            '画布操作：点选/拖拽节点、端口连线、自动排布（smart 智能/分层/主线/力导向/径向/时间线）、适应视野、清空、撤销。',
            '示例工作流：基础剪辑、媒体分析、缩略图与 GIF。',
            '产物预览与下载；运行进度与状态实时轮询；文件随任务上传到本地工作区。',
        ],
        'storage': [
            'localStorage：zen.video.canvas.v1（画布 {version,app,nodes[],connections[],view,meta}）、zen.theme（亮暗主题）。',
            '上传与任务：video-runtime/work/uploads、video-runtime/work/jobs（相对插件目录）。',
        ],
        'formats': [
            'AI 工作区工作流 JSON：{format:"omm-video-workflow", version:1, nodes:[{id,type,data}], connections:[{from,to,fromPort,toPort}]}（详见 json-specs/video.md）。',
            '导出与打开：导出 video-workflow.json；omm-video.js 同时接受工作台自身的画布 JSON，应用后与 AI 生成的文件等价。',
        ],
        'ai': '产品自身不含生成式 AI。通过 AI 工作区编排工作流：omm_product_info("video") 查节点与约束，omm_spec_search("视频工作台") 读 json-specs/video.md；生成的工作流 JSON 可用 ZenVideoAI.snapshot()/snapshotMarkdown() 取当前画布，或经 OMMShare 发给用户落库。',
        'best_practices': [
            '画布先加节点再连线；分析节点（媒体信息/场景/静音/黑场/缩略图）不改内容，可并联在输入之后。',
            '运行前确认视频输入节点已导入文件；画布为空或无文件时运行会被拦截。',
            '把可复用的流程存为示例工作流，导出/打开用工作流 JSON（omm-video-workflow），文件名 video-workflow.json。',
            '分析节点结果可并联在输入之后并行运行，不改变视频内容；缩略图最多 30 张。',
            '缺少内置 ffmpeg 或后端未连接时媒体信息与执行结果不可用，先检查健康栏的 ffmpeg 徽标。',
        ],
        'pitfalls': [
            '后端未连接时媒体信息与执行结果不可用，检查健康栏的 ffmpeg 徽标。',
            'drawtext 等节点的文本字段按 ffmpeg 表达式写（如 (w-text_w)/2），不要写成带括号的普通文案。',
        ],
        'suggested': ['帮我设计一条把高光空镜头剪掉的剪辑流程', '帮我给这段视频加美化字幕', '把画布里的视频发给所思所想'],
    },
    'visualization': {
        'id': 'visualization', 'name': '可视化图表', 'glyph': '图', 'purpose': '用 ECharts / Chart.js / ApexCharts / Zen 四种引擎做图表并导出（ZenViz）。',
        'port': 8320, 'entry': 'omm-visualization.html', 'runtime': 'static', 'order': 100,
        'channels': ['data.tables', 'documents'],
        'features': [
            '导入 CSV/TSV/XLSX/XLS/TXT，按“角色列”模型组织数据。',
            '四引擎切换、右侧属性面板（配色 mono/culture/science/editorial、标题、图例、尺寸等）。',
            '导出 PNG / PDF。',
        ],
        'storage': [
            'localStorage：zenviz.workspace.v2（{version:4,state:{engine,type,category}}）、zenviz.engine.v4.<id>。',
            'dataSelections 只在 localStorage，不在导入文件里。',
        ],
        'formats': [
            '可导入的只有右侧属性 JSON：{kind:"zenviz-right-properties", version:1（数字）, engines:{echarts|chartjs|apexcharts|zen:{typeStates,chartProps}}}。',
            '数据本身用 CSV/TSV/XLSX，按类别/数值/来源-目标-权重等角色列组织。',
        ],
        'ai': '无运行时 AI；json-specs/visualization.md 详述属性白名单、默认值、容差与角色列模型。',
        'best_practices': [
            'kind 与数字 version:1 必须精确；引擎 id 只能是四种之一。',
            '只写白名单属性键，且类型与默认值一致；“宁可省略，也不要写错类型”。',
            '数据用 CSV 按角色列给出，不要把数据塞进属性 JSON。',
            '需要原生学术图表时，优先走 MDFORGE 的 latex-figure 而不是截图。',
            '从数据工作台接收表格走 data.tables 频道；成品图通过 documents 频道发布。',
        ],
        'pitfalls': ['属性 JSON 里没有数据。', '字段类型写错会让整条引擎配置回退默认值。'],
        'suggested': ['把这份 CSV 画成柱状图', '生成右侧属性 JSON', '把图表成品发给所思所想'],
    },
    'writer': {
        'id': 'writer', 'name': '所思所想', 'glyph': '写', 'purpose': '无限画布上的长文写作与知识网络（ZenWriter）。',
        'port': 8321, 'entry': 'omm-writer.html', 'runtime': 'static', 'order': 110,
        'channels': ['documents'],
        'features': [
            '画布、节点（text/todo/group/markdown/math/image）、端口连线、分组折叠、涂鸦。',
            '自动布局（smart/spine/layered/force/radial/timeline）、跨画布搜索。',
            '导出 .zc 画布或 .zwlib 全库；IndexedDB 自动保存。',
        ],
        'storage': [
            'IndexedDB：zenwriter（settings/index/docs）、zc-assets（图片资源）。',
            'localStorage：zc-autosave、zc-docs、zc-settings、zwLayoutStrategy、zwDocListMode。',
        ],
        'formats': [
            '画布：{format:"zenwriter-canvas", v:2, name, nodes[], connections[], doodles?}。',
            '全库：{format:"zenwriter-library", docs:{…}}。',
            '节点 id 形如 node-<digits>；坐标 x∈[-1500,1500]、y∈[-1000,1000] 且 x/y 不为 0。',
        ],
        'ai': '无内置 AI 文本生成；json-specs/writer.md 给出可安全导入的节点/连线约束，适合让 AI 生成画布草稿。',
        'best_practices': [
            '导入的硬要求只有 nodes[]；导入总是新建画布，名称重复会自动去重。',
            '连线的两端必须是真实存在且不同的节点 id。',
            'content 是 HTML，必须转义 & < >；todo 用 <s>…</s> 表示完成。',
            '数学节点的 source 是 LaTeX 正文，JSON 里反斜杠要写两份。',
            '图片节点必须 srcMode:"url" 且用 https/data URL，绝不能用 link 模式、assetId 或 blob:。',
            'group 节点没有 children；成员关系靠连线表达，collapsed:true 会隐藏关联节点。',
            'markdown 节点只支持 H1–H3、列表、引用、代码围栏与行内强调/代码/链接。',
        ],
        'pitfalls': ['坐标写 0 会被视为未初始化。', '不要生成需要 IndexedDB blob 的图片节点。'],
        'suggested': ['把这篇提纲画成知识画布', '生成一份 .zc 草稿', '把这些卡片整理成写作节点'],
    },
    'zencard': {
        'id': 'zencard', 'name': '间隔复习', 'glyph': '卡', 'purpose': 'SM-2 间隔复习卡片与知识图谱，是跨产品内容的中转枢纽。',
        'port': 8323, 'entry': 'omm-zencard.html', 'runtime': 'static', 'order': 116,
        'channels': ['documents'],
        'features': [
            '复习队列（again=10 分钟、hard/good/easy）、卡片库搜索。',
            '图谱视图：由 links 与共享标签生成边；导入/导出 card pack 与 SRS 进度。',
        ],
        'storage': ['localStorage：zen.cards.v1、zen.srs.v1、zen.theme。'],
        'formats': [
            '卡片：{format:"zen-card", v:1, id:"zc-…", kind:quote|note|word|sentence|idea|todo|fact|image, source:manual|writer|annotate|corpus|english|search|data|web|clip, content(非空), translation?, note?, tags[], color, createdAt, updatedAt, links?:[{rel,id}], image?}。',
            '包：{format:"zen-card-pack", v:1, name, cards[]}；别名 text/en→content、zh→translation、notes→note。',
        ],
        'ai': '无内置 AI，但 ZenCard 是唯一通用中间格式，OMMShare.send 的 format:"zen-card" 被所有小工具理解。',
        'best_practices': [
            'v 是数字 1，content 非空，kind/source 只能用枚举值，id 唯一，日期用 ISO 格式。',
            '导入是“合并 + 去重”；缺少 SRS 状态的卡片会自动补建，失效状态会清理。',
            '生成卡片时给 links 填真实 id，才能形成有用的知识图谱。',
            '跨产品传递内容一律先转成 ZenCard，再用共享空间发送。',
            '卡片内容要自包含：读者不依赖原文档也能理解。',
        ],
        'pitfalls': ['source 写错枚举会导致卡片显示异常。', '不要把整篇长文塞进单张卡片。'],
        'suggested': ['把这段摘录做成卡片', '生成 10 张复习卡片带关联', '把这些卡片发给间隔复习'],
    },
    'zenflow': {
        'id': 'zenflow', 'name': '自动化编排', 'glyph': '流', 'purpose': '对卡片运行的自动化规则引擎（ZenFlow）。',
        'port': 8324, 'entry': 'omm-zenflow.html', 'runtime': 'static', 'order': 117,
        'channels': ['documents'],
        'features': [
            '规则 {name, priority, enabled, when:{source,kind,tag,text}, actions:[…]}。',
            '动作：addTag / setKind / highlight / send / publish / notify；可运行全部规则并查看效果。',
            '规则图复用画布布局；可导入/导出规则包。',
        ],
        'storage': ['localStorage：zen.flow.rules.v1、zen.flow.strategy.v1、zen.cards.v1、zen.theme。'],
        'formats': ['规则通过 ZenFlow.serialize/deserialize 导入导出；本质是纯数据 JSON。'],
        'ai': '无内置 AI；规则是纯数据，AI 可以安全生成规则包（前提：动作类型与枚举精确）。',
        'best_practices': [
            '用 ZenFlow.validateRule 校验后再交付；priority 小的规则先执行。',
            'send 的 to 必须是真实产品 id，publish 的 channel 必须是真实频道 id。',
            'when 条件的 source/kind/tag/text 要用产品枚举值，避免规则永远不触发。',
            '规则只产生副作用（打标签、发送、通知），不会修改卡片正文；要改正文请生成新卡片。',
            '把“每天把某标签的卡片发给复盘”这类重复操作写成规则，而不是每次手动做。',
        ],
        'pitfalls': ['不要写未知 action type。', '规则运行前先备份卡片数据。'],
        'suggested': ['写一条自动打标签规则', '把某标签卡片自动发送到所思所想', '检查我的规则是否有冲突'],
    },
    'zenclip': {
        'id': 'zenclip', 'name': '网页剪藏', 'glyph': '剪', 'purpose': '把网页选中的文字/HTML 变成 ZenCard（ZenClip）。',
        'port': 8325, 'entry': 'omm-zenclip.html', 'runtime': 'static', 'order': 118,
        'channels': ['documents'],
        'features': [
            '粘贴文字/HTML（去标签）+ URL + 标签 + kind + 备注 → 生成并保存卡片。',
            '预览 JSON/Markdown、下载卡片包、清空、发送到产品。',
        ],
        'storage': ['localStorage：zen.clip.v1、zen.theme。'],
        'formats': ['zen-card-pack，通过 ZenCard.fromWebSelection / serializePack / toMarkdown。'],
        'ai': '无内置 AI；适合让 AI 把原始剪藏整理成结构化卡片。',
        'best_practices': [
            'content 必须非空；标签用逗号（, 或 ，）分隔。',
            '默认 kind 是 quote，按内容改成 idea/fact/note 更有检索价值。',
            '保留 source URL 与来源标注，方便溯源。',
            '离线时下载卡片包，回到静书房再导入；跨产品用 OMMShare.send 发送。',
            '剪藏 HTML 必须去掉脚本与样式标签，只保留纯文本与必要结构。',
        ],
        'pitfalls': ['不要保留剪藏 HTML 的脚本标签。', '空内容的卡片会被拒绝。'],
        'suggested': ['把这段网页摘录整理成卡片', '给这张卡片加上来源和标签', '把剪藏发给语料库'],
    },
    'zenreview': {
        'id': 'zenreview', 'name': '复盘报告', 'glyph': '盘', 'purpose': '用本地卡片与时间线生成 Markdown 复盘报告（ZenReview）。',
        'port': 8326, 'entry': 'omm-zenreview.html', 'runtime': 'static', 'order': 119,
        'channels': ['documents'],
        'features': [
            '设置日期范围/标题/备注；粘贴静书房时间线与日程完成项 JSON。',
            '生成报告 → 复制 Markdown / 下载 .md / 导出为 ZenCard。',
        ],
        'storage': ['读取 zen.cards.v1 与 zen.clip.v1；写回 zen.cards.v1、zen.theme。'],
        'formats': ['时间线与完成项是数组 JSON；报告是 Markdown；卡片用 source:"manual", kind:"note", tags:["复盘"]。'],
        'ai': '无内置 AI，但生成的 Markdown 是极好的 AI 写作交接物。',
        'best_practices': [
            '两个 JSON 文本框必须解析成数组，解析失败按 [] 处理并提示用户。',
            '报告必须基于真实数据；AI 不得编造时间线事件或完成项。',
            '生成的 Markdown 可交给 MDFORGE 铸造为正式文档，或导出卡片进入复习流程。',
            '复盘结论要可执行：把下一步写成 todo 卡片并设好标签。',
            '时间线与完成项要分别粘贴到两个文本框，混在一起会导致时间线被当成待办。',
        ],
        'pitfalls': ['不要把 AI 的推测混进“已完成事项”列表。', '日期范围要与数据实际覆盖的区间一致。'],
        'suggested': ['根据本月时间线写一份复盘', '把复盘结论做成待办卡片', '把报告交给铸造台排版'],
    },
    'zenbackup': {
        'id': 'zenbackup', 'name': '统一备份', 'glyph': '备', 'purpose': '跨产品备份、差异对比、合并与恢复，以及 ZenPack 工作区便携包（ZenBackup）。',
        'port': 8327, 'entry': 'omm-zenbackup.html', 'runtime': 'static', 'order': 120,
        'channels': ['documents'],
        'features': [
            '扫描 localStorage → 选键 → 生成清单 → 打包/下载；导入后做差异（增/删/改）再合并或恢复。',
            'ZenPack：收集整个工作区 → 导出/导入 → 计划差异 → 恢复条目。',
        ],
        'storage': ['不拥有自己的产品键；操作所有 localStorage 键。'],
        'formats': [
            '清单：{format:"zen-backup", v:1, createdAt, name, products:[{id,name,version,savedAt,checksum(FNV-1a base36),data}]}。',
            'products[].id 就是 localStorage 键；data 能 JSON 解析就解析，否则保留原始字符串。',
        ],
        'ai': '无内置 AI；json-specs/zenpack.md 给出清单与恢复提示词。',
        'best_practices': [
            'checksum 必须是 data 的 FNV-1a base36；导入时逐项校验。',
            'products[].id 等于 localStorage 键，恢复就是写回这个键，不能改名。',
            '恢复是破坏性操作：先展示差异并让用户确认，操作前自动备份当前配置。',
            'IndexedDB（所思所想文档/图片、标注 PDF 布局）不在 localStorage 备份范围内，要单独提醒。',
            '跨设备迁移优先用 ZenPack 全工作区包，而不是单个产品的导出。',
        ],
        'pitfalls': ['不要静默覆盖同名键。', '不要声称备份包含 IndexedDB 数据。'],
        'suggested': ['列出我的工作区可备份项', '生成一份差异报告', '帮我规划一次全量恢复'],
    },
}

#: 共享频道角色说明，供 AI 判断“发到哪里”。
CHANNELS: Dict[str, Dict[str, str]] = {
    'documents': {'name': '文档', 'role': '通用文档/图表/报告/卡片', 'mime': 'markdown, tex, pdf, docx, zip, images'},
    'notes.english': {'name': '英语笔记', 'role': '双语表达、句子、模板、词条', 'mime': 'markdown, omm.bridge+json'},
    'data.tables': {'name': '表格数据', 'role': 'CSV/TSV/XLSX/JSON 表格', 'mime': 'text/csv, text/tab-separated-values, application/json'},
}

ALL = {**PRODUCTS, 'hub': HUB}
PRODUCT_IDS = tuple(PRODUCTS.keys())


def product(id_or_name: str) -> Dict[str, Any] | None:
    """按 id、中文名或字标查找产品。"""
    key = str(id_or_name or '').strip().lower()
    if key in ALL:
        return ALL[key]
    for identifier, item in ALL.items():
        name = str(item.get('name', '')).lower()
        glyph = str(item.get('glyph', '')).lower()
        if key == name or key == glyph or (len(key) >= 2 and (key in name or key in identifier)):
            return item
    return None


def best_practices_text(item: Dict[str, Any]) -> str:
    return '\n'.join('%d. %s' % (i, text) for i, text in enumerate(item.get('best_practices') or [], 1))


def brief(id_or_name: str) -> str:
    item = product(id_or_name)
    if not item:
        return ''
    return '%s（%s）：%s' % (item['name'], item['id'], item['purpose'])


def product_index_md() -> str:
    """生成给文档检索用的产品总览（在构建时写入 omm_knowledge/PRODUCTS.md）。"""
    lines = ['# 静书房 / OMM-ZEN 产品总览', '', '共 %d 个产品 + 工作台。所有产品页在独立 origin 运行，' % len(PRODUCTS),
             '跨产品内容请通过 ZenCard 与共享频道（%s）传递。' % '、'.join(CHANNELS), '']
    for item in [HUB] + [PRODUCTS[key] for key in PRODUCT_IDS]:
        lines += ['## %s · %s（%s）' % (item['glyph'], item['name'], item['id']), '',
                  '- 用途：%s' % item['purpose'],
                  '- 端口/入口：%s / %s（%s）' % (item['port'], item['entry'], item['runtime']),
                  '- 共享频道：%s' % ('、'.join(item['channels']) or '无'),
                  '- AI：%s' % item['ai']]
        lines += ['- 功能：'] + ['  - %s' % text for text in item['features']]
        lines += ['- 数据落点：'] + ['  - %s' % text for text in item['storage']]
        lines += ['- 格式：'] + ['  - %s' % text for text in item['formats']]
        lines += ['- 最佳实践：'] + ['  - %s' % text for text in item['best_practices']]
        lines += ['- 常见坑：'] + ['  - %s' % text for text in item['pitfalls']]
        lines.append('')
    return '\n'.join(lines) + '\n'
