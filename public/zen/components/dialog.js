/* OMM-ZEN UI · components/dialog
 * ------------------------------------------------------------------
 * confirm / alert / prompt rendered in the shared overlay layer.
 * API: ZenUI.dialog.confirm(message, opts) -> Promise<boolean>
 *      ZenUI.dialog.alert(message, opts)   -> Promise<true>
 *      ZenUI.dialog.prompt(message, value, opts) -> Promise<string|null>
 *
 * opts: { title, ok, cancel, danger, value, kind }
 * Depends: zen/components/layer.js
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var layer = ui.layer
  if (!layer) throw new Error('zen/ui: core/layer.js must load before components/dialog.js')

  var pending = null
  var wired = null

  function els() {
    var l = layer.get()
    if (wired !== l) {
      wired = l
      l.closeBtn = l.shadow.querySelector('.zenui-x')
      l.cancelBtn = l.shadow.querySelector('.zenui-cancel')
      l.okBtn = l.shadow.querySelector('.zenui-ok')
      l.bodyEl = l.shadow.querySelector('.zenui-body')
      l.inputEl = l.shadow.querySelector('.zenui-input')
      l.headTitle = l.shadow.querySelector('.zenui-title')
      l.veil.addEventListener('click', function (event) {
        if (event.target === l.veil) finish(false)
      })
      l.cancelBtn.addEventListener('click', function () { finish(false) })
      l.closeBtn.addEventListener('click', function () { finish(false) })
      l.okBtn.addEventListener('click', function () { finish(true) })
      l.inputEl.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); finish(true) }
      })
      l.veil.addEventListener('keydown', function (event) {
        if (event.key === 'Tab') trapTab(event, l)
      })
    }
    return l
  }

  function trapTab(event, l) {
    var focusables = l.veil.querySelectorAll('button:not([disabled]),input:not([disabled])')
    if (!focusables.length) return
    var list = Array.prototype.slice.call(focusables).filter(function (el) { return !el.hidden })
    if (!list.length) return
    var first = list[0]
    var last = list[list.length - 1]
    if (event.shiftKey && l.shadow.activeElement === first) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && l.shadow.activeElement === last) {
      event.preventDefault(); first.focus()
    }
  }

  function normalize(opts) {
    var o = typeof opts === 'string' ? { title: opts } : (opts || {})
    return {
      title: o.title || 'OMM-ZEN',
      ok: o.ok || '确定',
      cancel: o.cancel || '取消',
      danger: !!o.danger,
      kind: o.kind || 'confirm',
      value: o.value == null ? '' : String(o.value),
    }
  }

  function open(message, opts) {
    var l = els()
    var o = normalize(opts)
    if (pending) finish(false)
    if (l.closeMenu) l.closeMenu()
    return new Promise(function (resolve) {
      pending = { resolve: resolve, kind: o.kind }
      l.headTitle.textContent = o.title
      l.bodyEl.textContent = String(message == null ? '' : message)
      l.cancelBtn.textContent = o.cancel
      l.cancelBtn.hidden = o.kind === 'alert'
      l.okBtn.textContent = o.ok
      l.okBtn.classList.toggle('danger', o.danger)
      l.okBtn.classList.toggle('primary', !o.danger)
      l.inputEl.hidden = o.kind !== 'prompt'
      l.inputEl.value = o.value
      l.veil.hidden = false
      l.push({
        escape: function () { finish(false) },
        key: function (event) {
          if (event.key === 'Enter' && l.shadow.activeElement !== l.inputEl) {
            event.preventDefault(); finish(true)
          }
        },
      })
      l.pendingEntry = l.stack[l.stack.length - 1]
      window.requestAnimationFrame(function () {
        l.veil.classList.add('on')
        var target = o.kind === 'prompt' ? l.inputEl : l.okBtn
        try { target.focus({ preventScroll: true }) } catch (e) { /* ignore */ }
        if (o.kind === 'prompt' && l.inputEl.select) l.inputEl.select()
      })
    })
  }

  function finish(confirmed) {
    if (!pending) return
    var job = pending
    var l = els()
    pending = null
    var value = null
    if (job.kind === 'prompt') value = confirmed ? l.inputEl.value : null
    else if (job.kind === 'alert') value = true
    else value = !!confirmed
    l.veil.classList.remove('on')
    l.veil.hidden = true
    if (l.pendingEntry) { l.pop(l.pendingEntry); l.pendingEntry = null }
    layer.blurAll()
    job.resolve(value)
  }

  ui.dialog = {
    confirm: function (message, opts) { return open(message, opts) },
    alert: function (message, opts) {
      var o = normalize(opts); o.kind = 'alert'
      return open(message, o)
    },
    prompt: function (message, value, opts) {
      var o = normalize(opts); o.kind = 'prompt'; o.value = value
      return open(message, o)
    },
    close: function () { finish(false) },
  }
})(window)
