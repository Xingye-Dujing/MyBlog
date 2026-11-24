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
| `lib/zen-link.js` | 卡片按钮与知识库入口 |
| `lib/zen-backup.js` / `lib/zen-pack.js` | 工作区快照与工作区包：原始字符串保真、字段级脱敏、明确白名单与失败回滚 |
| `lib/zen-srs.js` / `lib/zen-review.js` | 间隔复习状态与复盘报告 |
| `lib/zen-flow.js` | 规则校验与执行 |
| `lib/zen-chart.js` | CSV 解析与自包含 SVG 图表 |
| `lib/zen-table.js` / `zen-paper.js` | 表格与论文辅助 |
| `lib/zen-crypto.js` | Base64 编解码、PBKDF2 派生（云同步产品共用） |
| `lib/zen-cloud.js` | `ZenCloud`：云面板/警告/页脚标记生成器与通用引擎（偏好、确认、错误分类、远端读取）；六个云同步产品共用，产品只保留数据快照与冲突策略 |
| `lib/zen-html.js` | `ZenHTML.sanitize()`：博客 Markdown 与产品富文本共用的 HTML 白名单清洗 |
| `lib/zen-job.js` | 画布产品的作业协议：JSON 提交、取消、视口中心插点（table / video 共用） |
| `lib/data-viz.js` / `viz-bridge.js` / `lib/search-library.js` | 出图、跨页送图、检索 |
| `zen/components/switch.js` | 共享 ARIA 开关（`data-zen-switch`），替代各产品的开关外观与点击实现 |
| `zen/components/shortcuts.js` | 除快捷键注册外还提供 `ZenUI.shortcuts.help()` 与 `.hk-*` 面板生成器 |
| `zen/foundation/util.js` | `ZenUtil.el()` / `ZenUtil.fmtDateTime()` / `ZenUtil.parentTargetOrigin()` / `ZenUtil.isTrustedParentMessage()` 等通用无状态助手（单一实现；跨窗口消息只信任精确 Hub 父窗口或同源父窗口） |
| `zen/foundation/base.css` | `zen-spin` 等关键帧的唯一真源；产品只引用动画名 |
| `zen/features/launcher.css` | hub 与 installer 共用的启动器样式 |

## 画布框架

`zen/canvas/layout.js` 是 6 策略自动布局的唯一实现；
`zen/canvas/engine.js` 提供节点、连线、视口、选择、历史与序列化。
画布样式是可选包 `zen/canvas/canvas.css`，只由画布产品单独引用；核心 `zen.css` 不加载它。

## 新增共享模块的规则

1. 纯逻辑放 `public/lib/zen-*.js`，暴露单一全局对象或 ES module 导出，不依赖具体产品。
2. 在 `tests/product_guard.py` 的 `SHARED_MODULES` 登记，纳入版本指纹。
3. 在 `tests/` 增加专项测试，覆盖核心行为与复用断言。
4. 更新本文与 `docs/product-guide.md`。
