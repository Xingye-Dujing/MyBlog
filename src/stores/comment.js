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
    if (initialized.value) {
      console.log('[CommentStore] Already initialized, skipping')
      return
    }
    
    console.log('[CommentStore] init() called')

    // Priority 1: localStorage
    const saved = localStorage.getItem(STORAGE_KEY)
    console.log('[CommentStore] Checking localStorage, has data:', !!saved)
    
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        // Only use localStorage data if it's not empty
        if (Array.isArray(parsed) && parsed.length > 0) {
          comments.value = parsed
          console.log('[CommentStore] Loaded from localStorage, count:', comments.value.length)
          initialized.value = true
          return
        } else {
          console.log('[CommentStore] localStorage data is empty, continuing to load from file')
        }
      } catch (e) {
        console.warn('[CommentStore] localStorage parse error:', e)
      }
    }

    // Priority 2: Load from static JSON file
    console.log('[CommentStore] Trying to load from /data/comments.json')
    try {
      const res = await fetch('/data/comments.json')
      console.log('[CommentStore] Static file response status:', res.status, res.ok)
      if (res.ok) {
        comments.value = await res.json()
        console.log('[CommentStore] Loaded from static file, count:', comments.value.length)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(comments.value))
        initialized.value = true
        return
      } else {
        console.error('[CommentStore] Static file fetch failed, status:', res.status)
      }
    } catch (error) {
      console.error('[CommentStore] Failed to load comments data from static file:', error)
    }

    // Fallback: empty data
    console.log('[CommentStore] Fallback to empty data')
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

  // Delete a comment - disabled in production
  function deleteComment(commentId) {
    if (import.meta.env.PROD) return
    const index = comments.value.findIndex(c => c.id === commentId)
    if (index !== -1) {
      comments.value.splice(index, 1)
    }
  }

  // Delete all comments for a chat - disabled in production
  function deleteChatComments(chatId) {
    if (import.meta.env.PROD) return
    comments.value = comments.value.filter(c => c.chatId !== chatId)
  }

  // Delete comments for a specific message - disabled in production
  function deleteMessageComments(chatId, messageId) {
    if (import.meta.env.PROD) return
    comments.value = comments.value.filter(c => !(c.chatId === chatId && c.messageId === messageId))
  }

  // Sync comments to file - disabled (read-only mode)
  async function syncToFile() {
    return false
  }

  // Filter out orphaned comments
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
    const blob = new Blob([JSON.stringify(comments.value, null, 2)], { type: 'application/json;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'blog-comments.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Import comments from JSON - disabled in production
  function importJSON(jsonData) {
    if (import.meta.env.PROD) return false
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
