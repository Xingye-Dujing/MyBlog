/* lib/zen-backup.js 单元测试 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ZenBackup } from '../public/lib/zen-backup.js'

const products = [
  { id: 'writer', name: '所思所想', data: [{ id: 'n1', content: 'a' }] },
  { id: 'corpus', name: '语料库', data: [{ id: 'e1', en: 'hello' }] },
]

test('collect 生成带校验和的清单', () => {
  const m = ZenBackup.collect(products, { name: '测试备份' })
  assert.equal(m.format, 'zen-backup')
  assert.equal(m.v, 1)
  assert.equal(m.name, '测试备份')
  assert.equal(m.products.length, 2)
  assert.equal(m.products[0].checksum, ZenBackup.checksum(products[0].data))
})

test('validate 检查格式/版本/校验和', () => {
  const m = ZenBackup.collect(products)
  assert.equal(ZenBackup.validate(m).ok, true)
  const bad = JSON.parse(JSON.stringify(m))
  bad.v = 2
  bad.products[0].checksum = 'wrong'
  const r = ZenBackup.validate(bad)
  assert.equal(r.ok, false)
  assert.ok(r.errors.length >= 2)
})

test('byId 按产品 id 建索引', () => {
  const m = ZenBackup.collect(products)
  assert.equal(ZenBackup.byId(m).writer.data[0].id, 'n1')
})

test('uniqueBy 按 id 去重', () => {
  const rows = [{ id: 'a' }, { id: 'a' }, { id: 'b' }, { noId: 1 }]
  assert.equal(ZenBackup.uniqueBy(rows).length, 3)
})

test('diff 找出新增/删除/变更', () => {
  const current = ZenBackup.collect([{ id: 'a', data: [{ id: '1', x: 1 }] }, { id: 'b', data: [] }])
  const incoming = ZenBackup.collect([{ id: 'a', data: [{ id: '1', x: 2 }] }, { id: 'c', data: [] }])
  const d = ZenBackup.diff(current, incoming)
  assert.deepEqual(d.added, ['c'])
  assert.deepEqual(d.removed, ['b'])
  assert.deepEqual(d.changed, ['a'])
})

test('merge 默认按 id 去重追加', () => {
  const current = ZenBackup.collect([{ id: 'writer', data: [{ id: 'a' }] }])
  const incoming = ZenBackup.collect([{ id: 'writer', data: [{ id: 'b' }, { id: 'a' }] }])
  const merged = ZenBackup.merge(current, incoming)
  const rows = ZenBackup.byId(merged).writer.data
  assert.equal(rows.length, 2)
})

test('merge 策略 incoming/current', () => {
  const current = ZenBackup.collect([{ id: 'writer', name: '旧', data: [{ id: 'a' }] }])
  const incoming = ZenBackup.collect([{ id: 'writer', name: '新', data: [{ id: 'b' }] }])
  assert.equal(ZenBackup.byId(ZenBackup.merge(current, incoming, { strategy: 'incoming' })).writer.name, '新')
  assert.equal(ZenBackup.byId(ZenBackup.merge(current, incoming, { strategy: 'current' })).writer.name, '旧')
})
