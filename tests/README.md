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
python tests/no_jp_quotes.py              # 仅引号修正（product_guard 已内置该能力）
node tests/test_message_security.mjs      # postMessage 协议与版本比较
node --test tests/test_zencard.mjs tests/test_srs.mjs tests/test_flow.mjs \
  tests/test_review.mjs tests/test_backup.mjs tests/test_products.mjs \
  tests/test_knowledge_graph.mjs tests/test_chart.mjs \
  tests/test_writer_deep.mjs tests/test_search_library.mjs \
  tests/test_search_page.mjs tests/test_data_viz.mjs \
  tests/test_dataviz_flow.mjs tests/test_data_flow.mjs \
  tests/test_canvas_layout.mjs tests/test_cmdk.mjs tests/test_cmdk_upgrade.mjs \
  tests/test_json_specs.mjs tests/test_today_panel.mjs tests/test_zenpack.mjs \
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

## 覆盖内容

**`test_backend_hardening.py`**（14 项）

- 桌面桥 `request_is_local()`：Host / Origin 双重校验，拒绝 DNS rebinding、跨站 POST 与 `Origin: null`。
- WebDAV `remote_url_is_public()`：拒绝 loopback、内网、链路本地、云元数据地址与 URL 内嵌凭据；验证 `OMM_CLOUD_ALLOW_PRIVATE` 开关。
- 共享资源授权：注册文件只允许按精确路径读取，不再把整个父目录加入白名单。
- mdforge 多实例隔离：两个 `create_app(root)` 实例各自提供自己的静态文件，不串目录。
- 签名错误脱敏：`CalledProcessError` 中的 `/p <password>` 不会被打印。

**`no_jp_quotes.py` / `test_no_jp_quotes.py`**（引号守卫，3 项）

- OMM-ZEN 全部产品源码、样式、规范文档与数据文件里禁止出现日式/繁体角引号：
  U+300C / U+300D、U+300E / U+300F、U+FE41–U+FE44、U+301D–U+301F，统一改为中文引号
  U+201C“ / U+201D”。
- 扫描范围覆盖整个仓库的自身源码与文档，自动跳过第三方依赖（`vendor`、`.venv`、
  `node_modules`）、构建产物、缓存以及被 git 忽略的本地工具目录（`.workbuddy`）。
- `python tests/no_jp_quotes.py` 默认即在发现时立即原地替换并自动复核；`--check` 只检查、
  不改文件，违规时以退出码 1 失败。脚本按字节读写以保留 CRLF/LF 原样。
- 单元测试验证替换映射、幂等性与“源码中零违规”。

**`product_guard.py` / `test_product_guard.py`**（统一产品守卫，37 项）

在引号守卫之上扩展为覆盖整个 OMM-ZEN 产品面的统一 lint 框架，11 个独立检查项
（`--list` 可查看，`--only` 可筛选）：

| 代码 | 检查项 | 自动修正 |
|---|---|---|
| `QUOTE` | 禁用角引号（复用 `no_jp_quotes`） | 是 |
| `LINK` | 产品页与 JSON 规范里的本地 `href`/`src`/Markdown 链接目标是否存在 | 否 |
| `IMPORT` | `public/` 下 ES 模块的相对导入是否可解析 | 否 |
| `BRIDGE` | 12 个消费型产品是否以 `type="module"` 引入 `zen-link.js` | 否 |
| `SPEC` | `json-specs/*.md` 是否都被 README 索引、索引是否指向存在的文件 | 否 |
| `DEBUG` | 产品页与模块里是否残留 `debugger` 调试语句 | 否 |
| `RESOURCE` | CSS `url()` 与非产品页静态资源引用是否可达（JS 动态表达式不误报） | 否 |
| `XSS` | 动态值拼入 `innerHTML` 等 HTML 写入口是否显式转义 | 否 |
| `A11Y` | 图片是否有 `alt`、交互控件是否有可访问名 | 否 |
| `REGISTRY` | 启动器从 `plugin_specs` 派生、入口页齐全、发布目录无漂移（未跟踪页面豁免） | 否 |
| `FORMAT` | JSON 规范声明的格式标识同时出现在实现产品源码中，防止文档与代码漂移 | 否 |

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
- 静态防护断言：4 个桥接脚本 + writer 内联脚本中不再出现 `postMessage(..., '*')`；所有 `message` 监听器都校验 `event.origin`；工作台把自身 origin 下发到 iframe URL，产品端读取该参数。

**`test_zencard.mjs` 等 18 个新增套件**（node:test，共 157 项）

