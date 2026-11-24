/* OMM-ZEN UI · components/switch
 * ------------------------------------------------------------------
 * One ARIA switch implementation for every product. The markup is a real
 * button so Space/Enter come from the browser; this module owns the toggle:
 * it flips aria-checked in the capture phase (before product handlers run),
 * then products react to their own state exactly as before.
 *
 *   <button type="button" class="switch" role="switch"
 *           aria-checked="false" data-zen-switch>
 *     <span class="switch-track" aria-hidden="true"></span>
 *     <span>Label</span>
 *   </button>
 *
 * API: ZenUI.switch.set(el, on) · ZenUI.switch.isOn(el) · ZenUI.switch.enhance(root)
 * Depends: zen/zen.css (component styles live in components.css)
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var SELECTOR = '[data-zen-switch]'

  function isOn(el) {
    return !!el && el.getAttribute('aria-checked') === 'true'
  }

  function set(el, on) {
    if (!el) return
    el.setAttribute('aria-checked', on ? 'true' : 'false')
  }

  function toggle(el) {
    set(el, !isOn(el))
  }

  function target(node) {
    return node && node.closest ? node.closest(SELECTOR) : null
  }

  /* Capture phase: aria reflects the new state before the product handler
   * runs, so a handler that re-applies its saved state stays authoritative. */
  document.addEventListener('click', function (event) {
    var el = target(event.target)
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return
    toggle(el)
  }, true)

  function enhance(root) {
    var scope = root || document
    var list = scope.querySelectorAll(SELECTOR)
    for (var i = 0; i < list.length; i++) {
      if (!list[i].hasAttribute('role')) list[i].setAttribute('role', 'switch')
      if (!list[i].hasAttribute('aria-checked')) list[i].setAttribute('aria-checked', 'false')
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { enhance(document) }, { once: true })
  } else {
    enhance(document)
  }

  ui.switch = { set: set, toggle: toggle, isOn: isOn, enhance: enhance }
})(window)
