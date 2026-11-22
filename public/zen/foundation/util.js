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
})(window)
