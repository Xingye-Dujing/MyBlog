/* OMM-ZEN UI · components/menu
 * ------------------------------------------------------------------
 * One dropdown / context menu implementation for every product. Replaces the
 * per-product context menus and dropdown behaviour that used to be copied
 * into writer, data, planner, table and video.
 *
 * API: ZenUI.menu.open(items, anchor, opts) -> close function
 *      ZenUI.menu.close()
 * items: { label, action, hint, danger, disabled } | '---' (separator)
 * opts:  { x, y, align: 'left'|'right' }  // x/y override anchor position
 * Depends: zen/components/layer.js
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var layer = ui.layer
  if (!layer) throw new Error('zen/ui: core/layer.js must load before components/menu.js')
  if (!global.ZenUtil) throw new Error('zen/ui: foundation/util.js must load before components/menu.js')
  var esc = global.ZenUtil.esc

  var active = null

  function actions() {
    return active ? Array.prototype.slice.call(active.el.querySelectorAll('.zenui-option:not([disabled])')) : []
  }

  function paint(index) {
    if (!active) return
    var list = actions()
    active.index = Math.max(0, Math.min(index, list.length - 1))
    list.forEach(function (el, i) { el.classList.toggle('active', i === active.index) })
    var target = list[active.index]
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' })
  }

  function close(restoreFocus) {
    if (!active) return
    var l = layer.get()
    var job = active
    active = null
    l.popmenu.hidden = true
    if (job.entry) l.pop(job.entry)
    l.closePopMenu = null
    if (restoreFocus !== false) layer.restoreFocus(job.anchor)
    if (job.opts.onClose) job.opts.onClose()
  }

  function place(el, anchor, opts) {
    var width = el.offsetWidth || 160
    var height = el.offsetHeight || 120
    var left, top
    if (opts.x != null && opts.y != null) {
      left = opts.x
      top = opts.y
    } else {
      var rect = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : { left: 0, bottom: 0, right: 0 }
      left = opts.align === 'right' ? rect.right - width : rect.left
      top = rect.bottom + 3
    }
    left = Math.max(6, Math.min(left, global.innerWidth - width - 6))
    top = Math.max(6, Math.min(top, global.innerHeight - height - 6))
    el.style.left = left + 'px'
    el.style.top = top + 'px'
    el.style.minWidth = width + 'px'
  }

  function choose(index) {
    if (!active) return
    var list = actions()
    var el = list[index]
    if (!el || el.disabled) return
    var job = active
    var rawIndex = job.valid[Number(el.dataset.index)]
    var fn = job.items[rawIndex] && job.items[rawIndex].action
    close()
    if (typeof fn === 'function') fn()
  }

  function open(items, anchor, opts) {
    var l = layer.get()
    opts = opts || {}
    if (l.closeMenu) l.closeMenu()
    if (l.closeContextMenu) l.closeContextMenu()
    close()
    var html = ''
    var valid = []
    ;(items || []).forEach(function (raw, i) {
      if (raw === '---' || (raw && raw.separator)) { html += '<div class="zenui-sep" role="separator"></div>'; return }
      var item = typeof raw === 'string' ? { label: raw, action: null } : (raw || {})
      if (item.disabled) {
        html += '<button class="zenui-option" type="button" role="menuitem" disabled>' + esc(item.label) + '</button>'
        valid.push(i)
        return
      }
      html += '<button class="zenui-option" type="button" role="menuitem" data-index="' + valid.length +
        '"' + (item.danger ? ' data-danger="true"' : '') + '>' + esc(item.label) +
        (item.hint ? '<span class="zenui-hint">' + esc(item.hint) + '</span>' : '') + '</button>'
      valid.push(i)
    })
    l.popmenu.innerHTML = html
    l.popmenu.hidden = false
    active = { el: l.popmenu, items: items || [], index: 0, opts: opts, valid: valid }
    place(l.popmenu, anchor, opts)
    Array.prototype.forEach.call(l.popmenu.querySelectorAll('.zenui-option:not([disabled])'), function (el, i) {
      el.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        choose(i)
      })
      el.addEventListener('pointerover', function () { paint(i) })
    })
    paint(0)
    layer.restoreFocus(actions()[0])
    var entry = {
      outside: function (event) {
        var path = event.composedPath ? event.composedPath() : [event.target]
        if (path.indexOf(l.popmenu) >= 0) return
        if (anchor && path.indexOf(anchor) >= 0) return
        close(false)
      },
      escape: function () { close(true) },
      key: function (event) {
        var list = actions()
        if (!list.length) return
        if (event.key === 'Tab') { close(true); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); event.stopImmediatePropagation()
          paint(active.index + (event.key === 'ArrowDown' ? 1 : -1) + list.length)
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault(); event.stopImmediatePropagation()
          paint(event.key === 'Home' ? 0 : list.length - 1)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopImmediatePropagation()
          choose(active.index)
        }
      },
    }
    active.entry = entry
    l.push(entry)
    l.closePopMenu = close
    return close
  }

  ui.menu = { open: open, close: close }
})(window)
