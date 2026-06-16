<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import { useCommentStore } from '@/stores/comment'
import { useSections } from '@/composables/useSections'
import { useChatActions } from '@/composables/useChatActions'
import MessageBubble from '@/components/MessageBubble.vue'
import MessageInput from '@/components/MessageInput.vue'
import CommentSection from '@/components/CommentSection.vue'
import OutlineSidebar from '@/components/OutlineSidebar.vue'

const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()
const commentStore = useCommentStore()

const messagesContainer = ref(null)
const inputRef = ref(null)
const isMobile = ref(window.innerWidth <= 768)

const chat = computed(() => {
  const id = route.params.id
  return chatStore.chats.find((c) => c.id === id) || null
})

const {
  sections,
  activeHeadingId,
  toggleSection,
  jumpToSection,
  handleOutlineUpdate,
  attachScrollListener,
  detachScrollListener,
} = useSections(chat, messagesContainer)

const {
  editingMessage,
  insertTarget,
  movingMessageId,
  moveDirection,
  editingTitle,
  titleInput,
  showTagsEditor,
  tagInput,
  showActions,
  syncStatus,
  handleSend: _handleSend,
  handleEdit,
  handleDelete: _handleDelete,
  handleMove: _handleMove,
  handleInsert,
  deleteChat,
  togglePin,
  syncToFile,
  startEditTitle,
  saveTitle,
  handleTitleKeydown,
  openTagsEditor,
  closeTagsEditor,
  addTag,
  removeTag,
  handleTagKeydown,
  handleFileImport: _handleFileImport,
  resetUIState,
} = useChatActions(chat, router, inputRef)

function handleSend(content) {
  _handleSend(content, handleOutlineUpdate)
}

function handleDelete(msg) {
  _handleDelete(msg, handleOutlineUpdate)
}

function handleMove(msg, direction) {
  _handleMove(msg, direction, handleOutlineUpdate)
}

function handleFileImport(event) {
  _handleFileImport(event, handleOutlineUpdate)
}

const messagesWithDates = computed(() => {
  if (!chat.value) return []
  const result = []
  let lastDate = ''
  for (let idx = 0; idx < chat.value.messages.length; idx++) {
    const msg = chat.value.messages[idx]
    const d = new Date(msg.timestamp)
    const dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const section = sections.value.find((s) => idx >= s.startMsgIndex && idx <= s.endMsgIndex)
    const isVisible = !section?.collapsed
    result.push({
      ...msg,
      showDate: dateKey !== lastDate,
      _visible: isVisible,
      _sectionId: section?.id,
    })
    lastDate = dateKey
  }
  return result
})

watch(
  () => route.params.id,
  (newId, oldId) => {
    resetUIState()
    if (oldId && newId) {
      const validChatIds = chatStore.chats.map((c) => c.id)
      const validMessageMap = {}
      chatStore.chats.forEach((c) => {
        validMessageMap[c.id] = c.messages.map((m) => m.id)
      })
      commentStore.filterOrphanedComments(validChatIds, validMessageMap)
      commentStore.syncToFile()
    }
    handleOutlineUpdate()
  },
)

watch(
  () => chat.value,
  () => {
    handleOutlineUpdate()
  },
  { deep: true, immediate: true },
)

function handleResize() {
  isMobile.value = window.innerWidth <= 768
}

onMounted(() => {
  window.addEventListener('resize', handleResize)
  attachScrollListener()
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  detachScrollListener()
})
</script>

