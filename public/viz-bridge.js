/* viz-bridge.js — ZenData → ZenViz 的投递桥（同时挂 globalThis.VizBridge）
 * 通过 OMMShare / postMessage / localStorage 三种路径送达，覆盖在线版与桌面版。
 */
const KEY = 'zen.viz.pending'

function isTrusted(origin) {
  try {
    if (origin === location.origin) return true
    const u = new URL(String(origin || ''))
    return (u.protocol === 'http:' || u.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '[::1]', '::1'].indexOf(u.hostname) >= 0
  } catch (e) {
    return false
  }
}

function parentTarget() {
  try {
    const raw = new URLSearchParams(location.search).get('omm_hub_origin')
    if (raw) {
      const u = new URL(raw)
      if ((u.protocol === 'http:' || u.protocol === 'https:') &&
          ['127.0.0.1', 'localhost', '[::1]', '::1'].indexOf(u.hostname) >= 0) return u.origin
    }
    // 不能用 document.referrer 作为 postMessage 目标：把页面嵌进任意站点时，
    // referrer 就是那个站点的 origin，会把手头的数据发给未授权的第三方。
  } catch (e) { /* ignore */ }
  return location.origin
}

/* 发送端：把 payload 投递给可视化产品。 */
function send(payload) {
  try { localStorage.setItem(KEY, JSON.stringify(payload)) } catch (e) {}
  if (window.OMMShare && window.OMMShare.send) {
    window.OMMShare.send({
      to: 'visualization', channel: 'data.tables', format: 'zenviz-data',
      title: payload.name || '数据表', payload,
    }).catch(function () {})
  }
  try {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'omm:zenviz-data', payload: payload }, parentTarget())
    }
  } catch (e) {}
  return payload
}

/* 接收端：注册处理函数，返回取消订阅函数。 */
function onData(handler) {
  function fire(payload) {
    if (!payload || payload.format !== 'zenviz-data') return
    try { handler(payload) } catch (e) { console.warn('[VizBridge] handler failed', e) }
  }
  function onMessage(e) {
    if (!isTrusted(e.origin)) return
    if (e.data && e.data.type === 'omm:zenviz-data') fire(e.data.payload)
  }
  window.addEventListener('message', onMessage)
  var offArtifact = null
  if (window.OMMShare && window.OMMShare.onArtifact) {
    offArtifact = window.OMMShare.onArtifact(function (a) {
      if (a && a.format === 'zenviz-data') fire(a.payload || a)
    })
  }
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      fire(JSON.parse(raw))
      localStorage.removeItem(KEY)
    }
  } catch (e) {}
  return function () {
    window.removeEventListener('message', onMessage)
    if (offArtifact) offArtifact()
  }
}

export const VizBridge = { send, onData, isTrusted, KEY }
if (typeof globalThis !== 'undefined') globalThis.VizBridge = VizBridge
