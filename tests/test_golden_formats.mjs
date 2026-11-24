/* Golden 样本对拍（node:test）
 * tests/golden_formats/ 下的每份样例必须同时通过产品 JS 导出与 AI 工作区的
 * Python 校验器（后者在 public/tests/test_golden_formats.py 中验证）。
 * 任何一侧改了格式规则而另一侧没跟上，这里就会失败。
 * 运行：node --test tests/test_golden_formats.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { ZenCard } from '../public/lib/zen-card.js'
import { ZenBackup } from '../public/lib/zen-backup.js'
import { ZenFlow } from '../public/lib/zen-flow.js'

const DIR = new URL('./golden_formats/', import.meta.url)
const read = (name) => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'))

test('Golden 卡片被产品 JS 校验器接受', () => {
  const result = ZenCard.validate(read('zencard-card.json'))
  assert.deepEqual(result, { ok: true, errors: [] })
})

test('Golden 卡片包被产品 JS 校验器接受', () => {
  const pack = read('zencard-pack.json')
  assert.equal(pack.format, 'zen-card-pack')
  assert.equal(pack.v, 1)
  for (const card of pack.cards) {
    assert.equal(ZenCard.validate(card).ok, true)
  }
  assert.equal(ZenCard.parsePack(JSON.stringify(pack)).cards.length, 1)
})

test('Golden 备份清单通过校验和与结构校验', () => {
  const manifest = read('zenbackup-manifest.json')
  assert.deepEqual(ZenBackup.validate(manifest), { ok: true, errors: [] })
})

test('Golden 规则通过 ZenFlow 校验', () => {
  const pack = read('zenflow-rules.json')
  for (const rule of pack.rules) {
    assert.deepEqual(ZenFlow.validateRule(rule), { ok: true, errors: [] })
  }
  assert.equal(ZenFlow.deserialize(JSON.stringify(pack)).length, 1)
})

test('Golden 样本确实被强制：篡改格式会被 JS 拒绝', () => {
  const card = read('zencard-card.json')
  assert.equal(ZenCard.validate({ ...card, format: 'zen-card-OLD' }).ok, false)

  const manifest = read('zenbackup-manifest.json')
  const tampered = { ...manifest, products: [{ ...manifest.products[0], checksum: 'deadbeef' }] }
  assert.equal(ZenBackup.validate(tampered).ok, false)

  const rules = read('zenflow-rules.json')
  assert.equal(ZenFlow.validateRule({ ...rules.rules[0], actions: [] }).ok, false)
  assert.throws(() => ZenFlow.deserialize(JSON.stringify(rules.rules)), /非法 zen-flow/)
  assert.throws(() => ZenFlow.deserialize(JSON.stringify({ ...rules, v: 2 })), /非法 zen-flow/)
})

test('Golden 样例文件与 Python 对拍测试同在', () => {
  const pythonTest = new URL('../public/tests/test_golden_formats.py', import.meta.url)
  assert.ok(readFileSync(pythonTest, 'utf8').includes('golden_formats'))
})
