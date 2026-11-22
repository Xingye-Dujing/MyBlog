# 回归测试

全部离线运行，不修改用户数据，也不启动后台服务。

图表页 `public/omm-visualization.html` 由共享仓库 `third_party/zenviz-core`
生成：**改图表功能请改 core 后运行 `python third_party/zenviz-core/build.py
--product omm --root .`，不要直接编辑生成物**；`test_zenviz_core_sync.mjs`
会逐字比对，防止两边（OMM / 采析绘）再次漂移。

## 运行

在仓库根目录执行：

```bash
python tests/run_all.py
```

端到端浏览器测试使用仓库自带虚拟环境中的 Playwright（自动由 `run_all.py` 发现并执行）；
首次运行若缺少浏览器，先执行一次 `public/.venv/Scripts/python.exe -m playwright install chromium-headless-shell`。
单独运行 E2E：

```bash
public/.venv/Scripts/python.exe -m unittest discover -s tests/e2e -v
```

或分别运行：

```bash
python -m unittest discover -s tests -v   # Python 后端安全、引号守卫与统一产品守卫
python tests/product_guard.py             # 每次改完就运行：自动修正引号并跑完全部守卫检查
python tests/product_guard.py --check     # 只检查、绝不改文件（回归套件使用，违规退出码 1）
python tests/product_guard.py --list      # 列出全部检查项与其代码
python tests/product_guard.py --only LINK,BRIDGE  # 只跑指定检查项
python tests/product_guard.py --only REGISTRY     # 产品注册表一致性
python tests/product_guard.py --only RESOURCE,XSS,A11Y  # 资源 / 转义 / 可访问性
python tests/product_guard.py --only FORMAT     # JSON 规范与产品源码一致
python tests/product_guard.py --only SPEC_SYNC  # AI 知识副本与 json-specs 逐字一致
python tests/product_guard.py --only RUNTIME    # ai 运行时仅官方可用
python tests/product_guard.py --only PRIVACY    # 隐藏日程不进入 AI 快照
python tests/product_guard.py --only GEN_FORMATS # 格式契约单一真源与生成物一致
python public/tools/gen_formats.py --check        # 单独校验格式生成物是否最新
python tests/product_guard.py --only VERSION    # 分层版本与内容指纹
python tests/product_guard.py --record-baseline # 发布后重录版本基线（仅发布时执行）
python tests/product_guard.py --suggest-bump    # 列出因内容变更而建议升版本的产品
python tests/no_jp_quotes.py              # 仅引号修正（product_guard 已内置该能力）
python -m pytest public/tests -q          # AI 工作区全部测试（含框架引号门禁与 golden 对拍）
node tests/test_message_security.mjs      # postMessage 协议与版本比较
node --test tests/test_markdown_sanitizer.mjs  # Markdown 输出白名单清洗（含 MathML 绕过）
node --test tests/test_zencard.mjs tests/test_srs.mjs tests/test_flow.mjs \
  tests/test_review.mjs tests/test_backup.mjs tests/test_products.mjs \
  tests/test_knowledge_graph.mjs tests/test_chart.mjs \
  tests/test_writer_deep.mjs tests/test_search_library.mjs \
  tests/test_search_page.mjs tests/test_data_viz.mjs \
  tests/test_dataviz_flow.mjs tests/test_data_flow.mjs \
  tests/test_canvas_layout.mjs tests/test_cmdk.mjs tests/test_cmdk_upgrade.mjs \
  tests/test_json_specs.mjs tests/test_golden_formats.mjs \
  tests/test_today_panel.mjs tests/test_zenpack.mjs \
  tests/test_zenviz_core_sync.mjs  # 图表页必须与 zen viz-core 生成结果逐字一致
npm run lint                              # 前端静态检查
npm run build                             # 前端生产构建
```

## 产品注册表单一真源

新增产品只需改 `public/desktop/plugin_specs.py` 的 `BUILTIN_PLUGINS`：
`public/desktop/product_registry.py` 从中派生启动器的 `APPS` / `WINDOW_TITLES`
（含后端类型与端口），统一守卫的 `REGISTRY` 检查再校验入口页、桌面程序表与
发布目录 `public/dist/catalog.json` 是否一致。发布目录允许滞后于产品清单，
但不允许出现未知产品或字段漂移。尚未 `git add` 的产品页属于开发中中间态，
不会被 REGISTRY 误判；一旦纳入版本库即开始校验。