- `zen-card.js` 通用知识卡片的归一化 / 严格校验 / 序列化 / 去重 / 指纹，以及与语料、批注、英语桥接包、写作画布、数据表、搜索、剪藏的双向转换。
- `zen-srs.js` SM-2 间隔重复：评级映射、间隔递增、遗忘重置、易度下限、到期队列、统计、持久化往返。
- `zen-flow.js` 工作流规则：条件匹配、六类动作、优先级多规则运行、副作用汇总、持久化。
- `zen-review.js` 复盘聚合：日期区间过滤、活跃度 / 标签统计、Markdown 报告生成。
- `zen-backup.js` 统一备份：清单校验和、差异比对、三种合并策略、按 id 去重。
- `test_products.mjs` 集成护栏：5 个新产品的标题 / 样式 / 桥接引入、模块脚本语法、DOM id 引用完整性、无开发残留；12 个既有产品仍引入 zen-link；origin 信任校验；每个页面的 id 引用都对得上真实元素。
- `test_knowledge_graph.mjs` Hub 知识图谱：工具栏入口与面板元素、命令注册、跨 iframe 卡片请求使用 frameTargetOrigin 而非通配符、产品端以明确 origin 回传、纯函数 `kgNormalize`/`dedupeGraphCards`/`kgEscape` 的归一化与转义。
- `test_chart.mjs` `zen-chart.js`：CSV 解析、数组/对象/CSV 归一化、柱状与折线 SVG、标题转义、data URL、空数据兜底。
- `test_writer_deep.mjs` Writer 深改：模块与面板引入、三个右键动作与分发分支、`ZenWriterDeep` 三个入口、引用块出处/批注、图表自包含 data URL、时间机器走工作台快照且二次确认、主脚本整体语法可解析。
- `test_search_library.mjs` `search-library.js`：历史条目与 zen-card 互转、全文检索、置顶、去重、卡片包导出/导入回填、统计。
- `test_search_page.mjs` 智能搜索深改：知识库模块引入与面板元素、渲染/筛选/置顶/发送、新搜索与清空后的刷新、导入导出、主脚本语法。
- `test_data_viz.mjs` `data-viz.js`：表格转 CSV 的转义、角色推断、数据负载构造与校验。
- `test_dataviz_flow.mjs` Data → Viz 一键出图：模块引入、菜单与动作、嵌入 origin、Viz 接收处理、桥接三路径与 origin 校验、两个主脚本语法。
- `test_data_flow.mjs` Hub 数据流面板：入口与面板元素、命令注册、`flowChannels` 按通道分组并保留角色、流转事件写入、角色标签渲染。
- `test_canvas_layout.mjs` Writer 通用布局引擎：从 Writer 原样抽取的 `zen-canvas-layout.js` 各策略均可产出无重叠、确定性坐标；Writer 不再内联实现、ZenFlow 与 Writer 均直接调用同一模块。
- `test_cmdk.mjs` Cmd+K 命令面板扩展：读取卡片 / 笔记 / 搜索历史三类既有 localStorage 来源，复用 `openKnowledgeGraph` / `showKgDetail` / `activateApp`，`cmdkRead` 容错与分组顺序。
- `test_cmdk_upgrade.mjs` Cmd+K 检索增强：子序列模糊评分（前缀加权）、`usageStats` 使用频率加权与稳定排序、本地即时命令（`= 算术`、`@date`、`hex/bin/oct` 换算，算术只接受安全字符）；面板本体未重建，仅在过滤阶段接入。
- `test_zenpack.mjs` ZenPack 工作区包：`zen-pack.js` 薄包装委托 `ZenBackup` 完成打包 / 校验 / 差异 / 合并，工作区键收集与恢复往返，产品 UI 入口断言。
- `tests/e2e/test_chain.py` 真实浏览器端到端：18 个产品页无脚本异常启动；ZenCard 建卡与刷新持久化；ZenFlow 建规则并验证通用布局模块与流程图节点；ZenPack 导出→清空→导入→恢复往返；Hub Cmd+K 检索产品自有数据。另含 `OfflineChainTest`：阻断一切非本地网络请求后，建卡、建规则、ZenPack 导出与 Cmd+K 仍全部可用，把“完全离线”变成回归项。
- `test_product_guard.py` 统一守卫：在原有 6 项之外新增 `REGISTRY`（启动器必须派生、入口页齐全、桌面程序表一致、发布目录无漂移，未跟踪的开发中间态豁免）、`RESOURCE`（CSS 静态资源引用可达，JS 动态表达式不误报）、`XSS`（动态值拼入 innerHTML 必须显式转义，受信任枚举与已转义写法不误报）、`A11Y`（图片有 alt、交互控件有可访问名）、`FORMAT`（JSON 规范声明的格式标识同时出现在实现源码中）；16 项专项用例覆盖这些反例。同时修复了 3 处存量问题：h5-news 装饰图补 `alt`、语料库新建分类按钮补 `aria-label`、Writer 导出插图补 `alt`。
- `test_json_specs.mjs` JSON 规范一致性：不只比对文档，直接调用 `ZenCard` / `ZenBackup` / `ZenPack` / `ZenSRS` / `ZenFlow` 的导出函数，断言产物满足 `format` / `v` / `cards[]` / `products[]` / `nodes` 等总表硬性要求，并验证卡片包、工作区包、SRS、规则序列化的往返。
- `test_today_panel.mjs` 与 `tests/e2e/test_today_panel.py` Hub“今日”面板：纯函数聚合待复习卡片、卡片数、笔记、规则启用数与最近笔记/搜索；面板只读各产品既有 localStorage、复用 `activateApp`、不新增存储；E2E 在真实浏览器注入数据后校验面板数字与条目。

## 前置条件

- Python 3.9+（需要 `flask`、`werkzeug`，项目 `public/requirements-mdforge.txt` 已包含）
- Node 18+
