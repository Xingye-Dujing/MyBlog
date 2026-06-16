<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import ChatList from '@/components/ChatList.vue'
import ChatView from '@/components/ChatView.vue'

const route = useRoute()

const hasActiveChat = computed(() => !!route.params.id)

// Check if mobile
function isMobile() {
  return window.innerWidth <= 768
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
    sidebarWidth.value = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, Number(savedWidth)))
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
function startResize(_e) {
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
})

onUnmounted(() => {
  window.removeEventListener('mousemove', doResize)
  window.removeEventListener('mouseup', stopResize)
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="home-layout">
    <ChatList
      v-show="!isCollapsed && (!hasActiveChat || !isMobile())"
      :class="{
        'mobile-hidden': hasActiveChat && !isMobile(),
        collapsed: isCollapsed && !isMobile(),
      }"
      :style="{ width: isMobile() ? '100%' : `${sidebarWidth}px` }"
    />

    <!-- Resize handle - only show on desktop when not collapsed -->
    <div
      v-if="!isCollapsed && !isMobile()"
      class="resize-handle"
      :class="{ resizing: isResizing }"
      @mousedown="startResize"
    ></div>

    <!-- Collapse toggle button -->
    <button
      v-if="!isMobile()"
      class="toggle-sidebar-btn"
      @click="toggleSidebar"
      :title="isCollapsed ? '展开侧边栏' : '折叠侧边栏'"
    ></button>

    <ChatView v-if="hasActiveChat" class="chat-panel" />

    <div v-else class="empty-state">
      <div class="empty-content">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <p class="empty-title">选择一个对话</p>
        <p class="empty-sub">或创建新的对话开始写作</p>
      </div>
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

.chat-panel {
  flex: 1;
  min-width: 0;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fafafa;
}

.empty-content {
  text-align: center;
  padding: 20px;
}

.empty-icon {
  width: 56px;
  height: 56px;
  margin: 0 auto 16px;
  color: #ddd;
}

.empty-icon svg {
  width: 100%;
  height: 100%;
}

.empty-title {
  font-size: 1.1rem;
  color: #999;
  margin: 0 0 6px;
  letter-spacing: 1.5px;
  font-weight: 200;
}

.empty-sub {
  font-size: 0.85rem;
  color: #ccc;
  margin: 0;
  letter-spacing: 0.5px;
}

/* Resize handle */
.resize-handle {
  width: 6px;
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

.resize-handle.resizing {
  background: linear-gradient(to right, transparent, rgba(64, 158, 255, 0.1), transparent);
}

/* Toggle sidebar button */
.toggle-sidebar-btn {
  position: absolute;
  top: 8px;
  right: 16px;
  z-index: 20;
  width: 36px;
  height: 36px;
  border: 1.5px solid #e0e0e0;
  background: #fff;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  transition: all 0.2s;
}

.toggle-sidebar-btn:hover {
  border-color: #000;
  color: #000;
  background: #fafafa;
}

@media (max-width: 768px) {
  .home-layout {
    height: 100dvh;
  }

  .mobile-hidden {
    display: none !important;
  }

  .empty-state {
    display: none;
  }

  .chat-panel {
    width: 100%;
    height: 100dvh;
  }

  .resize-handle {
    display: none;
  }

  .toggle-sidebar-btn {
    display: none;
  }
}
</style>
