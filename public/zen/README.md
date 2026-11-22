# OMM-ZEN 品牌视觉与交互库

`public/zen/` 是 OMM-ZEN 全部视觉与交互资产的唯一根。每个目录只承担**一种职责**，
名称之间不再重叠；产品不允许自带画布、弹窗、菜单、Toast、日期面板或第二套令牌。

> **底线（不可妥协）**：`zen/` 是通用可复用资产，**禁止**为某个产品写入分支、补丁、特例或调参。
> 产品独有的行为、样式与交互细节只能留在 `lib/zen-<id>.js`、`zen/products/<id>.css`、产品入口页，
> 通过共享库提供的配置与回调实现。

> **零残留（不可妥协）**：能力迁入 `zen/` 后，产品私有实现必须**全部删除**——旧浮层壳、监听器、辅助函数、
> 死绑定、无用模板、备份文件、过期文档。不留旧 API 别名或兼容包装，所有调用点统一到唯一规范 API 后移除别名。
> 当前无任何引用的文件/函数/CSS 规则/令牌一律删除（删前全局 grep 确认）；同一关注点只允许一份实现，
> 发现重复就合并并删副本。生成物漂移时改源再重新生成，不手改生成物。

## 目录职责

```text
zen/
├── README.md               本文件：总规范、分层、边界
├── zen.css                 唯一核心样式入口
├── foundation/             视觉基座——令牌、重置、通用 class 词汇
│   ├── tokens.css             颜色/字体/间距/层级令牌真源
│   ├── base.css               基础重置
│   ├── primitives.css         通用组件词汇（panel/dropdown/seg/hint…）
│   └── util.js                通用无状态助手（ZenUtil：DOM/字符串/错误分类）
├── components/             交互组件——JS 与自身样式同放
│   ├── index.js               核心装配、渐进增强
│   ├── components.css         组件外观（由 zen.css 导入）
│   ├── layer.js               唯一 shadow 浮层栈
│   ├── toast.js / dialog.js / select.js / menu.js / shortcuts.js   核心
│   │     dialog.js 同时提供 ZenUI.modal（通用内容模态壳）与 ZenUI.dialog.pick
│   └── popover.js / picker.js / tabs.js / tooltip.js                可选
│         popover.js 只负责锚定定位 / 单开互斥 / 外部点击关闭，内容归产品
├── canvas/                 画布能力——可选
│   ├── canvas.css             统一画布样式包
│   ├── engine.js              通用画布引擎
│   ├── layout.js              纯函数自动布局
│   └── README.md              画布契约
├── features/               可选视觉能力包（grid/doc/learning/cloud/tool）
├── products/               产品适配器样式（@layer zen.product）
└── (无 styles/ 与 ui/ 目录——它们的职责已拆入上述目录)
```

`foundation` 只管视觉传承，`components` 只管交互行为，`canvas` 只管画布领域，`features` 只管可选视觉包，
`products` 只管产品适配。五个目录互不重叠。

## 分层：核心必载 + 可选增量

| 层 | 内容 | 谁加载 |
|---|---|---|
| **核心样式** | `zen.css` → `foundation/*` + `components/components.css` | 所有产品 |
| **核心脚本** | `components/{layer,toast,dialog,select,menu,shortcuts,index}.js` | 所有产品 |
| **通用助手** | `foundation/util.js` → `ZenUtil`（DOM/字符串/错误分类） | 用到助手的产品 |
| **可选浮层** | `components/popover.js` → `ZenUI.popover`（锚定/单开/关闭） | 有下拉浮层的产品 |
| **可选样式包** | `features/*.css`、`canvas/canvas.css` | 只由真正用到的产品 link |
| **可选脚本** | `components/{picker,tabs,tooltip}.js`、`canvas/{layout,engine}.js` | 只由真正用到的产品加载 |
| **产品适配器** | `lib/zen-<id>.js`、`products/<id>.css` | 产品自己的业务与外观配置 |

核心入口不会全量导入 `features/`：不用画布的产品不再下载画布样式，没有日期输入的产品不再加载 picker。

## 接入

```html
<link rel="stylesheet" href="zen/zen.css" />
<link rel="stylesheet" href="zen/products/<id>.css" />
<script src="zen/components/layer.js"></script>
<script src="zen/components/toast.js"></script>
<script src="zen/components/dialog.js"></script>
<script src="zen/components/select.js"></script>
<script src="zen/components/menu.js"></script>
<script src="zen/components/shortcuts.js"></script>
<script src="zen/components/index.js"></script>
<!-- 可选：zen/canvas/canvas.css + canvas/layout.js + canvas/engine.js -->
<!-- 可选：zen/components/popover.js（下拉浮层）、picker.js、tabs.js、tooltip.js -->
```

## 约束

1. 不在产品页内联 `<style>`；产品 CSS 只做令牌配置与产品专有外观。
2. 不使用浏览器原生 `alert` / `confirm` / `prompt` / 日期时间面板；统一走 `components/`。
3. 共享库不写硬编码色值、z-index 或产品节点名；层级用 `--zen-z-*`。
4. 新增通用能力必须至少两个产品复用且无业务状态；产品差异通过配置 / 回调实现。
5. 改共享文件需提升套件版本；`tests/product_guard.py` 的 `SHARED_MODULES` 与
   `desktop/offline.py` 的 `copy_zen_styles` / `copy_zen_ui` / `copy_canvas_framework` 保持同步。

## 边界：什么必须共享，什么留在产品

- **必须共享**：同一交互/视觉机制的重复实现。通用无状态助手统一到 `ZenUtil`；
  右键/下拉菜单统一到 `ZenUI.menu`；弹窗、Toast、画布、选择器同理。
- **留在产品**：带业务状态的产品逻辑（云同步 watcher、数据归一化、学习词库语义）
  与产品独有的外观编排（各自顶部菜单的条目内容、定位与副作用）。这些看似重复，
  实则行为各异，强行统一只会引入按产品分支——违反“共享库无产品分支”的底线。
  重复出现时只允许把**无业务状态的那部分**下沉到 `ZenUtil`，状态与编排仍归产品。