<template>
  <div class="chat-view" :class="{ 'has-outline': !isMobile && sections.length > 0 }">
    <div class="chat-main">
      <div class="chat-header">
        <button class="back-btn mobile-only" @click="router.push({ name: 'home' })">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div class="header-info">
          <div v-if="editingTitle" class="title-edit-form" @click.stop>
            <input
              v-model="titleInput"
              class="title-input"
              autofocus
              @keydown="handleTitleKeydown"
              @blur="saveTitle"
            />
            <button class="title-save-btn" @click="saveTitle">保存</button>
          </div>
          <template v-else>
            <h2 class="chat-name" @dblclick="startEditTitle" :title="`双击编辑标题`">
              {{ chat.title }}
            </h2>
            <span class="chat-meta">{{ chat.messages.length }} 条消息</span>
          </template>
        </div>
        <div class="header-actions">
          <div v-if="syncStatus" class="sync-toast" :class="syncStatus">
            {{ syncStatus.includes('success') ? '已同步' : '同步失败' }}
          </div>
          <button
            class="header-btn"
            title="更多"
            @click="showActions = !showActions"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="1" />
              <circle cx="19" cy="12" r="1" />
              <circle cx="5" cy="12" r="1" />
            </svg>
          </button>
          <div
            v-if="showActions"
            class="actions-overlay"
            @click="showActions = false"
          ></div>
          <div v-if="showActions" class="actions-dropdown">
            <button @click="startEditTitle()">重命名对话</button>
            <button @click="openTagsEditor()">管理分类</button>
            <button
              @click="
                togglePin();
                showActions = false;
              "
            >
              {{ chat.pinned ? '取消置顶' : '置顶对话' }}
            </button>
            <button
              @click="
                syncToFile();
                showActions = false;
              "
            >
              同步到文件
            </button>
            <button
              @click="
                $refs.fileInput.click();
                showActions = false;
              "
            >
              从文件导入
            </button>
            <input
              ref="fileInput"
              type="file"
              accept=".json,application/json"
              @change="handleFileImport"
              style="display: none"
            />
            <button
              @click="
                chatStore.exportJSON();
                showActions = false;
              "
            >
              导出全部数据
            </button>
            <button class="danger" @click="deleteChat()">删除对话</button>
          </div>

          <!-- 标签编辑器弹窗 -->
          <div
            v-if="showTagsEditor"
            class="tags-editor-overlay"
            @click="closeTagsEditor"
          >
            <div class="tags-editor" @click.stop>
              <div class="tags-editor-header">
                <h3>管理分类</h3>
                <button class="close-btn" @click="closeTagsEditor">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <div class="current-tags">
                <span v-for="tag in chat.tags" :key="tag" class="current-tag">
                  {{ tag }}
                  <button @click="removeTag(tag)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </span>
                <span v-if="!chat.tags.length" class="no-tags">暂无分类</span>
              </div>
              <div class="add-tag-form">
                <input
                  v-model="tagInput"
                  class="tag-input"
                  placeholder="输入分类名称..."
                  @keydown="handleTagKeydown"
                />
                <button class="add-tag-btn" @click="addTag">添加</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 手机端大纲折叠面板 -->
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
            <span class="summary-badge">{{ sections.length }}章</span>
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
              :show-date="msg.showDate"
              :chat-id="chat.id"
              :move-class="
                movingMessageId === msg.id
                  ? moveDirection === 'up'
                    ? 'move-up'
                    : 'move-down'
                  : ''
              "
              @edit="handleEdit"
              @delete="handleDelete"
              @move="handleMove"
              @insert="handleInsert"
              @outline-update="handleOutlineUpdate"
            />
          </template>
          <div v-if="!chat.messages.length" class="empty-chat">
            <p>开始输入第一条消息</p>
          </div>
          <CommentSection :chat-id="chat.id" />
        </div>
      </div>

      <MessageInput
        ref="inputRef"
        :editing-message="editingMessage"
        :insert-target="insertTarget"
        @send="handleSend"
        @cancel-insert="insertTarget = null"
      />
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
:deep(.section-highlight) {
  transition: background 0.3s;
  background: #faf0e6;
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

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
}

.sync-toast {
  font-size: 0.75rem;
  padding: 4px 10px;
  border-radius: 4px;
  animation: fadeIn 0.2s ease;
}

.sync-toast.success {
  color: #2d7d2d;
  background: #e8f5e9;
}

.sync-toast.error {
  color: #c9372e;
  background: #fee;
}

.sync-toast.import-success {
  color: #2d7d2d;
  background: #e8f5e9;
}

.sync-toast.import-error {
  color: #c9372e;
  background: #fee;
}

.title-edit-form {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-input {
  border: 1.4px solid black;
  border-radius: 6px;
  padding: 3px 10px;
  font-family: serif;
  font-size: 1rem;
  outline: none;
  background: #fff;
}

.title-save-btn {
  padding: 6px 14px;
  background: #c9372e;
  color: #fff;
  border: none;
  border-radius: 4px;
  font-family: serif;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background 0.2s;
}

.title-save-btn:hover {
  background: #a52d25;
}

.tags-editor-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.2s ease;
}

.tags-editor {
  background: #fff;
  border-radius: 12px;
  width: 90%;
  max-width: 400px;
  padding: 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
}

.tags-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.tags-editor-header h3 {
  font-size: 1.1rem;
  font-weight: 400;
  color: #000;
  margin: 0;
  letter-spacing: 1px;
}

.close-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 6px;
  color: #666;
  border-radius: 6px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: #f0f0f0;
  color: #000;
}

.close-btn svg {
  width: 100%;
  height: 100%;
}

.current-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px;
  background: #fafafa;
  border-radius: 8px;
  min-height: 60px;
  margin-bottom: 16px;
}

.current-tag {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: #fee;
  color: #c9372e;
  border-radius: 16px;
  font-size: 0.85rem;
}

