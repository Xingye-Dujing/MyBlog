import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useCommentStore = defineStore('comment', () => {
  const comments = ref([])

  // Get comments for a specific chat (function, not computed)
  function getChatComments(chatId) {
    return comments.value.filter((c) => c.chatId === chatId)
  }

  // Get comments for a specific message (function, not computed)
  function getMessageComments(chatId, messageId) {
    return comments.value.filter((c) => c.chatId === chatId && c.messageId === messageId)
  }

  async function init() {
    console.log('[CommentStore] init() called')

    // Load from static JSON file
    console.log('[CommentStore] Trying to load from /data/comments.json')
    try {
      const res = await fetch('/data/comments.json')
      console.log('[CommentStore] Static file response status:', res.status, res.ok)
      if (res.ok) {
        comments.value = await res.json()
        console.log('[CommentStore] Loaded from static file, count:', comments.value.length)
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
  }

  return {
    comments,
    init,
    getChatComments,
    getMessageComments,
  }
})
