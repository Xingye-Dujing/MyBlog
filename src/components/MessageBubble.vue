<script setup>
import { computed } from 'vue'
import { renderMarkdown } from '@/composables/useMarkdown'

const props = defineProps({
  message: { type: Object, required: true },
  showDate: { type: Boolean, default: false }
})

const rendered = computed(() => renderMarkdown(props.message.content))

const timeStr = computed(() => {
  const d = new Date(props.message.timestamp)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
})

const dateStr = computed(() => {
  const d = new Date(props.message.timestamp)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return `${y}年 ${mo}月 ${da}日 星期${weekdays[d.getDay()]}`
})
</script>

<template>
  <div class="message-wrapper">
    <div v-if="showDate" class="date-separator">
      <span>{{ dateStr }}</span>
    </div>
    <div class="message-bubble">
      <div class="message-content" v-html="rendered"></div>
      <div class="message-footer">
        <span class="message-time">{{ timeStr }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-wrapper {
  margin-bottom: 8px;
}

.date-separator {
  text-align: center;
  margin: 24px 0 16px;
  position: relative;
}

.date-separator::before,
.date-separator::after {
  content: '';
  position: absolute;
  top: 50%;
  width: calc(50% - 100px);
  height: 1px;
  background: #e0e0e0;
}

.date-separator::before {
  left: 0;
}

.date-separator::after {
  right: 0;
}

.date-separator span {
  font-size: 0.8rem;
  color: #999;
  background: #fafafa;
  padding: 0 16px;
  letter-spacing: 1px;
}

.message-bubble {
  padding: 16px 20px 8px;
  border-left: 3px solid transparent;
  border-radius: 2px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.message-bubble:hover {
  background: #fafafa;
  border-left-color: #000;
}

.message-content {
  font-size: 1.05rem;
  line-height: 1.9;
  color: #333;
}

.message-content :deep(h2) {
  font-size: 1.5rem;
  font-weight: 400;
  color: #000;
  margin: 8px 0 12px;
  letter-spacing: 2px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e8e8e8;
}

.message-content :deep(h3) {
  font-size: 1.25rem;
  font-weight: 400;
  color: #111;
  margin: 8px 0 8px;
  letter-spacing: 1px;
}

.message-content :deep(p) {
  margin: 0 0 12px;
  text-indent: 0;
}

.message-content :deep(p:last-child) {
  margin-bottom: 0;
}

.message-content :deep(a) {
  color: #000;
  text-decoration: underline;
  text-underline-offset: 3px;
  transition: opacity 0.2s;
}

.message-content :deep(a:hover) {
  opacity: 0.6;
}

.message-content :deep(strong) {
  font-weight: 600;
  color: #000;
}

.message-content :deep(em) {
  font-style: italic;
  color: #555;
}

.message-content :deep(code) {
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Consolas', monospace;
  font-size: 0.9em;
}

.message-content :deep(pre) {
  background: #f5f5f5;
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 12px 0;
}

.message-content :deep(pre code) {
  background: none;
  padding: 0;
}

.message-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  margin: 12px 0;
}

.message-content :deep(blockquote) {
  border-left: 3px solid #000;
  padding-left: 16px;
  margin: 12px 0;
  color: #666;
}

.message-content :deep(ul),
.message-content :deep(ol) {
  margin: 12px 0;
  padding-left: 24px;
}

.message-content :deep(li) {
  margin: 4px 0;
}

.message-content :deep(hr) {
  border: none;
  border-top: 1px solid #e0e0e0;
  margin: 16px 0;
}

.message-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 12px 0;
}

.message-content :deep(th),
.message-content :deep(td) {
  border: 1px solid #e0e0e0;
  padding: 8px;
  text-align: left;
}

.message-content :deep(th) {
  background: #f5f5f5;
  font-weight: 600;
}

.message-content :deep(.katex) {
  font-size: 1em;
}

.message-content :deep(.hljs) {
  background: #f5f5f5;
  padding: 12px;
  border-radius: 4px;
  display: block;
  overflow-x: auto;
}

.message-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #f0f0f0;
}

.message-time {
  font-size: 0.75rem;
  color: #bbb;
  letter-spacing: 0.5px;
}

@media (max-width: 768px) {
  .message-bubble {
    padding: 12px 16px 6px;
  }

  .message-content {
    font-size: 1rem;
    line-height: 1.8;
  }

  .message-content :deep(h2) {
    font-size: 1.3rem;
  }

  .message-content :deep(h3) {
    font-size: 1.1rem;
  }

  .date-separator {
    margin: 20px 0 12px;
  }

  .date-separator span {
    font-size: 0.75rem;
  }

  .message-time {
    font-size: 0.7rem;
  }
}
</style>
