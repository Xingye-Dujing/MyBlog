import { defineStore } from 'pinia'
import { ref } from 'vue'

const DATA_URL = `${import.meta.env.BASE_URL}data/comments.json`

// JSON 是外部数据：单个非字符串 content 会让 markdown-it 在渲染时抛错，
// 缺 messageId 的评论也匹配不到对应消息。统一在这里归一化。
function normalizeComments(data) {
  if (!Array.isArray(data)) return []
  return data
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      ...item,
      content: typeof item.content === 'string' ? item.content : String(item.content ?? ''),
      messageId: item.messageId == null || item.messageId === '' ? null : item.messageId,
    }))
}

export const useCommentStore = defineStore('comment', () => {
  const comments = ref([])
  const isInitialized = ref(false)
  const loading = ref(false)
  const error = ref('')

  // Get comments for a specific chat (function, not computed)
  function getChatComments(chatId) {
    return comments.value.filter((c) => c.chatId === chatId)
  }

  // Get comments for a specific message (function, not computed)
  function getMessageComments(chatId, messageId) {
    return comments.value.filter((c) => c.chatId === chatId && c.messageId === messageId)
  }

  async function init() {
    // 失败后 error 有值：允许再次调用以真正重试（否则“重试”按钮无效）。
    if ((isInitialized.value && !error.value) || loading.value) return
    loading.value = true
    error.value = ''
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!Array.isArray(data)) throw new Error('数据格式无效')
      comments.value = normalizeComments(data)
    } catch (err) {
      console.error('[CommentStore] 加载失败:', err)
      error.value = '评论数据加载失败，请刷新重试。'
      comments.value = []
    } finally {
      loading.value = false
      isInitialized.value = true
    }
  }

  return {
    comments,
    isInitialized,
    loading,
    error,
    init,
    getChatComments,
    getMessageComments,
  }
})
