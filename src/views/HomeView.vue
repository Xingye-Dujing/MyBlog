<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import { useCommentStore } from '@/stores/comment'
import ChatList from '@/components/ChatList.vue'
import ChatView from '@/components/ChatView.vue'
import PortalView from './PortalView.vue'

const route = useRoute()
const chatStore = useChatStore()
const commentStore = useCommentStore()

const hasActiveChat = computed(() => !!route.params.id)

// Check if mobile — 响应式，随窗口尺寸/旋转更新
const isMobile = ref(window.innerWidth <= 768)
function handleViewportResize() {
  isMobile.value = window.innerWidth <= 768
}

// Sidebar state
const sidebarWidth = ref(320)
const isCollapsed = ref(false)
const isResizing = ref(false)
const minSidebarWidth = 200
const maxSidebarWidth = 600

// Load saved state from localStorage
onMounted(() => {
  const savedWidth = localStorage.getItem('sidebar-width')
  const savedCollapsed = localStorage.getItem('sidebar-collapsed')

  if (savedWidth) {
    const width = Number(savedWidth)
    // Math.max/min with NaN would emit `width: NaNpx` and collapse the layout.
    if (Number.isFinite(width)) {
      sidebarWidth.value = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, width))
    }
  }
  if (savedCollapsed === 'true') {
    isCollapsed.value = true
  }
})

function saveState() {
  localStorage.setItem('sidebar-width', String(sidebarWidth.value))
  localStorage.setItem('sidebar-collapsed', String(isCollapsed.value))
}

// Resize handlers
function startResize() {
  isResizing.value = true
  document.body.style.cursor = 'ew-resize'
  document.body.style.userSelect = 'none'
}

function doResize(e) {
  if (!isResizing.value) return

  const newWidth = e.clientX
  if (newWidth >= minSidebarWidth && newWidth <= maxSidebarWidth) {
    sidebarWidth.value = newWidth
  }
}

function nudgeSidebar(delta) {
  sidebarWidth.value = Math.max(
    minSidebarWidth,
    Math.min(maxSidebarWidth, sidebarWidth.value + delta),
  )
  saveState()
}

function stopResize() {
  isResizing.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  saveState()
}

// Toggle sidebar collapse
function toggleSidebar() {
  isCollapsed.value = !isCollapsed.value
  saveState()
}

// Keyboard shortcuts
function handleKeydown(e) {
  // Ctrl/Cmd + B: toggle sidebar collapse
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
    e.preventDefault()
    toggleSidebar()
  }
}

onMounted(() => {
  window.addEventListener('mousemove', doResize)
  window.addEventListener('mouseup', stopResize)
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', handleViewportResize)
})

onUnmounted(() => {
  // 拖拽进行中若发生路由跳转（HomeView 会被卸载），mouseup 永远不会到达这里；
  // 不复位会让 <body> 一直保持 ew-resize 光标且无法选中文本。
  stopResize()
  window.removeEventListener('mousemove', doResize)
  window.removeEventListener('mouseup', stopResize)
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', handleViewportResize)
})
</script>

<template>
  <div class="home-layout">
    <div v-if="chatStore.error" class="data-error" role="alert">
      <span>{{ chatStore.error }}</span>
      <button type="button" @click="chatStore.init(); commentStore.init()">重试</button>
    </div>
    <!-- 手机端不应用桌面端的折叠状态（否则桌面 Ctrl+B 折叠后，手机首页会白屏） -->
    <ChatList
      v-show="isMobile ? !hasActiveChat : !isCollapsed"
      :class="{
        'mobile-hidden': hasActiveChat && !isMobile,
        collapsed: isCollapsed && !isMobile,
      }"
      :style="{ width: isMobile ? '100%' : `${sidebarWidth}px` }"
    />

    <!-- Resize handle - only show on desktop when not collapsed -->
    <div
      v-if="!isCollapsed && !isMobile"
      class="resize-handle"
      :class="{ resizing: isResizing }"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="'拖拽调整侧栏宽度，当前 ' + sidebarWidth + ' 像素'"
      @mousedown="startResize"
      @keydown.left.prevent="nudgeSidebar(-20)"
      @keydown.right.prevent="nudgeSidebar(20)"
    ></div>

    <ChatView v-if="hasActiveChat" class="chat-panel" />

    <div v-else class="portal-panel">
      <PortalView />
    </div>
  </div>
</template>

<style scoped>
.home-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
  position: relative;
}

.data-error {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 16px;
  background: #fff3f3;
  border-bottom: 1px solid #f3c9c5;
  color: #a52d25;
  font-size: 0.85rem;
}
.data-error button {
  border: 1px solid #a52d25;
  background: #fff;
  color: #a52d25;
  border-radius: 4px;
  padding: 3px 10px;
  cursor: pointer;
}

.chat-panel {
  flex: 1;
  min-width: 0;
}

.portal-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  overflow-y: auto;
  overflow-x: hidden;
  background: #fafafa;
  padding: 64px 48px;
}

/* Resize handle */
.resize-handle {
  width: 3px;
  height: 100%;
  cursor: ew-resize;
  background: transparent;
  transition: background 0.2s;
  flex-shrink: 0;
  z-index: 10;
  margin-left: -3px;
}

.resize-handle:hover {
  background: linear-gradient(to right, transparent, rgba(0, 0, 0, 0.05), transparent);
}
.resize-handle:focus-visible {
  outline: 2px solid #c9372e;
  outline-offset: -2px;
}

.resize-handle.resizing {
  background: linear-gradient(to right, transparent, rgba(64, 158, 255, 0.1), transparent);
}

@media (max-width: 768px) {
  .home-layout {
    height: 100dvh;
  }

  .mobile-hidden {
    display: none !important;
  }

  .portal-panel {
    display: none;
  }
  .chat-panel {
    width: 100%;
    height: 100dvh;
  }

  .resize-handle {
    display: none;
  }
}
</style>
