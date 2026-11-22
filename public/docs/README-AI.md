# AI 工作区 · 静书房专属 Agent / Harness

把 `F:/python_project/ai-agent-framework`（`agent-workspace` v0.1.0）直接引入静书房，
并注入全部 OMM-ZEN 产品知识与最佳实践。
它是静书房的**内置插件**（id `ai`，端口 8328，runtime `ai`），像 MDFORGE / LaTeX 一样
带本地 Python 后端，但产品页、技能与规范完全离线可用。

---

## 1. 它做什么

- **20 个产品专家技能**：每个产品一个 skill（`omm.zen.<产品id>`），prompt 不只是简介，
  而是把工作流、数据落点、导入导出格式、AI 规范、**最佳实践**、常见坑编织成可执行指令。
  另有 `omm.zen.hub`（静书房管控）、`omm.zen.cross`（跨产品编排）、`omm.zen.ai`（工作区管家）。
- **领域只读工具**：`omm_product_list` / `omm_product_info` / `omm_spec_search` /
  `omm_spec_read` / `omm_workspace_status` / `omm_channel_info`，让 AI 先读规范再动手。
- **格式模板 + 代码校验**：`omm_format_list` / `omm_format_template` / `omm_format_validate`。
  AI 从模板取骨架，生成后交给校验器按产品真实解析规则检查（错误带路径与原因），修到 `ok=true`
  才交付——不再让 AI 自己写校验逻辑。前端还有“校验”标签页可人工粘贴检查；
  `zen-backup` 的 FNV-1a base36 checksum 由校验器按浏览器算法重算核对。
- **产物审批**：模型只提出 `present_artifact`；用户点“应用”后，前端用
  `OMMDesktop.saveText` 保存到静书房设定目录，或用 `OMMShare.send` 把 ZenCard 发到目标产品。
  宿主 `apply_artifact` 会拒绝文件名穿越、超过 8 MB 的文件，以及夹带密钥/密码的产物。
- **统一 AI 配置**：静书房“设置 → AI 服务”填一次，插件通过 `OMMDesktop.aiConfig()` 继承。
  密钥只从请求头 `X-Provider-Key` 进入内存，不写入 `ai.db` / 设置 / 日志 / 生成文件。
- **与静书房协调**：产品页可一键“打开产品”（`OMMShare.openApp`）；卡片可发送到间隔复习、
  所思所想、语料库、六级备考；共享频道声明为 `documents` / `notes.english` / `data.tables`；
  页面通过 `omm:theme` 消息继承工作台固定的 OMM-ZEN 外观令牌。

## 2. 目录

```text
public/
├── omm-ai.html                    # OMM-ZEN 风格前端（对话/技能/产品/知识/会话/设置）
├── agent_workspace/               # 从 ai-agent-framework 原样引入的框架
│   ├── service.py / agent.py / store.py / tools.py / skills.py / providers/ …
│   ├── omm_data.py                # 20 个产品的结构化知识（唯一真源）
│   ├── omm_skills.py              # 25 个技能（20 个产品专家 + 管控/跨产品/工作区管家/学习包/开发助手）
│   ├── omm_tools.py               # 9 个领域只读工具（含模板与校验）
│   ├── omm_validators.py          # 20 产品格式的校验器 + 空白模板 + FNV-1a checksum
│   ├── omm_host.py                # OMMZenHostAdapter：事实、规范、产物应用
│   ├── omm_server.py              # Flask create_app(plugin_dir, data_dir)
│   └── omm_knowledge/             # 规范：json-specs、MDFORGE AI 规范、格式校验说明、PRODUCTS.md
├── docs/                          # OMM-ZEN 设计系统：令牌、组件、共享模块、新产品开发指南
├── zen/foundation/                     # 统一样式层：入口、令牌、基础、组件、能力、产品专有
├── tests/
│   ├── test_omm_ai.py             # 知识/技能/工具/产物/路由/Flask/构建契约/前端契约
│   ├── test_omm_validators.py     # 20 产品模板与硬约束、checksum、工具/接口/前端校验契约
│   ├── test_hub_launch.py         # 静书房真实启动插件并打开页面
│   ├── test_ui_browser.py         # Playwright 无密钥开箱可用冒烟
│   └── framework/                 # 框架自带 131 个测试（含 quote style 的 2 个行为测试）
└── desktop/
    ├── plugin_specs.py            # BUILTIN_PLUGINS 新增 ai（8328 / runtime ai）
    ├── plugin_manager.py          # RUNTIMES += "ai"
    ├── hub_server.py              # _start_ai() + ensure() 分支
    ├── omm_launcher.py            # start_ai() + 独立 EXE 分支
    ├── build_exes.py              # _ai_backend_args()：hidden-import + add-data 知识目录
    └── omm_shared.py              # APP_NAMES += ai
```

## 导入约定

`agent_workspace/` 内含 `types.py`。若把**包目录本身**加入 `sys.path`，它会遮蔽标准库
`types`，导致 `MappingProxyType` 循环导入。唯一支持的用法是把 `public/` 加入 `sys.path`，
再以包路径导入：`import agent_workspace.omm_data`。`tests/conftest.py` 已如此配置，
`tests/test_import_paths.py` 用子进程锁定这一约定。

