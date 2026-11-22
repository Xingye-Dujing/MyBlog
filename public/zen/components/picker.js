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

  var POP_ID = 'zenui-picker-pop'
  var config = {
    labels: function () {
      return { done: '确定', clear: '清除', hour: '时', minute: '分' }
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

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

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
        close()
      },
      escape: close,
      key: function (event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          var opts = el.querySelectorAll('.pk-opt,.pk-day:not(.dis)')
          if (!opts.length) return
          event.preventDefault(); event.stopImmediatePropagation()
          var i = Array.prototype.indexOf.call(opts, l.shadow.activeElement)
          var next = (i + (event.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length
          try { opts[next].focus() } catch (e) { /* ignore */ }
        }
      },
    }
    l.push(ctx.entry)
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
  }

  function onPick(target) {
    if (!ctx) return
    var v = target.dataset.pick
    if (ctx.kind === 'multidate') {
      if (v === '@ok') {
        var value = ctx.dates.slice().sort()
        close()
        ctx.cb(value.join(','))
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
    if (v === '@clear') { close(); ctx.cb('', true); return }
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
      ctx.cb(v, false)
      return
    }
    if (ctx.kind === 'time') {
      if (target.dataset.part === 'h') { ctx.hh = v; render(); return }
      ctx.mm = v
      close()
      ctx.cb(ctx.hh + ':' + v, false)
    }
  }

  function dateHTML() {
    var l = labels()
    var weekStart = Number(config.weekStart()) || 0
    var names = config.weekdays() || []
    var html = '<div class="pk-head">' +
      '<div class="pk-nav" data-pick="@nav" data-dir="-1">‹</div>' +
      '<span class="pk-title">' + ctx.y + ' / ' + pad(ctx.m) + '</span>' +
      '<div class="pk-nav" data-pick="@nav" data-dir="1">›</div></div>'
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
      if (ctx.kind === 'multidate' ? ctx.dates.indexOf(ds) >= 0 : ds === ctx.value) cls.push('sel')
      html += '<div class="' + cls.join(' ') + '" data-pick="' + ds + '">' + d.getDate() + '</div>'
    }
    html += '</div>'
    if (ctx.kind === 'multidate') {
      html += '<div class="pk-multi-foot">' +
        '<span class="pk-clear" data-pick="@clear">' + esc(l.clear) + '</span>' +
        '<span class="pk-clear pk-done" data-pick="@ok">' + esc(l.done) + ' (' + ctx.dates.length + ')</span></div>'
    }
    if (ctx.kind === 'enddate') {
      html += '<div class="pk-multi-foot"><span class="pk-clear" data-pick="@clear">' + esc(l.clear) + '</span></div>'
    }
    return html
  }

  function timeHTML() {
    var l = labels()
    var hours = ''
    var minutes = ''
    for (var h = 0; h < 24; h++) {
      var hv = pad(h)
      hours += '<div class="pk-opt' + (hv === ctx.hh ? ' active' : '') +
        '" data-pick="' + hv + '" data-part="h">' + hv + '</div>'
    }
    for (var m = 0; m < 60; m++) {
      var mv = pad(m)
      minutes += '<div class="pk-opt' + (mv === ctx.mm ? ' active' : '') +
        '" data-pick="' + mv + '" data-part="m">' + mv + '</div>'
    }
    return '<div class="pk-cols">' +
      '<div class="pk-colwrap"><div class="pk-lab">' + esc(l.hour) + '</div><div class="pk-col">' + hours + '</div></div>' +
      '<div class="pk-colwrap"><div class="pk-lab">' + esc(l.minute) + '</div><div class="pk-col">' + minutes + '</div></div>' +
      '</div><div class="pk-clear" data-pick="@clear">' + esc(l.clear) + '</div>'
  }

  function close() {
    var l = layer.get()
    var el = ensurePop()
    if (ctx && el.classList.contains('open')) {
      if (config.hide) config.hide(el)
      else el.classList.remove('open')
    }
    if (ctx && ctx.entry) l.pop(ctx.entry)
    ctx = null
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
      el.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        open(kind, el, el.value || '', function (value, cleared) {
          el.value = value || ''
          try { el.dispatchEvent(new Event('input', { bubbles: true })) } catch (e) { /* ignore */ }
          try { el.dispatchEvent(new Event('change', { bubbles: true })) } catch (e) { /* ignore */ }
          if (cleared) el.dispatchEvent(new Event('change', { bubbles: true }))
        })
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
