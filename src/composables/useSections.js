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
      // 用 dataset 精确比对而非字符串拼 CSS 选择器：消息 id 来自静态 JSON，
      // 可能含引号 / 方括号等字符，直接拼接会让 querySelector 抛 SyntaxError。
      const targetEl = Array.from(container.querySelectorAll('[data-msg-id]')).find(
        (el) => el.dataset.msgId === String(targetMsg.id),
      )
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
    if (!messageElements.length) return
    const containerRect = container.getBoundingClientRect()
    // 取“顶部已越过阅读线”的最后一条消息：即便某条消息很高、顶部在线上方，
    // 也能稳定映射到它所属分区，避免导览高亮短暂消失。
    const readingLine = containerRect.top + Math.min(120, containerRect.height / 3)
    let activeMsgIndex = -1
    for (let i = 0; i < messageElements.length; i++) {
      if (messageElements[i].getBoundingClientRect().top <= readingLine) {
        activeMsgIndex = i
      } else {
        break
      }
    }
    if (activeMsgIndex === -1) activeMsgIndex = 0

    const activeMsgId = messageElements[activeMsgIndex].dataset.msgId
    // dataset 读出来永远是字符串；消息 id 来自静态 JSON，可能是数字。用 String
    // 归一化后才能与 jumpToSection / findMessageEl 的匹配方式保持一致。
    const msgIndex = chat.value.messages.findIndex((m) => String(m.id) === String(activeMsgId))
    const section =
      msgIndex === -1
        ? null
        : sections.value.find(
            (s) => s.headingMsgIndex !== null && msgIndex >= s.startMsgIndex && msgIndex <= s.endMsgIndex,
          )
    // 回退到最近的上一个带标题的分区，保证“开头”之前的消息也有高亮。
    let currentActiveId = section?.id ?? null
    if (!currentActiveId && msgIndex > -1) {
      const previous = [...sections.value]
        .reverse()
        .find((s) => s.headingMsgIndex !== null && s.startMsgIndex <= msgIndex)
      currentActiveId = previous?.id ?? null
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
