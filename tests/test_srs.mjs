/* lib/zen-srs.js 单元测试 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ZenSRS } from '../public/lib/zen-srs.js'

const T = Date.UTC(2026, 0, 1, 0, 0, 0)

test('createState 初始值', () => {
  const s = ZenSRS.createState('zc-1', T)
  assert.deepEqual(s, { id: 'zc-1', reps: 0, ease: 2.5, interval: 0, due: T, lapses: 0, last: null })
})

test('fromCards 去重并按卡片 id 建状态', () => {
  const states = ZenSRS.fromCards([{ id: 'a' }, { id: 'a' }, { id: 'b' }], T)
  assert.deepEqual(states.map((s) => s.id), ['a', 'b'])
})

test('grade：good 首次 1 天、第二次 6 天、第三次按 ease', () => {
  let s = ZenSRS.createState('a', T)
  s = ZenSRS.grade(s, 'good', T)
  assert.equal(s.interval, 1)
  assert.equal(s.due, T + ZenSRS.DAY)
  s = ZenSRS.grade(s, 'good', T + ZenSRS.DAY)
  assert.equal(s.interval, 6)
  s = ZenSRS.grade(s, 'good', T + 7 * ZenSRS.DAY)
  assert.equal(s.interval, Math.round(6 * s.ease))
})

test('grade：again 重置重复次数并加 lapse', () => {
  let s = ZenSRS.createState('a', T)
  s = ZenSRS.grade(s, 'good', T)
  s = ZenSRS.grade(s, 'again', T + ZenSRS.DAY)
  assert.equal(s.reps, 0)
  assert.equal(s.interval, 0)
  assert.equal(s.lapses, 1)
  assert.ok(s.due > T)
})

test('grade：数字 quality 与枚举等价且被裁剪', () => {
  const a = ZenSRS.grade(ZenSRS.createState('a', T), 5, T)
  const b = ZenSRS.grade(ZenSRS.createState('a', T), 'easy', T)
  assert.equal(a.interval, b.interval)
  assert.equal(ZenSRS.toQuality(99), 5)
  assert.equal(ZenSRS.toQuality(-3), 0)
  assert.equal(ZenSRS.toQuality('unknown'), 4)
})

test('grade：ease 永不低于下限', () => {
  let s = ZenSRS.createState('a', T)
  for (let i = 0; i < 20; i++) s = ZenSRS.grade(s, 'again', T + i * 1000)
  assert.ok(s.ease >= 1.3)
})

test('update 只改指定卡片', () => {
  const states = [ZenSRS.createState('a', T), ZenSRS.createState('b', T)]
  const out = ZenSRS.update(states, 'b', 'good', T)
  assert.equal(out[0].reps, 0)
  assert.equal(out[1].reps, 1)
})

test('dueQueue 只返回到期卡片并按时间排序', () => {
  const a = { id: 'a', due: T - 100, reps: 0 }
  const b = { id: 'b', due: T + 100, reps: 0 }
  const c = { id: 'c', due: T - 200, reps: 0 }
  const q = ZenSRS.dueQueue([a, b, c], T)
  assert.deepEqual(q.map((s) => s.id), ['c', 'a'])
  assert.equal(ZenSRS.dueQueue([a, b, c], T, 1).length, 1)
})

test('stats 统计', () => {
  const states = [
    { id: 'a', reps: 3, ease: 2.5, lapses: 1, due: T - 1 },
    { id: 'b', reps: 0, ease: 2.0, lapses: 0, due: T + 100 },
  ]
  const s = ZenSRS.stats(states, T)
  assert.equal(s.total, 2)
  assert.equal(s.learned, 1)
  assert.equal(s.learning, 1)
  assert.equal(s.lapses, 1)
  assert.equal(s.due, 1)
  assert.equal(s.avgEase, 2.25)
})

test('serialize / deserialize 往返', () => {
  const states = [ZenSRS.createState('a', T), ZenSRS.grade(ZenSRS.createState('b', T), 'good', T)]
  const back = ZenSRS.deserialize(ZenSRS.serialize(states))
  assert.deepEqual(back, states)
  assert.throws(() => ZenSRS.deserialize('{"format":"bad"}'))
})