## 分层版本模型

产品版本本就独立演进：改了一个产品，其他产品不必跟着升版本。VERSION 检查因此分三层：

- **套件版本**：`plugin_specs.VERSION` 与 `catalog.json` 的 `version`、`tag`、`base_url`、
  `gitee_url` 必须一致，代表同一次发布批次。
- **产品版本**：只在同一个产品的 `plugin_specs` 与发布目录之间比对，绝不跨产品比较；
  发布目录允许滞后于产品清单。
- **内容指纹**：基线 `tests/version_baseline.json` 记录每个产品入口页与共享模块的 hash。
  产品内容变了但版本没升会报警并给出补丁号建议；版本升了内容没变会提示空 bump；
  共享模块变了则要求升套件版本；已发布版本的 SHA-256 不可改写。

基线只在**发布完成时**用 `--record-baseline` 更新，随每次提交更新就会失去意义；
日常用 `--suggest-bump` 查看哪些产品因内容变更需要升版本。

## 覆盖内容

**`test_backend_hardening.py`**（20 项）

- 桌面桥 `request_is_local()`：Host / Origin 双重校验，拒绝 DNS rebinding、跨站 POST 与 `Origin: null`。
- WebDAV `remote_url_is_public()`：拒绝 loopback、内网、链路本地、云元数据地址与 URL 内嵌凭据；验证 `OMM_CLOUD_ALLOW_PRIVATE` 开关。现在还会把十进制整数、八进制与十六进制写法（如 `http://2130706433/`、`http://0177.0.0.1/`）规范化后再判断，堵住字面量绕过。
- WebDAV 重定向：`ValidatedRedirectHandler` 让 3xx 的每一跳都重新过 SSRF 校验，跨域跳转移除 `Authorization`，避免公网 DAV 用 302 把 Basic 凭据带回内网；`hub_server._webdav_request()` 改用校验过的 opener。
- 共享资源授权：注册文件只允许按精确路径读取，不再把整个父目录加入白名单。
- mdforge 多实例隔离：两个 `create_app(root)` 实例各自提供自己的静态文件，不串目录。
- 签名错误脱敏：`CalledProcessError` 中的 `/p <password>` 不会被打印。

**`no_jp_quotes.py` / `test_no_jp_quotes.py`**（引号守卫，3 项）

- OMM-ZEN 全部产品源码、样式、规范文档与数据文件里禁止出现日式/繁体角引号：
  U+300C / U+300D、U+300E / U+300F、U+FE41–U+FE44、U+301D–U+301F，统一改为中文引号
  U+201C“ / U+201D”。
- 扫描范围覆盖整个仓库的自身源码与文档，自动跳过第三方依赖（`vendor`、`.venv`、
  `node_modules`）、构建产物、缓存以及被 git 忽略的本地工具目录（`.workbuddy`）。
  **AI 工作区**里只有 OMM 自写的 `agent_workspace/omm_*.py` 纳入扫描，上游框架子包保持
  字节原样；此前被整体排除而漏掉的 4 处角引号已借此修复。
- `python tests/no_jp_quotes.py` 默认即在发现时立即原地替换并自动复核；`--check` 只检查、
  不改文件，违规时以退出码 1 失败。脚本按字节读写以保留 CRLF/LF 原样。
- 单元测试验证替换映射、幂等性与“源码中零违规”。

**`product_guard.py` / `test_product_guard.py`**（统一产品守卫，69 项）

在引号守卫之上扩展为覆盖整个 OMM-ZEN 产品面的统一 lint 框架，16 个独立检查项
（`--list` 可查看，`--only` 可筛选）：

