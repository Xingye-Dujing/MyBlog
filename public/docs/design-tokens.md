# 设计令牌

真源是 `zen/foundation/tokens.css`。本文只列取值与用途；新增产品只读 `zen-*` 令牌，
legacy 别名仅供存量代码使用，新代码不要引用。

## 颜色（浅色 / 深色）

| 令牌 | 用途 | 浅色 | 深色 |
|---|---|---|---|
| `--zen-ink` | 主文字 / 主线条 | `#1a1a1a` | `#e8e8e8` |
| `--zen-paper` | 页面底色 | `#ffffff` | `#1a1a1a` |
| `--zen-surface` | 面板底色 | `#ffffff` | `#232121` |
| `--zen-ink-dim` | 次要文字 | `rgba(26,26,26,.4)` | `rgba(232,232,232,.4)` |
| `--zen-ink-mid` | 中等强调文字 | `rgba(26,26,26,.62)` | `rgba(232,232,232,.66)` |
| `--zen-ink-faint` | 极弱文字 | `rgba(26,26,26,.15)` | `rgba(232,232,232,.15)` |
| `--zen-line` | 主边框 | `#1a1a1a` | `#e8e8e8` |
| `--zen-line-soft` | 次级边框 | `rgba(26,26,26,.15)` | `rgba(232,232,232,.15)` |
| `--zen-line-faint` | 分隔线 | `rgba(26,26,26,.06)` | `rgba(232,232,232,.06)` |
| `--zen-hover` | 悬停底色 | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` |
| `--zen-select-bg` | 选中底色 | `#f5f5f5` | `#2a2a2a` |

强调色固定为中性色，不提供用户自定义：

| 令牌 | 浅色 | 深色 |
|---|---|---|
| `--zen-accent` | `#000000` | `#ffffff` |
| `--zen-accent-soft` | `rgba(0,0,0,.06)` | `rgba(255,255,255,.12)` |
| `--zen-accent-wash` | `rgba(0,0,0,.03)` | `rgba(255,255,255,.06)` |
| `--zen-accent-line` | `rgba(0,0,0,.5)` | `rgba(255,255,255,.5)` |
| `--zen-accent-contrast` | `#ffffff` | `#1a1a1a` |

语义色：`--zen-red`、`--zen-green`、`--zen-blue`、`--zen-orange`、`--zen-yellow`、
`--zen-purple`（深浅两套，见 tokens.css）。

## 字体

- `--zen-font-text`：Literata → 宋体族衬线栈，正文与中文。
- `--zen-font-code`：等宽栈，仅代码与数字。历史坑：`--font-mono` 实际是衬线栈，
  需要真正等宽字体时用 `--zen-font-code`。

## 语义与数据色

`--zen-err` / `--zen-danger-bg` / `--zen-danger-line` 为错误语义色；
`--zen-control-accent` / `--zen-control-track` 为滑杆与开关控件色；
`--zen-highlight-yellow` 为消息高亮色；`--zen-canvas-port` / `--zen-canvas-conn` /
`--zen-canvas-node` / `--zen-canvas-title` 为画布节点色；`--zen-swatch-amber/olive/rust/blue`
为安装器色板；`--zen-swatch-teal` / `--zen-swatch-graphite` 为产品色阶与功能色块。
产品不再就地写死这些色值。

## 投影与遮罩

| 令牌 | 用途 | 浅色 | 深色 |
|---|---|---|---|
| `--zen-shadow-soft` | 控件、浮层的轻投影 | `rgba(26,26,26,.18)` | `rgba(0,0,0,.4)` |
| `--zen-shadow-deep` | 模态、抽屉的深投影 | `rgba(26,26,26,.24)` | `rgba(0,0,0,.5)` |
| `--zen-overlay` | 抽屉/弹层的背景遮罩 | `rgba(26,26,26,.22)` | `rgba(0,0,0,.45)` |
| `--zen-veil` | 浅色遮罩/玻璃层 | `rgba(255,255,255,.72)` | `rgba(0,0,0,.62)` |

legacy `--shadow-soft`、`--shadow-deep`、`--overlay`、`--veil` 只引用上述规范令牌，
不保留独立色值。

## 间距与圆角

| 令牌 | 值 |
|---|---|
| `--zen-space-1` | `4px` |
| `--zen-space-2` | `8px` |
| `--zen-space-3` | `12px` |
| `--zen-space-4` | `16px` |
| `--zen-space-5` | `24px` |

`--zen-radius: 0`（全品牌统一直角）；
`--zen-fscale: 1`（字号缩放由工作台无障碍设置注入）。状态圆点、画布端口与颜色取样点
可用 `50%` 表达语义圆形，除此之外的界面容器、控件和浮层不得写死或派生非零圆角。

## 层级

| 令牌 | 值 |
|---|---|
| `--zen-z-base` | `1` |
| `--zen-z-canvas` / `--zen-z-canvas-ui` | `10` / `40` |
| `--zen-z-cursor` / `--zen-z-sticky` | `100` / `300` |
| `--zen-z-dropdown` / `--zen-z-menu` | `1000` / `1000` |
| `--zen-z-toolbar` / `--zen-z-context` | `2000` / `2500` |
| `--zen-z-panel` / `--zen-z-popover` | `3000` / `4000` |
| `--zen-z-modal` / `--zen-z-preview` | `5000` / `6000` |
| `--zen-z-toast` / `--zen-z-confirm` | `8000` / `9999` |
| `--zen-z-cloud` | `12000` |
| `--zen-z-overlay` | `2147483600`（共享 ZenUI 浮层宿主） |

新组件不得自造 z-index。

## 层顺序

`zen.css` 唯一声明：`zen.tokens → zen.base → zen.primitives → zen.feature → zen.product → zen.override`。
产品样式必须包在 `@layer zen.product { … }` 中，覆盖只能用 `zen.override`。
