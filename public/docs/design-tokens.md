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

## 间距与圆角

`--zen-space-1..5` = 4 / 8 / 12 / 16 / 24px；`--zen-radius: 0`（全品牌统一直角）；
`--zen-fscale: 1`（字号缩放由工作台无障碍设置注入）。

## 层级

`--zen-z-base` 1 · canvas 10 · menu 1000 · toolbar 2000 · context 2500 ·
confirm 9999 · cloud 12000 · panel 2147482100。新组件不得自造 z-index。

## 层顺序

`zen.css` 唯一声明：`zen.tokens → zen.base → zen.primitives → zen.feature → zen.product → zen.override`。
产品样式必须包在 `@layer zen.product { … }` 中，覆盖只能用 `zen.override`。
