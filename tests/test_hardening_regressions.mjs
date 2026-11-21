/* 第二轮缺陷猎捕的回归测试（node:test）
 * 覆盖模块级边界输入、合并校验和、时间区间、postMessage 目标与产品页内联逻辑。
 * 运行：node --test tests/test_hardening_regressions.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ZenBackup } from '../public/lib/zen-backup.js'
import { ZenReview } from '../public/lib/zen-review.js'
import { ZenCard } from '../public/lib/zen-card.js'
import { ZenFlow } from '../public/lib/zen-flow.js'
import { ZenChart } from '../public/lib/zen-chart.js'
import { SearchLibrary } from '../public/lib/search-library.js'
import '../public/zen-canvas/layout-engine.js'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8')

/* ------------------------------ zen-backup ------------------------------ */

test('合并对象型产品数据不再清空，并重算校验和', () => {
  const current = { products: [{ id: 'zen.theme', data: { theme: 'dark' }, checksum: 'x' }] }
  const incoming = { products: [{ id: 'zen.theme', data: { theme: 'light' }, checksum: 'y' }] }
  const merged = ZenBackup.merge(current, incoming)
  assert.deepEqual(merged.products[0].data, { theme: 'dark' })
  assert.equal(ZenBackup.validate(merged).ok, true)
})

test('数组型数据合并后校验和必须对应新数据', () => {
  const current = { products: [{ id: 'p', data: [{ id: '1' }], checksum: 'bad' }] }
  const incoming = { products: [{ id: 'p', data: [{ id: '2' }], checksum: 'bad' }] }
  const merged = ZenBackup.merge(current, incoming)
  assert.equal(merged.products[0].checksum, ZenBackup.checksum(merged.products[0].data))
  assert.equal(ZenBackup.validate(merged).ok, true)
})

/* ------------------------------- zen-review ----------------------------- */

test('数字 epoch 形式的区间边界不会丢弃全部事件', () => {
  const data = { timeline: [{ ts: 1767225600000 }, { ts: '2026-01-15T10:00:00Z' }] }
  assert.equal(ZenReview.summarize(data, { from: 1767225600000, to: 1769904000000 }).events, 2)
  assert.equal(ZenReview.summarize(data, { from: '2026-01-01', to: '2026-02-01' }).events, 2)
})

/* -------------------------------- zen-card ------------------------------ */

test('数字时间戳不再被 normDate 替换为当前时间', () => {
  assert.equal(ZenCard.create({ content: 'x', createdAt: 1767225600000 }).createdAt,
    '2026-01-01T00:00:00.000Z')
  assert.equal(ZenCard.create({ content: 'x', createdAt: '1767225600000' }).createdAt,
    '2026-01-01T00:00:00.000Z')
})

test('各转换器对 null 输入容错而不是抛异常', () => {
  assert.equal(ZenCard.fromDataRow(null).content, '')
  assert.equal(ZenCard.fromCorpusEntry(null).content, '')
  assert.equal(ZenCard.fromAnnotateMark(null).content, '')
})

/* -------------------------------- zen-flow ------------------------------ */

test('validateRule / applyActions 遇到 null action 返回校验失败或跳过', () => {
  const result = ZenFlow.validateRule({ name: 'x', actions: [null] })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /actions\[0\]/)
  assert.equal(ZenFlow.applyActions({ actions: [null] }, { id: '1' }).effects.length, 0)
})

/* -------------------------------- zen-chart ----------------------------- */

test('normalize 数组元素含 null 不崩溃', () => {
  const d = ZenChart.normalize([null, { label: 'a', value: 1 }])
  assert.deepEqual(d.labels, ['', 'a'])
  assert.deepEqual(d.series[0].values, [0, 1])
})

test('renderSVG 容忍非数组的 series.values', () => {
  assert.match(ZenChart.renderSVG({ labels: ['a'], series: [null, { values: '12' }] }), /^<svg/)
})

test('parseCSV 支持引号内的逗号与双写引号', () => {
  const d = ZenChart.parseCSV('Name,Value\n"a,b",3\n"say ""hi""",4')
  assert.deepEqual(d.labels, ['a,b', 'say "hi"'])
  assert.deepEqual(d.series[0].values, [3, 4])
})

/* ----------------------------- search-library --------------------------- */

test('toCard 容忍 null 来源并正确读取字符串来源', () => {
  assert.doesNotThrow(() => SearchLibrary.toCard({ answer: 'x', sources: [null] }))
  assert.equal(SearchLibrary.toCard({ answer: 'x', sources: ['http://a'] }).ref, 'http://a')
})

