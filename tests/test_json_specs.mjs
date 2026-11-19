/* JSON 规范一致性专项测试（node:test）
 * 不只检查文档：直接调用各产品导出函数，验证产物确实符合 json-specs 的硬性要求。
 * 运行：node tests/test_json_specs.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ZenCard } from '../public/zen-card.js'
import { ZenBackup } from '../public/zen-backup.js'
import { ZenPack } from '../public/zen-pack.js'
import { ZenSRS } from '../public/zen-srs.js'
import { ZenFlow } from '../public/zen-flow.js'

test('ZenCard.create 产出 zen-card v1 且通过自身校验', () => {
  const c = ZenCard.create({ content: '规范卡片', tags: ['a', 'a', ' b '] })
  assert.equal(c.format, 'zen-card')
  assert.equal(c.v, 1)
  assert.ok(c.id)
  assert.deepEqual(c.tags, ['a', 'b'])
  assert.equal(ZenCard.validate(c).ok, true)
})

test('卡片包顶层满足 format/v/cards[]（zencard.md 硬性要求）', () => {
  const card = ZenCard.create({ content: 'x' })
  const pack = JSON.parse(ZenCard.serializePack([card], { name: '包' }, true))
  assert.equal(pack.format, 'zen-card-pack')
  assert.equal(pack.v, 1)
  assert.ok(Array.isArray(pack.cards))
  assert.equal(pack.cards.length, 1)
  assert.equal(pack.cards[0].format, 'zen-card')
})

test('ZenCard.toWriterCanvas 满足 writer.md 的 nodes 数组要求', () => {
  const canvas = ZenCard.toWriterCanvas([ZenCard.create({ content: 'x' })], '画布')
  assert.equal(canvas.format, 'zenwriter-canvas')
  assert.ok(Array.isArray(canvas.nodes))
  assert.ok(Array.isArray(canvas.connections))
})

test('ZenBackup.collect 满足 zenpack.md 的 format/v/products[] 要求', () => {
  const manifest = ZenBackup.collect([{ id: 'zen.cards.v1', data: [] }], { name: '包' })
  assert.equal(manifest.format, 'zen-backup')
  assert.equal(manifest.v, 1)
  assert.ok(Array.isArray(manifest.products))
  assert.equal(manifest.products[0].id, 'zen.cards.v1')
  assert.equal(ZenBackup.validate(manifest).ok, true)
})

test('ZenPack 工作区包与 ZenBackup 是同一格式，未另立规范', () => {
  const storage = {
    getItem: (k) => (k === 'zen.cards.v1' ? '[{"id":"c"}]' : null),
  }
  const pack = ZenPack.makePack(storage, { name: '工作区' })
  assert.equal(pack.format, 'zen-backup')
  assert.equal(pack.v, 1)
  assert.equal(ZenPack.readPack(JSON.stringify(pack)).format, 'zen-backup')
})

test('SRS 与规则序列化各自带 format/v，字段可被还原', () => {
  const srs = JSON.parse(ZenSRS.serialize([ZenSRS.createState('c1')]))
  assert.equal(srs.format, 'zen-srs')
  assert.equal(srs.v, 1)
  assert.ok(Array.isArray(srs.states))

  const rule = ZenFlow.createRule({ name: '规则', actions: [{ type: 'notify' }] })
  const flow = JSON.parse(ZenFlow.serialize([rule]))
  assert.equal(flow.format, 'zen-flow')
  assert.equal(flow.v, 1)
  assert.ok(Array.isArray(flow.rules))
  assert.equal(ZenFlow.validateRule(flow.rules[0]).ok, true)
})

test('所有格式的 format 值都是 ASCII 双引号可描述的固定字符串', () => {
  for (const name of ['zen-card', 'zen-card-pack', 'zen-backup', 'zen-srs', 'zen-flow']) {
    assert.match(name, /^[a-z][a-z0-9-]*$/)
  }
})