.current-tag button {
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 3px;
  color: #c9372e;
  border-radius: 50%;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.current-tag button:hover {
  background: #fdd;
}

.current-tag button svg {
  width: 100%;
  height: 100%;
}

.no-tags {
  font-size: 0.85rem;
  color: #999;
  width: 100%;
  text-align: center;
}

.add-tag-form {
  display: flex;
  gap: 8px;
}

.tag-input {
  flex: 1;
  border: 1.5px solid #e0e0e0;
  border-radius: 6px;
  padding: 8px 12px;
  font-family: serif;
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.2s;
}

.tag-input:focus {
  border-color: #c9372e;
}

.add-tag-btn {
  padding: 8px 20px;
  background: #c9372e;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-family: serif;
  font-size: 0.9rem;
  cursor: pointer;
  transition: background 0.2s;
}

.add-tag-btn:hover {
  background: #a52d25;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
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
}

.header-btn:hover {
  background: #f0f0f0;
  color: #000;
}

.header-btn svg {
  width: 100%;
  height: 100%;
}

.actions-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: #fff;
  border: 1.5px solid #e0e0e0;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  z-index: 100;
  min-width: 160px;
  overflow: hidden;
}

.actions-overlay {
  display: none;
}

.actions-dropdown button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 16px;
  border: none;
  background: none;
  cursor: pointer;
  font-family: serif;
  font-size: 0.85rem;
  color: #333;
  transition: background 0.15s;
}

.actions-dropdown button:hover {
  background: #f5f5f5;
}

.actions-dropdown button.danger {
  color: #c9372e;
}

.actions-dropdown button.danger:hover {
  background: #fee;
}

.file-input-label {
  display: block;
  width: 100%;
  padding: 10px 16px;
  font-family: serif;
  font-size: 0.85rem;
  color: #333;
  cursor: pointer;
  transition: background 0.15s;
}

.file-input-label:hover {
  background: #f5f5f5;
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

.empty-chat {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
}

.empty-chat p {
  font-size: 0.95rem;
  color: #ccc;
  letter-spacing: 1px;
}

@media (max-width: 768px) {
  .chat-view {
    height: 100dvh;
  }

  .back-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border: none;
    background: none;
    cursor: pointer;
    padding: 8px;
    color: #000;
    margin-right: 6px;
    flex-shrink: 0;
    border-radius: 6px;
    -webkit-tap-highlight-color: transparent;
  }

  .back-btn:active {
    background: #f0f0f0;
  }

  .back-btn svg {
    width: 100%;
    height: 100%;
  }

  .chat-header {
    padding: 10px 12px;
    padding-top: calc(10px + env(safe-area-inset-top));
  }

  .chat-name {
    font-size: 1.05rem;
  }

  .chat-meta {
    font-size: 0.72rem;
  }

  .header-btn {
    width: 40px;
    height: 40px;
    padding: 8px;
  }

  .messages-area {
    padding: 8px 0;
    -webkit-overflow-scrolling: touch;
  }

  .chat-tags-header {
    padding: 0 12px 8px;
  }

  .header-tag {
    font-size: 0.7rem;
    padding: 2px 8px;
  }

  /* Bottom sheet style dropdown for mobile */
  .actions-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    z-index: 199;
    animation: fadeIn 0.2s ease;
  }

  /* Bottom sheet style dropdown for mobile */
  .actions-dropdown {
    position: fixed;
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    margin-top: 0;
    border-radius: 16px 16px 0 0;
    border: none;
    border-top: 1.5px solid #e0e0e0;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
    min-width: auto;
    z-index: 200;
    padding-bottom: env(safe-area-inset-bottom);
    animation: slideUp 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .actions-dropdown button {
    padding: 16px 20px;
    font-size: 0.95rem;
    min-height: 50px;
    display: flex;
    align-items: center;
  }

  .actions-dropdown button:not(:last-child) {
    border-bottom: 1px solid #f0f0f0;
  }

  .title-edit-form {
    flex: 1;
  }

  .title-input {
    font-size: 1rem;
    padding: 4px 8px;
  }

  .title-save-btn {
    padding: 4px 10px;
    font-size: 0.8rem;
  }

  /* Mobile tags editor - full screen modal */
  .tags-editor-overlay {
    background: rgba(0, 0, 0, 0.6);
  }

  .tags-editor {
    width: 95%;
    max-width: none;
    padding: 16px;
    border-radius: 16px;
  }

  .tags-editor-header h3 {
    font-size: 1rem;
  }

  .close-btn {
    width: 36px;
    height: 36px;
  }

  .current-tags {
    min-height: 50px;
    padding: 10px;
  }

  .current-tag {
    font-size: 0.8rem;
    padding: 3px 8px;
  }

  .current-tag button {
    width: 16px;
    height: 16px;
  }

  .tag-input {
    font-size: 0.9rem;
    padding: 7px 10px;
    min-height: 44px;
  }

  .add-tag-btn {
    padding: 7px 16px;
    font-size: 0.85rem;
    min-height: 44px;
  }
}

@keyframes slideUp {
  from {
    transform: translateY(100%);
  }

  to {
    transform: translateY(0);
  }
}

@media print {
  .chat-header {
    border-bottom: 2px solid #000;
  }

  .header-actions {
    display: none;
  }

  .back-btn {
    display: none !important;
  }

  .messages-area {
    overflow: visible;
    background: #fff;
  }

  .chat-view {
    height: auto;
  }
}
</style>
