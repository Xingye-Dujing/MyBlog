<script setup>
import { ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import { getPlainText } from '@/composables/useMarkdown'

const router = useRouter()
const route = useRoute()
const chatStore = useChatStore()

const searchQuery = ref('')
const showNewChat = ref(false)
const newChatTitle = ref('')

const filteredChats = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const list = chatStore.sortedChats
  if (!q) return list
  return list.filter(c =>
    c.title.toLowerCase().includes(q) ||
    c.tags.some(t => t.toLowerCase().includes(q))
  )
})

const activeChatId = computed(() => route.params.id || null)

function selectChat(chat) {
  router.push({ name: 'chat', params: { id: chat.id } })
}

function createChat() {
  const title = newChatTitle.value.trim()
  if (!title) return
  const chat = chatStore.createChat(title)
  newChatTitle.value = ''
  showNewChat.value = false
  router.push({ name: 'chat', params: { id: chat.id } })
}

function cancelNewChat() {
  showNewChat.value = false
  newChatTitle.value = ''
}

function handleNewChatKey(e) {
  if (e.key === 'Enter') createChat()
  if (e.key === 'Escape') cancelNewChat()
}

function getLastMessage(chat) {
  if (!chat.messages.length) return '暂无消息'
  return getPlainText(chat.messages[chat.messages.length - 1].content, 50)
}

