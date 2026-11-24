/* viz-bridge.js — ZenData → ZenViz 的投递桥（同时挂 globalThis.VizBridge）
 * 桌面端走 OMMShare broker；嵌入回退由 Hub 校验来源后转发并回执。
 */
const KEY = 'zen.viz.pending'

function parentTarget() {
  try {
    const params = new URLSearchParams(location.search)
    const raw = params.get('omm_hub_origin')
    if (params.get('omm_embed') !== '1' || !raw) return ''
    const u = new URL(raw)
    if ((u.protocol === 'http:' || u.protocol === 'https:') &&
        ['127.0.0.1', 'localhost', '[::1]', '::1'].indexOf(u.hostname) >= 0) return u.origin
  } catch (e) { /* ignore */ }
  return ''
}

/* 返回 Promise<boolean>：只有 broker 成功或 Hub 收到可视化产品回执才为 true。 */
function send(payload) {
  try { localStorage.setItem(KEY, JSON.stringify(payload)) } catch (e) {}
  if (window.OMMShare && window.OMMShare.enabled === true && typeof window.OMMShare.send === 'function') {
    return Promise.resolve().then(function () {
      return window.OMMShare.send({
        to: 'visualization', format: 'zenviz-data',
        title: payload.name || '数据表', payload,
      })
    }).then(function () { return true }, function () { return false })
  }
  if (!window.parent || window.parent === window) return Promise.resolve(false)
  var target = parentTarget()
  if (!target) return Promise.resolve(false)
  return new Promise(function (resolve) {
    var token = 'viz' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    var settled = false
    var timer = 0
    function finish(ok) {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
      resolve(!!ok)
    }
    function onMessage(e) {
      if (!window.ZenUtil || !window.ZenUtil.isTrustedParentMessage(e)) return
      var data = e.data
      if (data && data.type === 'omm:zenviz-data-delivery' && data.token === token) {
        finish(data.ok === true)
      }
    }
    window.addEventListener('message', onMessage)
    timer = window.setTimeout(function () { finish(false) }, 6000)
    try {
      window.parent.postMessage({ type: 'omm:zenviz-data', token: token, payload: payload }, target)
    } catch (e) {
      finish(false)
    }
  })
}

/* 接收端：注册处理函数，返回取消订阅函数。 */
function onData(handler) {
  function fire(payload) {
    if (!payload || payload.format !== 'zenviz-data') return false
    try {
      handler(payload)
      return true
    } catch (e) {
      console.warn('[VizBridge] handler failed', e)
      return false
    }
  }
  function onMessage(e) {
    if (!window.ZenUtil || !window.ZenUtil.isTrustedParentMessage(e)) return
    var data = e.data
    if (!data || data.type !== 'omm:zenviz-data') return
    if (fire(data.payload) && data.token) {
      try {
        window.parent.postMessage(
          { type: 'omm:zenviz-data-received', token: data.token },
          e.origin
        )
      } catch (e) { /* ignore */ }
    }
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
    if (raw && fire(JSON.parse(raw))) localStorage.removeItem(KEY)
  } catch (e) {}
  return function () {
    window.removeEventListener('message', onMessage)
    if (offArtifact) offArtifact()
  }
}

export const VizBridge = { send, onData, KEY }
if (typeof globalThis !== 'undefined') globalThis.VizBridge = VizBridge
