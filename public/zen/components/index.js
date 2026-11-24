/* OMM-ZEN UI · entry
 * ------------------------------------------------------------------
 * Composes the shared component library and wires it to the product page.
 *
 * Core load order (every product):
 *   zen/components/layer.js
 *   zen/components/toast.js
 *   zen/components/dialog.js
 *   zen/components/select.js
 *   zen/components/menu.js
 *   zen/components/shortcuts.js
 *   zen/components/index.js
 *
 * Optional (loaded only by products that use them):
 *   zen/components/picker.js      date / time inputs
 *   zen/components/tabs.js        tab / segmented controls
 *   zen/components/tooltip.js     data-zen-tip tooltips
 *
 * Exposes: window.ZenUI
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var required = ['layer', 'toast', 'dialog', 'select', 'menu', 'shortcuts']
  for (var i = 0; i < required.length; i++) {
    if (!ui[required[i]]) {
      throw new Error('zen/ui: load ' + required.join(' + ') + ' before index.js (missing ' + required[i] + ')')
    }
  }

  ui.version = '2.0.0'

  var ACTION_SELECTOR = '[data-action]:not(button):not(a):not(input):not(select):not(textarea):not([contenteditable="true"])'

  /* Legacy product menus use clickable div/span markup. Enhance their keyboard
   * semantics in one place instead of keeping per-product key handlers. Native
   * buttons and controls are never wrapped or rebound. */
  function syncActionState(el) {
    if (el.classList.contains('disabled')) el.setAttribute('aria-disabled', 'true')
    else el.removeAttribute('aria-disabled')
  }

  function enhanceActions(root) {
    var scope = root || document
    var list = Array.prototype.slice.call(scope.querySelectorAll(ACTION_SELECTOR))
    if (scope.matches && scope.matches(ACTION_SELECTOR)) list.unshift(scope)
    list.forEach(function (el) {
      if (el.dataset.zenActionReady === '1') return
      if (el.closest('button,a,input,select,textarea')) return
      el.dataset.zenActionReady = '1'
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button')
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0')
      syncActionState(el)
      el.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
        if (event.repeat || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')) return
        event.preventDefault()
        event.stopPropagation()
        el.click()
      })
    })
  }

  function enhance(root) {
    enhanceActions(root)
    ui.select.enhance(root)
    if (ui.picker) ui.picker.enhance(root)
    if (ui.tooltip) ui.tooltip.enhance(root)
    if (ui.tabs) ui.tabs.enhance(root)
  }

  function start() {
    enhance(document)
    if (typeof MutationObserver !== 'function' || !document.body) return
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var record = records[i]
        if (record.type === 'attributes') {
          if (record.target.matches && record.target.matches(ACTION_SELECTOR)) syncActionState(record.target)
          continue
        }
        var added = record.addedNodes
        for (var j = 0; j < added.length; j++) {
          var node = added[j]
          if (!node || node.nodeType !== 1) continue
          enhanceActions(node)
          if (node.matches && node.matches('select[data-zen-select]')) {
            ui.select.enhance(node)
          } else if (node.querySelector && node.querySelector('select[data-zen-select]')) {
            ui.select.enhance(node)
          }
          if (ui.picker) {
            if (node.matches && node.matches('input[type="date"],input[type="time"],[data-zen-date],[data-zen-time]')) {
              ui.picker.enhance(node.parentNode || document)
            } else if (node.querySelector && node.querySelector('input[type="date"],input[type="time"],[data-zen-date],[data-zen-time]')) {
              ui.picker.enhance(node)
            }
          }
        }
      }
    }).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }

  ui.enhance = enhance
  ui.enhanceActions = enhanceActions
  ui.start = start

  ui.closeAll = function () {
    ui.dialog.close()
    ui.select.close()
    ui.menu.close()
    if (ui.picker) ui.picker.close()
  }
})(window)
