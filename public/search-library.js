/* search-library.js — 把智能搜索的历史沉淀成可检索的知识库
 * 纯函数、无 DOM；依赖同目录的 zen-card.js。同时挂 globalThis.SearchLibrary。
 */
import { ZenCard } from './zen-card.js'

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}
function arr(v) {
  return Array.isArray(v) ? v : []
}

/* 历史条目 -> zen-card：正文放摘要，问题放批注，首个来源放入处。 */
function toCard(entry, opts) {
  const e = entry && typeof entry === 'object' ? entry : {}
  const o = opts || {}
  const sources = arr(e.sources)
  const tags = []
    .concat(arr(e.tags), arr(o.tags), ['搜索'])
    .filter((t, i, a) => str(t).trim() && a.indexOf(t) === i)
    .map((t) => str(t).trim())
  return ZenCard.create({
    source: 'search',
    kind: 'fact',
    content: str(e.answer) || str(e.query),
    note: str(e.query),
    ref: sources.length ? str(sources[0].url || sources[0].link || '') : '',
    tags,
    color: e.pinned ? '#e3a400' : '',
    createdAt: e.ts ? new Date(e.ts).toISOString() : undefined,
  })
}

/* zen-card -> 历史条目（用于从卡片包导入）。 */
function fromCard(card) {
  const c = ZenCard.create(card)
  return {
    query: c.note || c.content,
    answer: c.note ? c.content : '',
    sources: c.ref ? [{ url: c.ref, title: c.ref }] : [],
    queries: [],
    ts: Date.parse(c.createdAt) || Date.now(),
    tags: c.tags.filter((t) => t !== '搜索'),
    pinned: c.color === '#e3a400',
  }
}

function filter(entries, query, opts) {
  const q = str(query).trim().toLowerCase()
  const o = opts || {}
  let list = arr(entries)
  if (o.onlyPinned) list = list.filter((e) => !!e.pinned)
  if (!q) return list
  return list.filter((e) => {
    const hay = [
      str(e.query), str(e.answer),
      arr(e.sources).map((s) => str(s.title) + ' ' + str(s.url) + ' ' + str(s.snippet)).join(' '),
      arr(e.tags).join(' '),
    ].join('\n').toLowerCase()
    return hay.indexOf(q) >= 0
  })
}

function dedupe(entries) {
  const seen = Object.create(null)
  return arr(entries).filter((e) => {
    const key = str(e && e.query).trim().toLowerCase()
    if (!key || seen[key]) return false
    seen[key] = 1
    return true
  })
}

function pack(entries, name) {
  return ZenCard.serializePack(arr(entries).map((e) => toCard(e)), { name: str(name) || '搜索知识库' }, true)
}

function unpack(text) {
  const pack = ZenCard.parsePack(text)
  return dedupe(pack.cards.map(fromCard))
}

function stats(entries) {
  const list = arr(entries)
  const sources = list.reduce((n, e) => n + arr(e.sources).length, 0)
  const tags = Object.create(null)
  list.forEach((e) => arr(e.tags).forEach((t) => { tags[t] = (tags[t] || 0) + 1 }))
  return {
    total: list.length,
    sources: sources,
    pinned: list.filter((e) => !!e.pinned).length,
    tags: Object.keys(tags).map((tag) => ({ tag, count: tags[tag] })).sort((a, b) => b.count - a.count),
  }
}

export const SearchLibrary = { toCard, fromCard, filter, dedupe, pack, unpack, stats }
if (typeof globalThis !== 'undefined') globalThis.SearchLibrary = SearchLibrary
export default SearchLibrary
