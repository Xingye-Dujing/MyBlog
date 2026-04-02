# 我的博客

一个极简风格的个人博客，基于 Vue 3 + Vite 构建。

## 特性

- **极简设计** - 干净简洁的界面，专注于内容本身
- **快速加载** - 基于 Vite 构建，极速开发体验与生产性能
- **Markdown 支持** - 内置 Markdown 渲染，支持代码高亮
- **数学公式** - 支持 LaTeX 数学公式（KaTeX）
- **聊天式布局** - 独特的聊天式文章展示方式
- **响应式设计** - 完美适配移动端与桌面端
- **页面过渡动画** - 流畅的页面切换效果

## 技术栈

- **框架**: Vue 3.5+
- **构建工具**: Vite 7+
- **状态管理**: Pinia 3+
- **路由**: Vue Router 5+
- **Markdown**: markdown-it + highlight.js + KaTeX

## 项目结构

```
src/
├── components/        # 可复用组件
│   ├── ChatList.vue   # 聊天列表
│   ├── ChatView.vue   # 聊天视图
│   ├── MessageBubble.vue    # 消息气泡
│   ├── CommentSection.vue   # 评论区域
│   └── ...
├── composables/       # 组合式函数
│   └── useMarkdown.js # Markdown 渲染工具
├── stores/           # Pinia 状态管理
├── views/            # 页面视图
│   ├── HomeView.vue   # 首页
│   ├── TimelineView.vue # 时间线
│   └── AboutView.vue  # 关于页面
├── App.vue           # 根组件
└── main.js           # 入口文件
```

## 快速开始

### 环境要求

- Node.js: ^20.19.0 或 >=22.12.0

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

## 功能模块

### Markdown 渲染

支持标准 Markdown 语法，内置代码高亮（GitHub 主题）和 LaTeX 数学公式。

### 聊天式布局

文章以聊天气泡的形式展示，提供独特的阅读体验。

### 评论系统

内置评论功能，支持对文章进行评论和互动。

## 样式定制

项目采用极简风格，主要样式定义在 `App.vue` 中：

- 字体：衬线字体（serif）
- 滚动条：自定义细滚动条
- 页面过渡：淡入淡出动画
