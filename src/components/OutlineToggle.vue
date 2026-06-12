<template>
  <div class="outline-toggle" @click.stop>
    <button
      class="outline-btn"
      :class="{ active: outlineEnabled }"
      @click="toggleOutline"
      :title="outlineEnabled ? '取消大纲节点' : '设为大纲节点'"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
    </button>
    <div v-if="editing" class="outline-editor" @click.stop>
      <input
        ref="inputRef"
        v-model="customTitle"
        placeholder="大纲显示标题（留空则自动取消息首行）"
        @keydown.enter="saveTitle"
        @blur="saveTitle"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue'
import { useChatStore } from '@/stores/chat'

const props = defineProps({
  chatId: { type: String, required: true },
  messageId: { type: String, required: true },
  messageContent: { type: String, default: '' },
  outline: { type: Object, default: () => ({ enabled: false, title: '' }) }
})

const emit = defineEmits(['update'])

const chatStore = useChatStore()
const editing = ref(false)
const customTitle = ref(props.outline?.title || '')
const inputRef = ref(null)

const outlineEnabled = computed(() => props.outline?.enabled || false)

function toggleOutline() {
  if (outlineEnabled.value) {
    // 已启用：关闭
    updateOutline(false, '')
  } else {
    // 未启用：打开编辑器，等待输入
    editing.value = true
    nextTick(() => {
      inputRef.value?.focus()
    })
  }
}

function saveTitle() {
  editing.value = false
  updateOutline(true, customTitle.value.trim())
}

function updateOutline(enabled, title) {
  const chat = chatStore.chats.find(c => c.id === props.chatId)
  const msg = chat?.messages.find(m => m.id === props.messageId)
  if (msg) {
    if (!msg.outline) msg.outline = { enabled: false, title: '' }
    msg.outline.enabled = enabled
    msg.outline.title = title
    chatStore.updateChat(props.chatId, { updatedAt: Date.now() })
    emit('update')
    if (!enabled) customTitle.value = '' // 清空标题
  }
}
</script>

<style scoped>
.outline-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.outline-btn {
  width: 28px;
  height: 28px;
  padding: 5px;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  color: #bbb;
  transition: all 0.2s;
}
.outline-btn:hover {
  background: #e8e8e8;
  color: #666;
}
.outline-btn.active {
  color: #c9372e;
  background: #fee;
}
.outline-editor {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 20;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  width: 200px;
}
.outline-editor input {
  width: 100%;
  border: 1px solid #ccc;
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 0.8rem;
  font-family: serif;
  outline: none;
}
.outline-editor input:focus {
  border-color: #c9372e;
}
@media (max-width: 768px) {
  .outline-editor {
    left: auto;
    right: 0;
    width: 180px;
  }
}
</style>