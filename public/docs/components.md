# 组件库

共享组件 class 定义在 `zen/foundation/primitives.css` 与 `zen/features/*.css`。
新产品优先直接使用这些 class；只有产品独有的结构与交互才写进
`zen/products/<id>.css`。

## 面板与弹窗

| class | 用途 |
|---|---|
| `.panel` / `.panel-h` / `.panel-t` / `.panel-x` | 侧栏面板、标题、说明、关闭按钮 |
| `.panel-head` / `.panel-body` / `.panel-foot` | 面板分区 |
| `.modal-box` / `.modal-head` / `.modal-body` / `.modal-foot` | 对话框骨架 |
| `.modal-title` | 对话框标题 |

## 按钮与分段控件

| class | 用途 |
|---|---|
| `.menu-btn` | 菜单/工具栏按钮（全品牌通用） |
| `.menu-group` / `.menu-label` / `.menu-sep` | 菜单分组 |
| `.dd-item` / `.dd-item-row` / `.dd-label` / `.dd-divider` | 下拉菜单项 |
| `.dropdown` / `.dd-scroll` / `.dd-empty` | 下拉容器 |
| `.seg` / `.seg button` / `.seg button.active` | 分段选择 |
| `.primary` / `.danger` / `.ghost-btn` | 动作语义修饰 |

## 表单与反馈

| class | 用途 |
|---|---|
| `.field` / `.ed-field` / `.ed-label` / `.ed-input` | 字段与编辑控件 |
| `.dd-select` / `.dd-text` / `.mono-sm` | 下拉输入、文本输入 |
| `.hint` / `.empty-hint` / `.dd-hint` | 说明文字 |
| `.spacer` | 弹性留白 |
| `.hidden` | 统一隐藏 |

## 能力型样式（features）

| 文件 | 适用产品 |
|---|---|
| `features/grid.css` | 表格、列表、数据视图 |
| `features/doc.css` | 文档、Markdown、富文本 |
| `canvas/canvas.css` | 使用 `zen/canvas/` 的画布产品（可选包，按需 link） |
| `features/learning.css` | 词库、卡片、间隔复习 |
| `features/cloud.css` | 云同步面板与状态 |
| `features/tool.css` | 小工具页（`.zt-*`） |

## 使用规则

- 颜色、间距、圆角一律通过令牌，不写死色值。
- 产品专有 class 加产品前缀（如 `.zw-`、`.zt-`），避免污染共享命名空间。
- 不要在 HTML 里内联 `<style>`；产品规则统一进产品 CSS。
- 组件结构可以组合，但不要复制共享组件的完整实现到产品 CSS。
