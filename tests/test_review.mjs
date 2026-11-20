/* zen-review.js 单元测试 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ZenReview } from '../public/zen-review.js'

const data = {
  timeline: [
    { app: 'writer', ts: '2026-01-01T09:00:00.000Z' },
    { app: 'corpus', ts: '2026-01-02T09:00:00.000Z' },
    { app: 'writer', ts: '2026-01-03T09:00:00.000Z' },
    { app: 'search', ts: '2025-12-30T09:00:00.000Z' },
  ],
  planner: [
    { title: '写周报', done: true },
    { title: '未完', done: false },
  ],
  cards: [
    { createdAt: '2026-01-01T00:00:00.000Z', tags: ['精读', 'AI'] },
    { createdAt: '2026-01-02T00:00:00.000Z', tags: ['精读'] },
  ],
}

test('dateKey 支持日期前缀与 ISO', () => {
  assert.equal(ZenReview.dateKey('2026-01-01T09:00:00Z'), '2026-01-01')
  assert.equal(ZenReview.dateKey('2026-01-01'), '2026-01-01')
  assert.equal(ZenReview.dateKey('bad'), '')
})

test('inRange 按日期区间过滤', () => {
  assert.equal(ZenReview.inRange('2026-01-02', { from: '2026-01-01', to: '2026-01-03' }), true)
  assert.equal(ZenReview.inRange('2025-12-31', { from: '2026-01-01' }), false)
  assert.equal(ZenReview.inRange('2026-01-02', null), true)
})

test('summarize 统计活跃度/标签/完成项', () => {
  const s = ZenReview.summarize(data)
  assert.equal(s.events, 4)
  assert.equal(s.cards, 2)
  assert.equal(s.done, 1)
  assert.equal(s.activeDays, 4)
  assert.equal(s.byApp.writer, 2)
  assert.equal(s.topTags[0].tag, '精读')
  assert.equal(s.topTags[0].count, 2)
})

test('summarize 支持区间过滤', () => {
  const s = ZenReview.summarize(data, { from: '2026-01-01', to: '2026-01-02' })
  assert.equal(s.events, 2)
  assert.equal(s.cards, 2)
})

test('dateKey 支持数字时间戳（epoch 毫秒）与纯数字字符串', () => {
  const ts = Date.parse('2026-01-02T00:00:00.000Z')
  assert.equal(ZenReview.dateKey(ts), '2026-01-02')
  assert.equal(ZenReview.dateKey(String(ts)), '2026-01-02')
  assert.equal(ZenReview.summarize({ timeline: [{ app: 'writer', ts }] }).events, 1)
})

test('summarize 区间过滤同样作用于有日期的完成待办', () => {
  const s = ZenReview.summarize({
    planner: [
      { title: '范围内', done: true, day: '2026-01-02' },
      { title: '范围外', done: true, day: '2025-01-01' },
    ],
  }, { from: '2026-01-01', to: '2026-01-03' })
  assert.equal(s.done, 1)
  assert.equal(s.doneList[0].title, '范围内')
})

test('buildReport 生成包含统计与表格的 Markdown', () => {
  const md = ZenReview.buildReport(data, { title: '周报', notes: '下周继续', range: { from: '2026-01-01', to: '2026-01-03' } })
  assert.ok(md.startsWith('# 周报'))
  assert.ok(md.includes('周期：2026-01-01 至 2026-01-03'))
  assert.ok(md.includes('| writer | 2 |'))
  assert.ok(md.includes('#精读'))
  assert.ok(md.includes('- 写周报'))
  assert.ok(md.includes('下周继续'))
})
