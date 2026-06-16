<template>
  <div
    class="outline-sidebar"
    :class="{ 'mobile-outline': isMobile }"
    :style="{ width: isMobile ? '100%' : width + 'px' }"
  >
    <div v-if="!isMobile" class="outline-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
      <span>文章导览</span>
    </div>
    <div class="outline-items">
      <div
        v-for="section in sections"
        :key="section.id"
        class="outline-item"
        :class="{ active: activeHeadingId === section.id }"
      >
        <div class="outline-item-header" @click="handleJump(section)">
          <button
            class="collapse-btn"
            @click.stop="handleToggle(section.id)"
            :title="section.collapsed ? '展开内容' : '折叠内容'"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              :style="{ transform: section.collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <div class="outline-title" :style="{ paddingLeft: (section.level - 1) * 12 + 'px' }">
            <span class="title-text">{{ section.title }}</span>
            <span v-if="section.messageCount > 1" class="msg-badge"
              >{{ section.messageCount }}条</span
            >
          </div>
        </div>
      </div>
    </div>
    <!-- 拖拽条（仅在非手机端显示） -->
    <div v-if="!isMobile" class="resize-handle" @mousedown="startResize"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  sections: { type: Array, required: true },
  activeHeadingId: { type: String, default: null },
  isMobile: { type: Boolean, default: false },
})

const emit = defineEmits(['toggle-section', 'jump-to'])

// 宽度控制
const STORAGE_KEY = 'outline-sidebar-width'
const DEFAULT_WIDTH = 260
const MIN_WIDTH = 180
const MAX_WIDTH = 400

const width = ref(DEFAULT_WIDTH)
let isResizing = false
let startX = 0
let startWidth = 0

function startResize(e) {
  isResizing = true
  startX = e.clientX
  startWidth = width.value
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'ew-resize'
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', stopResize)
  e.preventDefault()
}

function onMouseMove(e) {
  if (!isResizing) return
  const delta = e.clientX - startX
  let newWidth = startWidth - delta
  newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth))
  width.value = newWidth
}

function stopResize() {
  isResizing = false
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', stopResize)
  localStorage.setItem(STORAGE_KEY, width.value)
}

onMounted(() => {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    const w = parseInt(saved, 10)
    if (!isNaN(w) && w >= MIN_WIDTH && w <= MAX_WIDTH) {
      width.value = w
    }
  }
})

onUnmounted(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', stopResize)
})

function handleJump(section) {
  emit('jump-to', section)
}

function handleToggle(sectionId) {
  emit('toggle-section', sectionId)
}
</script>

<style scoped>
.outline-sidebar {
  position: relative;
  background: #fff;
  border-left: 1.5px solid #e0e0e0;
  height: 100vh;
  position: sticky;
  top: 0;
  overflow-y: auto;
  flex-shrink: 0;
  font-family: serif;
  transition: none;
}
.outline-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px 16px 12px;
  border-bottom: 1.5px solid #f0f0f0;
  font-size: 0.9rem;
  font-weight: 400;
  color: #000;
  letter-spacing: 1px;
}
.outline-header svg {
  width: 18px;
  height: 18px;
  color: #c9372e;
}
.outline-items {
  padding: 8px 0;
}
.outline-item {
  border-bottom: 1px solid #fafafa;
}
.outline-item-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 16px;
  cursor: pointer;
  transition: background 0.15s;
}
.outline-item-header:hover {
  background: #fafafa;
}
.outline-item.active .outline-item-header {
  background: #f5f5f5;
}
.collapse-btn {
  width: 24px;
  height: 24px;
  padding: 4px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: #999;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s;
}
.collapse-btn:hover {
  background: #e8e8e8;
  color: #333;
}
.collapse-btn svg {
  width: 14px;
  height: 14px;
  transition: transform 0.2s ease;
}
.outline-title {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.85rem;
  color: #444;
  overflow: hidden;
}
.title-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-badge {
  font-size: 0.7rem;
  color: #bbb;
  background: #f5f5f5;
  padding: 2px 6px;
  border-radius: 10px;
  flex-shrink: 0;
}
.outline-item.active .title-text {
  color: #000;
  font-weight: 500;
}
.resize-handle {
  position: absolute;
  left: -4px;
  top: 0;
  width: 8px;
  height: 100%;
  cursor: ew-resize;
  background: transparent;
  z-index: 10;
  transition: background 0.2s;
}
.resize-handle:hover {
  background: rgba(0, 0, 0, 0.05);
}
/* 手机端样式 */
.mobile-outline {
  width: 100% !important;
  position: sticky;
  top: 0;
  left: 0;
  right: 0;
  height: auto;
  max-height: 50vh;
  border-left: none;
  border-bottom: 1px solid #e0e0e0;
  z-index: 10;
  background: #fff;
  overflow-y: auto;
}
.mobile-outline .outline-items {
  padding: 0;
  max-height: 40vh;
  overflow-y: auto;
  border-top: 1px solid #f0f0f0;
}
.mobile-outline .outline-item-header {
  padding: 12px 16px;
}
@media (max-width: 768px) {
  .resize-handle {
    display: none;
  }
}
</style>
