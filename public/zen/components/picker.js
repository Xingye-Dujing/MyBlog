/* OMM-ZEN UI · components/picker
 * ------------------------------------------------------------------
 * Date / time / multi-date popup. Fully self-contained: markup, styling and
 * behaviour live in the shared shadow layer, so the component does not depend
 * on any optional CSS pack (previous versions borrowed .pk-* from grid.css).
 *
 * API:
 *   ZenUI.picker.open(kind, anchor, value, onSelect, locked, min)
 *   ZenUI.picker.close()
 *   ZenUI.picker.configure({ labels, weekdays, weekStart, place, scroll, hide })
 *   ZenUI.picker.enhance(root)   // native date/time inputs + data-zen-date/time
 *
 * kind: 'date' | 'time' | 'multidate' | 'enddate'
 * Depends: zen/components/layer.js
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var layer = ui.layer
  if (!layer) throw new Error('zen/ui: core/layer.js must load before components/picker.js')
  if (!global.ZenUtil) throw new Error('zen/ui: foundation/util.js must load before components/picker.js')
  var esc = global.ZenUtil.esc

  var POP_ID = 'zenui-picker-pop'
  var config = {
    labels: function () {
      return {
        done: '确定', clear: '清除', hour: '时', minute: '分',
        prevMonth: '上个月', nextMonth: '下个月',
      }
    },
    weekdays: function () { return ['一', '二', '三', '四', '五', '六', '日'] },
    weekStart: function () { return 1 },
    place: null,
    scroll: null,
    hide: null,
  }
  var ctx = null
  var pop = null

  function pad(n) { return n < 10 ? '0' + n : '' + n }

  function fmt(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  }

  function pd(str) {
    var p = String(str).split('-')
    return new Date(+p[0], +p[1] - 1, +p[2])
  }

  function addD(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
  }

  function todayDS() { return fmt(new Date()) }

  function labels() { return config.labels() || {} }

  function ensurePop() {
    var l = layer.get()
    if (pop && l.shadow.contains(pop)) return pop
    pop = l.shadow.querySelector('#' + POP_ID)
    if (pop) return pop
    pop = document.createElement('div')
    pop.id = POP_ID
    pop.className = 'picker-pop zenui-picker'
    l.shadow.appendChild(pop)
    pop.addEventListener('click', function (event) {
      var target = event.target.closest ? event.target.closest('[data-pick]') : null
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      onPick(target)
    })
    pop.addEventListener('keydown', onKeyDown)
    return pop
  }

  function place(el, anchor) {
    if (config.place) { config.place(el, anchor); return }
    var rect = anchor.getBoundingClientRect()
    var width = el.offsetWidth || 238
    var height = el.offsetHeight || 320
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    var top = rect.bottom + 6
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6)
    el.style.left = left + 'px'
    el.style.top = top + 'px'
  }

  function open(kind, anchor, value, cb, locked, min) {
    close()
    ctx = {
      kind: kind,
      anchor: anchor,
      cb: cb,
      y: null,
      m: null,
      hh: '09',
      mm: '00',
      value: value || '',
      locked: /^\d{4}-\d{2}-\d{2}$/.test(locked || '') ? locked : '',
      minDS: /^\d{4}-\d{2}-\d{2}$/.test(min || '') ? min : '',
      dates: [],
    }
    if (kind === 'date' || kind === 'enddate') {
      var d = value ? pd(value) : new Date()
      ctx.y = d.getFullYear()
      ctx.m = d.getMonth() + 1
    }
    if (kind === 'time' && value && /^\d{2}:\d{2}$/.test(value)) {
      var parts = value.split(':')
      ctx.hh = parts[0]
      ctx.mm = parts[1]
    }
    if (kind === 'multidate') {
      ctx.dates = value ? String(value).split(',').filter(Boolean) : []
      if (ctx.locked && ctx.dates.indexOf(ctx.locked) < 0) ctx.dates.push(ctx.locked)
      var first = ctx.dates.length ? pd(ctx.dates[0]) : new Date()
      ctx.y = first.getFullYear()
      ctx.m = first.getMonth() + 1
    }
    var el = ensurePop()
    el.classList.remove('pop-date', 'pop-time')
    el.classList.add('open', kind === 'time' ? 'pop-time' : 'pop-date')
    render()
    place(el, anchor)
    var l = layer.get()
    if (l.closeMenu) l.closeMenu()
    if (l.closePopMenu) l.closePopMenu()
    ctx.entry = {
      outside: function (event) {
        var path = event.composedPath ? event.composedPath() : [event.target]
        if (path.indexOf(el) >= 0 || (anchor && path.indexOf(anchor) >= 0)) return
        close(false)
      },
      escape: function () { close(true) },
    }
    l.push(ctx.entry)
    focusCurrent()
    return api
  }

  function render() {
    if (!ctx) return
    var el = ensurePop()
    var isCal = ctx.kind === 'date' || ctx.kind === 'multidate' || ctx.kind === 'enddate'
    el.innerHTML = isCal ? dateHTML() : timeHTML()
    if (config.scroll) {
      Array.prototype.forEach.call(el.querySelectorAll('.pk-col'), function (col) {
        config.scroll(col.querySelector('.pk-opt.active'), 'center')
      })
    }
    if (el.classList.contains('open')) focusCurrent()
  }

  function focusCurrent() {
    var el = ensurePop()
    var choices = el.querySelectorAll('.pk-day:not(.dis),.pk-opt')
    Array.prototype.forEach.call(choices, function (choice) { choice.tabIndex = -1 })
    var current = el.querySelector('.pk-day.sel:not(.dis),.pk-day.today:not(.dis),.pk-opt.active') || choices[0]
    if (!current) return
    current.tabIndex = 0
    try { current.focus() } catch (e) { /* ignore */ }
  }

  function onKeyDown(event) {
    if (!ctx) return
    if (event.key === 'Tab') {
      layer.trapTab(event, ensurePop().getRootNode())
      return
    }
    var target = event.target
    if (!target || !target.matches || !target.matches('.pk-day,.pk-opt')) return
    var delta = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key]
    if (!delta && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    event.stopImmediatePropagation()
    var choices = Array.prototype.slice.call(
      target.matches('.pk-day') ? ensurePop().querySelectorAll('.pk-day:not(.dis)') : ensurePop().querySelectorAll('.pk-opt')
    )
    if (!choices.length) return
    var index = choices.indexOf(target)
    var next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : (index + delta + choices.length) % choices.length
    target.tabIndex = -1
    choices[next].tabIndex = 0
    choices[next].focus()
  }

  function onPick(target) {
    if (!ctx) return
    var callback = ctx.cb
    var v = target.dataset.pick
    if (ctx.kind === 'multidate') {
      if (v === '@ok') {
        var value = ctx.dates.slice().sort()
        close()
        callback(value.join(','))
        return
      }
      if (v === '@clear') { ctx.dates = []; render(); return }
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        if (v === ctx.locked) return
        if (ctx.minDS && v < ctx.minDS) return
        var i = ctx.dates.indexOf(v)
        if (i >= 0) ctx.dates.splice(i, 1)
        else ctx.dates.push(v)
        render()
        return
      }
    }
    if (v === '@clear') { close(); callback('', true); return }
    if (v === '@nav') {
      var dir = parseInt(target.dataset.dir, 10)
      ctx.m += dir
      if (ctx.m < 1) { ctx.m = 12; ctx.y-- }
      if (ctx.m > 12) { ctx.m = 1; ctx.y++ }
      render()
      return
    }
    if ((ctx.kind === 'date' || ctx.kind === 'enddate') && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      close()
      callback(v, false)
      return
    }
    if (ctx.kind === 'time') {
      if (target.dataset.part === 'h') { ctx.hh = v; render(); return }
      ctx.mm = v
      close()
      callback(ctx.hh + ':' + v, false)
    }
  }

  function dateHTML() {
    var l = labels()
    var weekStart = Number(config.weekStart()) || 0
    var names = config.weekdays() || []
    var html = '<div class="pk-head">' +
      '<button class="pk-nav" type="button" data-pick="@nav" data-dir="-1" aria-label="' + esc(l.prevMonth) + '">‹</button>' +
      '<span class="pk-title">' + ctx.y + ' / ' + pad(ctx.m) + '</span>' +
      '<button class="pk-nav" type="button" data-pick="@nav" data-dir="1" aria-label="' + esc(l.nextMonth) + '">›</button></div>'
    html += '<div class="pk-grid">'
    for (var w = 0; w < 7; w++) html += '<div class="pk-wd">' + esc(names[w] || '') + '</div>'
    var first = new Date(ctx.y, ctx.m - 1, 1)
    var lead = (first.getDay() - weekStart + 7) % 7
    var start = addD(first, -lead)
    var today = todayDS()
    for (var i = 0; i < 42; i++) {
      var d = addD(start, i)
      var ds = fmt(d)
      var cls = ['pk-day']
      if (d.getMonth() + 1 !== ctx.m) cls.push('other')
      if (ctx.minDS && ds < ctx.minDS) cls.push('dis')
      if (ds === today) cls.push('today')
      var selected = ctx.kind === 'multidate' ? ctx.dates.indexOf(ds) >= 0 : ds === ctx.value
      if (selected) cls.push('sel')
      var disabled = ctx.minDS && ds < ctx.minDS
      html += '<button class="' + cls.join(' ') + '" type="button" data-pick="' + ds + '"' +
        (disabled ? ' disabled' : '') + ' aria-pressed="' + (selected ? 'true' : 'false') +
        '" aria-label="' + ds + '">' + d.getDate() + '</button>'
    }
    html += '</div>'
    if (ctx.kind === 'multidate') {
      html += '<div class="pk-multi-foot">' +
        '<button class="pk-clear" type="button" data-pick="@clear">' + esc(l.clear) + '</button>' +
        '<button class="pk-clear pk-done" type="button" data-pick="@ok">' + esc(l.done) + ' (' + ctx.dates.length + ')</button></div>'
    }
    if (ctx.kind === 'enddate') {
      html += '<div class="pk-multi-foot"><button class="pk-clear" type="button" data-pick="@clear">' + esc(l.clear) + '</button></div>'
    }
    return html
  }

  function timeHTML() {
    var l = labels()
    var hours = ''
    var minutes = ''
    for (var h = 0; h < 24; h++) {
      var hv = pad(h)
      hours += '<button class="pk-opt' + (hv === ctx.hh ? ' active' : '') +
        '" type="button" data-pick="' + hv + '" data-part="h" aria-pressed="' +
        (hv === ctx.hh ? 'true' : 'false') + '">' + hv + '</button>'
    }
    for (var m = 0; m < 60; m++) {
      var mv = pad(m)
      minutes += '<button class="pk-opt' + (mv === ctx.mm ? ' active' : '') +
        '" type="button" data-pick="' + mv + '" data-part="m" aria-pressed="' +
        (mv === ctx.mm ? 'true' : 'false') + '">' + mv + '</button>'
    }
    return '<div class="pk-cols">' +
      '<div class="pk-colwrap"><div class="pk-lab">' + esc(l.hour) + '</div><div class="pk-col">' + hours + '</div></div>' +
      '<div class="pk-colwrap"><div class="pk-lab">' + esc(l.minute) + '</div><div class="pk-col">' + minutes + '</div></div>' +
      '</div><button class="pk-clear" type="button" data-pick="@clear">' + esc(l.clear) + '</button>'
  }

  function close(restoreFocus) {
    var l = layer.get()
    var el = ensurePop()
    var anchor = ctx && ctx.anchor
    if (ctx && el.classList.contains('open')) {
      if (config.hide) config.hide(el)
      else el.classList.remove('open')
    }
    if (ctx && ctx.entry) l.pop(ctx.entry)
    ctx = null
    if (restoreFocus !== false && anchor && anchor.focus) {
      try { anchor.focus() } catch (e) { /* ignore */ }
    }
  }

  /* ---------------------------------------------------------------- enhance */
  function enhance(root) {
    var scope = root || document
    var list = scope.querySelectorAll(
      'input[type="date"]:not([data-zen-picker-ready]),input[type="time"]:not([data-zen-picker-ready]),' +
      '[data-zen-date]:not([data-zen-picker-ready]),[data-zen-time]:not([data-zen-picker-ready])'
    )
    Array.prototype.forEach.call(list, function (el) {
      el.dataset.zenPickerReady = '1'
      var kind = el.matches('input[type="time"]') || el.hasAttribute('data-zen-time') ? 'time' : 'date'
      if (el.matches('input')) el.readOnly = true
      function launch(event) {
        event.preventDefault()
        event.stopPropagation()
        open(kind, el, el.value || '', function (value) {
          el.value = value || ''
          try { el.dispatchEvent(new Event('input', { bubbles: true })) } catch (e) { /* ignore */ }
          try { el.dispatchEvent(new Event('change', { bubbles: true })) } catch (e) { /* ignore */ }
        })
      }
      el.addEventListener('click', launch)
      el.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') launch(event)
      })
    })
  }

  function configure(patch) {
    if (!patch) return
    Object.keys(patch).forEach(function (key) { config[key] = patch[key] })
    return api
  }

  var api = {
    open: open,
    close: close,
    configure: configure,
    enhance: enhance,
    get ctx() { return ctx },
    helpers: { pad: pad, fmt: fmt, pd: pd, addD: addD, todayDS: todayDS },
  }

  ui.picker = api
})(window)
