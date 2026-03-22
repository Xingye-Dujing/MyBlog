<script setup>
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import MessageBubble from '@/components/MessageBubble.vue'
import MessageInput from '@/components/MessageInput.vue'

const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()

const messagesContainer = ref(null)
const inputRef = ref(null)
const editingMessage = ref(null)
const showActions = ref(false)

const chat = computed(() => {
  const id = route.params.id
  return chatStore.chats.find(c => c.id === id) || null
})

const messagesWithDates = computed(() => {
  if (!chat.value) return []
  const result = []
  let lastDate = ''
  for (const msg of chat.value.messages) {
    const d = new Date(msg.timestamp)
    const dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    result.push({
      ...msg,
      showDate: dateKey !== lastDate
    })
    lastDate = dateKey
  }
  return result
})

function scrollToBottom(smooth = true) {
  nextTick(() => {
    const el = messagesContainer.value
    if (el) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: smooth ? 'smooth' : 'instant'
      })
    }
  })
}

function handleSend(content) {
  if (content === null) {
    editingMessage.value = null
    return
  }
  if (editingMessage.value) {
    chatStore.updateMessage(chat.value.id, editingMessage.value.id, content)
    editingMessage.value = null
  } else {
    chatStore.addMessage(chat.value.id, content)
  }
  scrollToBottom()
}

function handleEdit(msg) {
  editingMessage.value = msg
  inputRef.value?.setContent(msg.content)
}

function handleDelete(msg) {
  chatStore.deleteMessage(chat.value.id, msg.id)
}

function deleteChat() {
  if (!chat.value) return
  chatStore.deleteChat(chat.value.id)
  router.push({ name: 'home' })
}

function togglePin() {
  if (!chat.value) return
  chatStore.togglePin(chat.value.id)
}

async function syncToFile() {
  const ok = await chatStore.syncToFile()
  if (ok) {
    syncStatus.value = 'success'
  } else {
    syncStatus.value = 'error'
  }
  setTimeout(() => { syncStatus.value = '' }, 2000)
}

const syncStatus = ref('')

watch(() => route.params.id, () => {
  editingMessage.value = null
  showActions.value = false
  nextTick(() => scrollToBottom(false))
})

onMounted(() => {
  scrollToBottom(false)
})
</script>

<template>
  <div v-if="chat" class="chat-view">
    <div class="chat-header">
      <button class="back-btn mobile-only" @click="router.push({ name: 'home' })">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <div class="header-info">
        <h2 class="chat-name">{{ chat.title }}</h2>
        <span class="chat-meta">{{ chat.messages.length }} 条消息</span>
      </div>
      <div class="header-actions">
        <div v-if="syncStatus" class="sync-toast" :class="syncStatus">
          {{ syncStatus === 'success' ? '已同步' : '同步失败' }}
        </div>
        <button class="header-btn" title="更多" @click="showActions = !showActions">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
            <circle cx="5" cy="12" r="1" />
          </svg>
        </button>
        <div v-if="showActions" class="actions-overlay" @click="showActions = false"></div>
        <div v-if="showActions" class="actions-dropdown">
          <button @click="togglePin(); showActions = false">
            {{ chat.pinned ? '取消置顶' : '置顶对话' }}
          </button>
          <button @click="syncToFile(); showActions = false">
            同步到文件
          </button>
          <button @click="chatStore.exportJSON(); showActions = false">
            导出全部数据
          </button>
          <button class="danger" @click="deleteChat()">
            删除对话
          </button>
        </div>
      </div>
    </div>

    <div ref="messagesContainer" class="messages-area">
      <div class="messages-content">
        <div v-if="chat.tags.length" class="chat-tags-header">
          <span v-for="tag in chat.tags" :key="tag" class="header-tag">{{ tag }}</span>
        </div>
        <MessageBubble v-for="msg in messagesWithDates" :key="msg.id" :message="msg" :show-date="msg.showDate"
          @edit="handleEdit" @delete="handleDelete" />
        <div v-if="!chat.messages.length" class="empty-chat">
          <p>开始输入第一条消息</p>
        </div>
      </div>
    </div>

    <MessageInput ref="inputRef" :editing-message="editingMessage" @send="handleSend" />
  </div>
</template>

<style scoped>
.chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-width: 0;
}

.chat-header {
  display: flex;
  align-items: center;
  padding: 16px 24px;
  border-bottom: 1.5px solid #e0e0e0;
  background: #fff;
  position: relative;
}

.back-btn {
  display: none;
}

