<script setup>
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import { useSections } from '@/composables/useSections'
import { eagerLoadImagesInRange } from '@/utils/scrollHelper'
import MessageBubble from '@/components/MessageBubble.vue'
import CommentSection from '@/components/CommentSection.vue'
import OutlineSidebar from '@/components/OutlineSidebar.vue'

const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()

const messagesContainer = ref(null)
const isMobile = ref(window.innerWidth <= 768)
const showOutlinePanel = ref(true)
const searchQuery = ref('')
const showSearch = ref(false)
const searchInputRef = ref(null)
const currentMatchIndex = ref(0)

const chat = computed(() => {
  const id = route.params.id
  return chatStore.chats.find((c) => c.id === id) || null
})

const {
  sections,
  activeHeadingId,
  buildSections,
  toggleSection,
  jumpToSection,
  attachScrollListener,
  detachScrollListener,
} = useSections(chat, messagesContainer)

function isMessageVisible(msgIndex) {
  const section = sections.value.find(
    (s) => msgIndex >= s.startMsgIndex && msgIndex <= s.endMsgIndex,
  )
  return !section?.collapsed
}

const messagesWithDates = computed(() => {
  if (!chat.value) return []
  const result = []
  let lastDate = ''
  const query = searchQuery.value.trim().toLowerCase()
  for (let idx = 0; idx < chat.value.messages.length; idx++) {
    const msg = chat.value.messages[idx]
    const d = new Date(msg.timestamp)
    const dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const matchesSearch = query ? msg.content.toLowerCase().includes(query) : false
    result.push({
      ...msg,
      showDate: dateKey !== lastDate,
      _visible: isMessageVisible(idx),
      _searchMatch: matchesSearch,
    })
    lastDate = dateKey
  }
  return result
})

const searchMatchCount = computed(() => {
  return messagesWithDates.value.filter((m) => m._searchMatch).length
})

const currentMatchId = computed(() => {
  const matches = messagesWithDates.value.filter((m) => m._searchMatch)
  return matches[currentMatchIndex.value]?.id ?? null
})

function toggleSearch() {
  showSearch.value = !showSearch.value
  if (showSearch.value) {
    nextTick(() => {
      searchInputRef.value?.focus()
    })
  } else {
    searchQuery.value = ''
    currentMatchIndex.value = 0
  }
}

async function navigateSearch(direction) {
  const matches = messagesWithDates.value.filter((m) => m._searchMatch)
  if (!matches.length) return
  currentMatchIndex.value = (currentMatchIndex.value + direction + matches.length) % matches.length
  const target = matches[currentMatchIndex.value]
  // 命中项可能位于折叠分区中，先展开它所在（及之前）的分区。
  const idx = chat.value.messages.findIndex((m) => m.id === target.id)
  if (idx !== -1) {
    sections.value.forEach((section) => {
      if (section.collapsed && idx >= section.startMsgIndex && idx <= section.endMsgIndex) {
        toggleSection(section.id)
      }
    })
  }
  await nextTick()
  const el = messagesContainer.value?.querySelector(`[data-msg-id="${target.id}"]`)
  if (!el) return
  await eagerLoadImagesInRange(messagesContainer.value, el)
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

watch(searchQuery, () => {
  currentMatchIndex.value = 0
})

const OUTLINE_STORAGE_KEY = 'outline-panel-visible'

function toggleOutlinePanel() {
  showOutlinePanel.value = !showOutlinePanel.value
  localStorage.setItem(OUTLINE_STORAGE_KEY, String(showOutlinePanel.value))
}

function handleResize() {
  isMobile.value = window.innerWidth <= 768
}

function handleKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
    e.preventDefault()
    toggleOutlinePanel()
  }
}

