import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { getDefaultChats } from '@/data/defaultChats'

const STORAGE_KEY = 'blog-chats'
const VERSION_KEY = 'blog-chats-version'
const CURRENT_VERSION = 2

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

  function init() {
    const savedVersion = Number(localStorage.getItem(VERSION_KEY)) || 0
    if (savedVersion < CURRENT_VERSION) {
      // Version upgraded: regenerate defaults with fresh timestamps
      chats.value = getDefaultChats()
      localStorage.setItem(VERSION_KEY, String(CURRENT_VERSION))
      return
    }
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try {
        chats.value = JSON.parse(saved)
      } catch {
        chats.value = getDefaultChats()
      }
    } else {
      chats.value = getDefaultChats()
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats.value))
  }

  watch(chats, save, { deep: true })

  function createChat(title, tags = []) {
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

  function addMessage(chatId, content) {
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return null
    const msg = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      content,
      timestamp: Date.now()
    }
    chat.messages.push(msg)
    chat.updatedAt = Date.now()
    return msg
  }

  function updateMessage(chatId, messageId, content) {
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return
    const msg = chat.messages.find(m => m.id === messageId)
    if (!msg) return
    msg.content = content
    chat.updatedAt = Date.now()
  }

  function deleteMessage(chatId, messageId) {
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return
    chat.messages = chat.messages.filter(m => m.id !== messageId)
    chat.updatedAt = Date.now()
  }

  function deleteChat(chatId) {
    chats.value = chats.value.filter(c => c.id !== chatId)
    if (activeChatId.value === chatId) {
      activeChatId.value = null
    }
  }

  function updateChat(chatId, updates) {
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return
    Object.assign(chat, updates)
    chat.updatedAt = Date.now()
  }

  function togglePin(chatId) {
    const chat = chats.value.find(c => c.id === chatId)
    if (!chat) return
    chat.pinned = !chat.pinned
  }

  async function syncToFile() {
    try {
      const res = await fetch('/api/save-chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chats.value)
      })
      return res.ok
    } catch {
      return false
    }
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(chats.value, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'blog-chats.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  function importJSON(jsonData) {
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData
      chats.value = data
      return true
    } catch {
      return false
    }
  }

  function resetToDefault() {
    chats.value = getDefaultChats()
    activeChatId.value = null
  }

  return {
    chats, activeChatId, activeChat, sortedChats,
    init, createChat, addMessage, updateMessage, deleteMessage,
    deleteChat, updateChat, togglePin,
    syncToFile, exportJSON, importJSON, resetToDefault
  }
})
