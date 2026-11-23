/* OMM-ZEN UI · components/tabs
 * Optional. Adds tab behaviour to markup that uses the shared .zenui-tabs
 * visual vocabulary. Products keep their own panels and business handlers.
 *
 *   <div data-zen-tabs>
 *     <button class="zenui-tab" data-zen-tab="a" aria-selected="true">A</button>
 *     <button class="zenui-tab" data-zen-tab="b" aria-selected="false">B</button>
 *   </div>
 *
 * A product can keep its own markup / CSS vocabulary through two generic
 * attributes on the container: data-zen-tab-item (item selector, default
 * '.zenui-tab') and data-zen-tab-active (class toggled on the active item,
 * default none — aria-selected is always maintained).
 *
 * Dispatches a bubbling CustomEvent 'zen:tab' with { id, index, group }.
 * Depends: nothing
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var READY = 'data-zen-tabs-ready'

  function parts(group) {
    var sel = group.getAttribute('data-zen-tab-item') || '.zenui-tab'
    var tabs = group.querySelectorAll(sel)
    return {
      sel: sel,
      activeCls: group.getAttribute('data-zen-tab-active') || '',
      // Only manage tabindex when the product markup actually uses it (roving focus).
      focus: !!(tabs[0] && tabs[0].hasAttribute('tabindex')),
      tabs: tabs,
    }
  }

  function apply(p, target) {
    Array.prototype.forEach.call(p.tabs, function (other) {
      var on = other === target
      other.setAttribute('aria-selected', on ? 'true' : 'false')
      if (p.activeCls) other.classList.toggle(p.activeCls, on)
      if (p.focus) other.setAttribute('tabindex', on ? '0' : '-1')
    })
  }

  function emit(group, tab, index) {
    try {
      group.dispatchEvent(new CustomEvent('zen:tab', {
        bubbles: true,
        detail: { id: tab.getAttribute('data-zen-tab') || tab.dataset.zenTab, index: index, group: group.getAttribute('data-zen-tabs') },
      }))
    } catch (e) { /* ignore */ }
  }

  function select(group, id) {
    if (!group) return
    var p = parts(group)
    var target = null
    var index = -1
    Array.prototype.forEach.call(p.tabs, function (tab, i) {
      if (tab === id || tab.getAttribute('data-zen-tab') === String(id) || String(i) === String(id)) {
        target = tab
        index = i
      }
    })
    if (!target) return
    apply(p, target)
    emit(group, target, index)
  }

  function enhance(root) {
    var scope = root || document
    var list = scope.querySelectorAll('[data-zen-tabs]:not([' + READY + '])')
    Array.prototype.forEach.call(list, function (group) {
      group.setAttribute(READY, '1')
      var p = parts(group)
      Array.prototype.forEach.call(p.tabs, function (tab, index) {
        tab.addEventListener('click', function () {
          apply(p, tab)
          emit(group, tab, index)
        })
      })
    })
  }

  ui.tabs = { enhance: enhance, select: select }
})(window)
