/* zen-link.js — 把任意 omm-* 产品接入 zen-card 生态
 *
 * 页面右下角提供统一“卡”入口：把选中文字发布为 zen-card，或接收其它产品
 * 通过 OMMShare / 受信父窗口发来的卡片。视觉与浮层机制只在共享层实现，
 * 产品只声明自己的身份，不维护目标产品列表或私有卡片面板。
 */
import { ZenCard } from './zen-card.js'

const INBOX_KEY = 'zen.inbox.v1'
const CARD_KEY = 'zen.cards.v1'
const APP = window.OMMShare?.app ||
  document.querySelector('[data-omm-app]')?.getAttribute('data-omm-app') ||
  (location.pathname.match(/^\/omm-([a-z0-9_-]+)\.html$/i)?.[1] || '')

function notify(message, tone) { window.ZenUI.toast(message, tone) }

function readInbox() {
  const list = ZenUtil.getJSON(INBOX_KEY, [])
  return Array.isArray(list) ? list : []
}

function receive(card) {
  try {
    const created = ZenCard.create(card)
    const list = readInbox()
    if (list.some((item) => item.id === created.id)) return created
    list.push(created)
    if (!ZenUtil.setJSON(INBOX_KEY, list.slice(-200))) throw new Error('inbox write failed')
    document.dispatchEvent(new CustomEvent('zen-card:received', { detail: created }))
    notify('收到一张卡片：' + created.content.slice(0, 24))
    return created
  } catch {
    return null
  }
}

async function publish(card, target) {
  const created = ZenCard.create(card)
  if (target && window.OMMShare?.send) {
    try {
      await window.OMMShare.send({
        to: target,
        format: 'zen-card',
        title: created.content.slice(0, 40),
        payload: created,
      })
      notify('已发送到 ' + target)
      return created
    } catch {
      // 跨产品不可用时保留内容到本地，不把投递失败伪装成发送成功。
    }
  }
  return fallbackSave(created) ? created : null
}

function fallbackSave(card) {
  const list = ZenUtil.getJSON(CARD_KEY, [])
  if (!Array.isArray(list)) {
    notify('发送失败，本地卡片库格式也不可用', 'error')
    return false
  }
  if (!list.some((item) => item && item.id === card.id)) list.push(card)
  if (!ZenUtil.setJSON(CARD_KEY, list)) {
    notify('发送失败，本地保存也失败', 'error')
    return false
  }
  notify('已存入本地卡片库')
  return true
}

let trigger = null
let panel = null
let closePanel = null

function setBusy(busy) {
  if (!panel) return
  panel.querySelectorAll('.zenlink-targets button').forEach((button) => {
    button.disabled = busy
  })
}

function renderTargets(targets) {
  const container = panel.querySelector('.zenlink-targets')
  container.querySelectorAll('[data-peer]').forEach((button) => button.remove())
  targets.forEach((target) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'menu-btn'
    button.dataset.peer = target.id
    button.textContent = '发往 ' + target.name
    container.appendChild(button)
  })
}

function createPanel() {
  panel = document.createElement('section')
  panel.id = 'zen-link-panel'
  panel.className = 'zenlink-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-labelledby', 'zen-link-title')
  panel.innerHTML =
    '<header class="zenlink-head">' +
      '<div><h2 id="zen-link-title">发布为知识卡片</h2>' +
      '<p class="zenlink-hint">收录选中文字，或写入一张新卡片</p></div>' +
      '<button class="zenlink-close" type="button" aria-label="关闭卡片面板">×</button>' +
    '</header>' +
    '<div class="zenlink-body">' +
      '<label class="zenlink-field">卡片内容' +
        '<textarea id="zlp-text" class="ed-area" rows="4" placeholder="要剪藏的内容"></textarea>' +
      '</label>' +
      '<div class="zenlink-fields">' +
        '<label class="zenlink-field">标签' +
          '<input id="zlp-tags" class="ed-input" type="text" placeholder="标签，逗号分隔">' +
        '</label>' +
        '<label class="zenlink-field">类型' +
          '<select id="zlp-kind" data-zen-select></select>' +
        '</label>' +
      '</div>' +
      '<div class="zenlink-targets" aria-label="卡片保存目标">' +
        '<button class="menu-btn" type="button" data-to="">存本地</button>' +
      '</div>' +
      '<p class="zenlink-status" aria-live="polite"></p>' +
    '</div>'
  document.body.appendChild(panel)
  const kind = panel.querySelector('#zlp-kind')
  ZenCard.KINDS.forEach((value) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    kind.appendChild(option)
  })
  panel.querySelector('.zenlink-close').addEventListener('click', close)
  panel.querySelector('.zenlink-targets').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-to]')
    if (!button || button.disabled) return
    const text = panel.querySelector('#zlp-text').value.trim()
    if (!text) {
      panel.querySelector('.zenlink-status').textContent = '内容不能为空'
      panel.querySelector('#zlp-text').focus()
      return
    }
    const card = ZenCard.create({
      content: text,
      source: APP || 'clip',
      kind: panel.querySelector('#zlp-kind').value,
      tags: panel.querySelector('#zlp-tags').value.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      ref: location.href,
    })
    setBusy(true)
    panel.querySelector('.zenlink-status').textContent = button.dataset.to ? '正在发送…' : '正在保存…'
    try {
      const published = await publish(card, button.dataset.to || '')
      if (published) close()
      else {
        setBusy(false)
        panel.querySelector('.zenlink-status').textContent = '保存失败，请重试'
      }
    } catch {
      setBusy(false)
      panel.querySelector('.zenlink-status').textContent = '保存失败，请重试'
    }
  })
  trigger.setAttribute('aria-controls', panel.id)
  if (window.ZenUI.enhance) window.ZenUI.enhance(panel)
}

