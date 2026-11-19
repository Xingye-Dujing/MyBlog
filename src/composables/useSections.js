import { ref, nextTick } from 'vue'
import { getPlainText } from '@/composables/useMarkdown'
import { eagerLoadImagesInRange } from '@/utils/scrollHelper'

export function useSections(chat, messagesContainer) {
  const sections = ref([])
  const activeHeadingId = ref(null)
  let scrollElement = null

  function buildSections() {
    if (!chat.value || !chat.value.messages.length) {
      sections.value = []
      return
    }
    const messages = chat.value.messages
    const outlineIndices = []
    messages.forEach((msg, idx) => {
      if (msg.outline?.enabled) outlineIndices.push(idx)
    })

    const newSections = []

    if (outlineIndices.length === 0) {
      newSections.push({
        id: 'section-all',
        title: '全部内容',
        level: 2,
        startMsgIndex: 0,
        endMsgIndex: messages.length - 1,
        headingMsgIndex: null,
        collapsed: false,
        messageCount: messages.length,
      })
    } else {
      if (outlineIndices[0] > 0) {
        newSections.push({
          id: 'section-intro',
          title: '开头',
          level: 2,
          startMsgIndex: 0,
          endMsgIndex: outlineIndices[0] - 1,
          headingMsgIndex: null,
          collapsed: false,
          messageCount: outlineIndices[0],
        })
      }

      for (let i = 0; i < outlineIndices.length; i++) {
        const startIdx = outlineIndices[i]
        const endIdx = (outlineIndices[i + 1] ?? messages.length) - 1
        const msg = messages[startIdx]
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
          messageCount: endIdx - startIdx + 1,
        })
      }
    }

    const oldSectionsMap = new Map(sections.value.map((s) => [s.id, s.collapsed]))
    newSections.forEach((section) => {
      if (oldSectionsMap.has(section.id)) {
        section.collapsed = oldSectionsMap.get(section.id)
      }
    })

    sections.value = newSections
  }

  function toggleSection(sectionId) {
    const section = sections.value.find((s) => s.id === sectionId)
    if (section) {
      section.collapsed = !section.collapsed
      sections.value = [...sections.value]
    }
  }

  function jumpToSection(section) {
    if (!chat.value) return
    if (section.collapsed) toggleSection(section.id)

    const targetMsg = chat.value.messages[section.startMsgIndex]
    if (!targetMsg) return

    nextTick(async () => {
      const container = messagesContainer.value
      if (!container) return

      // 折叠的分区不在 DOM 中，按消息 id 定位，而不是用消息数组下标。
      const targetEl = container.querySelector(`[data-msg-id="${targetMsg.id}"]`)
      if (!targetEl) return

      await eagerLoadImagesInRange(container, targetEl)

      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
      activeHeadingId.value = section.id

      setTimeout(() => {
        targetEl.classList.add('section-highlight')
        setTimeout(() => {
          targetEl.classList.remove('section-highlight')
        }, 800)
      }, 100)
    })
  }

  function onScroll() {
    if (!messagesContainer.value || !sections.value.length || !chat.value) return
    const container = messagesContainer.value
    const messageElements = container.querySelectorAll('.message-wrapper')
    let currentActiveId = null
    for (let i = 0; i < messageElements.length; i++) {
      const el = messageElements[i]
      const rect = el.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      if (rect.top >= containerRect.top && rect.top <= containerRect.top + 100) {
        const msgId = el.dataset.msgId
        const msgIndex = chat.value.messages.findIndex((m) => m.id === msgId)
        const section =
          msgIndex === -1
            ? null
            : sections.value.find((s) => msgIndex >= s.startMsgIndex && msgIndex <= s.endMsgIndex)
        if (section && section.headingMsgIndex !== null) {
          currentActiveId = section.id
          break
        }
      }
    }
    if (currentActiveId !== activeHeadingId.value) activeHeadingId.value = currentActiveId
  }

  function handleOutlineUpdate() {
    buildSections()
  }

  function attachScrollListener() {
    if (messagesContainer.value) {
      detachScrollListener()
      scrollElement = messagesContainer.value
      scrollElement.addEventListener('scroll', onScroll)
    }
  }

  function detachScrollListener() {
    if (scrollElement) {
      scrollElement.removeEventListener('scroll', onScroll)
      scrollElement = null
    }
  }

  return {
    sections,
    activeHeadingId,
    buildSections,
    toggleSection,
    jumpToSection,
    handleOutlineUpdate,
    attachScrollListener,
    detachScrollListener,
  }
}
