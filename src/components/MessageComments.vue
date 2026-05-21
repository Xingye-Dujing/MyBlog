<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useCommentStore } from '@/stores/comment'
import { renderMarkdown } from '@/composables/useMarkdown'

const props = defineProps({
  chatId: { type: String, required: true },
  messageId: { type: String, required: true }
})

const commentStore = useCommentStore()

const showComments = ref(false)
const newCommentContent = ref('')
const isSubmitting = ref(false)
const commentsRef = ref(null)
const isDev = !import.meta.env.PROD

const comments = computed(() => {
  return commentStore.getMessageComments(props.chatId, props.messageId)
    .sort((a, b) => a.timestamp - b.timestamp)
})

const commentCount = computed(() => comments.value.length)

function toggleComments(e) {
  e.stopPropagation()
  showComments.value = !showComments.value
}

// Close panel when clicking outside
function handleClickOutside(e) {
  if (commentsRef.value && !commentsRef.value.contains(e.target)) {
    showComments.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})

function submitComment() {
  const content = newCommentContent.value.trim()
  if (!content || isSubmitting.value) return

  isSubmitting.value = true
  commentStore.addMessageComment(props.chatId, props.messageId, content)
  newCommentContent.value = ''
  isSubmitting.value = false

  // Sync to file only in dev mode
  if (isDev) {
    commentStore.syncToFile()
  }
}

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submitComment()
  }
}

function deleteComment(commentId) {
  if (!isDev) return
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
  <div class="message-comments" ref="commentsRef">
    <button class="comment-toggle-btn" @click="toggleComments" :class="{ 'has-comments': commentCount > 0 }"
      title="查看评论">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span v-if="commentCount > 0" class="comment-badge">{{ commentCount }}</span>
    </button>

    <transition name="slide-down">
      <div v-if="showComments" class="comments-panel" @click.stop>
        <div class="comments-header">
          <h4>评论</h4>
          <span class="comment-total">{{ commentCount }} 条评论</span>
        </div>

        <!-- Comments list -->
        <div class="comments-list">
          <div v-if="!comments.length" class="no-comments">
            <p>暂无评论，快来抢沙发吧～</p>
          </div>
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
              <button v-if="isDev" class="comment-delete" @click="deleteComment(comment.id)" title="删除评论">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Comment input -->
        <div class="comment-input-area">
          <textarea v-model="newCommentContent" class="comment-input" placeholder="写下你的评论...（按 Enter 发送，Shift+Enter 换行）"
            rows="2" @keydown="handleKeydown"></textarea>
          <button class="submit-comment-btn" :disabled="!newCommentContent.trim() || isSubmitting"
            @click="submitComment">
            发送
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.message-comments {
  position: relative;
  display: flex;
  align-items: center;
}

.comment-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 28px;
  height: 28px;
  padding: 5px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: #999;
  border-radius: 4px;
  transition: all 0.2s;
  position: relative;
}

.comment-toggle-btn:hover {
  background: #e8e8e8;
  color: #333;
}

.comment-toggle-btn svg {
  width: 100%;
  height: 100%;
}

.comment-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: #c9372e;
  color: #fff;
  font-size: 0.65rem;
  padding: 1px 4px;
  border-radius: 8px;
  min-width: 14px;
  text-align: center;
  font-weight: 500;
}

.comments-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  width: 320px;
  max-width: 90vw;
  padding: 16px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
  border: 1px solid #e8e8e8;
  z-index: 100;
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.2s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.comments-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e0e0e0;
}

.comments-header h4 {
  font-size: 0.9rem;
  font-weight: 500;
  color: #333;
  margin: 0;
}

.comment-total {
  font-size: 0.75rem;
  color: #999;
}

.comments-list {
  padding-right: 2px;
  max-height: 300px;
  overflow-y: auto;
  margin-bottom: 12px;
}

.no-comments {
  text-align: center;
  padding: 20px;
  color: #ccc;
  font-size: 0.85rem;
}

.comment-item {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #f5f5f5;
}

.comment-item:last-child {
  border-bottom: none;
}

.comment-avatar {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  background: linear-gradient(135deg, #c9372e, #a52d25);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.comment-avatar svg {
  width: 18px;
  height: 18px;
}

.comment-content {
  flex: 1;
  min-width: 0;
  position: relative;
}

.comment-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.comment-author {
  font-size: 0.8rem;
  font-weight: 500;
  color: #333;
}

.comment-time {
  font-size: 0.7rem;
  color: #bbb;
}

.comment-text {
  font-size: 0.85rem;
  line-height: 1.5;
  color: #444;
}

.comment-text :deep(p) {
  margin: 0;
}

.comment-text :deep(a) {
  color: #c9372e;
  text-decoration: underline;
}

.comment-text :deep(code) {
  background: #e8e8e8;
  padding: 2px 4px;
  border-radius: 3px;
  color: #c9372e;
}

.comment-delete {
  position: absolute;
  top: 0;
  right: 0;
  width: 20px;
  height: 20px;
  padding: 2px;
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
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e0e0e0;
}

.comment-input {
  flex: 1;
  border: 1.5px solid #e0e0e0;
  border-radius: 6px;
  padding: 6px 10px;
  font-family: serif;
  font-size: 0.85rem;
  resize: none;
  min-height: 36px;
  outline: none;
  transition: border-color 0.2s;
}

.comment-input:focus {
  border-color: #c9372e;
}

.submit-comment-btn {
  padding: 6px 16px;
  background: #c9372e;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-family: serif;
  font-size: 0.8rem;
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}

.submit-comment-btn:hover:not(:disabled) {
  background: #a52d25;
}

.submit-comment-btn:disabled {
  background: #e0e0e0;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .comments-panel {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: 0;
    top: auto;
    max-width: none;
    width: auto;
    border-radius: 16px 16px 0 0;
    z-index: 1000;
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
  }

  .slide-down-enter-from,
  .slide-down-leave-to {
    transform: translateY(100%);
  }

  .comment-avatar {
    width: 24px;
    height: 24px;
  }

  .comment-avatar svg {
    width: 16px;
    height: 16px;
  }

  .comment-delete {
    opacity: 1;
    position: static;
    margin-top: 6px;
  }

  .comment-input-area {
    flex-direction: column;
  }

  .submit-comment-btn {
    width: 100%;
    padding: 8px;
  }
}
</style>
