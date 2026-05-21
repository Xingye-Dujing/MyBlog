import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

const STORAGE_KEY = 'blog-chats'

export const useChatStore = defineStore('chat', () => {
  const chats = ref([])
  const activeChatId = ref(null)

  const activeChat = computed(() =>
    chats.value.find(c => c.id === activeChatId.value) || null
  )

  const sortedChats = computed(() =>
    [...chats.value].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.updatedAt - a.updatedAt
    })
  )

  async function init() {
    console.log('[ChatStore] init() called')
    
    // Priority 1: localStorage (user's current data)
    const saved = localStorage.getItem(STORAGE_KEY)
    console.log('[ChatStore] Checking localStorage, has data:', !!saved)
    
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        // Only use localStorage data if it's not empty
        if (Array.isArray(parsed) && parsed.length > 0) {
          chats.value = parsed
          console.log('[ChatStore] Loaded from localStorage, count:', chats.value.length)
          return
        } else {
          console.log('[ChatStore] localStorage data is empty, continuing to load from file')
        }
      } catch (e) {
        console.warn('[ChatStore] localStorage parse error:', e)
      }
    }

    // Priority 2: Load from static JSON file
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

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats.value))
  }

  watch(chats, save, { deep: true })

  function createChat(title, tags = []) {
    if (import.meta.env.PROD) return null
    const now = Date.now()
    const id = 'chat-' + now
    const chat = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      tags,
      pinned: false,
      messages: []
    }
    chats.value.unshift(chat)
    return chat
  }

  function updateChatTitle(chatId, newTitle) {
    if (import.meta.env.PROD) return
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return
    chat.title = newTitle
    chat.updatedAt = Date.now()
  }

  function updateChatTags(chatId, tags) {
    if (import.meta.env.PROD) return
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return
    chat.tags = tags
    chat.updatedAt = Date.now()
  }

  function addMessage(chatId, content) {
    if (import.meta.env.PROD) return null
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return null
    const msg = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      content,
      timestamp: Date.now(),
      editHistory: []
    }
    chat.messages.push(msg)
    chat.updatedAt = Date.now()
    return msg
  }

  function updateMessage(chatId, messageId, content) {
    if (import.meta.env.PROD) return
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return
    const msg = chat.messages.find(m => m.id === messageId)
    if (!msg) return
    // Add to edit history (keep original timestamp, record edit times)
    if (!msg.editHistory) {
      msg.editHistory = []
    }
    msg.editHistory.push(Date.now())
    msg.content = content
    chat.updatedAt = Date.now()
  }

  function moveMessage(chatId, messageId, direction) {
    if (import.meta.env.PROD) return
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return
    const index = chat.messages.findIndex(m => m.id === messageId)
    if (index === -1) return

    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= chat.messages.length) return

      // Swap messages
      ;[chat.messages[index], chat.messages[newIndex]] = [chat.messages[newIndex], chat.messages[index]]
    chat.updatedAt = Date.now()
  }

  function insertMessage(chatId, targetMessageId, content, position) {
    if (import.meta.env.PROD) return null
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return null
    const index = chat.messages.findIndex(m => m.id === targetMessageId)
    if (index === -1) return null

    const msg = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      content,
      timestamp: Date.now(),
      editHistory: []
    }

    const insertIndex = position === 'above' ? index : index + 1
    chat.messages.splice(insertIndex, 0, msg)
    chat.updatedAt = Date.now()
    return msg
  }

  function deleteMessage(chatId, messageId) {
    if (import.meta.env.PROD) return
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return
    chat.messages = chat.messages.filter(m => m.id !== messageId)
    chat.updatedAt = Date.now()
    // Note: Comment deletion is handled by commentStore to maintain separation
  }

  function deleteChat(chatId) {
    if (import.meta.env.PROD) return
    chats.value = chats.value.filter(c => c.id !== chatId)
    if (activeChatId.value === chatId) {
      activeChatId.value = null
    }
    // Note: Comment deletion is handled by commentStore to maintain separation
  }

  function updateChat(chatId, updates) {
    if (import.meta.env.PROD) return
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return
    Object.assign(chat, updates)
    chat.updatedAt = Date.now()
  }

  function togglePin(chatId) {
    if (import.meta.env.PROD) return
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return
    chat.pinned = !chat.pinned
  }

  // Sync chats to file - disabled (read-only mode)
  async function syncToFile() {
    return false
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(chats.value, null, 2)], { type: 'application/json;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'blog-chats.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  function importJSON(jsonData) {
    if (import.meta.env.PROD) return false
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData
      chats.value = data
      return true
    } catch {
      return false
    }
  }

  function resetToDefault() {
    if (import.meta.env.PROD) return
    chats.value = []
    activeChatId.value = null
  }

  // Import from user-selected file (for cross-device sync)
  function importFromUserFile(file) {
    if (import.meta.env.PROD) return Promise.resolve(false)
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target.result)
          chats.value = data
          localStorage.setItem(STORAGE_KEY, JSON.stringify(chats.value))
          resolve(true)
        } catch {
          resolve(false)
        }
      }
      reader.onerror = () => resolve(false)
      reader.readAsText(file)
    })
  }

  return {
    chats, activeChatId, activeChat, sortedChats,
    init, createChat, addMessage, updateMessage, deleteMessage,
    deleteChat, updateChat, togglePin, updateChatTitle, updateChatTags,
    syncToFile, exportJSON, importJSON, resetToDefault, importFromUserFile,
    moveMessage, insertMessage
  }
})