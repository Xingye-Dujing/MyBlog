import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const STORAGE_KEY = 'blog-comments'

export const useCommentStore = defineStore('comment', () => {
  const comments = ref([])
  const initialized = ref(false)

  // Get comments for a specific chat (function, not computed)
  function getChatComments(chatId) {
    return comments.value.filter(c => c.chatId === chatId)
  }

  // Get comments for a specific message (function, not computed)
  function getMessageComments(chatId, messageId) {
    return comments.value.filter(c => c.chatId === chatId && c.messageId === messageId)
  }

  // Get comment count for a chat (function, not computed)
  function getChatCommentCount(chatId) {
    return comments.value.filter(c => c.chatId === chatId).length
  }

  // Get comment count for a message (function, not computed)
  function getMessageCommentCount(chatId, messageId) {
    return comments.value.filter(c => c.chatId === chatId && c.messageId === messageId).length
  }

  async function init() {
    if (initialized.value) return

    // Priority 1: localStorage
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try {
        comments.value = JSON.parse(saved)
        initialized.value = true
        return
      } catch {
        // localStorage corrupted, continue to load from file
      }
    }

    // Priority 2: Load from dev API (src/data/comments.json)
    try {
      const res = await fetch('/api/load-comments')
      if (res.ok) {
        const result = await res.json()
        if (result.data && Array.isArray(result.data)) {
          comments.value = result.data
        } else if (Array.isArray(result)) {
          comments.value = result
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(comments.value))
        initialized.value = true
        return
      }
    } catch {
      // API not available, continue to fallback
    }

    // Fallback: empty data
    comments.value = []
    initialized.value = true
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(comments.value))
  }

  watch(comments, save, { deep: true })

  // Add a comment to a chat (chat-level comment)
  function addChatComment(chatId, content) {
    const comment = {
      id: 'comment-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      chatId,
      messageId: null, // null means it's a chat-level comment
      content,
      author: '访客', // Default author name
      timestamp: Date.now(),
      replies: [] // For future reply feature
    }
    comments.value.push(comment)
    return comment
  }

  // Add a comment to a specific message
  function addMessageComment(chatId, messageId, content) {
    const comment = {
      id: 'comment-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      chatId,
      messageId,
      content,
      author: '访客',
      timestamp: Date.now(),
      replies: []
    }
    comments.value.push(comment)
    return comment
  }

  // Delete a comment
  function deleteComment(commentId) {
    const index = comments.value.findIndex(c => c.id === commentId)
    if (index !== -1) {
      comments.value.splice(index, 1)
    }
  }

  // Delete all comments for a chat
  function deleteChatComments(chatId) {
    comments.value = comments.value.filter(c => c.chatId !== chatId)
  }

  // Delete comments for a specific message
  function deleteMessageComments(chatId, messageId) {
    comments.value = comments.value.filter(c => !(c.chatId === chatId && c.messageId === messageId))
  }

  // Sync comments to file
  async function syncToFile() {
    try {
      const res = await fetch('/api/save-comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(comments.value)
      })
      return res.ok
    } catch {
      return false
    }
  }

  // Filter out orphaned comments (comments whose chat/message no longer exists)
  function filterOrphanedComments(validChatIds, validMessageMap) {
    const beforeCount = comments.value.length
    comments.value = comments.value.filter(c => {
      // Check if chat exists
      if (!validChatIds.includes(c.chatId)) {
        return false
      }
      // If it's a message comment, check if message exists
      if (c.messageId && !validMessageMap[c.chatId]?.includes(c.messageId)) {
        return false
      }
      return true
    })
    return comments.value.length < beforeCount
  }

  // Export comments as JSON
  function exportJSON() {
    const blob = new Blob([JSON.stringify(comments.value, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'blog-comments.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Import comments from JSON
  function importJSON(jsonData) {
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData
      comments.value = data
      return true
    } catch {
      return false
    }
  }

  return {
    comments,
    initialized,
    getChatComments,
    getMessageComments,
    getChatCommentCount,
    getMessageCommentCount,
    init,
    addChatComment,
    addMessageComment,
    deleteComment,
    deleteChatComments,
    deleteMessageComments,
    syncToFile,
    filterOrphanedComments,
    exportJSON,
    importJSON
  }
})
