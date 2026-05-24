<script setup>
import { ref, computed } from 'vue'
import { renderMarkdown } from '@/composables/useMarkdown'
import { useCommentStore } from '@/stores/comment'

const props = defineProps({
  message: { type: Object, required: true },
  showDate: { type: Boolean, default: false }
})
const commentStore = useCommentStore()
const isCommentsExpanded = ref(false)
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

// Get comments for this specific message
const messageComments = computed(() => {
  return commentStore.getMessageComments(props.message.chatId, props.message.id)
    .sort((a, b) => a.timestamp - b.timestamp)
})

const commentCount = computed(() => messageComments.value.length)

function toggleComments() {
  isCommentsExpanded.value = !isCommentsExpanded.value
}

function formatTime(timestamp) {
  const d = new Date(timestamp)
  const now = new Date()
  const diff = now - d
  const oneMinute = 60000
  const oneHour = 3600000
  const oneDay = 86400000

  if (diff < oneMinute) {
    return '刚刚'
  } else if (diff < oneHour) {
    const mins = Math.floor(diff / oneMinute)
    return `${mins}分钟前`
  } else if (diff < oneDay) {
    const hours = Math.floor(diff / oneHour)
    return `${hours}小时前`
  } else if (diff < oneDay * 7) {
    const days = Math.floor(diff / oneDay)
    return `${days}天前`
  } else {
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const da = String(d.getDate()).padStart(2, '0')
    return `${mo}-${da}`
  }
}
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
        <button v-if="commentCount > 0"
          class="comment-toggle-btn"
          @click.stop="toggleComments"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>{{ commentCount }} 条评论</span>
        </button>
      </div>

      <!-- Message comments section -->
      <div v-if="commentCount > 0 && isCommentsExpanded" class="message-comments">
        <div v-for="comment in messageComments" :key="comment.id" class="comment-item">
          <div class="comment-avatar">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path
                d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
            </svg>
          </div>
          <div class="comment-content">
            <div class="comment-meta">
              <span class="comment-author">{{ comment.author }}</span>
              <span class="comment-time">{{ formatTime(comment.timestamp) }}</span>
            </div>
            <div class="comment-text" v-html="renderMarkdown(comment.content)"></div>
          </div>
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
  padding: 16px 26px 8px;
  border-left: 3px solid transparent;
  border-radius: 2px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.message-bubble:hover {
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
  word-wrap: break-word;
}

.message-content :deep(a:hover) {
  opacity: 0.6;
}

.message-content :deep(strong) {
  font-weight: bold;
  color: #000;
}

.message-content :deep(em) {
  font-style: italic;
  color: #555;
}

.message-content :deep(pre.hljs) {
  background: #f6f6f6;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  padding: 16px;
  margin: 12px 0;
  overflow-x: auto;
  line-height: 1.6;
}

.message-content :deep(pre.hljs code) {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  color: #333333d5;
}

.message-content :deep(code) {
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 0.9em;
  color: #c9372e;
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
  object-fit: contain;
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

.message-content :deep(blockquote) {
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
  font-weight: bold;
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

.comment-badge {
  font-size: 0.7rem;
  color: #c9372e;
  background: #fff5f5;
  padding: 2px 8px;
  border-radius: 10px;
  margin-left: 8px;
}

.comment-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.2s;
  color: #999;
  font-size: 0.75rem;
  margin-left: auto;
}

.comment-toggle-btn:hover {
  background: #f0f0f0;
  color: #c9372e;
}

.comment-toggle-btn svg {
  width: 16px;
  height: 16px;
}

.message-comments {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
}

.message-comments :deep(code){
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  color: #c9372e;
}

.comment-item {
  display: flex;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid #f5f5f5;
}

.comment-item:last-child {
  border-bottom: none;
}

.comment-avatar {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  background: linear-gradient(135deg, #c9372e, #a52d25);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.comment-avatar svg {
  width: 20px;
  height: 20px;
}

.comment-content {
  flex: 1;
  min-width: 0;
}

.comment-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.comment-author {
  font-size: 0.85rem;
  font-weight: 500;
  color: #333;
}

.comment-time {
  font-size: 0.75rem;
  color: #bbb;
}

.comment-text {
  font-size: 0.9rem;
  line-height: 1.6;
  color: #444;
}

.comment-text :deep(p) {
  margin: 0 0 6px;
}

.comment-text :deep(p:last-child) {
  margin-bottom: 0;
}

.comment-text :deep(a) {
  color: #c9372e;
  text-decoration: underline;
}

.comment-text :deep(code) {
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Consolas', monospace;
  font-size: 0.9em;
}

@media (max-width: 768px) {
  .message-bubble {
    padding: 10px 14px 6px;
  }

  .message-bubble:hover {
    border-left-color: transparent;
  }

  .message-content {
    font-size: 0.85rem;
    line-height: 1.7;
  }

  .message-content :deep(h2) {
    font-size: 1.2rem;
    margin: 6px 0 10px;
    padding-bottom: 6px;
  }

  .message-content :deep(h3) {
    font-size: 1.05rem;
    margin: 6px 0 6px;
  }

  .message-content :deep(p) {
    margin: 0 0 10px;
  }

  .message-content :deep(pre) {
    padding: 10px;
    margin: 10px 0;
  }

  .message-content :deep(ul),
  .message-content :deep(ol) {
    margin: 10px 0;
    padding-left: 20px;
  }

  .message-content :deep(hr) {
    margin: 14px 0;
  }

  .message-content :deep(table) {
    margin: 10px 0;
  }

  .message-content :deep(th),
  .message-content :deep(td) {
    padding: 6px;
  }

  .date-separator {
    margin: 4px 0 4px;
  }

  .date-separator span {
    font-size: 0.7rem;
    padding: 0 12px;
  }

  .message-time {
    font-size: 0.65rem;
  }

  .comment-toggle-btn {
    padding: 3px 6px;
    font-size: 0.7rem;
  }

  .comment-toggle-btn svg {
    width: 14px;
    height: 14px;
  }

  .message-comments {
    margin-top: 10px;
    padding-top: 10px;
  }

  .comment-item {
    gap: 8px;
    padding: 8px 0;
  }

  .comment-avatar {
    width: 26px;
    height: 26px;
  }

  .comment-avatar svg {
    width: 16px;
    height: 16px;
  }

  .comment-meta {
    gap: 6px;
    margin-bottom: 5px;
  }

  .comment-author {
    font-size: 0.8rem;
  }

  .comment-time {
    font-size: 0.65rem;
  }

  .comment-text {
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .comment-text :deep(p) {
    margin: 0 0 5px;
  }
}
</style>