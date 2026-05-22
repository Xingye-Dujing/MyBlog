import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const STORAGE_KEY = 'blog-chats'

export const useChatStore = defineStore('chat', () => {
  const chats = ref([])

  const sortedChats = computed(() =>
    [...chats.value].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.updatedAt - a.updatedAt
    })
  )

  async function init() {
    console.log('[ChatStore] init() called')

    // Load from static JSON file
    console.log('[ChatStore] Trying to load from /data/chats.json')
    try {
      const res = await fetch('/data/chats.json')
      console.log('[ChatStore] Static file response status:', res.status, res.ok)
      if (res.ok) {
        chats.value = await res.json()
        console.log('[ChatStore] Loaded from static file, count:', chats.value.length)
        // Save to localStorage for future use
        localStorage.setItem(STORAGE_KEY, JSON.stringify(chats.value))
        return
      } else {
        console.error('[ChatStore] Static file fetch failed, status:', res.status)
      }
    } catch (error) {
      console.error('[ChatStore] Failed to load chats data from static file:', error)
    }

    // Fallback: empty data
    console.log('[ChatStore] Fallback to empty data')
    chats.value = []
  }

  return {
    chats,
    sortedChats,
    init
  }
})