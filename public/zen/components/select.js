/* OMM-ZEN UI · components/select
 * ------------------------------------------------------------------
 * Candidate-list popup for native <select> elements. Markup stays native so
 * forms and existing JS (value / change / options) keep working unchanged:
 *
 *   <select data-zen-select> ... </select>
 *
 * API: ZenUI.select.enhance(root) · ZenUI.select.close()
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var layer = ui.layer
  if (!layer) throw new Error('zen/ui: core/layer.js must load before components/select.js')

  var active = null
  var wiredLayer = null
  var SELECTOR = 'select[data-zen-select]'

  function wireMenu() {
    var l = layer.get()
    if (wiredLayer === l) return
    wiredLayer = l
    l.menu.addEventListener('click', function (event) {
      var option = event.target.closest('.zenui-option')
      if (option) choose(Number(option.dataset.index))
    })
    l.menu.addEventListener('pointerover', function (event) {
      var option = event.target.closest('.zenui-option')
      if (option && active) {
        active.index = Number(option.dataset.index)
        paint(l, active.index)
      }
    })
  }

  function currentLabel(select) {
    var opt = select.options[select.selectedIndex]
    return opt ? opt.textContent : ''
  }

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function position(l, trigger) {
    var rect = trigger.getBoundingClientRect()
    var width = Math.max(rect.width, 140)
    var height = Math.min(l.menu.scrollHeight || 200, 320)
    var top = rect.bottom + 3
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 3)
    l.menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px'
    l.menu.style.top = top + 'px'
    l.menu.style.minWidth = width + 'px'
  }

  function paint(l, index) {
    var options = l.menu.querySelectorAll('.zenui-option')
    Array.prototype.forEach.call(options, function (el, i) {
      el.classList.toggle('active', i === index)
    })
    var target = options[index]
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' })
  }

  function choose(index) {
    if (!active) return
    var select = active.select
    var opt = select.options[index]
    if (!opt || opt.disabled) return
    select.value = opt.value
    try { select.dispatchEvent(new Event('change', { bubbles: true })) } catch (e) { /* ignore */ }
    active.sync()
    close()
    window.setTimeout(layer.blurAll, 0)
  }

  function close() {
    if (!active) return
    var l = layer.get()
    var entry = active.entry
    l.menu.hidden = true
    if (entry) l.pop(entry)
    try { active.trigger.setAttribute('aria-expanded', 'false') } catch (e) { /* ignore */ }
    active = null
    layer.blurAll()
  }

  function open(select, trigger, sync) {
    var l = layer.get()
    wireMenu()
    if (active && active.select === select) { close(); return }
    close()
    if (sync) sync()
    var html = ''
    Array.prototype.forEach.call(select.options, function (opt, i) {
      html += '<button class="zenui-option" type="button" role="option" data-index="' + i +
        '" aria-selected="' + (opt.value === select.value ? 'true' : 'false') + '">' +
        esc(opt.textContent) + '</button>'
    })
    l.menu.innerHTML = html || '<button class="zenui-option" type="button" disabled>无选项</button>'
    active = {
      select: select,
      trigger: trigger,
      sync: sync,
      index: Math.max(0, select.selectedIndex),
    }
    l.menu.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    position(l, trigger)
    paint(l, active.index)
    active.entry = {
      outside: function (event) {
        var path = event.composedPath ? event.composedPath() : [event.target]
        if (path.indexOf(l.menu) >= 0 || path.indexOf(trigger) >= 0) return
        close()
      },
      escape: close,
      key: function (event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); event.stopImmediatePropagation()
          var count = select.options.length
          active.index = (active.index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
          paint(l, active.index)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopImmediatePropagation()
          choose(active.index)
        }
      },
    }
    l.push(active.entry)
  }

  function enhance(root) {
    var scope = root || document
    var list = Array.prototype.slice.call(scope.querySelectorAll(SELECTOR))
    if (scope.matches && scope.matches(SELECTOR)) list.unshift(scope)
    if (!list.length) return
    var l = layer.get()
    list.forEach(function (select) {
      if (select.dataset.zenEnhanced === '1') return
      select.dataset.zenEnhanced = '1'
      var wrap = document.createElement('span')
      wrap.className = 'zenui-select'
      var trigger = document.createElement('button')
      trigger.type = 'button'
      trigger.className = 'zenui-select-trigger'
      trigger.setAttribute('aria-haspopup', 'listbox')
      trigger.setAttribute('aria-expanded', 'false')
      var label = document.createElement('span')
      trigger.appendChild(label)
      wrap.appendChild(trigger)
      select.parentNode.insertBefore(wrap, select)
      wrap.appendChild(select)
      select.setAttribute('aria-hidden', 'true')
      select.tabIndex = -1
      function sync() { label.textContent = currentLabel(select) }
      sync()
      select.addEventListener('change', sync)
      if (typeof MutationObserver === 'function') {
        new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true })
      }
      trigger.addEventListener('click', function (event) {
        event.preventDefault(); event.stopPropagation()
        open(select, trigger, sync)
      })
      trigger.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open(select, trigger, sync)
        }
      })
      var ownerLabel = wrap.closest('label')
      if (ownerLabel) {
        ownerLabel.removeAttribute('for')
        ownerLabel.addEventListener('click', function (event) {
          if (event.target.closest('.zenui-select-trigger')) return
          open(select, trigger, sync)
        })
      }
      if (!l.closeMenu) l.closeMenu = close
    })
  }

  ui.select = { enhance: enhance, close: close }
})(window)