async function open() {
  if (!trigger) return
  if (panel?.classList.contains('open')) {
    close()
    return
  }
  if (!panel) createPanel()
  const selected = (window.getSelection && String(window.getSelection()).trim()) || ''
  const text = panel.querySelector('#zlp-text')
  if (!text.value && selected) text.value = selected
  panel.querySelector('.zenlink-status').textContent = ''
  closePanel = window.ZenUI.popover.open(panel, trigger, {
    align: 'right',
    flip: true,
    gap: 10,
    pad: 12,
    activeClass: 'active',
    trapFocus: true,
    onOpen: () => {
      trigger.setAttribute('aria-expanded', 'true')
      text.focus()
    },
    onClose: () => {
      trigger.setAttribute('aria-expanded', 'false')
      closePanel = null
    },
  })
  if (window.OMMShare?.enabled && window.OMMShare.targets) {
    try {
      await window.OMMShare.loadSpace()
      if (!panel.classList.contains('open')) return
      renderTargets(window.OMMShare.targets())
    } catch {
      if (panel.classList.contains('open')) {
        panel.querySelector('.zenlink-status').textContent = '共享服务暂不可用，仍可存本地'
      }
    }
  }
}

function close() {
  if (closePanel) closePanel()
  else if (panel) window.ZenUI.popover.close(panel)
}

function mount() {
  if (document.querySelector('[data-zen-link-ui="false"]') || document.getElementById('zen-link-btn')) return
  trigger = document.createElement('button')
  trigger.id = 'zen-link-btn'
  trigger.type = 'button'
  trigger.className = 'zenlink-trigger'
  trigger.title = '发布为知识卡片 / 接收 zen-card'
  trigger.setAttribute('aria-label', 'zen-card 卡片桥接')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.textContent = '卡'
  trigger.addEventListener('click', open)
  document.body.appendChild(trigger)
}

function boot() {
  mount()
  if (window.OMMShare?.onArtifact) {
    window.OMMShare.onArtifact((artifact) => {
      if (artifact?.format === 'zen-card') receive(artifact.payload || artifact.card || artifact)
    })
  }
  window.addEventListener('message', (event) => {
    if (!ZenUtil.isTrustedParentMessage(event)) return
    const data = event.data
    if (data?.type === 'omm:zen-card') receive(data.card)
    if (data?.type === 'omm:zen-card-request') {
      const own = []
      ;['zen.cards.v1', 'zen.inbox.v1', 'zen.clip.v1'].forEach((key) => {
        const list = ZenUtil.getJSON(key, [])
        if (!Array.isArray(list)) return
        list.forEach((card) => {
          try { own.push(ZenCard.create(card)) } catch { /* 跳过损坏条目，不影响其它卡片 */ }
        })
      })
      try {
        // 只回给已通过父窗口与精确 origin 校验的请求方。
        window.parent.postMessage(
          { type: 'omm:zen-card-reply', token: data.token, app: APP, cards: own },
          event.origin,
        )
      } catch { /* 父窗口已关闭 */ }
    }
  })
}

export const ZenLink = { receive, publish, readInbox, APP }
if (typeof globalThis !== 'undefined') globalThis.ZenLink = ZenLink

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
} else {
  boot()
}
