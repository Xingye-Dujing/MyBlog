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

  function enhance(root) {
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
        var added = records[i].addedNodes
        for (var j = 0; j < added.length; j++) {
          var node = added[j]
          if (!node || node.nodeType !== 1) continue
          if (node.matches && node.matches('select[data-zen-select],select[data-omm-select]')) {
            ui.select.enhance(node)
          } else if (node.querySelector && node.querySelector('select[data-zen-select],select[data-omm-select]')) {
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
    }).observe(document.body, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }

  ui.enhance = enhance
  ui.start = start

  ui.closeAll = function () {
    ui.dialog.close()
    ui.select.close()
    ui.menu.close()
    if (ui.picker) ui.picker.close()
  }
})(window)
