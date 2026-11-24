/* zen-link.js — 把任意 omm-* 产品接入 zen-card 生态
 * 以 <script type="module" src="zen-link.js"></script> 引入即可：
 *   1) 页面右下角提供一个“卡”悬浮按钮，可把选中文字发布为 zen-card；
 *   2) 接收其他产品通过 OMMShare 或 postMessage 发来的 zen-card，存入统一收件箱。
 * 不改动产品自身逻辑，纯增量，避免破坏既有功能。
 */
import { ZenCard } from './zen-card.js'

const INBOX_KEY = 'zen.inbox.v1'
const APP = (function () {
  const m = (location.pathname.split('/').pop() || '').match(/^omm-([a-z0-9_-]+)\.html$/)
  return m ? m[1] : ''
})()

function toast(msg) { return window.ZenUI.toast(msg) }

function readInbox() {
  try { return JSON.parse(localStorage.getItem(INBOX_KEY) || '[]') } catch { return [] }
}
function receive(card) {
  try {
    const c = ZenCard.create(card)
    const list = readInbox()
    if (list.some((x) => x.id === c.id)) return c
    list.push(c)
    localStorage.setItem(INBOX_KEY, JSON.stringify(list.slice(-200)))
    document.dispatchEvent(new CustomEvent('zen-card:received', { detail: c }))
    toast('收到一张卡片：' + c.content.slice(0, 24))
    return c
  } catch (e) {
    return null
  }
}

async function publish(card, target) {
  const c = ZenCard.create(card)
  if (target && window.OMMShare && window.OMMShare.send) {
    try {
      await window.OMMShare.send({
        to: target,
        format: 'zen-card',
        title: c.content.slice(0, 40),
        payload: c,
      })
      toast('已发送到 ' + target)
      return c
    } catch (e) {
      return fallbackSave(c) ? c : null
    }
  }
  return fallbackSave(c) ? c : null
}

function fallbackSave(c) {
  try {
    const key = 'zen.cards.v1'
    const list = JSON.parse(localStorage.getItem(key) || '[]')
    if (!Array.isArray(list)) throw new Error('invalid local card library')
    if (!list.some((x) => x && x.id === c.id)) list.push(c)
    localStorage.setItem(key, JSON.stringify(list))
    toast('已存入本地卡片库')
    return true
  } catch (e) {
    toast('发送失败，本地保存也失败')
    return false
  }
}

function openPanel() {
  let panel = document.getElementById('zen-link-panel')
  if (panel) { panel.remove(); return }
  const selected = (window.getSelection() && String(window.getSelection()).trim()) || ''
  panel = document.createElement('div')
  panel.id = 'zen-link-panel'
  panel.style.cssText =
    'position:fixed;right:14px;bottom:60px;width:min(360px,calc(100vw - 28px));background:var(--paper,#ffffff);color:var(--ink,#1a1a1a);' +
    'border:1px solid var(--border,#1a1a1a);border-radius:var(--zen-radius);padding:14px;z-index:99998;box-shadow:0 8px 28px rgba(0,0,0,.16);' +
    'font:13px/1.5 "Literata", "SimSun", "宋体", "NSimSun", "Songti SC", "STSong", serif'
  panel.innerHTML =
    '<div style="display:flex;align-items:center;margin-bottom:8px"><b>发布为知识卡片</b>' +
    '<span style="flex:1"></span><button id="zlp-close" style="border:0;background:none;font-size:18px;cursor:pointer">×</button></div>' +
    '<textarea id="zlp-text" style="width:100%;min-height:72px;border:1px solid var(--border-dim,#d8d0c4);border-radius:var(--zen-radius);padding:7px;box-sizing:border-box" placeholder="要剪藏的内容"></textarea>' +
    '<div style="display:flex;gap:6px;margin-top:6px">' +
    '<input id="zlp-tags" style="flex:1;border:1px solid var(--border-dim,#d8d0c4);border-radius:var(--zen-radius);padding:6px" placeholder="标签，逗号分隔" />' +
    '<select id="zlp-kind" data-zen-select style="border:1px solid var(--border-dim,#d8d0c4);border-radius:var(--zen-radius);padding:6px">' +
    ZenCard.KINDS.map((k) => `<option value="${k}">${k}</option>`).join('') + '</select></div>' +
    '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
    '<button class="zlp-send" data-to="" style="padding:5px 9px">存本地</button>' +
    ['zencard', 'writer', 'corpus', 'english', 'annotate'].map((t) => `<button class="zlp-send" data-to="${t}" style="padding:5px 9px">发往 ${t}</button>`).join('') +
    '</div>'
  document.body.appendChild(panel)
  panel.querySelector('#zlp-text').value = selected
  panel.querySelector('#zlp-close').onclick = () => panel.remove()
  panel.querySelectorAll('.zlp-send').forEach((b) => {
    b.onclick = async () => {
      const text = panel.querySelector('#zlp-text').value.trim()
      if (!text) { toast('内容不能为空'); return }
      const card = ZenCard.create({
        content: text,
        source: APP || 'clip',
        kind: panel.querySelector('#zlp-kind').value,
        tags: panel.querySelector('#zlp-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        ref: location.href,
      })
      b.disabled = true
      try {
        const published = await publish(card, b.dataset.to || '')
        if (published) panel.remove()
        else b.disabled = false
      } catch (e) {
        b.disabled = false
      }
    }
  })
}

function mount() {
  const btn = document.createElement('button')
  btn.id = 'zen-link-btn'
  btn.title = '发布为知识卡片 / 接收 zen-card'
  btn.setAttribute('aria-label', 'zen-card 卡片桥接')
  btn.textContent = '卡'
  btn.style.cssText =
    'position:fixed;right:14px;bottom:14px;width:34px;height:34px;border-radius:var(--zen-radius,0px);' +
    'border:1px solid var(--border,#1a1a1a);background:var(--paper,#ffffff);color:var(--ink,#1a1a1a);font:14px "Literata", "SimSun", "宋体", "NSimSun", "Songti SC", "STSong", serif;cursor:pointer;z-index:99997;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.12)'
  btn.onclick = openPanel
  document.body.appendChild(btn)
}

function boot() {
  mount()
  if (window.OMMShare && window.OMMShare.onArtifact) {
    window.OMMShare.onArtifact(function (a) {
      if (a && a.format === 'zen-card') receive(a.payload || a.card || a)
    })
  }
  window.addEventListener('message', function (e) {
    if (!ZenUtil.isTrustedParentMessage(e)) return
    const d = e.data
    if (d && d.type === 'omm:zen-card') receive(d.card)
    if (d && d.type === 'omm:zen-card-request') {
      const own = []
      ;['zen.cards.v1', 'zen.inbox.v1', 'zen.clip.v1'].forEach((key) => {
        try {
          const raw = JSON.parse(localStorage.getItem(key) || '[]')
          if (Array.isArray(raw)) raw.forEach((c) => own.push(ZenCard.create(c)))
        } catch (_) { /* ignore */ }
      })
      try {
        // 只回给已通过父窗口与精确 origin 校验的请求方。
        window.parent.postMessage(
          { type: 'omm:zen-card-reply', token: d.token, app: APP, cards: own },
          e.origin
        )
      } catch (_) { /* ignore */ }
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
