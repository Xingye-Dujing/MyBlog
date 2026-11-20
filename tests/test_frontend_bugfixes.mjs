/* 前端逻辑边界回归测试（node:test）
 * 运行：node --test tests/test_frontend_bugfixes.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ZenChart } from '../public/zen-chart.js'
import { ZenBackup } from '../public/zen-backup.js'
import { ZenSRS } from '../public/zen-srs.js'
import { SearchLibrary } from '../public/search-library.js'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8')

/* ------------------------------- zen-chart ------------------------------- */

test('CSV 单元格中间的引号不会被当成字段包裹符', () => {
  const parsed = ZenChart.parseCSV('Product,Sales\nWidget 5",10\nGadget,20')
  assert.deepEqual(parsed.labels, ['Widget 5"', 'Gadget'])
  assert.deepEqual(parsed.series[0].values, [10, 20])
})

test('未闭合的引号按字面量保留，后续行不丢失', () => {
  const parsed = ZenChart.parseCSV('a,b\n"x,y\n1,2')
  assert.equal(parsed.labels.length, 2)
  assert.equal(parsed.labels[0], '"x')
  assert.deepEqual(parsed.series[0].values, [0, 2])
})

/* ------------------------------ zen-backup ------------------------------ */

test('缺失 checksum 的备份包不能通过校验', () => {
  const result = ZenBackup.validate({ format: 'zen-backup', v: 1, products: [{ id: 'k', data: { a: 1 } }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('checksum')))
})

test('合并时混合数组与对象不会丢弃对象数据', () => {
  const current = { products: [{ id: 'zen.settings', data: { theme: 'dark' }, checksum: 'x' }] }
  const incoming = { products: [{ id: 'zen.settings', data: [{ id: '1', v: 2 }], checksum: 'y' }] }
  const merged = ZenBackup.merge(current, incoming)
  assert.deepEqual(merged.products[0].data, { theme: 'dark' })
  assert.equal(ZenBackup.validate(merged).ok, true)
})

/* -------------------------------- zen-srs -------------------------------- */

test('数字 0 的卡片 id 不会被 SRS 丢弃', () => {
  const states = ZenSRS.fromCards([{ id: 0 }, { id: '1' }])
  assert.deepEqual(states.map((s) => s.id), ['0', '1'])
})

test('hard 评分用更新后的 ease 推导间隔', () => {
  const T = Date.UTC(2026, 0, 1)
  let s = ZenSRS.createState('a', T)
  s = ZenSRS.grade({ ...s, reps: 2, ease: 2.5, interval: 6 }, 'hard', T)
  assert.equal(s.ease, 2.36)
  assert.equal(s.interval, Math.round(6 * 2.36))
})

/* ---------------------------- search-library ---------------------------- */

test('epoch 0 的 createdAt 不会被改写成当前时间', () => {
  const entry = SearchLibrary.fromCard({ content: 'x', note: 'q', createdAt: 0 })
  assert.equal(entry.ts, 0)
})

/* --------------------------- 产品页内联逻辑 --------------------------- */

test('Data 的 WHERE 词法器支持科学计数法与带空格的一元负号', () => {
  const source = read('public/omm-data.html')
  const lexer = source.slice(source.indexOf('if (/[0-9]/.test(ch)'), source.indexOf("throw new Error('无法识别的字符"))
  assert.match(lexer, /\[eE\]/, '数字扫描应识别科学计数法')
  assert.ok(source.includes("'=<>(),.*+-'"), '运算符应包含 +/- 以支持一元符号')
  assert.match(source, /x\.v === '-' \|\| x\.v === '\+'/)
})

test('Hub live-data 在所有目标窗格回复后立即回传，不再固定 700ms', () => {
  const source = read('public/omm-hub.js')
  const segment = source.slice(source.indexOf('function respondLiveData('), source.indexOf('function dedupeGraphCards('))
  assert.ok(segment.includes('expected: 0, replied: 0'))
  assert.ok(segment.includes('waiter.replied >= waiter.expected') || source.includes('waiter.replied >= waiter.expected'))
  assert.ok(segment.includes("type: 'omm:live-data-reply'"))
})
