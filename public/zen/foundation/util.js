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

  /* Constrain a number to [a, b]; clamp01 is the common [0, 1] case. */
  u.clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)) }
  u.clamp01 = function (v) { return u.clamp(v, 0, 1) }

  /* Structured deep clone of JSON-safe data. undefined stays undefined. */
  u.clone = function (value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  }

  /* localStorage access that never throws (private mode / quota / disabled).
   * Values are raw strings; JSON parsing stays with the product. */
  function storage() {
    try { return global.localStorage } catch (e) { return null }
  }
  u.lsGet = function (key, fallback) {
    try {
      var s = storage()
      var v = s && s.getItem(key)
      return v === null || v === undefined ? fallback : v
    } catch (e) { return fallback }
  }
  u.lsSet = function (key, value) {
    try {
      var s = storage()
      if (!s) return false
      s.setItem(key, value)
      return true
    } catch (e) { return false }
  }
  u.lsDel = function (key) {
    try {
      var s = storage()
      if (!s) return false
      s.removeItem(key)
      return true
    } catch (e) { return false }
  }

  /* Generic closure factories / formatters used by more than one product. */
  u.debounce = function (fn, ms) {
    var timer = null
    return function () {
      var self = this, args = arguments
      if (timer) global.clearTimeout(timer)
      timer = global.setTimeout(function () { fn.apply(self, args) }, ms)
    }
  }

  /* yyyy-mm-dd; a non-date value falls back to its first 10 characters. */
  u.fmtDate = function (value) {
    if (!value) return ''
    var d = new Date(value)
    if (isNaN(d.getTime())) return u.str(value).slice(0, 10)
    return d.getFullYear() + '-' + u.pad(d.getMonth() + 1) + '-' + u.pad(d.getDate())
  }

  /* Sortable file-name timestamp: yyyyMMdd-HHmm (optionally :ss). */
  u.fileStamp = function (date, withSeconds) {
    var d = date || new Date()
    var out = d.getFullYear() + u.pad(d.getMonth() + 1) + u.pad(d.getDate()) +
      '-' + u.pad(d.getHours()) + u.pad(d.getMinutes())
    return withSeconds ? out + u.pad(d.getSeconds()) : out
  }

  /* Normalize a tag array or a delimited string (ASCII + common CJK separators). */
  u.tags = function (value) {
    if (Array.isArray(value)) return value.map(u.nz).filter(Boolean)
    if (typeof value === 'string') {
      return value.split(/[,，;；、|]/).map(u.nz).filter(Boolean)
    }
    return []
  }

  /* Save a pretty-printed JSON document through the shared download helper. */
  u.saveJSON = function (name, obj, mime) {
    return u.download(name, JSON.stringify(obj, null, 2), mime || 'application/json;charset=utf-8')
  }

  /* Read one / many File objects as text. Products keep their own parsing,
   * validation and normalization; this only replaces the FileReader skeleton. */
  u.readText = function (file, encoding) {
    if (file && typeof file.text === 'function') return file.text()
    return new Promise(function (resolve, reject) {
      try {
        var reader = new FileReader()
        reader.onload = function () { resolve(String(reader.result || '')) }
        reader.onerror = function () { reject(reader.error || new Error('read failed')) }
        reader.readAsText(file, encoding || 'utf-8')
      } catch (e) { reject(e) }
    })
  }
  u.readTexts = function (files, encoding) {
    return Promise.all(u.arr(files).map(function (f) { return u.readText(f, encoding) }))
  }

  /* JSON-in-localStorage with the same never-throw contract as lsGet/lsSet. */
  u.getJSON = function (key, fallback) {
    var raw = u.lsGet(key, null)
    if (raw === null || raw === undefined) return fallback
    try { return JSON.parse(raw) } catch (e) { return fallback }
  }
  u.setJSON = function (key, value) {
    try { return u.lsSet(key, JSON.stringify(value)) } catch (e) { return false }
  }
  u.removeJSON = function (key) { return u.lsDel(key) }

  /* Wire file drag & drop on a target. Only the wiring is shared: the product
   * callback decides which files are accepted and what to do with them.
   * opts: { highlight: 'class', onEnter, onLeave } — highlight is toggled on
   * the target; the hooks let a product drive its own visual feedback.
   * Returns an unbind function. */
  u.enableFileDrop = function (target, onFiles, opts) {
    if (!target) return function () {}
    var o = opts || {}
    var depth = 0
    function over(e) {
      if (!e.dataTransfer) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      if (depth++ === 0) {
        if (o.highlight) target.classList.add(o.highlight)
        if (o.onEnter) o.onEnter(e)
      }
    }
    function leave(e) {
      if (--depth <= 0) {
        depth = 0
        if (o.highlight) target.classList.remove(o.highlight)
        if (o.onLeave) o.onLeave(e)
      }
    }
    function drop(e) {
      if (!e.dataTransfer) return
      e.preventDefault()
      depth = 0
      if (o.highlight) target.classList.remove(o.highlight)
      if (typeof onFiles === 'function') onFiles(Array.prototype.slice.call(e.dataTransfer.files || []))
    }
    target.addEventListener('dragenter', over)
    target.addEventListener('dragover', over)
    target.addEventListener('dragleave', leave)
    target.addEventListener('drop', drop)
    return function unbind() {
      target.removeEventListener('dragenter', over)
      target.removeEventListener('dragover', over)
      target.removeEventListener('dragleave', leave)
      target.removeEventListener('drop', drop)
    }
  }
})(window)
