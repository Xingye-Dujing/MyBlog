/* search-library.js 单元测试 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchLibrary } from '../public/search-library.js'

const entries = [
  { query: '量子计算', answer: '量子计算利用叠加态。', sources: [{ url: 'https://a', title: 'A' }], tags: ['科技'], ts: '2026-01-01T00:00:00.000Z' },
  { query: '量子计算', answer: '重复项。', sources: [], ts: '2026-01-02T00:00:00.000Z' },
  { query: '六级备考', answer: '每天背单词。', sources: [{ url: 'https://b', title: 'B' }], tags: ['备考'], pinned: true, ts: '2026-01-03T00:00:00.000Z' },
]

test('toCard 把摘要/问题/来源放进卡片', () => {
  const c = SearchLibrary.toCard(entries[0])
  assert.equal(c.source, 'search')
  assert.equal(c.kind, 'fact')
  assert.equal(c.content, '量子计算利用叠加态。')
  assert.equal(c.note, '量子计算')
  assert.equal(c.ref, 'https://a')
  assert.ok(c.tags.includes('搜索'))
  assert.ok(c.tags.includes('科技'))
})

test('toCard 支持追加标签与置顶着色', () => {
  const c = SearchLibrary.toCard(entries[2], { tags: ['重点'] })
  assert.equal(c.color, '#e3a400')
  assert.ok(c.tags.includes('重点'))
})

test('fromCard 还原查询与来源', () => {
  const card = SearchLibrary.toCard(entries[0])
  const back = SearchLibrary.fromCard(card)
  assert.equal(back.query, '量子计算')
  assert.equal(back.answer, '量子计算利用叠加态。')
  assert.equal(back.sources[0].url, 'https://a')
})

test('filter 全文匹配 query/answer/source/tag，支持仅置顶', () => {
  assert.equal(SearchLibrary.filter(entries, '叠加态').length, 1)
  assert.equal(SearchLibrary.filter(entries, 'A').length, 1)
  assert.equal(SearchLibrary.filter(entries, '备考').length, 1)
  assert.equal(SearchLibrary.filter(entries, '', { onlyPinned: true }).length, 1)
  assert.equal(SearchLibrary.filter(entries, '不存在').length, 0)
})

test('dedupe 按问题去重', () => {
  assert.equal(SearchLibrary.dedupe(entries).length, 2)
})

test('pack / unpack 往返', () => {
  const text = SearchLibrary.pack(entries, '测试库')
  const back = SearchLibrary.unpack(text)
  assert.equal(back.length, 2)
  assert.equal(back[0].query, '量子计算')
  assert.ok(back.some((e) => e.pinned))
})

test('stats 统计来源、置顶与标签', () => {
  const s = SearchLibrary.stats(entries)
  assert.equal(s.total, 3)
  assert.equal(s.sources, 2)
  assert.equal(s.pinned, 1)
  assert.equal(s.tags[0].tag, '科技')
})
