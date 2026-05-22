<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import { getPlainText } from '@/composables/useMarkdown'

const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()

const searchQuery = ref('')
const expandedTags = ref(new Set())

const filteredChats = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const list = chatStore.sortedChats
  if (!q) return list
  return list.filter(c =>
    c.title.toLowerCase().includes(q) ||
    c.tags.some(t => t.toLowerCase().includes(q)) ||
    c.messages.some(m => m.content.toLowerCase().includes(q))
  )
})

// Get matching messages for preview
function getMatchingMessages(chat, query, limit = 2) {
  if (!query) return []
  const q = query.toLowerCase()
  const matches = chat.messages
    .filter(m => m.content.toLowerCase().includes(q))
    .slice(0, limit)
  return matches
}

// Group chats by tags
const groupedChats = computed(() => {
  const groups = {
    untagged: [],
    tagged: {}
  }

  filteredChats.value.forEach(chat => {
    if (chat.tags.length === 0) {
      groups.untagged.push(chat)
    } else {
      chat.tags.forEach(tag => {
        if (!groups.tagged[tag]) {
          groups.tagged[tag] = []
        }
        groups.tagged[tag].push(chat)
      })
    }
  })

  return groups
})

const activeChatId = computed(() => route.params.id || null)

function selectChat(chat) {
  router.push({ name: 'chat', params: { id: chat.id } })
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

function toggleTagExpand(tag) {
  const newSet = new Set(expandedTags.value)
  if (newSet.has(tag)) {
    newSet.delete(tag)
  } else {
    newSet.add(tag)
  }
  expandedTags.value = newSet
}

function isExpanded(tag) {
  return expandedTags.value.has(tag)
}
</script>

<template>
  <div class="chat-list">
    <div class="list-header">
      <h1 class="list-title">对话</h1>
    </div>

    <div class="search-box">
      <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input v-model="searchQuery" class="search-input" placeholder="搜索消息内容..." type="text">
      <button v-if="searchQuery" class="clear-search" @click="searchQuery = ''" title="清除搜索">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <div class="chat-items">
      <!-- Untagged chats -->
      <div v-if="groupedChats.untagged.length" class="chat-group">
        <div class="group-header" @click="toggleTagExpand('untagged')">
          <svg class="expand-icon" :class="{ expanded: isExpanded('untagged') }" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span>未分类</span>
          <span class="group-count">{{ groupedChats.untagged.length }}</span>
        </div>
        <div v-if="isExpanded('untagged')" class="group-content">
          <div v-for="chat in groupedChats.untagged" :key="chat.id" class="chat-item"
            :class="{ active: chat.id === activeChatId }" @click="selectChat(chat)">
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
              <p v-if="searchQuery && getMatchingMessages(chat, searchQuery).length" class="chat-preview search-match">
                <span v-for="(msg, idx) in getMatchingMessages(chat, searchQuery)" :key="msg.id"
                  class="message-snippet">
                  <span v-if="idx > 0" class="snippet-separator"> · </span>
                  <span class="snippet-text">{{ msg.content.substring(0, 60) }}{{ msg.content.length > 60 ? '...' : ''
                    }}</span>
                </span>
              </p>
              <p v-else class="chat-preview">{{ getLastMessage(chat) }}</p>
              <div v-if="chat.tags.length" class="chat-tags">
                <span v-for="tag in chat.tags.slice(0, 3)" :key="tag" class="tag">{{ tag }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Tagged chats -->
      <div v-for="(chats, tag) in groupedChats.tagged" :key="tag" class="chat-group">
        <div class="group-header" @click="toggleTagExpand(tag)">
          <svg class="expand-icon" :class="{ expanded: isExpanded(tag) }" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span>{{ tag }}</span>
          <span class="group-count">{{ chats.length }}</span>
        </div>
        <div v-if="isExpanded(tag)" class="group-content">
          <div v-for="chat in chats" :key="chat.id" class="chat-item" :class="{ active: chat.id === activeChatId }"
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
              <p v-if="searchQuery && getMatchingMessages(chat, searchQuery).length" class="chat-preview search-match">
                <span v-for="(msg, idx) in getMatchingMessages(chat, searchQuery)" :key="msg.id"
                  class="message-snippet">
                  <span v-if="idx > 0" class="snippet-separator"> · </span>
                  <span class="snippet-text">{{ msg.content.substring(0, 60) }}{{ msg.content.length > 60 ? '...' : ''
                    }}</span>
                </span>
              </p>
              <p v-else class="chat-preview">{{ getLastMessage(chat) }}</p>
              <div v-if="chat.tags.length" class="chat-tags">
                <span v-for="t in chat.tags.slice(0, 3)" :key="t" class="tag">{{ t }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!filteredChats.length" class="empty-list">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <p v-if="searchQuery">未找到相关消息</p>
        <p v-else>暂无对话</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-list {
  width: 320px;
  height: 100vh;
  border-right: 1.5px solid #e0e0e0;
  background: #fff;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.list-header {
  padding: 24px 20px 16px;
  border-bottom: 1px solid #f0f0f0;
}

.list-title {
  font-size: 1.5rem;
  font-weight: 400;
  color: #000;
  margin: 0;
  letter-spacing: 2px;
}

.search-box {
  position: relative;
  padding: 12px 20px;
  border-bottom: 1px solid #f0f0f0;
}

.search-icon {
  position: absolute;
  left: 32px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  color: #999;
  pointer-events: none;
}

.search-input {
  width: 100%;
  height: 36px;
  padding: 0 32px 0 32px;
  border: 1.5px solid #e8e8e8;
  border-radius: 18px;
  font-size: 0.9rem;
  font-family: serif;
  background: #fafafa;
  outline: none;
  transition: all 0.2s;
}

.search-input:focus {
  border-color: #c9372e;
  background: #fff;
}

.clear-search {
  position: absolute;
  right: 32px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  border: none;
  background: none;
  cursor: pointer;
  padding: 0;
  color: #999;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}

.clear-search:hover {
  background: #f0f0f0;
}

.clear-search svg {
  width: 14px;
  height: 14px;
}

.chat-items {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

/* Chat groups */
.chat-group {
  margin-bottom: 8px;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 20px;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
  color: #666;
  background: #fafafa;
  border-top: 1px solid #f0f0f0;
  border-bottom: 1px solid #f0f0f0;
  user-select: none;
  transition: all 0.2s;
}

.group-header:hover {
  background: #f5f5f5;
}

.group-header:first-child {
  border-top: none;
}

.expand-icon {
  width: 16px;
  height: 16px;
  transition: transform 0.2s;
  flex-shrink: 0;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

.group-count {
  margin-left: auto;
  font-size: 0.75rem;
  color: #bbb;
  font-weight: 400;
}

.group-content {
  overflow: hidden;
}

.chat-item {
  padding: 14px 20px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  border-left: 3px solid transparent;
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
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.chat-title {
  font-size: 0.95rem;
  font-weight: 500;
  color: #333;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 4px;
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
  font-size: 0.85rem;
  color: #999;
  margin: 0 0 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.5;
}

.chat-preview.search-match {
  color: #c9372e;
  white-space: normal;
  overflow: visible;
}

.message-snippet {
  display: inline;
}

.snippet-separator {
  margin: 0 2px;
  color: #ccc;
}

.snippet-text {
  display: inline;
}

.chat-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.tag {
  font-size: 0.7rem;
  color: #666;
  padding: 2px 8px;
  background: #f5f5f5;
  border-radius: 10px;
  letter-spacing: 0.5px;
}

.empty-list {
  padding: 60px 20px;
  text-align: center;
  color: #ccc;
}

.empty-list svg {
  width: 48px;
  height: 48px;
  margin-bottom: 12px;
  opacity: 0.3;
}

.empty-list p {
  font-size: 0.9rem;
  margin: 0;
}

@media (max-width: 768px) {
  .chat-list {
    width: 100%;
    height: 100dvh;
    border-right: none;
    border-bottom: 1.5px solid #e0e0e0;
  }

  .list-header {
    padding-top: calc(10px + env(safe-area-inset-top));
  }

  .list-title {
    font-size: 1.2rem;
  }

  .search-box {
    padding: 6px 14px;
  }

  .search-input {
    height: 32px;
    font-size: 0.75rem;
    padding-left: 40px;
  }

  .group-header {
    padding: 8px 14px;
    font-size: 0.8rem;
  }

  .group-count {
    font-size: 0.75rem;
  }

  .chat-item {
    padding: 10px 14px;
  }

  .chat-title {
    font-size: 0.85rem;
  }

  .chat-preview {
    font-size: 0.75rem;
    margin: 0 0 4px;
  }

  .chat-date {
    font-size: 0.65rem;
  }

  .tag {
    font-size: 0.6rem;
    padding: 1px 5px;
  }

  .empty-list {
    padding: 40px 16px;
  }

  .empty-list svg {
    width: 40px;
    height: 40px;
    margin-bottom: 10px;
  }

  .empty-list p {
    font-size: 0.85rem;
  }
}
</style>