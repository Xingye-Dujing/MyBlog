/* OMM-ZEN lib · CSV / TSV codec
 * ------------------------------------------------------------------
 * One lossless delimiter codec for product imports and exports. Quoted fields
 * may contain delimiters, CR/LF and doubled quotes; surrounding whitespace is
 * data, not something to trim. stringify(rows, delimiter, {formulaSafe:true})
 * protects spreadsheet exports without changing the default lossless codec.
 * Exposes: window.ZenCSV
 */
;(function (global) {
  'use strict'

  function delimiterOf(value) {
    var d = value == null ? ',' : String(value)
    if (d !== ',' && d !== '\t') throw new Error('仅支持逗号或制表符分隔')
    return d
  }

  function parse(text, delimiter) {
    var d = delimiterOf(delimiter)
    var s = String(text == null ? '' : text).replace(/^\uFEFF/, '')
    var rows = [], row = [], field = '', quoted = false, touched = false
    for (var i = 0; i < s.length; i++) {
      var ch = s[i]
      if (quoted) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            field += '"'
            i++
          } else quoted = false
        } else field += ch
        continue
      }
      if (ch === '"' && field === '') {
        quoted = true
        touched = true
        continue
      }
      if (ch === d) {
        row.push(field)
        field = ''
        touched = true
        continue
      }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++
        row.push(field)
        rows.push(row)
        row = []
        field = ''
        touched = false
        continue
      }
      field += ch
      touched = true
    }
    if (quoted) field = '"' + field
    if (touched || field !== '' || row.length) {
      row.push(field)
      rows.push(row)
    }
    return rows
  }

  function stringify(rows, delimiter, opts) {
    var d = delimiterOf(delimiter)
    var formulaSafe = !!(opts && opts.formulaSafe)
    return (Array.isArray(rows) ? rows : []).map(function (row) {
      return (Array.isArray(row) ? row : []).map(function (value) {
        var s = value == null ? '' : String(value)
        if (formulaSafe && (/^[=+@\t\r]/.test(s) || /^-(?![0-9.])/.test(s))) s = "'" + s
        if (/["\r\n]/.test(s) || s.indexOf(d) >= 0 || /^\s|\s$/.test(s)) {
          return '"' + s.replace(/"/g, '""') + '"'
        }
        return s
      }).join(d)
    }).join('\r\n') + ((Array.isArray(rows) && rows.length) ? '\r\n' : '')
  }

  global.ZenCSV = { parse: parse, stringify: stringify }
})(window)
