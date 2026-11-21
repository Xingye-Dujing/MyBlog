# 共享模块

新产品按需引入下列模块，不再重复实现同类逻辑。所有模块使用经典脚本挂全局对象，
不依赖打包器。

## 工作台桥接（所有产品必须）

| 文件 | 作用 |
|---|---|
| `omm-embed.js` | 嵌入模式识别、父窗口 origin 校验与快捷入口 |
| `omm-desktop.js` | 桌面桥接、统一 UI 组件、存档面板、主题消息 |
| `omm-share.js` | 跨产品共享总线、ZenCard 发送与频道 |

三者顺序固定：`omm-embed.js` → `omm-desktop.js` → `omm-share.js`。
禁止通配符 `postMessage`，目标 origin 必须来自父窗口或 iframe 自身 URL。

## 可复用产品逻辑

| 文件 | 作用 |
|---|---|
| `lib/zen-card.js` | ZenCard 创建 / 校验 / 打包，跨产品通用格式 |
| `lib/zen-link.js` | 卡片按钮与知识库入口 |
| `lib/zen-backup.js` / `lib/zen-pack.js` | 工作区快照与工作区包 |
| `lib/zen-srs.js` / `lib/zen-review.js` | 间隔复习状态与复盘报告 |
| `lib/zen-flow.js` | 规则校验与执行 |
| `lib/zen-chart.js` | CSV 解析与自包含 SVG 图表 |
| `lib/zen-table.js` / `zen-paper.js` | 表格与论文辅助 |
| `lib/zen-crypto.js` | Base64 编解码、PBKDF2 派生（云同步产品共用） |
| `lib/data-viz.js` / `viz-bridge.js` / `lib/search-library.js` | 出图、跨页送图、检索 |

## 画布框架

`zen-canvas/layout-engine.js` 是 6 策略自动布局的唯一实现；
`zen-canvas/zen-canvas.js` 提供节点、连线、视口、选择、历史与序列化。
画布样式已并入 `zen-style/features/canvas-framework.css`，由 `zen.css` 统一加载。

## 新增共享模块的规则

1. 纯逻辑放 `public/zen-*.js`，暴露单一全局对象，不依赖具体产品。
2. 在 `tests/product_guard.py` 的 `SHARED_MODULES` 登记，纳入版本指纹。
3. 在 `tests/` 增加专项测试，覆盖核心行为与复用断言。
4. 更新本文与 `docs/product-guide.md`。
