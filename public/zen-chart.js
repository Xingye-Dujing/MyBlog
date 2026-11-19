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

function parseCSV(text, delimiter) {
  const d = delimiter || ','
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return { labels: [], series: [] }
  const cells = lines.map((line) => line.split(d).map((x) => x.trim()))
  const width = Math.max.apply(null, cells.map((c) => c.length))
  const labels = cells.slice(1).map((c) => c[0] || '')
  const names = cells[0].slice(1)
  const series = []
  for (let s = 1; s < width; s++) {
    series.push({
      name: names[s - 1] || '系列' + s,
      values: cells.slice(1).map((c) => Number(c[s]) || 0),
    })
  }
  return { labels: labels, series: series }
}

function normalize(spec) {
  if (Array.isArray(spec)) return { labels: spec.map((x) => String(x.label || x.name || '')), series: [{ name: '值', values: spec.map((x) => Number(x.value) || 0) }] }
  const s = spec && typeof spec === 'object' ? spec : {}
  if (s.labels && s.series) return { labels: s.labels.map(String), series: Array.isArray(s.series) ? s.series : [] }
  if (typeof s.csv === 'string') return parseCSV(s.csv, s.delimiter)
  return { labels: [], series: [] }
}

/* spec: { kind:'bar'|'line', title, palette, labels:[], series:[{name,values}] }
 * 或 { csv:'...', kind, title } 或 [{label,value}, ...] */
function renderSVG(spec) {
  const input = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {}
  const data = normalize(spec)
  const kind = input.kind === 'line' ? 'line' : 'bar'
  const palette = PALETTES[input.palette] || PALETTES.mono
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
