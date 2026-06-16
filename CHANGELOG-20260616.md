# 改进工作记录

> 日期：2026-06-16
> 项目：Vue 3 + Vite 博客 (D:\blog\web)
> 分支：main + production

---

## 一、概述

本次对话完成了两个分支上各 9 项改进（production 分支 #1 不适用），涵盖性能优化、代码重构、新功能添加和错误处理。每项改进均独立 commit，仅本地提交，未推送远程。

---

## 二、main 分支改进

### #1 路由懒加载
- **文件**：`src/router/index.js`
- **内容**：AboutView、TimelineView 改为 `() => import(...)` 动态导入
- **Commit**：(之前已完成)

### #2 v-if 替代 display:none
- **文件**：`src/components/ChatView.vue`、`src/components/MessageBubble.vue`
- **内容**：折叠消息改用 `<template v-for>` + `v-if="msg._visible"`，不再渲染 DOM 节点
- **注意**：Vue 3 中 v-if 优先于 v-for，需用 `<template>` 包裹
- **Commit**：`8114b1f`

### #3 图片懒加载
- **文件**：`src/composables/useMarkdown.js`
- **内容**：添加 markdown-it 自定义 image renderer，自动添加 `loading="lazy"` 属性
- **Commit**：`069190a`

### #4 ChatView 拆分为 composables
- **新建文件**：
  - `src/composables/useSections.js` — 章节构建、折叠、跳转、滚动监听
  - `src/composables/useChatActions.js` — 编辑、删除、移动、标签、标题、文件导入等
- **文件**：`src/components/ChatView.vue` script setup 从 ~425 行缩减到 ~125 行
- **关键问题**：composable 返回的 ref 在模板中需顶层解构才能自动 unwrap，不能通过 `actions.refName` 访问
- **Commit**：`49f3302`

### #5 内联样式改为 CSS class
- **文件**：`src/composables/useSections.js`、`src/components/ChatView.vue`
- **内容**：`jumpToSection` 中 `el.style.background` 改为 `el.classList.add('section-highlight')`
- **Commit**：`8c7bf5c`（与 #6 合并）

### #6 修复未使用的 import
- **文件**：`MessageInput.vue`、`OutlineSidebar.vue`、`HomeView.vue`、`useMarkdown.js`、`eslint.config.js`
- **内容**：移除 `const props =`、`_e` 参数、`catch (_)`；ESLint 添加 node globals 覆盖
- **Commit**：`8c7bf5c`（与 #5 合并）

### #7 应用内搜索
- **文件**：`src/components/ChatView.vue`
- **内容**：
  - 搜索按钮（放大镜图标）+ 可展开搜索栏
  - 输入框 + 匹配计数 + 上下导航 + 关闭按钮
  - `messagesWithDates` computed 增加 `_searchMatch` 标记
  - 匹配消息高亮淡黄色，Enter 跳下一个，Esc 关闭
  - 切换对话自动清空搜索状态
  - 移动端 font-size: 16px 防 iOS 自动缩放
- **Commit**：`5622d91`

### #8 URL 深链接
- **文件**：`src/components/ChatView.vue`、`src/components/MessageBubble.vue`
- **内容**：
  - `scrollToHashMessage()` 读取 `#msg-{id}` hash，滚动到消息 + 脉冲高亮动画
  - 时间戳可点击复制深链接到剪贴板，显示"已复制"
  - 添加 `deep-link-highlight` CSS 动画（黄色 box-shadow 扩散，1.5s 消退）
- **Commit**：`df1382f`

### #9 全局错误处理
- **文件**：`src/main.js`、`src/router/index.js`
- **内容**：
  - `app.config.errorHandler` 捕获 Vue 未处理错误
  - `/:pathMatch(.*)*` 404 通配路由重定向到首页
  - `beforeEach` 守卫检查 chat ID 有效性
- **Commit**：`ad64a5a`

---

## 三、production 分支改进

production 分支只有 `/` 和 `/chat/:id` 两个路由，无 AboutView/TimelineView，ChatView 更简单（无编辑/标签/标题功能），因此 #1 不适用。

