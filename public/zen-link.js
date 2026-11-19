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

var HUB_ORIGIN = (function () {
  try {
    var raw = new URLSearchParams(location.search).get('omm_hub_origin')
    if (!raw) return ''
    var u = new URL(raw)
    if ((u.protocol === 'http:' || u.protocol === 'https:') &&
        ['127.0.0.1', 'localhost', '[::1]', '::1'].indexOf(u.hostname) >= 0) {
      return u.origin
    }
  } catch (e) { /* ignore */ }
  return ''
})()

function parentTarget() {
  if (HUB_ORIGIN) return HUB_ORIGIN
  try {
    if (document.referrer) return new URL(document.referrer).origin
  } catch (e) { /* ignore */ }
  return location.origin
}

function isTrusted(origin) {
  try {
    if (origin === location.origin) return true
    const u = new URL(String(origin || ''))
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '[::1]', '::1'].indexOf(u.hostname) >= 0
    )
  } catch (e) {
    return false
  }
}

function toast(msg) {
  let box = document.getElementById('zen-link-toast')
  if (!box) {
    box = document.createElement('div')
    box.id = 'zen-link-toast'
    box.style.cssText =
      'position:fixed;left:50%;bottom:54px;transform:translateX(-50%);background:#000;color:#fff;' +
      'padding:7px 14px;border-radius:6px;font:12px/1.5 sans-serif;z-index:99999;opacity:0;' +
      'pointer-events:none;transition:opacity .18s;max-width:80vw'
    document.body.appendChild(box)
  }
  box.textContent = msg
  box.style.opacity = '1'
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { box.style.opacity = '0' }, 1900)
}

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

function publish(card, target) {
  const c = ZenCard.create(card)
  if (target && window.OMMShare && window.OMMShare.send) {
    return window.OMMShare.send({
      to: target,
      format: 'zen-card',
      title: c.content.slice(0, 40),
      payload: c,
    }).then(() => {
      toast('已发送到 ' + target)
      return c
    }).catch(() => {
      fallbackSave(c)
      return c
    })
  }
  fallbackSave(c)
  return Promise.resolve(c)
}

function fallbackSave(c) {
  try {
    const key = 'zen.cards.v1'
    const list = JSON.parse(localStorage.getItem(key) || '[]')
    if (!list.some((x) => x && x.id === c.id)) list.push(c)
    localStorage.setItem(key, JSON.stringify(list))
    toast('已存入本地卡片库')
  } catch (e) {
    toast('保存失败')
  }
}

function openPanel() {
  let panel = document.getElementById('zen-link-panel')
  if (panel) { panel.remove(); return }
  const selected = (window.getSelection() && String(window.getSelection()).trim()) || ''
  panel = document.createElement('div')
  panel.id = 'zen-link-panel'
  panel.style.cssText =
    'position:fixed;right:14px;bottom:60px;width:min(360px,calc(100vw - 28px));background:#fff;color:#111;' +
    'border:1px solid #111;border-radius:8px;padding:14px;z-index:99998;box-shadow:0 8px 28px rgba(0,0,0,.16);' +
    'font:13px/1.5 -apple-system,"Segoe UI",sans-serif'
  panel.innerHTML =
    '<div style="display:flex;align-items:center;margin-bottom:8px"><b>发布为知识卡片</b>' +
    '<span style="flex:1"></span><button id="zlp-close" style="border:0;background:none;font-size:18px;cursor:pointer">×</button></div>' +
    '<textarea id="zlp-text" style="width:100%;min-height:72px;border:1px solid #ccc;border-radius:5px;padding:7px;box-sizing:border-box" placeholder="要剪藏的内容"></textarea>' +
    '<div style="display:flex;gap:6px;margin-top:6px">' +
    '<input id="zlp-tags" style="flex:1;border:1px solid #ccc;border-radius:5px;padding:6px" placeholder="标签，逗号分隔" />' +
    '<select id="zlp-kind" style="border:1px solid #ccc;border-radius:5px;padding:6px">' +
    ZenCard.KINDS.map((k) => `<option value="${k}">${k}</option>`).join('') + '</select></div>' +
    '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
    '<button class="zlp-send" data-to="" style="padding:5px 9px">存本地</button>' +
    ['zencard', 'writer', 'corpus', 'english', 'annotate'].map((t) => `<button class="zlp-send" data-to="${t}" style="padding:5px 9px">发往 ${t}</button>`).join('') +
    '</div>'
  document.body.appendChild(panel)
  panel.querySelector('#zlp-text').value = selected
  panel.querySelector('#zlp-close').onclick = () => panel.remove()
  panel.querySelectorAll('.zlp-send').forEach((b) => {
    b.onclick = () => {
      const text = panel.querySelector('#zlp-text').value.trim()
      if (!text) { toast('内容不能为空'); return }
      const card = ZenCard.create({
        content: text,
        source: APP || 'clip',
        kind: panel.querySelector('#zlp-kind').value,
        tags: panel.querySelector('#zlp-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        ref: location.href,
      })
      publish(card, b.dataset.to || '')
      panel.remove()
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
    'position:fixed;right:14px;bottom:14px;width:34px;height:34px;border-radius:50%;' +
    'border:1px solid #111;background:#fff;color:#111;font:14px sans-serif;cursor:pointer;z-index:99997;' +
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
    if (!isTrusted(e.origin)) return
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
        window.parent.postMessage(
          { type: 'omm:zen-card-reply', token: d.token, app: APP, cards: own },
          parentTarget()
        )
      } catch (_) { /* ignore */ }
    }
  })
}

export const ZenLink = { receive, publish, readInbox, APP, isTrusted }
if (typeof globalThis !== 'undefined') globalThis.ZenLink = ZenLink

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
} else {
  boot()
}
