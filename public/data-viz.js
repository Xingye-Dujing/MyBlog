/* data-viz.js — ZenData 表格 → ZenViz 可导入数据（纯函数，无依赖）
 * 同时挂到 globalThis.DataViz。
 */
function str(v) {
  return v === null || v === undefined ? '' : String(v)
}
function arr(v) {
  return Array.isArray(v) ? v : []
}
function cell(v) {
  if (v === null || v === undefined) return ''
  return String(v)
}
function csvCell(v) {
  const s = cell(v)
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
function isNumeric(v) {
  if (v === '' || v === null || v === undefined) return false
  return !isNaN(Number(v))
}

function toCSV(table) {
  const t = table && typeof table === 'object' ? table : {}
  const headers = arr(t.cols).map((c) => str(c && (c.name || c.title))) 
  const rows = arr(t.rows).map((r) => arr(r))
  const lines = [headers.map(csvCell).join(',')]
  rows.forEach((r) => lines.push(r.map(csvCell).join(',')))
  return lines.join('\r\n')
}

/* 首列非数值视为分类，其余数值列作为系列。 */
function guessRoles(headers, rows) {
  const h = arr(headers).map(String)
  let category = 0
  for (let c = 0; c < h.length; c++) {
    const numeric = arr(rows).length && arr(rows).every((r) => isNumeric(r[c]))
    if (!numeric) { category = c; break }
  }
  const values = []
  for (let c = 0; c < h.length; c++) {
    if (c === category) continue
    if (arr(rows).some((r) => isNumeric(r[c]))) values.push(c)
  }
  if (!values.length && h.length > 1) values.push(category === 0 ? 1 : 0)
  return { category: category, values: values }
}

function toPayload(table, opts) {
  const t = table && typeof table === 'object' ? table : {}
  const o = opts || {}
  const headers = arr(t.cols).map((c) => str(c && (c.name || c.title)) || '列')
  const rows = arr(t.rows).map((r) => arr(r).map(cell))
  return {
    format: 'zenviz-data',
    v: 1,
    name: str(o.name || t.name) || '数据工作台',
    headers: headers,
    rows: rows,
    csv: toCSV(t),
    roles: guessRoles(headers, rows),
  }
}

function parsePayload(text) {
  const obj = typeof text === 'string' ? JSON.parse(text) : text
  if (!obj || obj.format !== 'zenviz-data' || obj.v !== 1) throw new Error('非法 zenviz-data 数据')
  if (!Array.isArray(obj.headers) || !Array.isArray(obj.rows)) throw new Error('缺少 headers / rows')
  return obj
}

export const DataViz = { toCSV, csvCell, guessRoles, toPayload, parsePayload, isNumeric }
if (typeof globalThis !== 'undefined') globalThis.DataViz = DataViz
export default DataViz
