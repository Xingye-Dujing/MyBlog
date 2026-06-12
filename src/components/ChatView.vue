<script setup>
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import MessageBubble from '@/components/MessageBubble.vue'
import CommentSection from '@/components/CommentSection.vue'
import OutlineSidebar from '@/components/OutlineSidebar.vue'
import { getPlainText } from '@/composables/useMarkdown'

const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()

const messagesContainer = ref(null)
const isMobile = ref(window.innerWidth <= 768)

// 大纲相关状态
const sections = ref([])      // 章节列表
const activeHeadingId = ref(null)  // 当前高亮的章节 ID
let scrollListener = null

const chat = computed(() => {
  const id = route.params.id
  return chatStore.chats.find(c => c.id === id) || null
})

// 判断消息是否显示日期分隔线
function shouldShowDate(msg, idx) {
  if (idx === 0) return true
  const prevMsg = chat.value.messages[idx - 1]
  const d1 = new Date(msg.timestamp)
  const d2 = new Date(prevMsg.timestamp)
  return d1.toDateString() !== d2.toDateString()
}

// 判断消息是否可见（根据章节折叠状态）
function isMessageVisible(msgIndex) {
  const section = sections.value.find(s => msgIndex >= s.startMsgIndex && msgIndex <= s.endMsgIndex)
  return !section?.collapsed
}

// 构建章节：基于消息的 outline.enabled 字段
function buildSections() {
  if (!chat.value || !chat.value.messages.length) {
    sections.value = []
    return
  }
  const messages = chat.value.messages
  // 收集所有启用大纲的消息索引
  const outlineIndices = []
  messages.forEach((msg, idx) => {
    if (msg.outline?.enabled) outlineIndices.push(idx)
  })

  const newSections = []

  if (outlineIndices.length === 0) {
    // 没有任何大纲节点：整体作为一个章节
    newSections.push({
      id: 'section-all',
      title: '全部内容',
      level: 2,
      startMsgIndex: 0,
      endMsgIndex: messages.length - 1,
      headingMsgIndex: null,
      collapsed: false,
      messageCount: messages.length
    })
  } else {
    // 开头部分（第一个大纲之前的内容）
    if (outlineIndices[0] > 0) {
      newSections.push({
        id: 'section-intro',
        title: '开头',
        level: 2,
        startMsgIndex: 0,
        endMsgIndex: outlineIndices[0] - 1,
        headingMsgIndex: null,
        collapsed: false,
        messageCount: outlineIndices[0]
      })
    }

    // 每个大纲节点（包含自身）形成一个章节
    for (let i = 0; i < outlineIndices.length; i++) {
      const startIdx = outlineIndices[i]
      const endIdx = (outlineIndices[i + 1] ?? messages.length) - 1
      const msg = messages[startIdx]
      // 获取自定义标题，若无则取消息内容的纯文本前 30 字
      let title = msg.outline?.title?.trim()
      if (!title) {
        const plain = getPlainText(msg.content, 30)
        title = plain.length > 30 ? plain.slice(0, 30) + '…' : plain
      }
      newSections.push({
        id: `section-${msg.id}`,
        title,
        level: 2,
        startMsgIndex: startIdx,
        endMsgIndex: endIdx,
        headingMsgIndex: startIdx,
        collapsed: false,
        messageCount: endIdx - startIdx + 1
      })
    }
  }

  // 保留原有的折叠状态
  const oldSectionsMap = new Map(sections.value.map(s => [s.id, s.collapsed]))
  newSections.forEach(section => {
    if (oldSectionsMap.has(section.id)) {
      section.collapsed = oldSectionsMap.get(section.id)
    }
  })

  sections.value = newSections
}

// 切换章节折叠状态
function toggleSection(sectionId) {
  const section = sections.value.find(s => s.id === sectionId)
  if (section) {
    section.collapsed = !section.collapsed
    sections.value = [...sections.value]  // 触发响应式更新
    // 折叠/展开后，可能需要重新调整滚动位置（可选）
    nextTick(() => {
      if (!section.collapsed && section.headingMsgIndex !== null) {
        // 如果展开，可选滚动到该章节标题
      }
    })
  }
}

// 跳转到指定章节（滚动到该章节的第一条消息）
function jumpToSection(section) {
  if (!chat.value) return
  // 如果章节已折叠，先展开
  if (section.collapsed) toggleSection(section.id)

  const targetMsgIndex = section.startMsgIndex
  const targetMsg = chat.value.messages[targetMsgIndex]
  if (!targetMsg) return

  nextTick(() => {
    const messageElements = messagesContainer.value?.querySelectorAll('.message-wrapper')
    const targetIdx = targetMsgIndex
    if (messageElements && messageElements[targetIdx]) {
      messageElements[targetIdx].scrollIntoView({ behavior: 'smooth', block: 'start' })
      activeHeadingId.value = section.id
      // 短暂高亮效果
      setTimeout(() => {
        const el = messageElements[targetIdx]
        if (el) {
          el.style.transition = 'background 0.3s'
          el.style.background = '#faf0e6'
          setTimeout(() => { if (el) el.style.background = '' }, 800)
        }
      }, 100)
    }
  })
}

