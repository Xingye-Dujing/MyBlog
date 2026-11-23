/* OMM-ZEN foundation · util
 * ------------------------------------------------------------------
 * Generic, stateless helpers shared by every OMM-ZEN product. One canonical
 * implementation per concern; products bind their local names to these
 * functions instead of re-implementing them. No product state, no branching,
 * no hardcoded colours or node names — every product may use every helper.
 *
 * Exposes: window.ZenUtil
 * Load before any product script (it has no dependencies).
 */
;(function (global) {
  'use strict'
  var u = (global.ZenUtil = global.ZenUtil || {})

  /* DOM */
  u.byId = function (id) { return document.getElementById(id) }
  u.tpl = function (id) { var t = u.byId(id); return t ? t.innerHTML : '' }
  u.setText = function (id, v) { var e = u.byId(id); if (e) e.textContent = v }
  u.toggleCls = function (id, cls, on) { var e = u.byId(id); if (e) e.classList.toggle(cls, !!on) }
  u.autosize = function (id) {
    var x = u.byId(id)
    if (!x) return
    x.style.height = 'auto'
    x.style.height = x.scrollHeight + 'px'
  }

  /* strings / ids */
  u.nz = function (v) { return String(v == null ? '' : v).trim() }
  u.low = function (v) { return u.nz(v).toLowerCase() }
  u.kz = function (v) { return u.low(v).replace(/\s+/g, ' ') }
  u.nowISO = function () { return new Date().toISOString() }
  u.pad = function (n) { return n < 10 ? '0' + n : '' + n }
  u.str = function (v) { return v === null || v === undefined ? '' : String(v) }
  u.arr = function (v) { return Array.isArray(v) ? v : [] }

  /* cloud-sync error classification (Supabase "table missing" family) */
  u.isTableMissing = function (err) {
    return !!(err && (err.code === 'PGRST205' ||
      /schema cache|Could not find the table/i.test(err.message || '')))
  }

  /* HTML escaping. The 5th entity (apostrophe) is opt-out for legacy callers
   * that only escape the 4 core entities; no product branching lives here. */
  u.esc = function (value, opts) {
    var s = u.str(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    return (!opts || opts.apos !== false) ? s.replace(/'/g, '&#39;') : s
  }

  /* Unique id. The optional prefix is supplied by the caller. */
  u.uid = function (prefix) {
    return (prefix || '') + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8)
  }

  /* Blob / text download with optional UTF-8 BOM. */
  u.download = function (name, content, mime, bom) {
    try {
      var blob = (typeof content === 'string')
        ? new Blob([bom ? '\ufeff' + content : content],
            { type: mime || 'text/plain;charset=utf-8' })
        : content
      var url = URL.createObjectURL(blob)
      var a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      global.setTimeout(function () {
        try { URL.revokeObjectURL(url) } catch (e) { /* ignore */ }
      }, 3000)
      return true
    } catch (e) { return false }
  }

  /* Clipboard copy with legacy execCommand fallback.
   * Returns Promise<boolean>; messaging stays in the product via callbacks. */
  u.copy = function (text, onOk, onFail) {
    function ok() { if (typeof onOk === 'function') onOk() }
    function fallback() {
      var ta = document.createElement('textarea')
      ta.value = u.str(text)
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      var done = false
      try { done = !!(document.execCommand && document.execCommand('copy')) } catch (e) { /* ignore */ }
      ta.remove()
      if (done) ok()
      else if (typeof onFail === 'function') onFail()
      return done
    }
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { ok(); return true },
        function () { return fallback() }
      )
    }
    return Promise.resolve(fallback())
  }

  /* Filesystem-safe file name. */
  u.safeName = function (value, opts) {
    var o = opts || {}
    var raw = (value == null || value === '') ? (o.fallback || '') : value
    var s = u.str(raw).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, o.max || 60)
    return s || (o.fallback || '')
  }

  /* Escape a literal for use inside a RegExp constructor. */
  u.escRe = function (value) {
    return u.str(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
})(window)
