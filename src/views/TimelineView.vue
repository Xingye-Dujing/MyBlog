<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import { renderMarkdown } from '@/composables/useMarkdown'

const router = useRouter()
const chatStore = useChatStore()

const viewMode = ref('month') // 'day', 'month', 'year'

// Group all messages by date
const timelineData = computed(() => {
  const messages = []

  chatStore.chats.forEach((chat) => {
    chat.messages.forEach((msg) => {
      messages.push({
        ...msg,
        chatId: chat.id,
        chatTitle: chat.title,
        chatPinned: chat.pinned,
      })
    })
  })

  // Sort by timestamp descending
  messages.sort((a, b) => b.timestamp - a.timestamp)

  return messages
})

// Group messages by different time periods
const groupedTimeline = computed(() => {
  const messages = timelineData.value
  const groups = {}

  messages.forEach((msg) => {
    const date = new Date(msg.timestamp)
    let key

    if (viewMode.value === 'year') {
      key = String(date.getFullYear())
    } else if (viewMode.value === 'month') {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    } else {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }

    if (!groups[key]) {
      groups[key] = []
    }
    groups[key].push(msg)
  })

  return groups
})

// Get sorted period keys
const sortedKeys = computed(() => {
  return Object.keys(groupedTimeline.value).sort((a, b) => {
    if (viewMode.value === 'year') {
      return b.localeCompare(a)
    }
    return b.localeCompare(a)
  })
})

// Format period label for display
function formatPeriodLabel(key) {
  if (viewMode.value === 'year') {
    return `${key}年`
  } else if (viewMode.value === 'month') {
    const [year, month] = key.split('-')
    return `${year}年${parseInt(month)}月`
  } else {
    const [year, month, day] = key.split('-')
    const date = new Date(year, month - 1, day)
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const weekday = weekdays[date.getDay()]
    return `${year}年${parseInt(month)}月${parseInt(day)}日 ${weekday}`
  }
}

// Format message time
function formatMessageTime(timestamp) {
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

// Navigate to chat
function goToChat(chatId) {
  router.push({ name: 'chat', params: { id: chatId } })
}

// Toggle view mode
function setViewMode(mode) {
  viewMode.value = mode
}
</script>

<template>
  <div class="timeline-view">
    <div class="timeline-header">
      <h1 class="timeline-title">时间线</h1>
      <div class="view-mode-toggle">
        <button :class="{ active: viewMode === 'day' }" @click="setViewMode('day')">日</button>
        <button :class="{ active: viewMode === 'month' }" @click="setViewMode('month')">月</button>
        <button :class="{ active: viewMode === 'year' }" @click="setViewMode('year')">年</button>
      </div>
    </div>

    <div class="timeline-content">
      <div v-if="sortedKeys.length === 0" class="empty-timeline">
        <p>暂无消息记录</p>
      </div>

      <div v-else class="timeline-groups">
        <div v-for="key in sortedKeys" :key="key" class="timeline-group">
          <div class="group-label">
            {{ formatPeriodLabel(key) }}
            <span class="message-count">{{ groupedTimeline[key].length }}条消息</span>
          </div>

          <div class="group-messages">
            <div v-for="msg in groupedTimeline[key]" :key="msg.id" class="timeline-message">
              <div class="message-time">{{ formatMessageTime(msg.timestamp) }}</div>
              <div class="message-content">
                <div class="message-chat-link" @click="goToChat(msg.chatId)">
                  <svg
                    v-if="msg.chatPinned"
                    class="pin-icon"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                  </svg>
                  <span>{{ msg.chatTitle }}</span>
                </div>
                <div class="message-text" v-html="renderMarkdown(msg.content)"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="timeline-footer">
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
.timeline-view {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #fafafa;
  overflow: hidden;
}

.timeline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  background: #fff;
  border-bottom: 1px solid #e0e0e0;
}

.timeline-title {
  font-size: 1.6rem;
  font-weight: 200;
  color: #000;
  letter-spacing: 3px;
  margin: 0;
}

.view-mode-toggle {
  display: flex;
  gap: 4px;
  background: #f0f0f0;
  padding: 4px;
  border-radius: 6px;
}

.view-mode-toggle button {
  padding: 6px 16px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-family: serif;
  font-size: 0.85rem;
  color: #666;
  border-radius: 4px;
  transition: all 0.2s;
}

.view-mode-toggle button.active {
  background: #000;
  color: #fff;
}

.view-mode-toggle button:hover:not(.active) {
  background: #e0e0e0;
}

.timeline-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.empty-timeline {
  text-align: center;
  padding: 60px 20px;
  color: #999;
}

.timeline-groups {
  max-width: 800px;
  margin: 0 auto;
}

.timeline-group {
  margin-bottom: 32px;
}

.group-label {
  font-size: 1.1rem;
  font-weight: 400;
  color: #333;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 2px solid #e0e0e0;
  display: flex;
  align-items: center;
  gap: 12px;
  letter-spacing: 1px;
}

.message-count {
  font-size: 0.75rem;
  color: #999;
  font-weight: normal;
}

.group-messages {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.timeline-message {
  display: flex;
  gap: 16px;
  padding: 16px 20px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  transition: box-shadow 0.2s;
}

.timeline-message:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.message-time {
  font-size: 0.75rem;
  color: #999;
  flex-shrink: 0;
  padding-top: 4px;
  min-width: 50px;
}

.message-content {
  flex: 1;
  min-width: 0;
}

.message-chat-link {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  color: #409eff;
  cursor: pointer;
  margin-bottom: 8px;
  transition: opacity 0.2s;
}

.message-chat-link:hover {
  opacity: 0.8;
}

.pin-icon {
  width: 12px;
  height: 12px;
  color: #c9372e;
}

.message-chat-link span {
  font-weight: 400;
}

.message-text {
  font-size: 0.9rem;
  line-height: 1.6;
  color: #333;
}

.message-text :deep(p) {
  margin: 0 0 8px;
}

.message-text :deep(p:last-child) {
  margin: 0;
}

.message-text :deep(pre) {
  background: #f5f5f5;
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 8px 0;
}

.message-text :deep(code) {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.85em;
  word-break: break-word;
}

.message-text :deep(:not(pre) > code) {
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
}

.message-text :deep(img) {
  max-width: 300px;
}

.message-text :deep(a) {
  word-break: break-word;
}

.timeline-footer {
  border-top: 1px solid #e0e0e0;
  padding: 12px 24px;
  background: #fff;
}

.footer-link {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: #666;
  padding: 8px 12px;
  border-radius: 6px;
  transition: all 0.2s;
  max-width: fit-content;
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
  .timeline-header {
    padding: 16px;
    padding-top: calc(16px + env(safe-area-inset-top));
  }

  .timeline-title {
    font-size: 1.4rem;
  }

  .timeline-content {
    padding: 16px;
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
  }

  .timeline-message {
    padding: 12px 16px;
  }

  .message-text :deep(img) {
    max-width: 200px;
  }

  .message-time {
    min-width: 45px;
    font-size: 0.7rem;
  }

  .view-mode-toggle button {
    padding: 5px 12px;
    font-size: 0.8rem;
  }
}
</style>