async function scrollToHashMessage() {
  const hash = route.hash
  if (!hash || !hash.startsWith('#msg-')) return
  const msgId = hash.slice(5)
  // 数据由异步 fetch 提供：轮询等待消息渲染，避免固定延时造成深链接失效。
  for (let attempt = 0; attempt < 30; attempt++) {
    await nextTick()
    if (chat.value) {
      const idx = chat.value.messages.findIndex((m) => m.id === msgId)
      const section = sections.value.find(
        (s) => idx >= s.startMsgIndex && idx <= s.endMsgIndex,
      )
      if (section?.collapsed) toggleSection(section.id)
      await nextTick()
      const el = messagesContainer.value?.querySelector(`[data-msg-id="${msgId}"]`)
      if (el) {
        await eagerLoadImagesInRange(messagesContainer.value, el)
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        el.classList.add('deep-link-highlight')
        setTimeout(() => el.classList.remove('deep-link-highlight'), 1500)
        return
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

watch(() => route.hash, scrollToHashMessage)

watch(
  () => route.params.id,
  () => {
    buildSections()
    activeHeadingId.value = null
    showSearch.value = false
    searchQuery.value = ''
    currentMatchIndex.value = 0
    nextTick(() => {
      if (messagesContainer.value) {
        messagesContainer.value.scrollTop = 0
      }
    })
  },
)

watch(
  () => chat.value,
  (newChat) => {
    if (newChat) {
      buildSections()
      nextTick(() => {
        if (route.hash.startsWith('#msg-')) {
          scrollToHashMessage()
        } else if (messagesContainer.value) {
          messagesContainer.value.scrollTop = 0
        }
      })
    }
  },
  { immediate: true, deep: true },
)

onMounted(() => {
  window.addEventListener('resize', handleResize)
  window.addEventListener('keydown', handleKeydown)
  attachScrollListener()
  scrollToHashMessage()

  const saved = localStorage.getItem(OUTLINE_STORAGE_KEY)
  if (saved === 'false') {
    showOutlinePanel.value = false
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('keydown', handleKeydown)
  detachScrollListener()
})
</script>

<template>
  <div v-if="chat" class="chat-view" :class="{ 'has-outline': sections.length > 0 }">
    <!-- Main content area -->
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
        <button class="header-btn" type="button" title="搜索（内容中的关键词）" aria-label="搜索消息内容" @click="toggleSearch">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
        <!-- Desktop: outline toggle button (Ctrl+O also works) -->
        <button
          v-if="!isMobile && sections.length > 0"
          class="header-btn"
          type="button"
          :title="showOutlinePanel ? '隐藏导览（Ctrl+O）' : '显示导览（Ctrl+O）'"
          :aria-label="showOutlinePanel ? '隐藏导览' : '显示导览'"
          :aria-pressed="showOutlinePanel"
          @click="toggleOutlinePanel"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </button>
        <!-- Mobile: outline toggle button -->
        <button
          v-if="isMobile && sections.length > 0"
          class="outline-toggle-btn"
          type="button"
          @click="toggleOutlinePanel"
          :title="showOutlinePanel ? '隐藏导览' : '显示导览'"
          :aria-label="showOutlinePanel ? '隐藏导览' : '显示导览'"
          :aria-pressed="showOutlinePanel"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </button>
      </div>

      <div v-if="showSearch" class="search-bar">
        <div class="search-input-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            class="search-input"
            placeholder="搜索消息内容..."
            @keydown.enter="navigateSearch(1)"
            @keydown.esc="toggleSearch"
          />
          <span v-if="searchQuery" class="search-count">
            {{ searchMatchCount > 0 ? `${currentMatchIndex + 1} / ${searchMatchCount}` : '无结果' }}
          </span>
          <button
            v-if="searchMatchCount > 1"
            class="search-nav-btn"
            title="上一个"
            @click="navigateSearch(-1)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            v-if="searchMatchCount > 1"
            class="search-nav-btn"
            title="下一个"
            @click="navigateSearch(1)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button class="search-close-btn" title="关闭搜索" @click="toggleSearch">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Mobile outline panel (only when sections exist) -->
      <div
        v-if="isMobile && sections.length > 0 && showOutlinePanel"
        class="mobile-outline-container"
      >
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
          <template v-for="msg in messagesWithDates" :key="msg.id">
            <MessageBubble
              v-if="msg._visible"
              :message="msg"
              :chat-id="chat.id"
              :show-date="msg.showDate"
              :class="{
                'search-match': msg._searchMatch,
                'current-search-match': msg.id === currentMatchId,
              }"
              :data-msg-id="msg.id"
            />
          </template>
          <CommentSection :chat-id="chat.id" />
        </div>
      </div>
    </div>

    <!-- Desktop outline sidebar -->
    <OutlineSidebar
      v-if="!isMobile && sections.length > 0 && showOutlinePanel"
      :sections="sections"
      :active-heading-id="activeHeadingId"
      :is-mobile="false"
      @toggle-section="toggleSection"
      @jump-to="jumpToSection"
    />
  </div>

  <!-- 找不到对话（或数据仍在加载）时显示；必须与外层 v-if="chat" 配对，
       不能挂到大纲侧栏的 v-if 上，否则手机端/隐藏大纲时会误报“对话不存在”。 -->
  <div v-else class="chat-missing">
    <template v-if="chatStore.loading">
      <p>正在加载对话…</p>
    </template>
    <template v-else>
      <h2>对话不存在或已被移除</h2>
      <p>{{ chatStore.error || '链接可能已失效，请从首页选择一个对话。' }}</p>
      <button type="button" class="back-home-btn" @click="router.push({ name: 'home' })">
        返回首页
      </button>
    </template>
  </div>
</template>

<style scoped>
.chat-missing {
  max-width: 520px;
  margin: 15vh auto;
  padding: 32px;
  text-align: center;
  color: #444;
}
.chat-missing h2 {
  font-size: 1.3rem;
  font-weight: 400;
  margin-bottom: 12px;
}
.chat-missing p {
  font-size: 0.9rem;
  color: #888;
  margin-bottom: 20px;
}
.back-home-btn {
  padding: 8px 20px;
  border: 1px solid #c9372e;
  background: #fff;
  color: #c9372e;
  border-radius: 4px;
  cursor: pointer;
}
.back-home-btn:hover {
  background: #fff5f5;
}

:deep(.section-highlight) {
  transition: background 0.3s;
  background: #faf0e6;
}

:deep(.search-match) {
  background: #fffde7 !important;
  transition: background 0.3s;
}

:deep(.current-search-match) {
  background: #ffe0b2 !important;
  box-shadow: inset 3px 0 0 #e65100;
  transition: background 0.3s;
}

:deep(.deep-link-highlight) {
  animation: deepLinkPulse 1.5s ease;
}

@keyframes deepLinkPulse {
  0% {
    background: #fff3cd;
    box-shadow: 0 0 0 0 rgba(255, 193, 7, 0.4);
  }
  50% {
    background: #fff3cd;
    box-shadow: 0 0 0 8px rgba(255, 193, 7, 0);
  }
  100% {
    background: transparent;
    box-shadow: 0 0 0 0 rgba(255, 193, 7, 0);
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
  flex-shrink: 0;
}

.header-btn svg {
  width: 100%;
  height: 100%;
}

.search-bar {
  border-bottom: 1px solid #e0e0e0;
  background: #fff;
  padding: 8px 24px;
}

.search-input-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #f5f5f5;
  border-radius: 8px;
  padding: 4px 8px;
}

.search-input-wrap svg {
  width: 16px;
  height: 16px;
  color: #999;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  font-size: 0.9rem;
  font-family: Literata, serif;
  padding: 4px 0;
  min-width: 0;
}

.search-count {
  font-size: 0.75rem;
  color: #999;
  white-space: nowrap;
  flex-shrink: 0;
}

.search-nav-btn,
.search-close-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px;
  color: #666;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s;
}

.search-nav-btn:hover,
.search-close-btn:hover {
  background: #e0e0e0;
  color: #000;
}

.search-nav-btn svg,
.search-close-btn svg {
  width: 16px;
  height: 16px;
}

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
    max-height: 100dvh;
  }

  .chat-main {
    height: 100%;
    min-height: 0; /* Critical: allow flex children to shrink */
  }

  .messages-area {
    flex: 1;
    min-height: 0; /* Critical: allow scrolling */
    overflow-y: auto;
    padding: 8px 0;
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
  .outline-toggle-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 8px;
    margin-left: 6px;
    border: none;
    background: none;
    color: #666;
    cursor: pointer;
    border-radius: 6px;
    flex-shrink: 0;
  }

  .outline-toggle-btn:active {
    background: #f0f0f0;
  }

  .outline-toggle-btn svg {
    width: 100%;
    height: 100%;
  }

  .search-bar {
    padding: 8px 12px;
  }

  .search-input {
    font-size: 0.8rem;
  }

  .header-btn {
    width: 36px;
    height: 36px;
    padding: 8px;
  }
}

/* Mobile outline panel styles */
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
