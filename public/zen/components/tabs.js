/* OMM-ZEN UI · components/tabs
 * Optional. Adds tab behaviour to markup that uses the shared .zenui-tabs
 * visual vocabulary. Products keep their own panels and business handlers.
 *
 *   <div data-zen-tabs>
 *     <button class="zenui-tab" data-zen-tab="a" aria-selected="true">A</button>
 *     <button class="zenui-tab" data-zen-tab="b" aria-selected="false">B</button>
 *   </div>
 *
 * Dispatches a bubbling CustomEvent 'zen:tab' with { id, index, group }.
 * Depends: nothing
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var READY = 'data-zen-tabs-ready'

  function enhance(root) {
    var scope = root || document
    var list = scope.querySelectorAll('[data-zen-tabs]:not([' + READY + '])')
    Array.prototype.forEach.call(list, function (group) {
      group.setAttribute(READY, '1')
      var tabs = group.querySelectorAll('.zenui-tab')
      Array.prototype.forEach.call(tabs, function (tab, index) {
        tab.addEventListener('click', function () {
          Array.prototype.forEach.call(tabs, function (other) {
            other.setAttribute('aria-selected', other === tab ? 'true' : 'false')
          })
          try {
            group.dispatchEvent(new CustomEvent('zen:tab', {
              bubbles: true,
              detail: { id: tab.dataset.zenTab, index: index, group: group.dataset.zenTabs },
            }))
          } catch (e) { /* ignore */ }
        })
      })
    })
  }

  ui.tabs = { enhance: enhance }
})(window)
