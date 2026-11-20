/* zen-chart.js — 把简单数据渲染成自包含 SVG，供 Writer 内嵌图节点使用。
 * 纯函数、无依赖；同时挂到 globalThis.ZenChart。
 */
const PALETTES = {
  mono: ['#26231f', '#6b655b', '#a9a198'],
  culture: ['#b56545', '#e3a400', '#7c7f42'],
  science: ['#5b7692', '#359be0', '#8a6cf0'],
  editorial: ['#cc3333', '#3366cc', '#339933'],
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function arr(v) {
  return Array.isArray(v) ? v : []
}
function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

function parseCSV(text, delimiter) {
  const d = delimiter || ','
  const s = String(text || '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  // 支持引号包裹的单元格：内部的逗号与换行是数据，不是分隔符；双写引号表示
  // 一个字面引号。原来的 line.split(d) 会把 "a,b" 拆成两列并制造幽灵系列。
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ }
        else quoted = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      // 只有字段开头的引号才是包裹符；单元格中间的英寸号等必须原样保留，
      // 否则一个引号会吞掉后面所有分隔符与换行，整张表塌成一行。
      // 没有配对引号时（未闭合的引号）也按字面量保留，避免吞掉整张表。
      if (field === '' && s.indexOf('"', i + 1) >= 0) quoted = true
      else field += ch
    } else if (ch === d) {
      row.push(field.trim()); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(field.trim()); field = ''
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  // 未闭合的引号按字面量处理：把开头那个引号补回去，避免丢掉整段数据。
  if (quoted) field = '"' + field
  row.push(field.trim())
  if (row.some((c) => c !== '')) rows.push(row)
  if (!rows.length) return { labels: [], series: [] }
  const width = Math.max.apply(null, rows.map((r) => r.length))
  const labels = rows.slice(1).map((r) => r[0] || '')
  const names = rows[0].slice(1)
  const series = []
  for (let col = 1; col < width; col++) {
    series.push({
      name: names[col - 1] || '系列' + col,
      values: rows.slice(1).map((r) => Number(r[col]) || 0),
    })
  }
  return { labels: labels, series: series }
}

function normalizeSeries(list) {
  return arr(list).map((s) => ({
    name: s && typeof s === 'object' ? str(s.name) : '',
    values: s && Array.isArray(s.values) ? s.values : [],
  }))
}

function normalize(spec) {
  if (Array.isArray(spec)) {
    const items = spec.map((x) => (x && typeof x === 'object' ? x : {}))
    return {
      labels: items.map((x) => String(x.label || x.name || '')),
      series: [{ name: '值', values: items.map((x) => Number(x.value) || 0) }],
    }
  }
  const s = spec && typeof spec === 'object' ? spec : {}
  if (s.labels && s.series) {
    return {
      labels: Array.isArray(s.labels) ? s.labels.map(String) : [],
      series: normalizeSeries(s.series),
    }
  }
  if (typeof s.csv === 'string') return parseCSV(s.csv, s.delimiter)
  return { labels: [], series: [] }
}

/* spec: { kind:'bar'|'line', title, palette, labels:[], series:[{name,values}] }
 * 或 { csv:'...', kind, title } 或 [{label,value}, ...] */
function renderSVG(spec) {
  const input = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {}
  const data = normalize(spec)
  const kind = input.kind === 'line' ? 'line' : 'bar'
  // 用自有属性判定，避免 __proto__ / constructor 等原型键被当成调色板。
  const palette = (Object.prototype.hasOwnProperty.call(PALETTES, input.palette)
    ? PALETTES[input.palette]
    : null) || PALETTES.mono
  const W = Math.max(320, Number(input.width) || 720)
  const H = Math.max(200, Number(input.height) || 420)
  const padL = 56, padR = 24, padT = input.title ? 52 : 24, padB = 42
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const all = []
  data.series.forEach((s) => (s.values || []).forEach((v) => all.push(Number(v) || 0)))
  const max = all.length ? Math.max.apply(null, all) : 1
  const min = Math.min.apply(null, all.concat([0]))
  const span = max - min || 1
  const n = Math.max(data.labels.length, 1)
  const out = []
  out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">')
  out.push('<rect width="100%" height="100%" fill="#ffffff"/>')
  if (input.title) out.push('<text x="' + W / 2 + '" y="30" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#26231f">' + esc(input.title) + '</text>')
  // axes
  out.push('<line x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '" stroke="#26231f" stroke-width="1"/>')
  out.push('<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H - padB) + '" stroke="#26231f" stroke-width="1"/>')
  for (let t = 0; t <= 4; t++) {
    const y = padT + (plotH * t) / 4
    const val = max - (span * t) / 4
    out.push('<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(38,35,31,.08)"/>')
    out.push('<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-family="sans-serif" font-size="10" fill="#6b655b">' + esc(Math.round(val)) + '</text>')
  }
  const yOf = (v) => padT + plotH - ((Number(v) || 0) - min) / span * plotH
  if (kind === 'bar') {
    const group = plotW / n
    const bw = Math.max(4, group / (data.series.length + 1))
    data.series.forEach((s, si) => {
      ;(s.values || []).forEach((v, i) => {
        const x = padL + group * i + (si + 0.5) * bw
        const y = yOf(v)
        out.push('<rect x="' + x + '" y="' + y + '" width="' + (bw - 2) + '" height="' + Math.max(0, H - padB - y) + '" fill="' + palette[si % palette.length] + '"><title>' + esc(s.name + ': ' + v) + '</title></rect>')
      })
    })
  } else {
    data.series.forEach((s, si) => {
      const pts = (s.values || []).map((v, i) => (padL + (plotW * i) / Math.max(n - 1, 1)) + ',' + yOf(v))
      out.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + palette[si % palette.length] + '" stroke-width="2"/>')
      pts.forEach((p, i) => {
        const xy = p.split(',')
        out.push('<circle cx="' + xy[0] + '" cy="' + xy[1] + '" r="3" fill="' + palette[si % palette.length] + '"><title>' + esc(s.name + ': ' + s.values[i]) + '</title></circle>')
      })
    })
  }
  data.labels.forEach((label, i) => {
    const x = kind === 'bar' ? padL + (plotW / n) * (i + 0.5) : padL + (plotW * i) / Math.max(n - 1, 1)
    out.push('<text x="' + x + '" y="' + (H - padB + 16) + '" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#6b655b">' + esc(String(label).slice(0, 12)) + '</text>')
  })
  if (data.series.length > 1) {
    data.series.forEach((s, si) => {
      out.push('<rect x="' + (padL + si * 90) + '" y="' + (H - 16) + '" width="10" height="10" fill="' + palette[si % palette.length] + '"/>')
      out.push('<text x="' + (padL + si * 90 + 14) + '" y="' + (H - 7) + '" font-family="sans-serif" font-size="10" fill="#6b655b">' + esc(s.name) + '</text>')
    })
  }
  out.push('</svg>')
  return out.join('')
}

function toDataURL(spec) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderSVG(spec))
}

export const ZenChart = { PALETTES, parseCSV, normalize, renderSVG, toDataURL, esc }
if (typeof globalThis !== 'undefined') globalThis.ZenChart = ZenChart
export default ZenChart
