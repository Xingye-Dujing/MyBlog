<script setup>
import { computed } from 'vue'
import { renderMarkdown } from '@/composables/useMarkdown'

const props = defineProps({
  message: { type: Object, required: true },
  showDate: { type: Boolean, default: false }
})

const emit = defineEmits(['edit', 'delete'])

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
  return `${y} 年 ${mo} 月 ${da} 日 星期${weekdays[d.getDay()]}`
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
        <div class="message-actions">
          <button class="action-btn" title="编辑" @click="emit('edit', message)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button class="action-btn action-delete" title="删除" @click="emit('delete', message)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
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
  position: relative;
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

.message-content :deep(blockquote) {
  border-left: 3px solid #c9372e;
  margin: 12px 0;
  padding: 8px 16px;
  color: #555;
  background: #f9f9f9;
}

.message-content :deep(pre.hljs) {
  background: #f6f6f6;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  padding: 16px;
  margin: 12px 0;
  overflow-x: auto;
  font-size: 0.9rem;
  line-height: 1.6;
}

.message-content :deep(pre.hljs code) {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}

.message-content :deep(code) {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 0.9em;
  color: #c9372e;
}

.message-content :deep(pre code) {
  background: none;
  padding: 0;
  color: inherit;
}

.message-content :deep(ul),
.message-content :deep(ol) {
  margin: 8px 0;
  padding-left: 24px;
}

.message-content :deep(li) {
  margin-bottom: 4px;
}

.message-content :deep(img) {
  max-width: 100%;
  border-radius: 8px;
  margin: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

/* Multi-image container for essay-style layout */
.message-content :deep(p:has(img)) {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 16px;
  margin: 16px 0;
}

/* Desktop: uniform height, auto width */
.message-content :deep(p:has(img) img) {
  height: 280px;
  width: auto;
  object-fit: cover;
  margin: 0;
  border: 2px solid #fff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

/* Middle divider image: smaller, circular */
.message-content :deep(p:has(img) img[alt="ZS"]) {
  height: 40px;
  width: 40px;
  border-radius: 50%;
  flex-shrink: 0;
  border: 2px solid #fff;
}

.message-content :deep(.katex-display) {
  margin: 16px 0;
  overflow-x: auto;
}

.message-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
}

.message-content :deep(th),
.message-content :deep(td) {
  border: 1px solid #e0e0e0;
  padding: 8px 12px;
  text-align: left;
}

.message-content :deep(th) {
  background: #f6f6f6;
  font-weight: 500;
}

.message-content :deep(hr) {
  border: none;
  border-top: 1px solid #e0e0e0;
  margin: 16px 0;
}

.message-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  padding-top: 4px;
}

.message-time {
  font-size: 0.75rem;
  color: #bbb;
  letter-spacing: 0.5px;
  transition: color 0.2s;
}

.message-bubble:hover .message-time {
  color: #999;
}

.message-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.message-bubble:hover .message-actions {
  opacity: 1;
}

.action-btn {
  width: 28px;
  height: 28px;
  padding: 5px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 4px;
  color: #999;
  transition: all 0.2s;
}

.action-btn:hover {
  background: #e8e8e8;
  color: #333;
}

.action-btn svg {
  width: 100%;
  height: 100%;
}

.action-delete:hover {
  background: #fee;
  color: #c9372e;
}

@media (max-width: 768px) {
  .message-bubble {
    padding: 12px 14px 6px;
  }

  .message-bubble:hover {
    background: #fafafa;
    border-left-color: transparent;
  }

  .message-content {
    font-size: 0.95rem;
    line-height: 1.8;
  }

  .message-content :deep(h2) {
    font-size: 1.25rem;
    letter-spacing: 1px;
  }

  .message-content :deep(h3) {
    font-size: 1.1rem;
  }

  .message-content :deep(pre.hljs) {
    font-size: 0.78rem;
    padding: 12px;
    border-radius: 4px;
    -webkit-overflow-scrolling: touch;
  }

  .message-content :deep(code) {
    font-size: 0.82em;
  }

  .message-content :deep(.katex-display) {
    margin: 12px -14px;
    padding: 0 14px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .message-content :deep(table) {
    display: block;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .message-content :deep(blockquote) {
    margin: 8px 0;
    padding: 6px 12px;
  }

  .message-content :deep(img) {
    border-radius: 6px;
  }

  /* Mobile: stack images vertically with uniform width */
  .message-content :deep(p:has(img)) {
    flex-direction: column;
    gap: 12px;
    margin: 12px 0;
  }

  /* Mobile: uniform width, auto height to maintain aspect ratio */
  .message-content :deep(p:has(img) img) {
    width: 280px;
    max-width: 90%;
    height: auto;
    align-self: center;
  }

  .message-content :deep(p:has(img) img[alt="ZS"]) {
    width: 32px;
    height: 32px;
    align-self: center;
  }

  .message-actions {
    opacity: 1;
  }

  .action-btn {
    width: 32px;
    height: 32px;
    padding: 6px;
  }

  .date-separator {
    margin: 16px 0 12px;
  }

  .date-separator::before,
  .date-separator::after {
    width: calc(50% - 80px);
  }

  .date-separator span {
    font-size: 0.72rem;
    padding: 0 10px;
  }

  .message-time {
    font-size: 0.7rem;
  }
}

@media print {
  .message-actions {
    display: none;
  }

  .message-bubble {
    border-left-color: #000 !important;
    background: none !important;
  }

  .date-separator::before,
  .date-separator::after {
    background: #000;
  }
}
</style>
