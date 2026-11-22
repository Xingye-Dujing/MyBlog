/* OMM-ZEN UI · components/tooltip
 * Optional. One tooltip surface in the shared shadow layer for every product.
 * Mark any element with data-zen-tip="说明文字".
 * Depends: zen/components/layer.js
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var layer = ui.layer
  if (!layer) throw new Error('zen/ui: core/layer.js must load before components/tooltip.js')

  var current = null
  var timer = null

  function hide() {
    if (timer) { global.clearTimeout(timer); timer = null }
    if (!current) return
    var l = layer.get()
    l.tip.hidden = true
    current = null
  }

  function show(target) {
    var text = target.getAttribute('data-zen-tip')
    if (!text) return
    var l = layer.get()
    l.tip.textContent = text
    l.tip.hidden = false
    var rect = target.getBoundingClientRect()
    var left = Math.max(6, Math.min(rect.left, global.innerWidth - l.tip.offsetWidth - 6))
    var top = rect.top - l.tip.offsetHeight - 6
    if (top < 6) top = rect.bottom + 6
    l.tip.style.left = left + 'px'
    l.tip.style.top = top + 'px'
    current = target
  }

  function enhance(root) {
    var scope = root || document
    var list = scope.querySelectorAll('[data-zen-tip]:not([data-zen-tip-ready])')
    Array.prototype.forEach.call(list, function (el) {
      el.setAttribute('data-zen-tip-ready', '1')
      el.addEventListener('pointerenter', function () {
        timer = global.setTimeout(function () { show(el) }, 240)
      })
      el.addEventListener('pointerleave', hide)
      el.addEventListener('focus', function () { show(el) })
      el.addEventListener('blur', hide)
    })
  }

  ui.tooltip = { enhance: enhance, hide: hide }
})(window)
