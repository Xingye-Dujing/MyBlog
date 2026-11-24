/* zen-card.js — OMM-ZEN 通用知识卡片格式
 * ============================================================
 * 一套跨产品的最小中间格式：让“标注 / 搜索 / 语料 / 写作 / 数据”
 * 之间搬运内容不再需要为每对产品写一次性转换。
 *
 * 本文件是无依赖、纯函数的 ESM 模块，同时挂到 globalThis.ZenCard，
 * 因此既能被 `import { ZenCard }`，也能在浏览器里用 <script type="module">
 * 加载后通过 window.ZenCard 调用。所有会用到“当前时间 / 随机数”的
 * 函数都允许注入，便于测试时得到确定结果。
 */

const FORMAT = 'zen-card'
const VERSION = 1

const KINDS = ['quote', 'note', 'word', 'sentence', 'idea', 'todo', 'fact', 'image']
const SOURCES = ['manual', 'writer', 'annotate', 'corpus', 'english', 'search', 'data', 'web', 'clip']

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

function arr(v) {
  return Array.isArray(v) ? v : []
}

function normTags(v) {
  const seen = Object.create(null)
  const out = []
  arr(v).forEach(function (t) {
    const s = str(t).trim()
    if (s && !seen[s]) {
      seen[s] = 1
      out.push(s)
    }
  })
  return out
}

