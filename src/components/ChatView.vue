<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import MessageBubble from '@/components/MessageBubble.vue'
import CommentSection from '@/components/CommentSection.vue'

const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()

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
      chatId: chat.value.id, // Add chatId to each message for comment lookup
      showDate: dateKey !== lastDate
    })
    lastDate = dateKey
  }
  return result
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
    </div>

    <div ref="messagesContainer" class="messages-area">
      <div class="messages-content">
        <div v-if="chat.tags.length" class="chat-tags-header">
          <span v-for="tag in chat.tags" :key="tag" class="header-tag">{{ tag }}</span>
        </div>
        <MessageBubble v-for="msg in messagesWithDates" :key="msg.id" :message="msg" :show-date="msg.showDate" />

        <!-- Comment section -->
        <CommentSection :chat-id="chat.id" />
      </div>
    </div>
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
  min-height: 100%;
  display: flex;
  flex-direction: column;
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

@media (max-width: 768px) {
  .chat-view {
    height: 100dvh;
  }

  .back-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    background: none;
    cursor: pointer;
    padding: 6px;
    color: #000;
    margin-right: 6px;
    flex-shrink: 0;
    border-radius: 5px;
    -webkit-tap-highlight-color: transparent;
  }

  .back-btn:active {
    background: #f0f0f0;
  }

  .back-btn svg {
    width: 18px;
    height: 18px;
  }

  .chat-header {
    padding: 8px 4px;
    padding-top: calc(8px + env(safe-area-inset-top));
  }

  .chat-name {
    font-size: 0.95rem;
    letter-spacing: 0.5px;
  }

  .chat-meta {
    font-size: 0.68rem;
  }

  .messages-area {
    padding: 6px 0;
    -webkit-overflow-scrolling: touch;
  }

  .messages-content {
    padding: 0 16px;
  }

  .chat-tags-header {
    padding: 10px 12px 6px;
    gap: 5px;
  }

  .header-tag {
    font-size: 0.65rem;
    padding: 2px 6px;
    border-radius: 10px;
  }
}
</style>