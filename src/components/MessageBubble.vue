<script setup>
import { computed, ref } from 'vue'
import { renderMarkdown } from '@/composables/useMarkdown'

const props = defineProps({
  message: { type: Object, required: true },
  showDate: { type: Boolean, default: false },
  moveClass: { type: String, default: '' }
})

const emit = defineEmits(['edit', 'delete', 'move', 'insert'])

const showHistory = ref(false)

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

const editHistoryStr = computed(() => {
  if (!props.message.editHistory || props.message.editHistory.length === 0) return ''
  return props.message.editHistory.map(ts => {
    const d = new Date(ts)
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const da = String(d.getDate()).padStart(2, '0')
    return `${mo}-${da} ${h}:${m}`
  }).join(' · ')
})

const hasEditHistory = computed(() => {
  return props.message.editHistory && props.message.editHistory.length > 0
})

const timelineEvents = computed(() => {
  if (!props.message.editHistory || props.message.editHistory.length === 0) return []

  const events = [{
    type: 'create',
    timestamp: props.message.timestamp,
    label: '创建'
  }]

  props.message.editHistory.forEach((ts, index) => {
    events.push({
      type: 'edit',
      timestamp: ts,
      label: `第 ${index + 1} 次编辑`
    })
  })

  return events
})

function formatTimelineTime(ts) {
  const d = new Date(ts)
  const now = new Date()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')

  if (d.toDateString() === now.toDateString()) {
    return `今天 ${h}:${m}`
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) {
    return `昨天 ${h}:${m}`
  }

  return `${mo}-${da} ${h}:${m}`
}
</script>

<template>
  <div class="message-wrapper" :class="moveClass">
    <div v-if="showDate" class="date-separator">
      <span>{{ dateStr }}</span>
    </div>
    <div class="message-bubble">
      <div class="message-content" v-html="rendered"></div>
      <div class="message-footer">
        <div class="footer-left">
          <span class="message-time">{{ timeStr }}</span>
          <span v-if="hasEditHistory" class="edit-history" @click="showHistory = true"
            :title="`编辑时间：${editHistoryStr}`">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </span>
        </div>
        <div class="message-actions">
          <button class="action-btn" title="上移" @click="emit('move', message, 'up')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button class="action-btn" title="下移" @click="emit('move', message, 'down')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button class="action-btn" title="在上方插入" @click="emit('insert', message, 'above')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button class="action-btn" title="在下方插入" @click="emit('insert', message, 'below')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
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

    <!-- History Timeline Modal -->
    <div v-if="showHistory" class="history-overlay" @click="showHistory = false">
      <div class="history-modal" @click.stop>
        <div class="history-header">
          <h3>编辑历史</h3>
          <button class="history-close" @click="showHistory = false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div class="history-timeline">
          <div v-for="(event, index) in timelineEvents" :key="index" class="timeline-item">
            <div class="timeline-dot" :class="event.type">
              <svg v-if="event.type === 'create'" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </div>
            <div class="timeline-content">
              <span class="timeline-label">{{ event.label }}</span>
              <span class="timeline-time">{{ formatTimelineTime(event.timestamp) }}</span>
            </div>
            <div v-if="index < timelineEvents.length - 1" class="timeline-line"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-wrapper {
  margin-bottom: 8px;
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease;
}

.message-wrapper.move-up {
  animation: moveUp 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.message-wrapper.move-down {
  animation: moveDown 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes moveUp {
  0% {
    transform: translateY(-20px);
    opacity: 0.5;
  }

  100% {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes moveDown {
  0% {
    transform: translateY(20px);
    opacity: 0.5;
  }

  100% {
    transform: translateY(0);
    opacity: 1;
  }
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

.footer-left {
  display: flex;
  align-items: center;
  gap: 8px;
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

.edit-history {
  display: flex;
  align-items: center;
  cursor: help;
}

.edit-history svg {
  width: 14px;
  height: 14px;
  color: #999;
}

.edit-history:hover svg {
  opacity: 1;
}

/* History Timeline Modal */
.history-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.2s ease;
}

.history-modal {
  background: #fff;
  border-radius: 12px;
  width: 90%;
  max-width: 360px;
  padding: 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1.5px solid #f0f0f0;
}

.history-header h3 {
  font-size: 1rem;
  font-weight: 400;
  color: #000;
  margin: 0;
  letter-spacing: 1px;
}

.history-close {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 6px;
  color: #666;
  border-radius: 6px;
  transition: all 0.2s;
}

.history-close:hover {
  background: #f0f0f0;
  color: #000;
}

.history-close svg {
  width: 100%;
  height: 100%;
}

.history-timeline {
  position: relative;
  padding-left: 20px;
}

.timeline-item {
  position: relative;
  padding-bottom: 20px;
}

.timeline-dot {
  position: absolute;
  left: -24px;
  top: 4px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  border: 2px solid #c9372e;
  z-index: 1;
}

.timeline-dot.create {
  background: #c9372e;
  border-color: #c9372e;
}

.timeline-dot svg {
  width: 12px;
  height: 12px;
}

.timeline-dot.create svg {
  stroke: #fff;
}

.timeline-dot:not(.create) svg {
  stroke: #c9372e;
}

.timeline-content {
  margin-left: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.timeline-label {
  font-size: 0.9rem;
  color: #333;
  font-weight: 400;
}

.timeline-time {
  font-size: 0.75rem;
  color: #999;
}

.timeline-line {
  position: absolute;
  left: -16px;
  top: 24px;
  bottom: 0;
  width: 2px;
  background: linear-gradient(to bottom, #e0e0e0, transparent);
}

@media (max-width: 768px) {
  .history-modal {
    width: 95%;
  }

  .timeline-label {
    font-size: 0.85rem;
  }

  .timeline-time {
    font-size: 0.7rem;
  }

  .timeline-dot {
    width: 18px;
    height: 18px;
    left: -22px;
  }

  .timeline-dot svg {
    width: 10px;
    height: 10px;
  }
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
    gap: 2px;
  }

  .action-btn {
    padding: 3px;
  }

  .footer-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .edit-history svg {
    width: 14px;
    height: 14px;
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