### #2 v-if 替代 v-show
- **文件**：`ChatView.vue`、`MessageBubble.vue`
- **内容**：移除 MessageBubble 的 `visible` prop 和 `v-show`，ChatView 用 `<template v-for>` + `v-if`
- **Commit**：`3167cf1`

### #3 图片懒加载
- **文件**：`src/composables/useMarkdown.js`
- **内容**：同 main 分支，添加 image renderer + 修复 `catch (_)`
- **Commit**：`13a5ccf`

### #4+5 Composable 提取 + CSS class 高亮
- **新建文件**：`src/composables/useSections.js`（production 版本，无 useChatActions）
- **文件**：`ChatView.vue` script setup 从 ~245 行缩减到 ~95 行
- **Commit**：`daba62b`

### #6 修复未使用的 import
- **文件**：`MessageInput.vue`、`OutlineSidebar.vue`、`HomeView.vue`
- **Commit**：`f027b94`

### #7 应用内搜索
- **文件**：`ChatView.vue`
- **内容**：同 main 分支功能，但适配 production 的简化版 ChatView
- **Commit**：`80ad2a6`

### #8 URL 深链接
- **文件**：`ChatView.vue`、`MessageBubble.vue`
- **内容**：同 main 分支
- **Commit**：`f767933`

### #9 全局错误处理
- **文件**：`main.js`、`router/index.js`、`stores/chat.js`
- **额外修复**：production 的 store 用 `fetch` 异步加载 JSON，路由守卫在数据加载前执行会误判。添加 `isInitialized` ref，守卫仅在初始化完成后检查
- **Commit**：`f948307`

---

## 四、关键踩坑记录

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| Vue v-if/v-for 优先级 | v-if 在 v-for 之前求值，`msg` 未定义 | 用 `<template v-for>` 包裹，v-if 放内层 |
| composable ref 不 unwrap | `actions.syncStatus` 在模板中是 ref 对象 | 顶层解构所有 ref |
| @click 多行表达式解析失败 | Vue 模板编译器无法处理换行分隔的语句 | 加 semicolons 分隔 |
| 路由守卫误重定向 | production store 异步加载，守卫执行时 chats 为空 | 添加 `isInitialized` 标记 |
| Windows 无 jq | Prettier hook 需要解析 stdin JSON | 改用 Node.js 脚本 |
| ESLint 不识别浏览器全局 | 缺少 globals 配置 | 安装 `globals` 包，添加 `globals.browser` |
| ESLint 不识别 process | devApi.js 是 Node 环境 | 为 `src/plugins/**/*.js` 添加 `globals.node` 覆盖 |

---

## 五、项目结构变化

```
src/
├── composables/
│   ├── useMarkdown.js      # 修改：图片 lazy loading，修复 catch
│   ├── useSections.js      # 新建：章节逻辑（两个分支都有）
│   └── useChatActions.js   # 新建：操作逻辑（仅 main 分支）
├── components/
│   ├── ChatView.vue        # 重构：composable 提取 + 搜索 + 深链接
│   ├── MessageBubble.vue   # 修改：移除 visible prop，添加复制链接
│   ├── MessageInput.vue    # 修复：移除未使用 const props
│   └── OutlineSidebar.vue  # 修复：移除未使用 const props
├── views/
│   └── HomeView.vue        # 修复：移除未使用参数
├── router/
│   └── index.js            # 修改：404 路由 + chat ID 守卫
├── stores/
│   └── chat.js             # 修改：添加 isInitialized（仅 production）
└── main.js                 # 修改：添加 errorHandler
```

---

## 六、后续可做事项

1. **同步到远程**：两个分支的 commit 均未 push 到 MyBlog/Gitee
2. **main 分支同步改进**：production 的 `isInitialized` 修复也需要同步到 main（如果 main 的 store 也是异步加载）
3. **搜索结果高亮文本**：当前搜索只高亮整条消息背景，可进一步在文本中用 `<mark>` 标记匹配词
4. **搜索快捷键**：可添加 `Ctrl+F` 拦截浏览器默认搜索，聚焦到应用内搜索框
5. **消息锚点分享**：MessageBubble 右键菜单添加"复制消息链接"选项
