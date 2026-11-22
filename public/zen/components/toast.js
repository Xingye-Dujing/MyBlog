/* OMM-ZEN UI · components/toast
 * ------------------------------------------------------------------
 * The one toast implementation for every product. Renders into the shared
 * shadow layer so no product CSS can style or leak into it.
 *
 * API: ZenUI.toast(message, opts) -> close function
 *      ZenUI.toast.clear()
 * opts: { tone: 'info'|'success'|'warning'|'error', duration: ms }
 * Depends: zen/components/layer.js
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var layer = ui.layer
  if (!layer) throw new Error('zen/ui: core/layer.js must load before components/toast.js')

  var live = []

  function remove(node) {
    var i = live.indexOf(node)
    if (i >= 0) live.splice(i, 1)
    if (node.parentNode) node.parentNode.removeChild(node)
  }

  function toast(message, opts) {
    var l = layer.get()
    var o = opts || {}
    var node = document.createElement('div')
    node.className = 'zenui-toast'
    node.dataset.tone = o.tone || 'info'
    node.setAttribute('role', o.tone === 'error' ? 'alert' : 'status')
    node.textContent = String(message == null ? '' : message)
    l.toasts.appendChild(node)
    live.push(node)
    var timer = global.setTimeout(function () { remove(node) }, Number(o.duration) || 2600)
    node.addEventListener('click', function () {
      global.clearTimeout(timer)
      remove(node)
    })
    return function close() {
      global.clearTimeout(timer)
      remove(node)
    }
  }

  toast.clear = function () {
    live.slice().forEach(remove)
  }

  ui.toast = toast
})(window)
