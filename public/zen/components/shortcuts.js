/* OMM-ZEN UI · components/shortcuts
 * ------------------------------------------------------------------
 * One keyboard binding registry. Products supply a map of key -> handler;
 * the shared code handles modifiers, editable-target guards and teardown.
 * This replaces the per-product key switches (writer / table / video).
 *
 * API: ZenUI.shortcuts.bind(map) -> unbind function
 *      ZenUI.shortcuts.format(key) -> human readable hint
 * Keys: 'mod+z', 'mod+shift+z', 'delete', 'backspace', 'f', 'escape' ...
 * A binding may be { run: fn, allowInput: true, label: '说明' }.
 * Depends: nothing (but loaded through index.js)
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var bindings = []
  var wired = false

  function normalize(key) {
    var parts = String(key).toLowerCase().split('+').map(function (s) { return s.trim() }).filter(Boolean)
    var mod = parts.indexOf('mod') >= 0 || parts.indexOf('ctrl') >= 0 || parts.indexOf('meta') >= 0
    var shift = parts.indexOf('shift') >= 0
    var alt = parts.indexOf('alt') >= 0
    var main = parts.filter(function (p) {
      return ['mod', 'ctrl', 'meta', 'shift', 'alt'].indexOf(p) < 0
    }).join('+')
    return { mod: mod, shift: shift, alt: alt, main: main }
  }

  function matches(event, spec) {
    var mod = event.ctrlKey || event.metaKey
    if (!!mod !== spec.mod) return false
    if (!!event.shiftKey !== spec.shift) return false
    if (!!event.altKey !== spec.alt) return false
    var key = String(event.key || '').toLowerCase()
    if (spec.main === 'del') spec.main = 'delete'
    return key === spec.main
  }

  function editable(target) {
    if (!target || target.nodeType !== 1) return false
    var tag = target.tagName.toLowerCase()
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true
  }

  function ensure() {
    if (wired) return
    wired = true
    document.addEventListener('keydown', function (event) {
      for (var i = bindings.length - 1; i >= 0; i--) {
        var b = bindings[i]
        if (!matches(event, b.spec)) continue
        if (!b.allowInput && editable(event.target)) continue
        event.preventDefault()
        event.stopImmediatePropagation()
        b.run(event)
        return
      }
    }, true)
  }

  function bind(map) {
    ensure()
    var added = Object.keys(map || {}).map(function (key) {
      var raw = map[key]
      var entry = typeof raw === 'function'
        ? { run: raw, allowInput: false }
        : { run: raw.run, allowInput: !!raw.allowInput }
      var item = { spec: normalize(key), run: entry.run, allowInput: entry.allowInput, label: entry.label }
      bindings.push(item)
      return item
    })
    return function unbind() {
      added.forEach(function (item) {
        var i = bindings.indexOf(item)
        if (i >= 0) bindings.splice(i, 1)
      })
    }
  }

  function format(key) {
    var s = normalize(key)
    var out = []
    if (s.mod) out.push(/Mac|iPhone|iPad/i.test(navigator.platform || '') ? '⌘' : 'Ctrl')
    if (s.alt) out.push('Alt')
    if (s.shift) out.push('Shift')
    out.push(s.main.length === 1 ? s.main.toUpperCase() : s.main)
    return out.join('+')
  }

  ui.shortcuts = { bind: bind, format: format, normalize: normalize }
})(window)
