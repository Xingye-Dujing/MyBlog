<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'

const visible = ref(false)
const noticeBox = ref(null)
const closeBtn = ref(null)
let previouslyFocused = null

function isDesktop() {
  return window.innerWidth > 768
}

onMounted(() => {
  if (!isDesktop()) return
  const dismissed = localStorage.getItem('reading-notice-dismissed')
  if (dismissed !== 'true') {
    previouslyFocused = document.activeElement
    visible.value = true
    document.body.style.overflow = 'hidden'
    nextTick(() => closeBtn.value?.focus())
  }
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  document.body.style.overflow = ''
})

function handleKeydown(e) {
  if (!visible.value) return
  if (e.key === 'Escape') {
    close()
    return
  }
  // 焦点陷阱：对话框打开时 Tab 只在内部按钮间循环，不跑到背景内容。
  if (e.key === 'Tab') {
    const items = noticeBox.value?.querySelectorAll('button:not([disabled])')
    if (!items?.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

function close() {
  visible.value = false
  document.body.style.overflow = ''
  previouslyFocused?.focus?.()
  previouslyFocused = null
}

function dismiss() {
  localStorage.setItem('reading-notice-dismissed', 'true')
  close()
}

</script>

<template>
  <Teleport to="body">
    <Transition name="notice-fade">
      <div v-if="visible" class="notice-overlay" @click.self="close">
        <div
          ref="noticeBox"
          class="notice-box"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reading-notice-title"
        >
          <div id="reading-notice-title" class="notice-title">阅读提示</div>
          <div class="notice-body">
            <p>电脑端推荐将浏览器缩放至 <strong>90%</strong> 阅读博客，以获得最佳排版效果。</p>
            <p>推荐按 <strong>F11</strong> 全屏浏览，获得更沉浸的阅读体验。</p>
            <p>快捷键：<strong>Ctrl+B</strong> 折叠/展开左侧文章列表，<strong>Ctrl+O</strong> 折叠/展开右侧大纲导览。</p>
          </div>
          <div class="notice-footer">
            <button ref="closeBtn" class="notice-btn notice-btn-ghost" @click="close">
              稍后再说
            </button>
            <button class="notice-btn" @click="dismiss">不再提醒</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.notice-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.25);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}

.notice-box {
  background: #fff;
  border-radius: 10px;
  padding: 28px 32px 20px;
  max-width: 400px;
  width: 90%;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
  border: 1px solid #e0e0e0;
}

.notice-title {
  font-size: 1.05rem;
  color: #000;
  font-weight: 600;
  margin-bottom: 14px;
  letter-spacing: 0.5px;
}

.notice-body {
  font-size: 0.88rem;
  color: #444;
  line-height: 1.7;
}

.notice-body p {
  margin: 0 0 8px;
}

.notice-body p:last-child {
  margin-bottom: 0;
}

.notice-body strong {
  color: #c9372e;
}

.notice-footer {
  margin-top: 18px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.notice-btn:focus-visible {
  outline: 2px solid #c9372e;
  outline-offset: 2px;
}

.notice-btn {
  background: #fff;
  border: 1.5px solid #e0e0e0;
  color: #666;
  font-size: 0.82rem;
  padding: 6px 16px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  font-family: Literata, serif;
}

.notice-btn:hover {
  border-color: #c9372e;
  color: #c9372e;
  background: #fff;
}

.notice-fade-enter-active,
.notice-fade-leave-active {
  transition: opacity 0.25s ease;
}

.notice-fade-enter-active .notice-box,
.notice-fade-leave-active .notice-box {
  transition: transform 0.25s ease;
}

.notice-fade-enter-from,
.notice-fade-leave-to {
  opacity: 0;
}

.notice-fade-enter-from .notice-box {
  transform: scale(0.95);
}
</style>