| 代码 | 检查项 | 自动修正 |
|---|---|---|
| `QUOTE` | 禁用角引号（复用 `no_jp_quotes`） | 是 |
| `LINK` | 产品页与 JSON 规范里的本地 `href`/`src`/Markdown 链接目标是否存在 | 否 |
| `IMPORT` | `public/` 下 ES 模块的相对导入是否可解析 | 否 |
| `BRIDGE` | 12 个消费型产品是否以 `type="module"` 引入 `lib/zen-link.js` | 否 |
| `SPEC` | `json-specs/*.md` 是否都被 README 索引、索引是否指向存在的文件 | 否 |
| `DEBUG` | 产品页与模块里是否残留 `debugger` 调试语句 | 否 |
| `RESOURCE` | CSS `url()` 与非产品页静态资源引用是否可达（JS 动态表达式不误报） | 否 |
| `XSS` | 动态值拼入 `innerHTML` 等 HTML 写入口是否显式转义 | 否 |
| `A11Y` | 图片是否有 `alt`、交互控件是否有可访问名 | 否 |
| `REGISTRY` | 启动器从 `plugin_specs` 派生、入口页齐全、发布目录无漂移（未跟踪页面豁免） | 否 |
| `SPEC_SYNC` | AI 工作区的 `omm_knowledge/` 副本与 `json-specs/` 真源逐字一致（含 README 别名） | 否 |
| `RUNTIME` | 只有官方 `ai` 可声明 `runtime='ai'`；第三方 `plugin.json` 不得提权执行本机代码 | 否 |
| `PRIVACY` | Planner 标记为“隐藏内容（仅编辑页可见）”的日程不得进入 Hub 快照或 AI 上下文 | 否 |
| `GEN_FORMATS` | 格式契约注册表是单一真源：生成物逐字一致、校验器/源码/golden 绑定齐全 | 否 |
| `FORMAT` | JSON 规范声明的格式标识同时出现在实现产品源码中，防止文档与代码漂移 | 否 |
| `VERSION` | 分层版本模型：套件版本严格一致、产品版本只比同产品、内容指纹防漏升版本 | 否 |

- 默认运行会先自动修正引号，再串行跑完所有检查；`--check` 全程只读，违规退出码 1。
- 误报豁免：外链 / 锚点 / `data:` / `javascript:`、JS 模板与替换占位符 `${}`、`$2`、
  构建变量 `%BASE_URL%`、Markdown 散文示例 `[文字](链接)`、第三方 `vendor` 与 Vue 前端
  `src/` 均被正确排除；根相对路径同时按 `public/` 与仓库根两种基准解析。
- 检查函数接收内存文件表与存在性谓词，单测用合成数据逐项验证（含真实代码树零异常、
  CLI 参数、分组报告），不改动任何产品文件。
- 已以 `--check` 模式作为独立步骤接入 `run_all.py`，取代原单一引号步骤。

**`test_message_security.mjs`**（20 项）

- 从真实源码抽取 `isNewerVersion` / `versionKey` 并在 VM 中执行，验证与后端 Python 元组比较语义一致（`1.2.0 > 1.2`）。
- `frameTargetOrigin()`：按 iframe 自身 URL 推导目标 origin，跨端口场景不被工作台 origin 覆盖；拒绝非 loopback 地址。
- 静态防护断言：4 个桥接脚本 + writer 与 AI 工作区内联脚本中不再出现 `postMessage(..., '*')`；所有 `message` 监听器都校验 `event.origin` 与 `event.source === window.parent`；工作台把自身 origin 下发到 iframe URL，产品端读取该参数。
- AI 工作区消息监听：此前完全无校验，任意 iframe 都能借 `omm:theme` 改写主题或触发新建会话。现在复用 Hub 下发的 origin，单独实现 `isTrustedParentOrigin()` 并拦截非父窗口来源；6 项行为用例分别覆盖嵌入与独立运行下信任/拒绝的情形（共 28 项 JS 检查）。

**`test_zencard.mjs` 等专项套件**（node:test，数量以实际运行为准）