.header-info {
  flex: 1;
  min-width: 0;
}

.chat-name {
  font-size: 1.2rem;
  font-weight: 400;
  color: #000;
  margin: 0;
  letter-spacing: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-meta {
  font-size: 0.78rem;
  color: #bbb;
  letter-spacing: 0.5px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
}

.sync-toast {
  font-size: 0.75rem;
  padding: 4px 10px;
  border-radius: 4px;
  animation: fadeIn 0.2s ease;
}

.sync-toast.success {
  color: #2d7d2d;
  background: #e8f5e9;
}

.sync-toast.error {
  color: #c9372e;
  background: #fee;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.header-btn {
  width: 34px;
  height: 34px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  padding: 7px;
  color: #666;
  transition: all 0.2s;
}

.header-btn:hover {
  background: #f0f0f0;
  color: #000;
}

.header-btn svg {
  width: 100%;
  height: 100%;
}

.actions-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: #fff;
  border: 1.5px solid #e0e0e0;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  z-index: 100;
  min-width: 160px;
  overflow: hidden;
}

.actions-overlay {
  display: none;
}

.actions-dropdown button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 16px;
  border: none;
  background: none;
  cursor: pointer;
  font-family: 'LXGW WenKai', serif;
  font-size: 0.85rem;
  color: #333;
  transition: background 0.15s;
}

.actions-dropdown button:hover {
  background: #f5f5f5;
}

.actions-dropdown button.danger {
  color: #c9372e;
}

.actions-dropdown button.danger:hover {
  background: #fee;
}

.messages-area {
  flex: 1;
  overflow-y: auto;
  padding: 16px 0;
  background: #fafafa;
}

.messages-content {
  max-width: 900px;
  margin: 0 auto;
  padding: 0 24px;
}

.chat-tags-header {
  display: flex;
  gap: 6px;
  padding: 0 0 12px;
  flex-wrap: wrap;
}

.header-tag {
  font-size: 0.75rem;
  color: #666;
  padding: 3px 10px;
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  letter-spacing: 0.5px;
}

.empty-chat {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
}

.empty-chat p {
  font-size: 0.95rem;
  color: #ccc;
  letter-spacing: 1px;
}

@media (max-width: 768px) {
  .chat-view {
    height: 100dvh;
  }

  .back-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border: none;
    background: none;
    cursor: pointer;
    padding: 8px;
    color: #000;
    margin-right: 6px;
    flex-shrink: 0;
    border-radius: 6px;
    -webkit-tap-highlight-color: transparent;
  }

  .back-btn:active {
    background: #f0f0f0;
  }

  .back-btn svg {
    width: 100%;
    height: 100%;
  }

  .chat-header {
    padding: 10px 12px;
    padding-top: calc(10px + env(safe-area-inset-top));
  }

  .chat-name {
    font-size: 1.05rem;
  }

  .chat-meta {
    font-size: 0.72rem;
  }

  .header-btn {
    width: 40px;
    height: 40px;
    padding: 8px;
  }

  .messages-area {
    padding: 8px 0;
    -webkit-overflow-scrolling: touch;
  }

  .chat-tags-header {
    padding: 0 12px 8px;
  }

  .header-tag {
    font-size: 0.7rem;
    padding: 2px 8px;
  }

  /* Bottom sheet style dropdown for mobile */
  .actions-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    z-index: 199;
    animation: fadeIn 0.2s ease;
  }

  /* Bottom sheet style dropdown for mobile */
  .actions-dropdown {
    position: fixed;
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    margin-top: 0;
    border-radius: 16px 16px 0 0;
    border: none;
    border-top: 1.5px solid #e0e0e0;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
    min-width: auto;
    z-index: 200;
    padding-bottom: env(safe-area-inset-bottom);
    animation: slideUp 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .actions-dropdown button {
    padding: 16px 20px;
    font-size: 0.95rem;
    min-height: 50px;
    display: flex;
    align-items: center;
  }

  .actions-dropdown button:not(:last-child) {
    border-bottom: 1px solid #f0f0f0;
  }
}

@keyframes slideUp {
  from {
    transform: translateY(100%);
  }

  to {
    transform: translateY(0);
  }
}

@media print {
  .chat-header {
    border-bottom: 2px solid #000;
  }

  .header-actions {
    display: none;
  }

  .back-btn {
    display: none !important;
  }

  .messages-area {
    overflow: visible;
    background: #fff;
  }

  .chat-view {
    height: auto;
  }
}
</style>