function normDate(v, fallback) {
  if (typeof v === 'number' && isFinite(v)) {
    const d = new Date(v)
    return isNaN(d.getTime()) ? fallback : d.toISOString()
  }
  const s = str(v).trim()
  if (!s) return fallback
  if (/^\d+$/.test(s)) {
    const d = new Date(Number(s))
    return isNaN(d.getTime()) ? fallback : d.toISOString()
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? fallback : d.toISOString()
}

function nowISO(now) {
  if (now instanceof Date && !isNaN(now.getTime())) return now.toISOString()
  const n = typeof now === 'number' ? now : Date.now()
  return new Date(n).toISOString()
}

function uid(now, rand) {
  const t = (typeof now === 'number' ? now : Date.now()).toString(36)
  const r = Math.floor((typeof rand === 'number' ? rand : Math.random()) * 0xffffff)
    .toString(36)
    .padStart(4, '0')
  return 'zc-' + t + '-' + r
}

function escapeHtml(s) {
  return str(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function stripHtml(s) {
  return str(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

/* Normalise arbitrary input into a well-formed card. Never throws. */
function create(input, opts) {
  const o = opts || {}
  const raw = input && typeof input === 'object' ? input : { content: str(input) }
  const stamp = nowISO(o.now)
  const kind = KINDS.indexOf(raw.kind) >= 0 ? raw.kind : 'note'
  const source = SOURCES.indexOf(raw.source) >= 0 ? raw.source : 'manual'
  const content = str(raw.content !== undefined ? raw.content : raw.text !== undefined ? raw.text : raw.en)
  const card = {
    format: FORMAT,
    v: VERSION,
    id: str(raw.id) || uid(o.now, o.rand),
    kind: kind,
    source: source,
    ref: str(raw.ref),
    content: content,
    translation: str(raw.translation !== undefined ? raw.translation : raw.zh),
    note: str(raw.note !== undefined ? raw.note : raw.notes),
    tags: normTags(raw.tags),
    color: str(raw.color),
    createdAt: normDate(raw.createdAt, stamp),
    updatedAt: normDate(raw.updatedAt, stamp),
  }
  const links = arr(raw.links)
    .map(function (l) {
      if (!l || typeof l !== 'object') return null
      const id = str(l.id)
      return id ? { rel: str(l.rel) || 'related', id: id } : null
    })
    .filter(Boolean)
  if (links.length) card.links = links
  if (raw.image) card.image = str(raw.image)
  return card
}

/* Strict validation. Returns { ok, errors }. */
function validate(card) {
  const errors = []
  if (!card || typeof card !== 'object') return { ok: false, errors: ['卡片必须是对象'] }
  if (card.format !== FORMAT) errors.push('format 必须是 zen-card')
  if (card.v !== VERSION) errors.push('v 必须是数字 1')
  if (!str(card.id)) errors.push('id 不能为空')
  if (KINDS.indexOf(card.kind) < 0) errors.push('kind 非法')
  if (SOURCES.indexOf(card.source) < 0) errors.push('source 非法')
  if (!str(card.content).trim()) errors.push('content 不能为空')
  if (!Array.isArray(card.tags)) errors.push('tags 必须是数组')
  if (card.createdAt && isNaN(new Date(card.createdAt).getTime())) errors.push('createdAt 非法')
  if (card.updatedAt && isNaN(new Date(card.updatedAt).getTime())) errors.push('updatedAt 非法')
  if (card.links !== undefined) {
    if (!Array.isArray(card.links)) errors.push('links 必须是数组')
    else
      card.links.forEach(function (l, i) {
        if (!l || typeof l !== 'object' || !str(l.id)) errors.push('links[' + i + '].id 不能为空')
      })
  }
  return { ok: errors.length === 0, errors: errors }
}

function parse(text) {
  const obj = typeof text === 'string' ? JSON.parse(text) : text
  const card = create(obj)
  const result = validate(card)
  if (!result.ok) throw new Error('非法 zen-card：' + result.errors.join('；'))
  return card
}

function serialize(card, pretty) {
  const result = validate(card)
  if (!result.ok) throw new Error('非法 zen-card：' + result.errors.join('；'))
  return JSON.stringify(card, null, pretty ? 2 : 0)
}

function serializePack(cards, meta, pretty) {
  const list = arr(cards).map(function (c) {
    return create(c)
  })
  list.forEach(function (c) {
    const r = validate(c)
    if (!r.ok) throw new Error('非法 zen-card：' + r.errors.join('；'))
  })
  const pack = {
    format: 'zen-card-pack',
    v: VERSION,
    name: str(meta && meta.name),
    cards: list,
  }
  return JSON.stringify(pack, null, pretty ? 2 : 0)
}

function parsePack(text) {
  const obj = typeof text === 'string' ? JSON.parse(text) : text
  if (!obj || obj.format !== 'zen-card-pack' || !Array.isArray(obj.cards)) {
    throw new Error('非法 zen-card-pack')
  }
  const cards = obj.cards.map(create)
  cards.forEach(function (card, index) {
    const result = validate(card)
    if (!result.ok) throw new Error('非法 zen-card-pack：cards[' + index + '] ' + result.errors.join('；'))
  })
  return { name: str(obj.name), cards: cards }
}

/* Stable content-based fingerprint, used to de-duplicate across products. */
function fingerprint(card) {
  const c = create(card)
  const key = [c.kind, c.content.trim(), c.translation.trim()].join('\u0001')
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return 'fp-' + (h >>> 0).toString(36)
}

function merge(cards, opts) {
  const o = opts || {}
  const byId = Object.create(null)
  const byFp = Object.create(null)
  const out = []
  arr(cards)
    .map(create)
    .forEach(function (c) {
      const fp = fingerprint(c)
      const idKey = c.id
      if (byId[idKey] || (o.byFingerprint !== false && byFp[fp])) return
      byId[idKey] = 1
      byFp[fp] = 1
      out.push(c)
    })
  if (o.sort !== false) {
    out.sort(function (a, b) {
      return str(a.createdAt).localeCompare(str(b.createdAt))
    })
  }
  return out
}

/* ---- per-product conversions (all pure) ---- */

function fromCorpusEntry(entry, categories) {
  entry = entry && typeof entry === 'object' ? entry : {}
  const cats = arr(categories)
  const cat = cats.find(function (c) {
    return c && c.id === entry.categoryId
  })
  return create({
    source: 'corpus',
    kind: 'sentence',
    content: entry.en,
    translation: entry.zh,
    note: entry.notes,
    tags: [cat && cat.name, entry.type].filter(Boolean).concat(arr(entry.tags)),
    ref: entry.source,
    color: entry.favorite ? '#e3a400' : '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  })
}

function toCorpusEntry(card, categoryId) {
  const c = create(card)
  return {
    id: c.id,
    type: c.kind === 'word' ? 'collocation' : 'sentence',
    categoryId: str(categoryId) || 'zen-card',
    en: c.content,
    zh: c.translation,
    tags: c.tags,
    source: c.ref,
    notes: c.note,
    favorite: false,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

function fromAnnotateMark(mark, doc) {
  mark = mark && typeof mark === 'object' ? mark : {}
  const text = doc && typeof doc.text === 'string' ? doc.text : ''
  const start = Number(mark.start) || 0
  const end = Number(mark.end) || start
  return create({
    source: 'annotate',
    kind: 'quote',
    content: str(mark.quote) || text.slice(start, end),
    note: str(mark.note !== undefined ? mark.note : mark.memo),
    ref: doc && doc.title ? str(doc.title) : '',
    tags: arr(mark.tags),
    color: str(mark.color),
  })
}

function toAnnotateMark(card, docId) {
  const c = create(card)
  return {
    id: c.id,
    doc: str(docId),
    start: 0,
    end: c.content.length,
    quote: c.content,
    sty: c.note ? 'note' : 'hl',
    note: c.note,
    ts: str(c.createdAt).slice(0, 16).replace('T', ' '),
  }
}

function fromEnglishBridge(item) {
  if (!item || typeof item !== 'object') return null
  if (item.t === 'word') {
    return create({
      source: 'english',
      kind: 'word',
      content: item.w,
      translation: item.m,
      note: item.note,
      ref: item.src,
      tags: [].concat(arr(item.tags), ['word']),
    })
  }
  if (item.t === 'sentence') {
    return create({
      source: 'english',
      kind: 'sentence',
      content: item.en,
      translation: item.zh,
      tags: ['sentence'],
    })
  }
  if (item.t === 'doc') {
    return create({
      source: 'english',
      kind: 'note',
      content: item.text,
      ref: item.title,
      tags: ['doc'],
    })
  }
  return null
}

function toEnglishBridge(card) {
  const c = create(card)
  if (c.kind === 'word') {
    return { t: 'word', w: c.content, m: c.translation, note: c.note, tags: c.tags, src: c.ref }
  }
  if (c.kind === 'sentence' || c.kind === 'quote') {
    return { t: 'sentence', en: c.content, zh: c.translation }
  }
  return { t: 'doc', title: c.ref || c.id, text: c.content }
}

function toWriterNode(card, index) {
  const c = create(card)
  const n = Number(index) || 1
  const parts = ['<p>' + escapeHtml(c.content) + '</p>']
  if (c.translation) parts.push('<p><em>' + escapeHtml(c.translation) + '</em></p>')
  if (c.note) parts.push('<blockquote>' + escapeHtml(c.note) + '</blockquote>')
  const tagLine = c.tags.length ? '<p><small>#' + c.tags.map(escapeHtml).join(' #') + '</small></p>' : ''
  return {
    id: 'node-' + n,
    type: 'text',
    x: -360 + ((n - 1) % 3) * 380,
    y: -200 + Math.floor((n - 1) / 3) * 260,
    w: '320px',
    title: str(c.ref) || c.kind,
    content: parts.join('') + tagLine,
  }
}

function toWriterCanvas(cards, name) {
  const list = arr(cards).map(create)
  return {
    format: 'zenwriter-canvas',
    v: 2,
    name: str(name) || '知识卡片',
    // Array#map passes a 0-based index; toWriterNode expects 1-based positions,
    // so offset it or the first two cards collide on id/position.
    nodes: list.map(function (c, i) { return toWriterNode(c, i + 1) }),
    connections: [],
  }
}

function toDataRow(card) {
  const c = create(card)
  return {
    id: c.id,
    kind: c.kind,
    source: c.source,
    content: c.content,
    translation: c.translation,
    note: c.note,
    tags: c.tags.join('|'),
    ref: c.ref,
    createdAt: c.createdAt,
  }
}

function fromDataRow(row, source) {
  row = row && typeof row === 'object' ? row : {}
  return create({
    source: source || 'data',
    kind: row.kind,
    content: row.content !== undefined ? row.content : row.text,
    translation: row.translation,
    note: row.note,
    tags: typeof row.tags === 'string' ? row.tags.split('|') : row.tags,
    ref: row.ref,
    createdAt: row.createdAt,
  })
}

function fromSearchResult(result) {
  const r = result && typeof result === 'object' ? result : { title: str(result) }
  return create({
    source: 'search',
    kind: 'fact',
    content: str(r.answer || r.content || r.summary || r.title),
    note: str(r.note),
    ref: str(r.url || r.href || r.source),
    tags: arr(r.tags).concat(['搜索']),
  })
}

function toMarkdown(card) {
  const c = create(card)
  const lines = ['> ' + c.content.split('\n').join('\n> ')]
  if (c.translation) lines.push('', c.translation)
  if (c.note) lines.push('', '**批注**：' + c.note)
  const meta = ['来源：' + c.source]
  if (c.ref) meta.push('出处：' + c.ref)
  if (c.tags.length) meta.push('标签：' + c.tags.map(function (t) { return '#' + t }).join(' '))
  lines.push('', '<small>' + meta.join(' · ') + '</small>')
  return lines.join('\n')
}

function fromWebSelection(sel, opts) {
  const o = opts || {}
  const text = stripHtml(sel && (sel.text !== undefined ? sel.text : sel))
  return create({
    source: o.source || 'clip',
    kind: o.kind || 'quote',
    content: text,
    ref: str(o.url || (sel && sel.url)),
    note: str(o.note),
    tags: arr(o.tags),
  })
}

export const ZenCard = {
  FORMAT,
  VERSION,
  KINDS,
  SOURCES,
  create,
  validate,
  parse,
  serialize,
  serializePack,
  parsePack,
  fingerprint,
  merge,
  fromCorpusEntry,
  toCorpusEntry,
  fromAnnotateMark,
  toAnnotateMark,
  fromEnglishBridge,
  toEnglishBridge,
  toWriterNode,
  toWriterCanvas,
  toDataRow,
  fromDataRow,
  fromSearchResult,
  toMarkdown,
  fromWebSelection,
  escapeHtml,
  stripHtml,
}

if (typeof globalThis !== 'undefined') globalThis.ZenCard = ZenCard

export default ZenCard
