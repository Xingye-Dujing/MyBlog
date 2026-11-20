import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const DATA_URL = `${import.meta.env.BASE_URL}data/chats.json`

// 静态数据里曾出现整条消息重复（id 完全相同）：Vue 的 :key、深链接与大纲跳转都
// 依赖消息 id 唯一。加载时做一次防御性去重，避免数据回归时再次引发渲染/定位错乱。
function normalizeChats(data) {
  if (!Array.isArray(data)) throw new Error('数据格式无效')
  return data.map((chat) => {
    if (!chat || !Array.isArray(chat.messages)) return chat
    const seen = new Set()
    const messages = []
    for (const msg of chat.messages) {
      const key = msg && msg.id != null ? msg.id : `__idx_${messages.length}`
      if (seen.has(key)) continue
      seen.add(key)
      messages.push(msg)
    }
    if (messages.length === chat.messages.length) return chat
    console.warn(`[ChatStore] 对话 ${chat.id} 存在重复消息 id，已去重 ${chat.messages.length - messages.length} 条`)
    return { ...chat, messages }
  })
}

export const useChatStore = defineStore('chat', () => {
  const chats = ref([])
  const isInitialized = ref(false)
  const loading = ref(false)
  const error = ref('')

  const sortedChats = computed(() =>
    [...chats.value].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.updatedAt - a.updatedAt
    }),
  )

  async function init() {
    // 失败后 error 有值：允许再次调用以真正重试（否则“重试”按钮无效）。
    if ((isInitialized.value && !error.value) || loading.value) return
    loading.value = true
    error.value = ''
    try {
      // 静态文件始终取最新内容；使用部署 base，兼容非根目录部署。
      const res = await fetch(DATA_URL, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      chats.value = normalizeChats(data)
    } catch (err) {
      console.error('[ChatStore] 加载失败:', err)
      error.value = '对话数据加载失败，请检查网络后刷新重试。'
      chats.value = []
    } finally {
      loading.value = false
      isInitialized.value = true
    }
  }

  return {
    chats,
    isInitialized,
    loading,
    error,
    sortedChats,
    init,
  }
})
