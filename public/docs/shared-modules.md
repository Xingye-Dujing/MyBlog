# 共享模块

新产品按需引入下列模块，不再重复实现同类逻辑。所有模块使用经典脚本挂全局对象，
不依赖打包器。

## 工作台桥接（所有产品必须）

| 文件 | 作用 |
|---|---|
| `omm-embed.js` | 嵌入模式识别、父窗口 origin 校验与快捷入口 |
| `omm-desktop.js` | 桌面桥接、统一 UI 组件、存档面板、主题消息 |
| `omm-share.js` | 跨产品共享总线：按收发双方能力自动解析唯一频道；异步处理器成功后才 ACK，失败保留 inbox |

三者顺序固定：`omm-embed.js` → `omm-desktop.js` → `omm-share.js`。
入口页用 `data-omm-app="<产品 id>"` 声明身份，`index.html` 等非 `omm-*.html` 入口同样适用。
禁止通配符 `postMessage`，目标 origin 必须来自父窗口或 iframe 自身 URL；消息接收统一调用
`ZenUtil.isTrustedParentMessage(event)`，不得只信任任意 loopback origin。

ZenBackup 在桌面嵌入环境通过 Hub 的 `omm:workspace-backup-request/reply` 协议逐产品采集与恢复；
Hub 只接受 `zenbackup` 来源，恢复按 `maskedPaths` 合并当前设备敏感字段，失败产品逐项报告。

## 可复用产品逻辑

| 文件 | 作用 |
|---|---|
| `lib/zen-card.js` | ZenCard 创建 / 校验 / 打包，跨产品通用格式 |
| `lib/zen-link.js` | 卡片按钮与知识库入口；浮层复用 `ZenUI.popover`，发送目标由 `OMMShare.targets()` 按当前频道权限解析；只读采集页可用 `data-zen-link-ui="false"` 隐藏按钮 |
| `lib/zen-backup.js` / `lib/zen-pack.js` | 工作区快照与工作区包：原始字符串保真、字段级脱敏、明确白名单与失败回滚 |
| `lib/zen-srs.js` / `lib/zen-review.js` | 间隔复习状态与复盘报告 |
| `lib/zen-flow.js` | 规则校验与执行 |
| `lib/zen-chart.js` | CSV 解析与自包含 SVG 图表 |
| `lib/zen-table.js` / `lib/zen-video.js` | 表格与视频工作流产品层 |
| `lib/zen-crypto.js` | Base64 编解码、PBKDF2 派生（云同步产品共用） |
| `lib/zen-cloud.js` | `ZenCloud`：云面板/警告/页脚标记生成器与通用引擎（偏好、工作区隔离与确认、错误分类、远端读取）；六个云同步产品共用，产品只保留数据快照与冲突策略 |
| `lib/zen-csv.js` | `ZenCSV.parse()` / `ZenCSV.stringify()`：CSV 与 TSV 的唯一编解码器，保留引号、分隔符、换行和字段首尾空格；导出可用 `{formulaSafe:true}` 阻断电子表格公式注入 |
| `lib/zen-html.js` | `ZenHTML.sanitize()`：博客 Markdown 与产品富文本共用的 HTML 白名单清洗 |
| `lib/zen-job.js` | 画布产品的作业协议：统一 HTTP/JSON 错误、取消、单实例轮询终态、视口中心插点（table / video 共用） |
| `lib/data-viz.js` / `viz-bridge.js` / `lib/search-library.js` | 出图、跨页送图、检索 |
| `zen/components/switch.js` | 共享 ARIA 开关（`data-zen-switch`），替代各产品的开关外观与点击实现 |
| `zen/components/shortcuts.js` | 除快捷键注册外还提供 `ZenUI.shortcuts.help()` 与 `.hk-*` 面板生成器 |
| `zen/components/archive.css` | 存档与跨产品共享面板的唯一视觉实现，由 `zen/zen.css` 加载；桥接不注入 shadow 样式或私有 Toast |
| `zen/foundation/util.js` | `ZenUtil.el()` / `ZenUtil.fmtDateTime()` / `ZenUtil.parentTargetOrigin()` / `ZenUtil.isTrustedParentMessage()` 等通用无状态助手（单一实现；跨窗口消息只信任精确 Hub 父窗口或同源父窗口） |
| `zen/foundation/base.css` | `zen-spin` 等关键帧的唯一真源；产品只引用动画名 |
| `zen/features/launcher.css` | hub 与 installer 共用的启动器样式 |

## 画布框架

`zen/canvas/layout.js` 是 6 策略自动布局的唯一实现；
`zen/canvas/engine.js` 提供节点、连线、视口、选择、历史、序列化与数据载入校验。
画布样式是可选包 `zen/canvas/canvas.css`，只由画布产品单独引用；核心 `zen.css` 不加载它。

写入要求（画布产品共用，禁止各自实现）：

- `ZenCanvas.normalizeSpec(data, config)` 与 `fromJSON()` 共用同一份校验/归一化实现；
  坐标用 `parseFloat` 处理，`toJSON()` 输出的 `"80px"` 可以原样回载。产品不得再写
  私有的 `toCanvasJSON` / `finite` 之类的第二套校验器。
- 通用检查（根节点、版本、规模、id、类型、端口、重复、环路）在共享层；产品只通过
  `config` 提供 `format`、`types` 与 `validate` 业务规则回调。
- writer 的 SVG 层直接带共享类 `zc-svg-layer`，连线样式只来自 `zen/canvas/canvas.css`；
  共享层不写 `#svg-layer` 等产品私有选择器，writer 专有规则留在 `zen/products/writer.css`。

## 新增共享模块的规则

1. 纯逻辑放 `public/lib/zen-*.js`，暴露单一全局对象或 ES module 导出，不依赖具体产品。
2. 在 `tests/product_guard.py` 的 `SHARED_MODULES` 登记，纳入版本指纹。
3. 在 `tests/` 增加专项测试，覆盖核心行为与复用断言。
4. 更新本文与 `docs/product-guide.md`。

`zen-csv.js` 使用经典脚本全局对象，不依赖打包器；导入导出均通过 `ZenCSV`，产品不得再维护私有分隔符解析器。
