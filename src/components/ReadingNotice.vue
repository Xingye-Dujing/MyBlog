<script setup>
import { ref, onMounted } from 'vue'

const visible = ref(false)

function isDesktop() {
  return window.innerWidth > 768
}

onMounted(() => {
  if (!isDesktop()) return
  const dismissed = localStorage.getItem('reading-notice-dismissed')
  if (dismissed !== 'true') {
    visible.value = true
  }
})

function close() {
  visible.value = false
}

function dismiss() {
  localStorage.setItem('reading-notice-dismissed', 'true')
  visible.value = false
}

</script>

<template>
  <Teleport to="body">
    <Transition name="notice-fade">
      <div v-if="visible" class="notice-overlay" @click.self="close">
        <div class="notice-box">
          <div class="notice-title">阅读提示</div>
          <div class="notice-body">
            <p>电脑端推荐将浏览器缩放至 <strong>90%</strong> 阅读博客，以获得最佳排版效果。</p>
            <p>推荐按 <strong>F11</strong> 全屏浏览，获得更沉浸的阅读体验。</p>
          </div>
          <div class="notice-footer">
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
  font-family: serif;
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
