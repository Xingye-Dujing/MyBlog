<script setup>
import { computed } from 'vue'
import { useCommentStore } from '@/stores/comment'
import { renderMarkdown } from '@/composables/useMarkdown'

const props = defineProps({
  chatId: { type: String, required: true }
})

const commentStore = useCommentStore()

const comments = computed(() => {
  return commentStore.getMessageComments(props.chatId, null)
    .sort((a, b) => a.timestamp - b.timestamp)
})

const commentCount = computed(() => comments.value.length)

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
  <div v-if="comments.length" class="chat-comment-section">
    <div class="section-header">
      <h3>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        评论区
      </h3>
      <span class="comment-total">{{ commentCount }} 条评论</span>
    </div>

    <!-- Comments list -->
    <div class="comments-list">
      <div v-for="comment in comments" :key="comment.id" class="comment-item">
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
</template>

<style scoped>
.chat-comment-section {
  border-top: 1.5px solid #e0e0e0;
  background: #fafafa;
  padding: 24px;
  margin-top: 24px;
  border-radius: 8px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
}

.section-header h3 {
  font-size: 1.1rem;
  font-weight: 400;
  color: #000;
  margin: 0;
  letter-spacing: 1px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-header h3 svg {
  width: 20px;
  height: 20px;
  color: #c9372e;
}

.comment-total {
  font-size: 0.8rem;
  color: #999;
  margin-left: auto;
}

.comments-list {
  margin-bottom: 0;
}

.comment-item {
  display: flex;
  gap: 12px;
  padding: 16px 0;
  border-bottom: 1px solid #f0f0f0;
}

.comment-item:last-child {
  border-bottom: none;
}

.comment-avatar {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  background: linear-gradient(135deg, #c9372e, #a52d25);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.comment-avatar svg {
  width: 24px;
  height: 24px;
}

.comment-content {
  flex: 1;
  min-width: 0;
}

.comment-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.comment-author {
  font-size: 0.9rem;
  font-weight: 500;
  color: #333;
}

.comment-time {
  font-size: 0.8rem;
  color: #bbb;
}

.comment-text {
  font-size: 0.95rem;
  line-height: 1.7;
  color: #444;
}

.comment-text :deep(p) {
  margin: 0 0 8px;
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
  .chat-comment-section {
    padding: 16px;
    margin-top: 16px;
    border-radius: 6px;
  }

  .comment-avatar {
    width: 32px;
    height: 32px;
  }

  .comment-avatar svg {
    width: 20px;
    height: 20px;
  }

  .comment-item {
    gap: 10px;
    padding: 12px 0;
  }

  .comment-author {
    font-size: 0.85rem;
  }

  .comment-time {
    font-size: 0.75rem;
  }

  .comment-text {
    font-size: 0.9rem;
  }
}
</style>
