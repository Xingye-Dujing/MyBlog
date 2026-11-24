# OMM-ZEN 交互组件

`public/zen/components/` 只负责**交互行为**。视觉令牌来自同根的 `foundation/`，可选视觉包在 `features/`。
组件样式 `components.css` 由核心入口 `zen/zen.css` 导入；浮层内部结构由组件注入统一的 shadow root，
不依赖任何可选 CSS 包。

## 核心组件（所有产品加载）

| 文件 | 全局 | 用途 |
|---|---|---|
| `layer.js` | `ZenUI.layer` | 唯一 shadow 浮层栈：Escape / 外部点击 / 焦点管理 |
| `popover.js` | `ZenUI.popover` | 通用锚定浮层：视口定位、焦点选项、Escape / 外部点击与关闭后焦点返回 |
| `toast.js` | `ZenUI.toast` | 统一 Toast，替代各产品的私有提示 |
| `dialog.js` | `ZenUI.dialog` | `confirm/alert/prompt`，返回 Promise |
| `dialog.js` | `ZenUI.modal` | 通用内容模态壳与可搜索选择器 `ZenUI.dialog.pick` |
| `select.js` | `ZenUI.select` | 原生 `<select data-zen-select>` 的候选区 |
| `menu.js` | `ZenUI.menu` | 下拉 / 右键菜单，替代各产品私有菜单 |
| `shortcuts.js` | `ZenUI.shortcuts` | 快捷键注册表；`help()` / `parseRows()` 生成共享 `.hk-*` 说明面板 |
| `index.js` | `ZenUI` | 装配、渐进增强、MutationObserver |

## 可选组件（按需加载）

| 文件 | 用途 |
|---|---|
| `picker.js` | 日期 / 时间 / 多日期弹窗，仅用于有日期输入的产品；支持 Enter/Space 打开、方向键导航与焦点返回 |
| `tabs.js` | 选项卡行为 |
| `tooltip.js` | `data-zen-tip` 提示气泡 |
| `switch.js` | hub / installer / message / redact 的 ARIA 开关 |

## 加载顺序

```html
<script src="zen/components/layer.js"></script>
<script src="zen/components/popover.js"></script>
<script src="zen/components/toast.js"></script>
<script src="zen/components/dialog.js"></script>
<script src="zen/components/select.js"></script>
<script src="zen/components/menu.js"></script>
<script src="zen/components/shortcuts.js"></script>
<script src="zen/components/index.js"></script>
<script src="omm-desktop.js"></script>
```

`index.js` 在 DOM 就绪后增强全页，并监听动态插入的控件。日期组件未加载时不会报错。
旧产品使用 `data-action` 的 div/span 会自动获得 button 语义、Tab 焦点与 Enter/Space 激活；原生控件不重复绑定。

## 设计原则

- **无构建**：经典脚本，每个文件挂载一个 `ZenUI.*` 命名空间。
- **渐进增强**：原生控件保持原生语义；`select` 的 `value/change/options` 与日期输入的 `YYYY-MM-DD` 不变。
- **单浮层栈**：所有浮层在同一个 shadow root 内，Escape / 外部点击只作用于最上层；`popover.js` 与 `archive.css` 共用焦点陷阱、关闭后焦点返回和无障碍令牌。
- **通用底线**：不写任何单一产品的分支、样式或调参；产品差异通过配置 / 回调解决。
