/* OMM-ZEN UI · components/context-menu
 * ------------------------------------------------------------------
 * Shared mechanics for a RICH context menu: an arbitrary product-owned HTML
 * element shown at a cursor point, clamped/flipped into the viewport, one open
 * at a time, closed on outside-click / Escape through the shared layer.
 *
 * Unlike components/menu.js (a generated list of simple label/action items),
 * this component does not own the menu's markup. The product keeps its own
 * template, i18n, context-dependent groups and action dispatch; it only
 * delegates the open/close/position mechanics here.
 *
 * API: ZenUI.contextMenu.open(el, x, y, opts) -> close function
 *      ZenUI.contextMenu.close()
 *      ZenUI.contextMenu.closeAll()
 * opts (all generic):
 *   pad            viewport padding (default 8)
 *   beforeOpen(el) hook run BEFORE measuring, for product visibility groups
 *   onOpen/onClose hooks(el)
 * Depends: zen/components/layer.js (load after it)
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var layer = ui.layer
  if (!layer) throw new Error('zen/ui: layer.js must load before context-menu.js')

  var active = null

  function place(el, x, y, pad) {
    var w = el.offsetWidth || 200
    var h = el.offsetHeight || 200
    var left = x
    var top = y
    if (left + w > global.innerWidth - pad) left = global.innerWidth - w - pad
    if (left < pad) left = pad
    if (top + h > global.innerHeight - pad) {
      top = y - h - pad
      if (top < pad) top = Math.max(pad, global.innerHeight - h - pad)
    }
    el.style.left = Math.round(left) + 'px'
    el.style.top = Math.round(top) + 'px'
  }

  function close() {
    if (!active) return
    var job = active
    active = null
    job.el.classList.remove('open')
    if (job.entry) layer.get().pop(job.entry)
    layer.get().closeContextMenu = null
    if (job.opts.onClose) job.opts.onClose(job.el)
  }

  function open(el, x, y, opts) {
    if (!el) return function () {}
    opts = opts || {}
    close()
    if (opts.beforeOpen) opts.beforeOpen(el, { x: x, y: y })
    var l = layer.get()
    active = { el: el, opts: opts, entry: null }
    el.classList.add('open')
    place(el, x, y, opts.pad != null ? opts.pad : 8)
    var entry = {
      outside: function (event) {
        if (!active || active.el !== el) return
        var path = event.composedPath ? event.composedPath() : [event.target]
        if (path.indexOf(el) >= 0) return
        close()
      },
      escape: close,
    }
    active.entry = entry
    l.push(entry)
    l.closeContextMenu = close
    if (opts.onOpen) opts.onOpen(el, { x: x, y: y })
    return close
  }

  ui.contextMenu = { open: open, close: close, closeAll: close }
})(window)
