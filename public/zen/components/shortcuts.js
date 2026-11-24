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
    // A literal '+' is the key itself, not a modifier separator.
    if (String(key) === '+') return { mod: false, shift: false, alt: false, main: '+' }
    var parts = String(key).toLowerCase().split('+').map(function (s) { return s.trim() }).filter(Boolean)
    var mod = parts.indexOf('mod') >= 0 || parts.indexOf('ctrl') >= 0 || parts.indexOf('meta') >= 0
    var shift = parts.indexOf('shift') >= 0
    var alt = parts.indexOf('alt') >= 0
    var main = parts.filter(function (p) {
      return ['mod', 'ctrl', 'meta', 'shift', 'alt'].indexOf(p) < 0
    }).join('+')
    return { mod: mod, shift: shift, alt: alt, main: main }
  }

  /* Canonical key names so products can bind readable 'space' / 'escape'
   * instead of quoting the raw event.key values ' ' / 'Esc'. */
  function keyName(event) {
    var k = String(event.key || '').toLowerCase()
    if (k === ' ' || k === 'spacebar') return 'space'
    if (k === 'esc') return 'escape'
    return k
  }

  /* Printable punctuation that requires Shift on a US layout. The resulting
   * character already implies Shift, so the modifier is not matched for them. */
  var SHIFTED = /[~!@#$%^&*()_+{}|:"<>?]/

  function matches(event, spec) {
    var mod = event.ctrlKey || event.metaKey
    if (!!mod !== spec.mod) return false
    if (!!event.altKey !== spec.alt) return false
    var key = keyName(event)
    var main = spec.main === 'del' ? 'delete' : spec.main
    if (main.length === 1 && SHIFTED.test(main)) return key === main
    if (!!event.shiftKey !== spec.shift) return false
    return key === main
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
      // An open shared surface (menu / select / picker / modal / sheet) owns
      // the keyboard until it closes; global product shortcuts stay dormant.
      if (ui.layer && ui.layer.hasOpen && ui.layer.hasOpen()) return
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

  /* The shortcut help sheet is shared: products only supply their own rows
   * (or the product-localised DSL text) and call help(). All .hk-* markup is
   * generated here so no product owns a private copy of the sheet. */
  var esc = global.ZenUtil.esc

  function row(desc, keys) {
    return '<div class="hk-row"><span>' + esc(desc) + '</span>' +
      '<span class="hk-key">' + esc(keys) + '</span></div>'
  }

  function section(title, rows) {
    return '<div class="hk-section"><div class="hk-section-title">' + esc(title) +
      '</div>' + (rows || []).join('') + '</div>'
  }

  function note(html) {
    return '<div class="hk-section"><div class="hk-note">' + html + '</div></div>'
  }

  function grid(sections) {
    return '<div class="hk-grid">' + (sections || []).join('') + '</div>'
  }

  /* DSL: sections separated by '~~', title/rows by '§', pairs by '|'. */
  function parseRows(text, opts) {
    var o = opts || {}
    var expand = o.expand || function (s) { return String(s == null ? '' : s) }
    var defaultMod = /Mac|iPhone|iPad/i.test(navigator.platform || '') ? '⌘' : 'Ctrl'
    var raw = expand(String(text || '')).split('{M}').join(
      o.mod == null ? defaultMod : o.mod
    )
    return raw.split('~~').map(function (sec) {
      var cut = sec.indexOf('§')
      var pairs = (cut < 0 ? '' : sec.slice(cut + 1)).split('|')
      var rows = []
      for (var i = 0; i + 1 < pairs.length; i += 2) rows.push(row(pairs[i], pairs[i + 1]))
      return section(cut < 0 ? sec : sec.slice(0, cut), rows)
    })
  }

  function help(opts) {
    var o = opts || {}
    var body = o.body || grid(o.sections || [])
    return global.ZenUI.modal.open({
      title: o.title || '快捷键',
      width: o.width || 'min(560px, 96vw)',
      html: o.template || body,
      ids: { close: o.closeId || 'shortcuts-close' },
      onMount: function (root) {
        var host = o.bodyId ? root.querySelector('#' + o.bodyId) : null
        if (host) host.innerHTML = body
        if (o.onMount) o.onMount(root)
      },
      onClose: o.onClose,
    })
  }

  ui.shortcuts = {
    bind: bind,
    format: format,
    normalize: normalize,
    row: row,
    section: section,
    note: note,
    grid: grid,
    parseRows: parseRows,
    help: help,
  }
})(window)