/* --------------------------- zen-canvas-layout -------------------------- */

test('导出的 computeRadialOrTimeline 允许省略 opt', () => {
  assert.doesNotThrow(() =>
    globalThis.ZenCanvasLayout.computeRadialOrTimeline([{ id: 'a', w: 100, h: 100 }], [], 'radial'))
})

/* ------------------------- 原型键与 manifest 转义 ------------------------ */

test('ZenChart 调色板不接受 __proto__ 等原型键', () => {
  const svg = ZenChart.renderSVG({ kind: 'bar', palette: '__proto__', labels: ['a'], series: [{ values: [1] }] })
  assert.match(svg, /^<svg/)
  assert.doesNotMatch(svg, /fill="undefined"/)
})

test('Hub 数据流面板转义插件 manifest 的 role / id', () => {
  const src = read('public/omm-hub.js')
  const at = src.indexOf("class=\"flow-chip '")
  const block = src.slice(at, at + 260)
  assert.match(block, /kgEscape\(a\.role\)/)
  assert.match(block, /kgEscape\(a\.id\)/)
})

/* ------------------------- postMessage 目标约束 -------------------------- */

test('卡片请求按已校验的请求方 origin 回传，而非 referrer', () => {
  const src = read('public/lib/zen-link.js')
  const reply = src.slice(src.indexOf("type: 'omm:zen-card-reply'"))
  assert.match(reply.slice(0, 200), /e\.origin/)
  assert.doesNotMatch(reply.slice(0, 200), /parentTarget\(\)/)
})

test('桥接脚本不再把 referrer / 通配符当作 postMessage 目标', () => {
  assert.doesNotMatch(read('public/viz-bridge.js'), /document\.referrer\)\.origin/)
  for (const rel of ['public/omm-share.js', 'public/omm-embed.js', 'public/omm-desktop.js']) {
    assert.doesNotMatch(read(rel), /\|\| '\*'/)
  }
})

test('VizBridge.onData 的退订同时移除 OMMShare 处理器', () => {
  const src = read('public/viz-bridge.js')
  assert.match(src, /offArtifact = window\.OMMShare\.onArtifact/)
  assert.match(src, /if \(offArtifact\) offArtifact\(\)/)
})

/* --------------------------- 产品页内联逻辑 ------------------------------ */

test('AI 实时数据超时比较与最终保存的 resolver 是同一引用', () => {
  const src = read('public/omm-ai.html')
  assert.match(src, /S\.liveResolve === wrapped/)
  assert.doesNotMatch(src, /S\.liveResolve === resolve/)
})

test('ZenReview 导出只追加新报告卡片，不写回剪藏并集', () => {
  const src = read('public/omm-zenreview.html')
  const at = src.indexOf("$('tocards-btn').addEventListener")
  assert.ok(at >= 0, 'tocards 事件处理器未找到')
  const block = src.slice(at, at + 700)
  assert.doesNotMatch(block, /cards\(\)\.concat/)
  assert.match(block, /localStorage\.getItem\('zen\.cards\.v1'\)/)
})

test('Hub 设置备份导出前清空 WebDAV 密码', () => {
  const src = read('public/omm-hub.js')
  const block = src.slice(src.indexOf('function downloadBackup'), src.indexOf('function downloadBackup') + 700)
  assert.match(block, /password: ''/)
  assert.doesNotMatch(block, /appearance: hubAppearance/)
})

test('Hub 今日面板参与 Esc 关闭与 closePopovers', () => {
  const src = read('public/omm-hub.js')
  assert.match(src, /else if \(todayOpen\)/)
  const pop = src.slice(src.indexOf('function closePopovers'), src.indexOf('function closePopovers') + 500)
  assert.match(pop, /if \(todayOpen\) closeToday\(\)/)
})

test('Data 的 SQL 词法器支持负数，文本编码不再被数值强转', () => {
  const src = read('public/omm-data.html')
  const at = src.indexOf('function tokenize')
  assert.ok(at >= 0, 'SQL 词法器未找到')
  const block = src.slice(at, at + 4000)
  assert.ok(block.includes("ch === '-' && ("), '负号分支缺失')
  const cmp = src.slice(src.indexOf('function cmpVals'), src.indexOf('function cmpVals') + 400)
  assert.ok(cmp.includes('isNumericValue(a)') && cmp.includes('isNumericValue(b)'),
    '比较函数未改用规范数字判定')
})