## 3. 运行

源码方式（需要先在 `.venv` 安装 `requests>=2.31`）：

```powershell
# 直接启动独立 AI 工作区（端口 8328）
.venv\Scripts\python.exe desktop\omm_launcher.py --app ai

# 或在静书房中：先把插件 stage 到目录，再用工作台启动
.venv\Scripts\python.exe -c "import sys;sys.path.insert(0,'desktop');import offline;offline.stage_plugin('ai',__import__('pathlib').Path('build/plugin-dirs/ai'))"
.venv\Scripts\python.exe desktop\omm_launcher.py --app hub --debug --plugins build\plugin-dirs
```

打包时 `build_exes.py` 会把 `agent_workspace` 全部子模块与 `omm_knowledge/` 一起打进
`OMM-ZEN.exe`、`OMM-ZEN-Framework`、`OMM-AI.exe`；在线安装器的 catalog 也会自动包含该插件。
用户从 zip 导入的第三方插件仍强制 `static`，不能冒充 `ai` 运行时执行本机代码。

## 4. 测试

```powershell
.venv\Scripts\python.exe -m pytest tests -q
# 203 passed
```

其中 `tests/framework/test_quote_style.py` 是全仓门禁：源码里禁止日式角括号，
误写时用 `python tools/check_quote_style.py --fix` 一键修复（OpenCode 写入钩子也会修）。
`.workbuddy/`、`data/` 等历史目录在排除表里，不参与扫描。

测试覆盖：产品目录完整性（20 个、端口唯一、每个 ≥5 条最佳实践）、25 个技能深度与可用性、
9 个领域工具执行、20 产品模板全量可校验与硬约束拒绝用例、FNV-1a checksum 与浏览器一致、
宿主事实与上下文、产物应用（路径穿越/密钥/卡片/打开产品）、
离线对话与技能路由、自定义 provider 注册、Flask 全部路由、密钥不回传、
桌面构建契约、前端 OMM-ZEN 样式与桥接契约，以及静书房真实启动插件的端到端检查。

## 5. 给 AI 添加知识

1. 在 `agent_workspace/omm_data.py` 的 `PRODUCTS` 增加/更新产品条目（用途、功能、数据落点、
   格式、AI、最佳实践、坑、示例请求）。技能会自动衍生，无需改 `omm_skills.py`。
2. 把新的规范文档放进 `agent_workspace/omm_knowledge/`，`omm_spec_search` / `docs_search`
   会自动检索。更新 `PRODUCTS.md`：
   `python -c "from agent_workspace.omm_data import product_index_md; ..."`。
3. 新增或改动导入格式时，编辑 `public/json-specs/format-registry.json`（唯一可编辑真源），
   再运行 `python public/tools/gen_formats.py`。不要手改 `omm_formats_generated.py` 与
   `formats.generated.md`：`GEN_FORMATS` 守卫会检查生成物是否与注册表逐字一致，
   深度语义校验器通过注册表的 `validator` 字段绑定，并由 golden fixtures 钉死。
4. 运行 `pytest tests -q` 确认目录/技能/文档/格式契约测试仍然通过。

## 6. 与标注工作台（ZenMark）的实时结合

文本标注页不只是“能生成一个可导入的 JSON”，它已经把编码结果做成 AI 可直接消费的只读上下文：

- **页面侧**：`window.ZenAnnotateAI` 暴露 `snapshot()`（结构化 JSON）、
  `snapshotAsync()`（会补全表格引文原文）、`snapshotMarkdown()`（给模型看的紧凑摘要）。
  摘要只包含方法数据、码表、编码树、信度结果与“典型引文”，不含整篇访谈原文。
- **实时通道**：标注页监听工作台广播的 `omm:zen-card-request`（只接受 loopback
  parent origin，回复用显式 `targetOrigin`），回一张 `kind:"omm.annotate.snapshot"` 的卡片。
  `omm-hub.js` 的 live-data 桥把它收进 `omm_live.annotate`；同源 web 版则直接从
  `localStorage['zencode.project.v1']` 生成同一结构。AI 工作区的 `omm_live_data`
  上下文因此能真实引用用户当前的码号、轮次、κ 值与典型引文，而不是靠用户复制粘贴。
- **用户动作**：“互通 → 发送到 AI 工作区”把同一份摘要通过共享频道 `documents`
  发给 AI 插件（`format: omm.annotate.markdown`）；独立网页版降级为下载 Markdown。
- **文档与校验**：`json-specs/annotate.md`（同步到 `omm_knowledge/annotate.md`）
  已补齐 `cellCodes[]`、`reliability[]`、`star`、`kind:"table"` 的规则与生成提示词；
  `omm_validators.py` 会校验这些新数组的行号、轮次、引用与 κ/po 范围。
- **技能**：`omm.zen.annotate` 由 `omm_data.PRODUCTS['annotate']` 自动衍生，知识更新
  无需改 `omm_skills.py`。`PRODUCTS.md` 用 `product_index_md()` 重新生成。
