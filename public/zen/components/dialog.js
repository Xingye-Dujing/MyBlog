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
  if (!global.ZenUtil) throw new Error('zen/ui: foundation/util.js must load before components/dialog.js')
  var esc = global.ZenUtil.esc

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

  /* Generic content modal --------------------------------------------
   * The one shell for product-specific dialog content (help, preview,
   * settings, pickers, …). Kept in the light DOM so product code that
   * queries its content by id keeps working; only the shell is shared.
   *
   * API: ZenUI.modal.open(opts) -> { close, el, body, foot }
   *      ZenUI.modal.close()
   * opts: { title, html, foot, ids:{title,body,foot}, width, onMount, onClose }
   */
  var modalStack = []

  function modalEls() {
    var host = document.createElement('div')
    host.className = 'zenui-modal'
    host.setAttribute('hidden', '')
    host.innerHTML =
      '<div class="zenui-modal-card" role="dialog" aria-modal="true">' +
      '  <div class="zenui-modal-head"><b class="zenui-modal-title"></b>' +
      '    <button class="zenui-modal-x" type="button" aria-label="关闭">×</button></div>' +
      '  <div class="zenui-modal-body"></div>' +
      '  <div class="zenui-modal-foot"></div>' +
      '</div>'
    ;(document.body || document.documentElement).appendChild(host)
    return {
      host: host,
      card: host.querySelector('.zenui-modal-card'),
      title: host.querySelector('.zenui-modal-title'),
      body: host.querySelector('.zenui-modal-body'),
      foot: host.querySelector('.zenui-modal-foot'),
      x: host.querySelector('.zenui-modal-x'),
    }
  }

  // Only the top-most modal owns the canonical ids, so document.getElementById
  // in product code always finds the active dialog.
  function applyIds(m, ids) {
    m.title.id = ids.title || 'modal-title'
    m.body.id = ids.body || 'modal-body'
    m.foot.id = ids.foot || 'modal-foot'
    m.x.id = ids.close || ''
  }
  function stripIds(m) {
    m.title.id = ''
    m.body.id = ''
    m.foot.id = ''
    m.x.id = ''
  }

  function modalClose() {
    if (!modalStack.length) return
    var s = modalStack.pop()
    s.m.host.classList.remove('on')
    s.m.host.setAttribute('hidden', '')
    if (s.entry) layer.get().pop(s.entry)
    if (s.m.host.parentNode) s.m.host.parentNode.removeChild(s.m.host)
    if (modalStack.length) applyIds(modalStack[modalStack.length - 1].m, modalStack[modalStack.length - 1].ids)
    layer.blurAll()
    if (s.opts.onClose) s.opts.onClose()
  }

  function modalOpen(opts) {
    var o = opts || {}
    if (pending) finish(false)
    if (modalStack.length) stripIds(modalStack[modalStack.length - 1].m)
    var m = modalEls()
    var ids = o.ids || {}
    applyIds(m, ids)
    m.card.setAttribute('aria-labelledby', ids.title || 'modal-title')
    m.title.textContent = o.title || ''
    m.body.innerHTML = o.html || ''
    m.foot.innerHTML = o.foot || ''
    m.foot.hidden = !o.foot
    m.card.style.width = o.width || ''
    var s = { opts: o, m: m, ids: ids, entry: null }
    m.host.removeAttribute('hidden')
    m.host.classList.add('on')
    s.entry = {
      escape: function () { ui.modal.close() },
      outside: function (event) {
        var path = event.composedPath ? event.composedPath() : [event.target]
        if (path.indexOf(m.host) >= 0) return
        ui.modal.close()
      },
    }
    layer.get().push(s.entry)
    modalStack.push(s)
    m.x.addEventListener('click', function () { ui.modal.close() })
    m.host.addEventListener('pointerdown', function (event) {
      if (event.target === m.host) ui.modal.close()
    })
    if (o.onMount) o.onMount(m.body, m.foot)
    window.requestAnimationFrame(function () {
      try { m.x.focus({ preventScroll: true }) } catch (e) { /* ignore */ }
    })
    return {
      el: m.host, body: m.body, foot: m.foot,
      close: function () { ui.modal.close() },
    }
  }

  ui.modal = {
    open: modalOpen,
    close: modalClose,
    isOpen: function () { return modalStack.length > 0 },
  }

  /* Searchable picker (command palette / gallery) built on the shared shell. */
  ui.dialog.pick = function (opts) {
    var o = opts || {}
    var items = o.items || []
    return new Promise(function (resolve) {
      var settled = false
      var active = 0
      var visible = items.slice()
      var html = '<p class="zenui-pick-msg">' + esc(o.message || '') + '</p>' +
        '<input class="zenui-pick-input" type="text" spellcheck="false" placeholder="' +
        esc(o.placeholder || '') + '" value="' + esc(o.value || '') + '" />' +
        '<div class="zenui-pick-list" role="listbox"></div>'
      var foot = '<button class="zenui-btn zenui-cancel" type="button">' +
        esc(o.cancel || '取消') + '</button>' +
        '<button class="zenui-btn primary zenui-ok" type="button">' +
        esc(o.ok || '确定') + '</button>'
      var handle = ui.modal.open({
        title: o.title || '', html: html, foot: foot,
        onMount: function (body, foot) {
          var input = body.querySelector('.zenui-pick-input')
          var list = body.querySelector('.zenui-pick-list')
          function paint() {
            list.innerHTML = visible.length
              ? visible.map(function (it, i) {
                return '<div class="zenui-option' + (i === active ? ' active' : '') +
                  '" role="option" data-i="' + i + '" aria-selected="' +
                  (i === active ? 'true' : 'false') + '">' + esc(it.label) +
                  (it.hint ? '<span class="zenui-hint">' + esc(it.hint) + '</span>' : '') +
                  '</div>'
              }).join('')
              : '<div class="zenui-hint">无匹配项</div>'
          }
          function filter() {
            var q = String(input.value || '').toLowerCase()
            visible = items.filter(function (it) {
              return !q || String(it.label).toLowerCase().indexOf(q) >= 0 ||
                String(it.hint || '').toLowerCase().indexOf(q) >= 0
            }).slice(0, 12)
            active = Math.max(0, Math.min(active, visible.length - 1))
            paint()
          }
          function done(value) {
            if (settled) return
            settled = true
            input.removeEventListener('input', filter)
            list.removeEventListener('click', onListClick)
            document.removeEventListener('keydown', onKey, true)
            handle.close()
            resolve(value == null ? null : value)
          }
          function onListClick(ev) {
            var el = ev.target && ev.target.closest ? ev.target.closest('[data-i]') : null
            if (el) done(visible[Number(el.dataset.i)].value)
          }
          function onKey(ev) {
            if (ev.key === 'Escape') { ev.preventDefault(); done(null) }
            else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
              ev.preventDefault(); ev.stopImmediatePropagation()
              if (visible.length) {
                active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length
                paint()
              }
            } else if (ev.key === 'Enter') {
              ev.preventDefault(); done(visible[active] ? visible[active].value : null)
            }
          }
          input.addEventListener('input', filter)
          list.addEventListener('click', onListClick)
          document.addEventListener('keydown', onKey, true)
          foot.querySelector('.zenui-cancel').addEventListener('click', function () { done(null) })
          foot.querySelector('.zenui-ok').addEventListener('click', function () {
            done(visible[active] ? visible[active].value : null)
          })
          body.closest('.zenui-modal').querySelector('.zenui-modal-x')
            .addEventListener('click', function () { done(null) })
          filter()
          input.focus()
          if (input.select) input.select()
        },
        onClose: function () { if (!settled) { settled = true; resolve(null) } },
      })
    })
  }
})(window)
