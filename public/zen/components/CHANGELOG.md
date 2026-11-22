# Changelog · OMM-ZEN UI

## 1.0.0

- 建立 `public/zen/components/` 共享组件库，与 `zen/foundation`、`zen/canvas` 并列。
- `core/layer.js`：统一 shadow 浮层容器、浮层栈、Escape / 外部点击处理。
- `components/dialog.js`：迁移 OMMUI 的 confirm / alert / prompt，新增焦点约束。
- `components/select.js`：迁移 OMMUI 的候选区弹窗，统一使用 `data-zen-select`。
- `components/picker.js`：从日程安排产品提取日期 / 时间 / 多日期选择器，支持原生 date/time 输入增强。
- `index.js`：统一入口、自动增强、`window.OMMUI` 兼容门面。
- `ui.css`：`@layer zen.ui` 组件层样式，由 `zen/zen.css` 统一导入。
- 全部 OMM-ZEN 产品页接入；ZenPlan 与复盘报告迁移到共享 Picker。
