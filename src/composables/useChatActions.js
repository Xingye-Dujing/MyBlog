import { ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useCommentStore } from '@/stores/comment'

export function useChatActions(chat, router, inputRef) {
  const chatStore = useChatStore()
  const commentStore = useCommentStore()

  const editingMessage = ref(null)
  const insertTarget = ref(null)
  const movingMessageId = ref(null)
  const moveDirection = ref('')
  const editingTitle = ref(false)
  const titleInput = ref('')
  const showTagsEditor = ref(false)
  const tagInput = ref('')
  const showActions = ref(false)
  const syncStatus = ref('')

  function handleSend(content, onOutlineUpdate) {
    if (content === null) {
      editingMessage.value = null
      insertTarget.value = null
      return
    }
    if (editingMessage.value) {
      chatStore.updateMessage(chat.value.id, editingMessage.value.id, content)
      editingMessage.value = null
    } else if (insertTarget.value) {
      chatStore.insertMessage(
        chat.value.id,
        insertTarget.value.messageId,
        content,
        insertTarget.value.position,
      )
      insertTarget.value = null
    } else {
      chatStore.addMessage(chat.value.id, content)
    }
    onOutlineUpdate?.()
  }

  function handleEdit(msg) {
    editingMessage.value = msg
    inputRef.value?.setContent(msg.content)
  }

  function handleDelete(msg, onOutlineUpdate) {
    chatStore.deleteMessage(chat.value.id, msg.id)
    commentStore.deleteMessageComments(chat.value.id, msg.id)
    commentStore.syncToFile()
    onOutlineUpdate?.()
  }

  function handleMove(msg, direction, onOutlineUpdate) {
    movingMessageId.value = msg.id
    moveDirection.value = direction
    chatStore.moveMessage(chat.value.id, msg.id, direction)
    setTimeout(() => {
      movingMessageId.value = null
      moveDirection.value = ''
    }, 300)
    onOutlineUpdate?.()
  }

  function handleInsert(msg, position) {
    insertTarget.value = { messageId: msg.id, position }
    inputRef.value?.setContent('')
    inputRef.value?.focus()
  }

  function deleteChat() {
    if (!chat.value) return
    chatStore.deleteChat(chat.value.id)
    commentStore.deleteChatComments(chat.value.id)
    commentStore.syncToFile()
    router.push({ name: 'home' })
  }

  function togglePin() {
    if (!chat.value) return
    chatStore.togglePin(chat.value.id)
  }

  async function syncToFile() {
    const ok = await chatStore.syncToFile()
    syncStatus.value = ok ? 'success' : 'error'
    setTimeout(() => {
      syncStatus.value = ''
    }, 2000)
  }

  function startEditTitle() {
    titleInput.value = chat.value.title
    editingTitle.value = true
    showActions.value = false
  }

  function saveTitle() {
    const newTitle = titleInput.value.trim()
    if (newTitle && newTitle !== chat.value.title) {
      chatStore.updateChatTitle(chat.value.id, newTitle)
    }
    editingTitle.value = false
    titleInput.value = ''
  }

  function cancelEditTitle() {
    editingTitle.value = false
    titleInput.value = ''
  }

  function handleTitleKeydown(e) {
    if (e.key === 'Enter') {
      saveTitle()
    } else if (e.key === 'Escape') {
      cancelEditTitle()
    }
  }

  function openTagsEditor() {
    tagInput.value = ''
    showTagsEditor.value = true
    showActions.value = false
  }

  function closeTagsEditor() {
    showTagsEditor.value = false
    tagInput.value = ''
  }

  function addTag() {
    const tag = tagInput.value.trim()
    if (!tag) return
    if (!chat.value.tags.includes(tag)) {
      chatStore.updateChatTags(chat.value.id, [...chat.value.tags, tag])
    }
    tagInput.value = ''
  }

  function removeTag(tag) {
    chatStore.updateChatTags(
      chat.value.id,
      chat.value.tags.filter((t) => t !== tag),
    )
  }

  function handleTagKeydown(e) {
    if (e.key === 'Enter') {
      addTag()
    }
  }

  function handleFileImport(event, onOutlineUpdate) {
    const file = event.target.files[0]
    if (!file) return

    chatStore.importFromUserFile(file).then((ok) => {
      syncStatus.value = ok ? 'import-success' : 'import-error'
      setTimeout(() => {
        syncStatus.value = ''
      }, 2000)
      event.target.value = ''
      onOutlineUpdate?.()
    })
  }

  function resetUIState() {
    editingMessage.value = null
    showActions.value = false
    editingTitle.value = false
  }

  return {
    editingMessage,
    insertTarget,
    movingMessageId,
    moveDirection,
    editingTitle,
    titleInput,
    showTagsEditor,
    tagInput,
    showActions,
    syncStatus,
    handleSend,
    handleEdit,
    handleDelete,
    handleMove,
    handleInsert,
    deleteChat,
    togglePin,
    syncToFile,
    startEditTitle,
    saveTitle,
    cancelEditTitle,
    handleTitleKeydown,
    openTagsEditor,
    closeTagsEditor,
    addTag,
    removeTag,
    handleTagKeydown,
    handleFileImport,
    resetUIState,
  }
}