// 滚动监听，高亮当前所在的章节
function onScroll() {
  if (!messagesContainer.value || !sections.value.length) return
  const container = messagesContainer.value
  const messageElements = container.querySelectorAll('.message-wrapper')
  let currentActiveId = null
  for (let i = 0; i < messageElements.length; i++) {
    const el = messageElements[i]
    const rect = el.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    if (rect.top >= containerRect.top && rect.top <= containerRect.top + 100) {
      const section = sections.value.find(s => i >= s.startMsgIndex && i <= s.endMsgIndex)
      if (section && section.headingMsgIndex !== null) {
        currentActiveId = section.id
        break
      }
    }
  }
  if (currentActiveId !== activeHeadingId.value) {
    activeHeadingId.value = currentActiveId
  }
}

// 监听窗口大小变化，更新手机端标志
function handleResize() {
  isMobile.value = window.innerWidth <= 768
}

// 监听路由变化，重新构建大纲
watch(() => route.params.id, () => {
  buildSections()
  activeHeadingId.value = null
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = 0
    }
  })
})

// 监听对话内容变化（如果数据动态加载后可能变化）
watch(() => chat.value, (newChat) => {
  if (newChat) {
    buildSections()
    nextTick(() => {
      if (messagesContainer.value) {
        messagesContainer.value.scrollTop = 0
      }
    })
  }
}, { immediate: true, deep: true })

onMounted(() => {
  window.addEventListener('resize', handleResize)
  if (messagesContainer.value) {
    messagesContainer.value.addEventListener('scroll', onScroll)
    scrollListener = onScroll
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  if (messagesContainer.value && scrollListener) {
    messagesContainer.value.removeEventListener('scroll', scrollListener)
  }
})
</script>

<template>
  <div v-if="chat" class="chat-view" :class="{ 'has-outline': sections.length > 0 }">
    <!-- 主要内容区域 -->
    <div class="chat-main">
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

      <!-- 手机端大纲折叠面板（仅当有章节时显示） -->
      <div v-if="isMobile && sections.length > 0" class="mobile-outline-container">
        <details class="mobile-outline-details">
          <summary class="mobile-outline-summary">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <span>文章导览</span>
          </summary>
          <OutlineSidebar
            :sections="sections"
            :active-heading-id="activeHeadingId"
            :is-mobile="true"
            @toggle-section="toggleSection"
            @jump-to="jumpToSection"
          />
        </details>
      </div>

      <div ref="messagesContainer" class="messages-area">
        <div class="messages-content">
          <div v-if="chat.tags.length" class="chat-tags-header">
            <span v-for="tag in chat.tags" :key="tag" class="header-tag">{{ tag }}</span>
          </div>
          <MessageBubble
            v-for="(msg, idx) in chat.messages"
            :key="msg.id"
            :message="msg"
            :show-date="shouldShowDate(msg, idx)"
            :visible="isMessageVisible(idx)"
          />
          <CommentSection :chat-id="chat.id" />
        </div>
      </div>
    </div>

    <!-- 电脑端大纲侧边栏 -->
    <OutlineSidebar
      v-if="!isMobile && sections.length > 0"
      :sections="sections"
      :active-heading-id="activeHeadingId"
      :is-mobile="false"
      @toggle-section="toggleSection"
      @jump-to="jumpToSection"
    />
  </div>
</template>

<style scoped>
.chat-view {
  flex: 1;
  display: flex;
  flex-direction: row;
  height: 100vh;
  min-width: 0;
  overflow: hidden;
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
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
    flex-direction: column;
    height: 100dvh;
  }

  .chat-header {
    padding: 10px 12px;
    padding-top: calc(10px + env(safe-area-inset-top));
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

/* 手机端大纲折叠面板样式 */
.mobile-outline-container {
  border-bottom: 1px solid #e0e0e0;
  background: #fff;
}

.mobile-outline-details {
  background: #fff;
}

.mobile-outline-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  cursor: pointer;
  list-style: none;
  font-size: 0.9rem;
  color: #333;
  user-select: none;
}

.mobile-outline-summary::-webkit-details-marker {
  display: none;
}

.mobile-outline-summary svg {
  width: 18px;
  height: 18px;
  color: #c9372e;
}

.summary-badge {
  margin-left: auto;
  font-size: 0.75rem;
  color: #999;
  background: #f5f5f5;
  padding: 2px 8px;
  border-radius: 12px;
}

.mobile-outline-details[open] .mobile-outline-summary {
  border-bottom: 1px solid #f0f0f0;
}
</style>