- `lib/zen-card.js` 通用知识卡片的归一化 / 严格校验 / 序列化 / 去重 / 指纹，以及与语料、批注、英语桥接包、写作画布、数据表、搜索、剪藏的双向转换。
- `lib/zen-srs.js` SM-2 间隔重复：评级映射、间隔递增、遗忘重置、易度下限、到期队列、统计、持久化往返。
- `lib/zen-flow.js` 工作流规则：条件匹配、六类动作、优先级多规则运行、副作用汇总、持久化。
- `lib/zen-review.js` 复盘聚合：日期区间过滤、活跃度 / 标签统计、Markdown 报告生成。
- `lib/zen-backup.js` 统一备份：清单校验和、差异比对、三种合并策略、按 id 去重，以及导出脱敏与恢复白名单。
- 备份安全：`isSecretKey()` 按词识别 `apiKey` / `token` / `secret` / `password` / `supabase` 等字段；`redactSecrets()` 在导出时丢弃整条凭据键、遮罩敏感字段并重算校验和，使清单仍通过校验；`restorableEntries()` 只接受 OMM-ZEN 键前缀或本地已存在的键，挡住 `__proto__` 与任意覆写。ZenPack 导出即脱敏、恢复只写工作区目录内的键；ZenBackup 页的扫描预览、导出与恢复同样走这套规则。6 项专项用例覆盖误报、漏报、篡改与往返。
- `test_products.mjs` 集成护栏：5 个新产品的标题 / 样式 / 桥接引入、模块脚本语法、DOM id 引用完整性、无开发残留；12 个既有产品仍引入 zen-link；origin 信任校验；每个页面的 id 引用都对得上真实元素。
- `test_knowledge_graph.mjs` Hub 知识图谱：工具栏入口与面板元素、命令注册、跨 iframe 卡片请求使用 frameTargetOrigin 而非通配符、产品端以明确 origin 回传、纯函数 `kgNormalize`/`dedupeGraphCards`/`kgEscape` 的归一化与转义。
- `test_chart.mjs` `lib/zen-chart.js`：CSV 解析、数组/对象/CSV 归一化、柱状与折线 SVG、标题转义、data URL、空数据兜底。
- `test_writer_deep.mjs` Writer 深改：模块与面板引入、三个右键动作与分发分支、`ZenWriterDeep` 三个入口、引用块出处/批注、图表自包含 data URL、时间机器走工作台快照且二次确认、主脚本整体语法可解析。
- `test_search_library.mjs` `lib/search-library.js`：历史条目与 zen-card 互转、全文检索、置顶、去重、卡片包导出/导入回填、统计。
- `test_search_page.mjs` 智能搜索深改：知识库模块引入与面板元素、渲染/筛选/置顶/发送、新搜索与清空后的刷新、导入导出、主脚本语法。
- `test_data_viz.mjs` `lib/data-viz.js`：表格转 CSV 的转义、角色推断、数据负载构造与校验。
- `test_dataviz_flow.mjs` Data → Viz 一键出图：模块引入、菜单与动作、嵌入 origin、Viz 接收处理、桥接三路径与 origin 校验、两个主脚本语法。
- `test_data_flow.mjs` Hub 数据流面板：入口与面板元素、命令注册、`flowChannels` 按通道分组并保留角色、流转事件写入、角色标签渲染。
- `test_canvas_layout.mjs` 通用布局引擎：`zen/canvas/layout.js` 各策略均可产出无重叠、确定性坐标；Writer 与 ZenFlow 共用该模块。
- `test_zen_crypto.mjs` 共用加密工具：`lib/zen-crypto.js` 的 Base64 往返、PBKDF2 派生与 AES-GCM 加解密，并断言六个云同步产品复用共享实现、不再内联重复函数。
- `test_cmdk.mjs` Cmd+K 命令面板扩展：读取卡片 / 笔记 / 搜索历史三类既有 localStorage 来源，复用 `openKnowledgeGraph` / `showKgDetail` / `activateApp`，`cmdkRead` 容错与分组顺序。
- `test_cmdk_upgrade.mjs` Cmd+K 检索增强：子序列模糊评分（前缀加权）、`usageStats` 使用频率加权与稳定排序、本地即时命令（`= 算术`、`@date`、`hex/bin/oct` 换算，算术只接受安全字符）；面板本体未重建，仅在过滤阶段接入。
- `test_zenpack.mjs` ZenPack 工作区包：`lib/zen-pack.js` 薄包装委托 `ZenBackup` 完成打包 / 校验 / 差异 / 合并，工作区键收集与恢复往返，产品 UI 入口断言。
- `test_annotate_reliability.mjs` 从 `omm-paper.js` 抽取信度纯函数验证表格行号对齐：第二编码者按提示/导出表填写的 1 基行号必须换算回 `cellCodes.row` 的 0 基键，否则一致性检验会把所有项目判为“只有一方编码”、κ 恒为 0。含完全一致（κ=1、missing=0）与单处分歧两组用例。
- `tests/e2e/test_chain.py` 真实浏览器端到端：18 个产品页无脚本异常启动；ZenCard 建卡与刷新持久化；ZenFlow 建规则并验证通用布局模块与流程图节点；ZenPack 导出→清空→导入→恢复往返；Hub Cmd+K 检索产品自有数据。另含 `OfflineChainTest`：阻断一切非本地网络请求后，建卡、建规则、ZenPack 导出与 Cmd+K 仍全部可用，把“完全离线”变成回归项。
- `test_product_guard.py` 统一守卫：在原有 6 项之外新增 `REGISTRY`（启动器必须派生、入口页齐全、桌面程序表一致、发布目录无漂移，未跟踪的开发中间态豁免）、`RESOURCE`（CSS 静态资源引用可达，JS 动态表达式不误报）、`XSS`（动态值拼入 innerHTML 必须显式转义，受信任枚举与已转义写法不误报）、`A11Y`（图片有 alt、交互控件有可访问名）、`FORMAT`（JSON 规范声明的格式标识同时出现在实现源码中）、`VERSION`（套件版本一致、产品版本只比同产品、内容指纹防漏升、空 bump 与降级提示）、`SPEC_SYNC`（AI 知识副本与规范真源逐字一致）、`RUNTIME`（仅官方 `ai` 可执行本机代码）、`PRIVACY`（隐藏日程不进入 AI 快照）、`GEN_FORMATS`（格式契约单一真源与生成物一致）；45 项专项用例覆盖这些反例。同时修复了 3 处存量问题：h5-news 装饰图补 `alt`、语料库新建分类按钮补 `aria-label`、Writer 导出插图补 `alt`。
- `test_json_specs.mjs` JSON 规范一致性：不只比对文档，直接调用 `ZenCard` / `ZenBackup` / `ZenPack` / `ZenSRS` / `ZenFlow` 的导出函数，断言产物满足 `format` / `v` / `cards[]` / `products[]` / `nodes` 等总表硬性要求，并验证卡片包、工作区包、SRS、规则序列化的往返。
- `test_today_panel.mjs` 与 `tests/e2e/test_today_panel.py` Hub“今日”面板：纯函数聚合待复习卡片、卡片数、笔记、规则启用数与最近笔记/搜索；面板只读各产品既有 localStorage、复用 `activateApp`、不新增存储；E2E 在真实浏览器注入数据后校验面板数字与条目。
- **AI 工作区对齐**：`no_jp_quotes.py` 现在扫描 OMM 自写的 `agent_workspace/omm_*.py`（上游框架子包保持原样），修复了 4 处漏网的角引号；AI 自带 `tools/check_quote_style.py` 排除 `.workbuddy/` 与 `vendor/` 后，原本被跳过的全仓库门禁恢复运行。`SPEC_SYNC` 守卫把 14 份知识副本绑定到 `json-specs/` 真源；`RUNTIME` 守卫把本机代码执行权限锁给官方 `ai`。`run_all.py` 接入 `pytest public/tests`，AI 工作区全部测试（含框架门禁、golden 对拍与实时数据上下文）纳入统一回归。
- `test_golden_formats.mjs` 与 `public/tests/test_golden_formats.py` Golden 对拍：`tests/golden_formats/` 的四份样例必须同时通过产品 JS 导出与 AI Python 校验器；篡改格式或校验和会被两侧同时拒绝。对拍发现并修复了一处真实漂移：`omm_validators.v_zenflow` 原先放行空 `actions`，现已与 `lib/zen-flow.js` 的 `validateRule` 一致。`public/tests/test_import_paths.py` 用子进程锁定 `agent_workspace` 只能经包路径导入，避免包内 `types.py` 遮蔽标准库。
- **跨产品联动**：`test_search_page.mjs` 新增知识库一键“存为卡片”——历史条目经 `SearchLibrary.toCard()` 落到统一卡片库，闭合“搜索→卡片→复习”链路；`test_flow.mjs` 校验 `ZenFlow.templates()` 的四套规则模板全部合法且枚举正确，ZenFlow 空状态可一键载入。
- **AI 读取真实数据**：`omm-ai.html` 在发送前经 `omm:live-data-request/reply` 向 Hub 请求各产品只读快照（Hub 聚合同源 localStorage 并复用 `zen-card-request` 跨 iframe 收集卡片），放入 chat 请求的 `context.omm_live`；`omm_host.omm_live_context` 把它渲染成模型上下文，递归脱敏 `apiKey`/`token`/`supabase` 等字段、数组限 50 条正文限 20 条、深度截断容错。独立运行或 Hub 超时则静默降级，绝不阻塞对话。测试见 `test_ai_live_context.mjs`、`test_knowledge_graph.mjs` 与 `public/tests/test_omm_live_context.py`；全部只改 OMM 自写文件，vendored 框架保持原样。
- **AI 学习包技能**：新增 `omm.zen.study` 技能（第 21 个），把实时数据变成复习卡片包/规则包草稿；`omm_live_data` 纳入所有技能的公共上下文，模型据此回答"我最近的数据…"。`test_omm_ai.py` 更新技能覆盖断言。
- **ZenReview 从工作台拉取**：ZenReview 的"从工作台拉取"按钮复用同一条 `omm:live-data-request` 链路，Hub 快照新增 timeline（flowEvents）与 planner（`zp-data-v2` 扁平化）两类数据，自动填回粘贴框；明确 origin、token 校验、超时降级。测试见 `test_review_pull.mjs` 与 `test_knowledge_graph.mjs`。
- **Data→Viz→Report**：可视化产品新增"复盘"导出按钮，把当前图表的标题/类型/行列数登记到 `zen.viz.review.v1`（限 50 条）；Hub 快照把它并入 timeline，ZenReview 拉取后自动纳入报告。测试见 `test_dataviz_flow.mjs` 与 `test_knowledge_graph.mjs`。
- **格式契约单一真源**：新增 `public/json-specs/format-registry.json`，把 28 个（产品 × 格式）契约的 format token、版本、字段/枚举、硬门槛、最小模板、检测规则、深度校验器绑定、实现源码与 golden fixture 集中到一处。`public/tools/gen_formats.py` 由它生成 `omm_formats_generated.py`（`TEMPLATES` / `DETECTION` / `detect_kind` / 声明式校验）与 `formats.generated.md`（AI 工作区逐字镜像）。`omm_validators.py` 的模板表、检测 if 链和校验器绑定表已删除，改为使用生成物；深度语义校验器保留但由注册表的 `validator` 字段绑定，并由 golden fixtures 与硬门槛用例钉死。`GEN_FORMATS` 守卫把"生成物是否最新/绑定是否齐全"变成可执行约束，测试见 `public/tests/test_gen_formats.py` 与守卫单测。改契约流程：编辑注册表 → `python public/tools/gen_formats.py` → 跑回归。
- **隐藏日程隐私保护（全链路）**：Planner 的 `ed.hidden` 项标记为"仅编辑页可见"，UI 用 `•••••` 掩码。新增统一隐私模块 `omm_privacy.py`（`HIDDEN_MASK` / `is_hidden` / `scrub`），覆盖所有 AI 数据读取路径：① Hub 的 `collectLiveLocalData()` 源头跳过 `e.hidden === true` 的日程；② `omm_host.omm_live_context` 用 `scrub()` 兜底；③ `omm_tools.build_tools()` 用 `_privacy_wrapped` 统一包装**所有工具**的返回值，隐藏项与凭据字段一律过滤；④ `build_skills()` 给**每个技能**注入"隐私红线"守则，禁止读取/引用/复述隐藏内容与凭据。这样新增工具或技能也自动受保护。`PRIVACY` 守卫锁死全部不变量，测试见 `test_omm_privacy.py`、`test_omm_live_context.py`、`test_knowledge_graph.mjs` 与守卫单测。
- **Writer 引用回链复习**：引用节点 header 新增"习"按钮（仅带 `zenCardId` 的节点），经 Hub 的 `omm:review-card` 协议激活 ZenCard 并转发 `omm:focus-card`，ZenCard 切到卡片库、高亮并滚动到该卡片；两端都校验父窗口来源、明确 origin、无通配符。
- **今日复习画布**：Writer 的卡片选择器新增"只看今日到期"筛选，读 `zen.srs.v1` 用 `due <= now` 过滤并标记"待复习"，避免引入新模块依赖。测试见 `test_writer_review_link.mjs` 与 E2E `test_writer_review_link.py`（真实浏览器验证筛选与复习按钮）。

## 前置条件

- Python 3.9+（需要 `flask`、`werkzeug`，项目 `public/requirements-mdforge.txt` 已包含）
- Node 18+
