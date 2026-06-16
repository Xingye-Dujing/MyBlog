<script setup>
import { ref, computed } from 'vue'
import { useCommentStore } from '@/stores/comment'
import { renderMarkdown } from '@/composables/useMarkdown'

const props = defineProps({
  chatId: { type: String, required: true },
})

const commentStore = useCommentStore()

const newCommentContent = ref('')
const isSubmitting = ref(false)

const comments = computed(() => {
  return commentStore
    .getMessageComments(props.chatId, null)
    .sort((a, b) => a.timestamp - b.timestamp)
})

const commentCount = computed(() => comments.value.length)

function submitComment() {
  const content = newCommentContent.value.trim()
  if (!content || isSubmitting.value) return

  isSubmitting.value = true
  commentStore.addChatComment(props.chatId, content)
  newCommentContent.value = ''
  isSubmitting.value = false

  // Sync to file in dev mode
  commentStore.syncToFile()
}

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submitComment()
  }
}

function deleteComment(commentId) {
  if (confirm('确定要删除这条评论吗？')) {
    commentStore.deleteComment(commentId)
    commentStore.syncToFile()
  }
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
  <div class="chat-comment-section">
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
      <div v-if="!comments.length" class="no-comments">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <p>暂无评论，快来发表你的看法吧～</p>
      </div>
      <div v-for="comment in comments" :key="comment.id" class="comment-item">
        <div class="comment-avatar">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path
              d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
            />
          </svg>
        </div>
        <div class="comment-content">
          <div class="comment-meta">
            <span class="comment-author">{{ comment.author }}</span>
            <span class="comment-time">{{ formatTime(comment.timestamp) }}</span>
          </div>
          <div class="comment-text" v-html="renderMarkdown(comment.content)"></div>
          <button class="comment-delete" @click="deleteComment(comment.id)" title="删除评论">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6" />
              <path
                d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Comment input -->
    <div class="comment-input-area">
      <textarea
        v-model="newCommentContent"
        class="comment-input"
        placeholder="写下你的评论...（按 Enter 发送，Shift+Enter 换行）"
        rows="3"
        @keydown="handleKeydown"
      ></textarea>
      <button
        class="submit-comment-btn"
        :disabled="!newCommentContent.trim() || isSubmitting"
        @click="submitComment"
      >
        发表评论
      </button>
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
  margin-bottom: 20px;
}

.no-comments {
  text-align: center;
  padding: 40px 20px;
  color: #ccc;
}

.no-comments svg {
  width: 48px;
  height: 48px;
  margin-bottom: 12px;
  opacity: 0.5;
}

.no-comments p {
  font-size: 0.9rem;
  margin: 0;
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
  position: relative;
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

.comment-text :deep(strong) {
  font-weight: 600;
}

.comment-text :deep(em) {
  font-style: italic;
}

.comment-text :deep(code) {
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 0.9em;
  color: #c9372e;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}

.comment-text :deep(pre) {
  background: #f6f6f6;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  padding: 12px;
  margin: 8px 0;
  overflow-x: auto;
  font-size: 0.85rem;
  line-height: 1.6;
}

.comment-text :deep(pre code) {
  background: none;
  padding: 0;
  color: inherit;
}

.comment-text :deep(blockquote) {
  border-left: 3px solid #c9372e;
  margin: 8px 0;
  padding: 8px 12px;
  color: #555;
  background: #f9f9f9;
}

.comment-delete {
  position: absolute;
  top: 0;
  right: 0;
  width: 28px;
  height: 28px;
  padding: 4px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: #ccc;
  border-radius: 4px;
  opacity: 0;
  transition: all 0.2s;
}

.comment-item:hover .comment-delete {
  opacity: 1;
}

.comment-delete:hover {
  background: #fee;
  color: #c9372e;
}

.comment-delete svg {
  width: 100%;
  height: 100%;
}

.comment-input-area {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

.comment-input {
  flex: 1;
  border: 1.5px solid #e0e0e0;
  border-radius: 6px;
  padding: 12px 16px;
  font-family: serif;
  font-size: 0.95rem;
  resize: none;
  min-height: 80px;
  outline: none;
  transition: border-color 0.2s;
}

.comment-input:focus {
  border-color: #c9372e;
}

.submit-comment-btn {
  padding: 12px 24px;
  background: #c9372e;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-family: serif;
  font-size: 0.9rem;
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
  align-self: flex-start;
}

.submit-comment-btn:hover:not(:disabled) {
  background: #a52d25;
}

.submit-comment-btn:disabled {
  background: #e0e0e0;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .chat-comment-section {
    padding: 16px 12px;
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
    margin-top: 16px;
    border-radius: 0;
  }

  .section-header {
    margin-bottom: 16px;
  }

  .section-header h3 {
    font-size: 1rem;
  }

  .section-header h3 svg {
    width: 18px;
    height: 18px;
  }

  .comment-item {
    gap: 10px;
    padding: 12px 0;
  }

  .comment-avatar {
    width: 36px;
    height: 36px;
  }

  .comment-avatar svg {
    width: 20px;
    height: 20px;
  }

  .comment-author {
    font-size: 0.85rem;
  }

  .comment-text {
    font-size: 0.9rem;
  }

  .comment-delete {
    opacity: 1;
    position: static;
    margin-top: 8px;
  }

  .comment-input-area {
    flex-direction: column;
  }

  .comment-input {
    min-height: 60px;
    font-size: 0.9rem;
  }

  .submit-comment-btn {
    width: 100%;
    padding: 12px;
    font-size: 0.9rem;
  }

  .no-comments {
    padding: 30px 16px;
  }

  .no-comments svg {
    width: 40px;
    height: 40px;
  }
}
</style>
