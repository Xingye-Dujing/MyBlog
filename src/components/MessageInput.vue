<script setup>
import { ref, nextTick, onMounted, onUnmounted } from 'vue'

const emit = defineEmits(['send'])

const props = defineProps({
  editingMessage: { type: Object, default: null },
  placeholder: { type: String, default: '写点什么... 支持 Markdown、代码块、$数学公式$' }
})

const content = ref('')
const textareaRef = ref(null)
const isDragOver = ref(false)

function autoResize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 300) + 'px'
}

function insertImageMarkdown(filename) {
  const textarea = textareaRef.value
  if (!textarea) return

  const markdown = `![${filename}](/img/${filename})`
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const text = content.value
  const before = text.substring(0, start)
  const after = text.substring(end)

  content.value = before + markdown + after
  isDragOver.value = false

  nextTick(() => {
    textarea.focus()
    const newPos = start + markdown.length
    textarea.setSelectionRange(newPos, newPos)
    autoResize()
  })
}

function handleDrop(e) {
  e.preventDefault()
  isDragOver.value = false

  const files = e.dataTransfer.files
  if (files.length > 0 && files[0].type.startsWith('image/')) {
    const file = files[0]
    insertImageMarkdown(file.name)
  }
}

function handleDragOver(e) {
  e.preventDefault()
  isDragOver.value = true
}

function handleDragLeave(e) {
  e.preventDefault()
  isDragOver.value = false
}

function handlePaste(e) {
  const items = e.clipboardData?.items
  if (!items) return

  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) {
      e.preventDefault()
      const file = items[i].getAsFile()
      if (file) {
        // For clipboard images, use a generic name with timestamp
        const filename = `clipboard-${Date.now()}.${file.name.split('.').pop() || 'png'}`
        insertImageMarkdown(filename)
      }
      break
    }
  }
}

function handleKeydown(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    send()
  }
}

function send() {
  const text = content.value.trim()
  if (!text) return
  emit('send', text)
  content.value = ''
  nextTick(autoResize)
}

function setContent(text) {
  content.value = text
  nextTick(() => {
    autoResize()
    textareaRef.value?.focus()
  })
}

function cancelEdit() {
  content.value = ''
  nextTick(autoResize)
  emit('send', null)
}

onMounted(() => {
  const textarea = textareaRef.value
  if (textarea) {
    textarea.addEventListener('dragover', handleDragOver)
    textarea.addEventListener('dragleave', handleDragLeave)
    textarea.addEventListener('drop', handleDrop)
    textarea.addEventListener('paste', handlePaste)
  }
})

onUnmounted(() => {
  const textarea = textareaRef.value
  if (textarea) {
    textarea.removeEventListener('dragover', handleDragOver)
    textarea.removeEventListener('dragleave', handleDragLeave)
    textarea.removeEventListener('drop', handleDrop)
    textarea.removeEventListener('paste', handlePaste)
  }
})

defineExpose({ setContent })
</script>

<template>
  <div class="message-input">
    <div class="input-wrapper">
      <div v-if="editingMessage" class="editing-hint">
        <span>正在编辑消息</span>
        <button class="cancel-btn" @click="cancelEdit">取消</button>
      </div>
      <div class="input-area" :class="{ 'drag-over': isDragOver }">
        <textarea ref="textareaRef" v-model="content" :placeholder="isDragOver ? '释放以上传图片...' : placeholder" rows="1"
          @input="autoResize" @keydown="handleKeydown"></textarea>
        <button class="send-btn" :disabled="!content.trim()" @click="send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
      <div class="input-hint">
        <span v-if="!isDragOver">Ctrl + Enter 发送</span>
        <span v-else>释放以上传图片</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-input {
  border-top: 1px solid #e0e0e0;
  padding: 12px 0;
  background: #fff;
}

.input-wrapper {
  max-width: 900px;
  margin: 0 auto;
  padding: 0 24px;
}

.editing-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  margin-bottom: 8px;
  background: #f8f8f8;
  border-radius: 4px;
  border-left: 3px solid #c9372e;
}

.editing-hint span {
  font-size: 0.8rem;
  color: #666;
}

.cancel-btn {
  font-size: 0.8rem;
  font-family: 'LXGW WenKai', 'Consolas', serif;
  color: #c9372e;
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 3px;
  transition: background 0.2s;
}

.cancel-btn:hover {
  background: #fee;
}

.input-area {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  position: relative;
}

.input-area.drag-over {
  background: #f0f7ff;
  border-radius: 8px;
  padding: 10px;
  margin: -10px;
}

.input-area.drag-over textarea {
  border-color: #409eff;
  background: #fff;
}

.input-area textarea {
  flex: 1;
  resize: none;
  border: 1.5px solid #e0e0e0;
  border-radius: 8px;
  padding: 10px 14px;
  font-family: 'LXGW WenKai', 'Consolas', serif;
  font-size: 0.95rem;
  line-height: 1.6;
  outline: none;
  background: #fafafa;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  min-height: 42px;
  max-height: 300px;
}

.input-area textarea:focus {
  border-color: #000;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.05);
}

.input-area textarea::placeholder {
  color: #bbb;
}

.send-btn {
  width: 42px;
  height: 42px;
  border: 1.5px solid #000;
  background: #000;
  color: #fff;
  border-radius: 8px;
  cursor: pointer;
  padding: 9px;
  flex-shrink: 0;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.send-btn:hover:not(:disabled) {
  background: #333;
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.send-btn:disabled {
  background: #e0e0e0;
  border-color: #e0e0e0;
  cursor: not-allowed;
}

.send-btn svg {
  width: 100%;
  height: 100%;
}

.input-hint {
  margin-top: 6px;
  text-align: right;
}

.input-hint span {
  font-size: 0.7rem;
  color: #ccc;
  letter-spacing: 0.5px;
}

@media (max-width: 768px) {
  .message-input {
    padding: 10px 0;
    padding-bottom: calc(10px + env(safe-area-inset-bottom));
  }

  .input-wrapper {
    padding: 0 12px;
  }

  .input-area {
    gap: 8px;
  }

  .input-area textarea {
    font-size: 16px;
    padding: 10px 12px;
    min-height: 40px;
    max-height: 160px;
    border-radius: 20px;
  }

  .input-area textarea::placeholder {
    font-size: 0.85rem;
  }

  .send-btn {
    width: 40px;
    height: 40px;
    padding: 9px;
    border-radius: 50%;
  }

  .editing-hint {
    margin-bottom: 6px;
    padding: 5px 10px;
  }

  .input-hint {
    display: none;
  }
}
</style>
