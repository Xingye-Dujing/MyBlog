<script setup>
// 单文件网页门户：条目与 public/ 下的静态页一一对应
const pages = [
  { href: '/omm-analysis.html', title: '舆情演化分析', desc: '交互式教程，逐段拆解《刘学州事件》论文' },
  { href: '/omm-annotate.html', title: '文本标注', desc: '逐句标记与批注的阅读标注工具' },
  { href: '/omm-corpus.html', title: '英语语料库', desc: '语料检索、统计与词频浏览' },
  { href: '/omm-data.html', title: '数据工作台', desc: '数据清洗、统计与报表输出' },
  { href: '/omm-english.html', title: '六级备考', desc: '大学英语六级词汇与真题训练' },
  { href: '/omm-latex.html', title: 'LaTeX 编译工作台', desc: '公式排版与实时预览' },
  { href: '/omm-message.html', title: '消息同步', desc: '跨端消息的整理与同步' },
  { href: '/omm-planner.html', title: '日程安排', desc: '时间块规划与待办视图' },
  { href: '/omm-redact.html', title: '文档脱敏', desc: '文本敏感信息识别与脱敏处理' },
  { href: '/omm-visualization.html', title: '可视化图表', desc: '数据到图形的多形态可视化' },
  { href: '/omm-writer.html', title: '所思所想', desc: '块编辑器写作与导出' },
  { href: '/h5-news.html', title: '高校开放', desc: '高校资讯与开放数据浏览' },
]
</script>

<template>
  <div class="portal">
    <header>
      <h1>星野笃敬</h1>
    </header>
    <div class="grid">
      <a v-for="p in pages" :key="p.href" class="card" :href="p.href">
        <h2>{{ p.title }}</h2>
        <p>{{ p.desc }}</p>
        <span class="go">打开 →</span>
      </a>
    </div>
  </div>
</template>

<style scoped>
.portal {
  width: 100%;
  max-width: 1120px;
  margin: auto;
}

header {
  border-bottom: 1px solid #f0f0f0;
  padding-bottom: 20px;
  margin-bottom: 40px;
}

h1 {
  font-size: 24px;
  font-weight: 400;
  margin: 0;
  letter-spacing: 0.02em;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 44px;
}

a.card {
  display: block;
  padding: 24px 26px;
  text-decoration: none;
  color: inherit;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 16px;
  transition: background 0.15s, border-color 0.15s;
}

a.card:hover {
  background: #fafafa;
  border-color: #999;
}

a.card h2 {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 400;
}

a.card p {
  margin: 0;
  color: #999;
  font-size: 13.5px;
  line-height: 1.6;
}

.go {
  display: block;
  margin-top: 16px;
  font-size: 12px;
  color: #ccc;
}

a.card:hover .go {
  color: #999;
}
</style>