function formatDate(ts) {
  const d = new Date(ts)
  const now = new Date()
  const diff = now - d
  const oneDay = 86400000
  if (diff < oneDay && d.getDate() === now.getDate()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (diff < oneDay * 2) return '昨天'
  if (diff < oneDay * 7) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return weekdays[d.getDay()]
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}
</script>

<template>
  <div class="chat-list">
    <div class="list-header">
      <h1 class="list-title">对话</h1>
      <button class="new-chat-btn" title="新建对话" @click="showNewChat = !showNewChat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>

    <div v-if="showNewChat" class="new-chat-form">
      <input v-model="newChatTitle" class="new-chat-input" placeholder="输入对话标题..." autofocus
        @keydown="handleNewChatKey">
      <div class="new-chat-actions">
        <button class="btn-cancel" @click="cancelNewChat">取消</button>
        <button class="btn-confirm" :disabled="!newChatTitle.trim()" @click="createChat">创建</button>
      </div>
    </div>

    <div class="search-box">
      <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input v-model="searchQuery" class="search-input" placeholder="搜索对话..." type="text">
    </div>

    <div class="chat-items">
      <div v-for="chat in filteredChats" :key="chat.id" class="chat-item" :class="{ active: chat.id === activeChatId }"
        @click="selectChat(chat)">
        <div class="chat-item-main">
          <div class="chat-item-header">
            <span class="chat-title">
              <svg v-if="chat.pinned" class="pin-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
              </svg>
              {{ chat.title }}
            </span>
            <span class="chat-date">{{ formatDate(chat.updatedAt) }}</span>
          </div>
          <p class="chat-preview">{{ getLastMessage(chat) }}</p>
          <div v-if="chat.tags.length" class="chat-tags">
            <span v-for="tag in chat.tags.slice(0, 3)" :key="tag" class="tag">{{ tag }}</span>
          </div>
        </div>
      </div>

      <div v-if="!filteredChats.length" class="empty-list">
        <p v-if="searchQuery">没有找到匹配的对话</p>
        <p v-else>暂无对话，点击 + 创建</p>
      </div>
    </div>

    <div class="list-footer">
      <router-link to="/about" class="footer-link">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        <span>关于</span>
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.chat-list {
  width: 320px;
  height: 100vh;
  border-right: 1.5px solid #e0e0e0;
  display: flex;
  flex-direction: column;
  background: #fff;
  position: sticky;
  top: 0;
  flex-shrink: 0;
  transition: width 0.2s ease;
}

.chat-list.collapsed {
  width: 0 !important;
  overflow: hidden;
  border-right: none;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 20px 12px;
  border-bottom: 1px solid #f0f0f0;
}

.list-title {
  font-size: 1.6rem;
  font-weight: 200;
  color: #000;
  letter-spacing: 3px;
  margin: 0;
}

.new-chat-btn {
  width: 36px;
  height: 36px;
  border: 1.5px solid #000;
  background: #fff;
  border-radius: 8px;
  cursor: pointer;
  padding: 7px;
  color: #000;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.new-chat-btn:hover {
  background: #000;
  color: #fff;
}

.new-chat-btn svg {
  width: 100%;
  height: 100%;
}

.new-chat-form {
  padding: 12px 20px;
  border-bottom: 1px solid #f0f0f0;
}

.new-chat-input {
  width: 100%;
  border: 1.5px solid #e0e0e0;
  border-radius: 6px;
  padding: 8px 12px;
  font-family: 'LXGW WenKai', serif;
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.2s;
}

.new-chat-input:focus {
  border-color: #000;
}

.new-chat-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.btn-cancel,
.btn-confirm {
  padding: 5px 14px;
  border-radius: 5px;
  font-family: 'LXGW WenKai', serif;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-cancel {
  background: none;
  border: 1px solid #e0e0e0;
  color: #666;
}

.btn-cancel:hover {
  border-color: #999;
}

.btn-confirm {
  background: #000;
  border: 1px solid #000;
  color: #fff;
}

.btn-confirm:hover:not(:disabled) {
  background: #333;
}

.btn-confirm:disabled {
  background: #e0e0e0;
  border-color: #e0e0e0;
  cursor: not-allowed;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-bottom: 1px solid #f0f0f0;
}

.search-icon {
  width: 18px;
  height: 18px;
  color: #bbb;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  border: none;
  outline: none;
  font-family: 'LXGW WenKai', serif;
  font-size: 0.9rem;
  color: #333;
  background: transparent;
}

.search-input::placeholder {
  color: #ccc;
}

.chat-items {
  flex: 1;
  overflow-y: auto;
}

.chat-item {
  padding: 14px 20px;
  border-bottom: 1px solid #f5f5f5;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.chat-item:hover {
  background: #fafafa;
}

.chat-item.active {
  background: #f5f5f5;
  border-left: 3px solid #000;
  padding-left: 17px;
}

.chat-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.chat-title {
  font-size: 0.95rem;
  font-weight: 400;
  color: #000;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.pin-icon {
  width: 14px;
  height: 14px;
  color: #c9372e;
  flex-shrink: 0;
}

.chat-date {
  font-size: 0.75rem;
  color: #bbb;
  flex-shrink: 0;
  margin-left: 8px;
}

.chat-preview {
  font-size: 0.82rem;
  color: #999;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.chat-tags {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.tag {
  font-size: 0.7rem;
  color: #888;
  padding: 1px 8px;
  background: #f0f0f0;
  border-radius: 3px;
}

.chat-item.active .tag {
  background: #e8e8e8;
}

.empty-list {
  padding: 40px 20px;
  text-align: center;
}

.empty-list p {
  font-size: 0.9rem;
  color: #ccc;
}

.list-footer {
  border-top: 1px solid #f0f0f0;
  padding: 12px 20px;
}

.footer-link {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: #666;
  padding: 8px 12px;
  border-radius: 6px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.footer-link:hover {
  background: #f5f5f5;
  color: #000;
}

.footer-link svg {
  width: 20px;
  height: 20px;
}

.footer-link span {
  font-size: 0.9rem;
  letter-spacing: 1px;
}

@media (max-width: 768px) {
  .chat-list {
    width: 100%;
    height: 100dvh;
    border-right: none;
    position: static;
  }

  .list-header {
    padding: 16px 16px 10px;
    padding-top: calc(16px + env(safe-area-inset-top));
  }

  .list-title {
    font-size: 1.4rem;
  }

  .new-chat-btn {
    width: 40px;
    height: 40px;
    padding: 8px;
  }

  .search-box {
    padding: 10px 16px;
  }

  .new-chat-form {
    padding: 10px 16px;
  }

  .chat-item {
    padding: 14px 16px;
    -webkit-touch-callout: none;
  }

  .chat-item:active {
    background: #f0f0f0;
  }

  .chat-item.active {
    padding-left: 13px;
  }

  .list-footer {
    padding: 10px 16px;
    padding-bottom: calc(10px + env(safe-area-inset-bottom));
  }

  .footer-link {
    min-height: 44px;
  }
}
</style>
