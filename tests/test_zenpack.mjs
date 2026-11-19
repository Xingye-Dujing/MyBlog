/* ZenPack 工作区包专项测试（node:test）
 * 验证薄包装确实委托 ZenBackup，且工作区键收集 / 恢复往返正确。
 * 运行：node tests/test_zenpack.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ZenPack } from '../public/zen-pack.js'
import { ZenBackup } from '../public/zen-backup.js'

const HTML = readFileSync(new URL('../public/omm-zenbackup.html', import.meta.url), 'utf8')

function storage(seed) {
  const map = new Map(Object.entries(seed || {}))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    _map: map,
  }
}

test('工作区键目录覆盖卡片/规则/笔记/设置', () => {
  for (const key of ['zen.cards.v1', 'zen.flow.rules.v1', 'zc-docs', 'omm-search-v1', 'zen.theme']) {
    assert.ok(ZenPack.WORKSPACE_KEYS.includes(key), key)
  }
})

test('scanWorkspace 解析 JSON 并保留原始字符串', () => {
  const s = storage({
    'zen.cards.v1': '[{"id":"a"}]',
    'zen.theme': 'dark',
    'missing.key': null,
  })
  const rows = ZenPack.scanWorkspace(s, ['zen.cards.v1', 'zen.theme', 'missing.key'])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].data, [{ id: 'a' }])
  assert.equal(rows[1].data, 'dark')
})

test('makePack 产出通过 ZenBackup.validate 的清单', () => {
  const s = storage({ 'zen.cards.v1': '[{"id":"a"}]', 'zc-docs': '{"v":1}' })
  const pack = ZenPack.makePack(s)
  assert.equal(pack.format, 'zen-backup')
  assert.equal(pack.v, 1)
  assert.equal(pack.products.length, 2)
  assert.deepEqual(ZenBackup.validate(pack), { ok: true, errors: [] })
})

test('readPack 校验并在损坏时抛错', () => {
  const s = storage({ 'zen.cards.v1': '[]' })
  const text = JSON.stringify(ZenPack.makePack(s))
  assert.equal(ZenPack.readPack(text).format, 'zen-backup')
  assert.throws(() => ZenPack.readPack('{"format":"wrong"}'))
})

test('planPack 的差异与合并都委托 ZenBackup', () => {
  const a = ZenBackup.collect([{ id: 'x', data: [{ id: 1 }] }], {})
  const b = ZenBackup.collect([{ id: 'x', data: [{ id: 1 }, { id: 2 }] }, { id: 'y', data: [] }], {})
  const plan = ZenPack.planPack(a, b)
  assert.deepEqual(plan.diff.added, ['y'])
  assert.deepEqual(plan.diff.changed, ['x'])
  assert.equal(plan.merged.products.length, 2)
  assert.equal(plan.merged.products.find((p) => p.id === 'x').data.length, 2)
})

test('恢复往返：导出包写入新存储后键与值一致', () => {
  const src = storage({ 'zen.cards.v1': '[{"id":"a"}]', 'zen.theme': 'dark' })
  const pack = ZenPack.makePack(src)
  const dst = storage({ 'old.key': '1' })
  const n = ZenPack.applyPack(pack, dst)
  assert.equal(n, 2)
  assert.equal(dst.getItem('zen.cards.v1'), '[{"id":"a"}]')
  assert.equal(dst.getItem('zen.theme'), 'dark')
})

test('ZenBackup 产品提供 ZenPack 入口并直接调用通用模块', () => {
  for (const id of ['zp-collect', 'zp-export', 'zp-file', 'zp-restore', 'zp-diff']) {
    assert.ok(HTML.includes('id="' + id + '"'), '缺少入口: ' + id)
  }
  assert.ok(HTML.includes("import { ZenPack } from './zen-pack.js'"))
  assert.ok(HTML.includes('ZenPack.makePack('))
  assert.ok(HTML.includes('ZenPack.readPack('))
  assert.ok(HTML.includes('ZenPack.applyPack('))
})

test('ZenPack 未重复实现备份核心函数', () => {
  const code = ZenPack.makePack.toString() + ZenPack.readPack.toString() + ZenPack.planPack.toString()
  assert.ok(code.includes('ZenBackup.'), '应委托 ZenBackup')
})

/* ------------------------------------------------- 导出脱敏与恢复键白名单 */

test('isSecretKey 按词识别字段与条目名', () => {
  for (const key of ['apiKey', 'api_key', 'accessToken', 'client_secret', 'password',
    'X-Supabase-Key', 'zenglish-supabase-config-v1']) {
    assert.equal(ZenBackup.isSecretKey(key), true, key)
  }
  for (const key of ['zen.cards.v1', 'omm-search-v1', 'apiBase', 'title', 'content']) {
    assert.equal(ZenBackup.isSecretKey(key), false, key)
  }
})

test('redactSecrets 遮罩敏感字段、丢弃凭据条目并重算校验和', () => {
  const raw = ZenBackup.collect([
    { id: 'omm-search-v1', data: { apiKey: 'sk-123', apiBase: 'https://x', headers: { Authorization: 'Bearer y' } } },
    { id: 'zenglish-supabase-config-v1', data: { url: 'https://x', key: 'abc' } },
    { id: 'zen.cards.v1', data: [{ id: 'a', content: 'ok' }] },
  ])
  const safe = ZenBackup.redactSecrets(raw)
  assert.deepEqual(safe.products.map((p) => p.id), ['omm-search-v1', 'zen.cards.v1'])
  assert.equal(safe.products[0].data.apiKey, '***REDACTED***')
  assert.equal(safe.products[0].data.headers.Authorization, '***REDACTED***')
  assert.equal(safe.products[0].data.apiBase, 'https://x')
  assert.deepEqual(ZenBackup.validate(safe), { ok: true, errors: [] })
  assert.equal(raw.products[0].data.apiKey, 'sk-123') // 不改动原对象
})

test('makePack 导出即脱敏，不带走密钥', () => {
  const s = storage({
    'omm-search-v1': JSON.stringify({ apiKey: 'sk-secret', query: 'hello' }),
    'zenglish-supabase-config-v1': JSON.stringify({ key: 'abc' }),
    'zen.cards.v1': '[]',
  })
  const pack = ZenPack.makePack(s)
  assert.deepEqual(pack.products.map((p) => p.id).sort(), ['omm-search-v1', 'zen.cards.v1'])
  const search = pack.products.find((p) => p.id === 'omm-search-v1')
  assert.equal(search.data.apiKey, '***REDACTED***')
  assert.equal(search.data.query, 'hello')
  assert.ok(!JSON.stringify(pack).includes('sk-secret'))
})

test('restorableEntries 拒绝任意键、特殊键与凭据键', () => {
  const manifest = ZenBackup.collect([
    { id: 'zen.cards.v1', data: [] },
    { id: '__proto__', data: { polluted: true } },
    { id: 'admin', data: 'x' },
    { id: 'zenglish-supabase-config-v1', data: { key: 'abc' } },
    { id: 'my-notes', data: [] },
  ])
  const entries = ZenBackup.restorableEntries(manifest, ['my-notes'])
  assert.deepEqual(entries.map((e) => e.key), ['zen.cards.v1', 'my-notes'])
})

test('applyPack 只写工作区白名单内的键', () => {
  const manifest = ZenBackup.collect([
    { id: 'zen.cards.v1', data: '[]' },
    { id: '__proto__', data: '{}' },
    { id: 'admin', data: 'x' },
  ])
  const dst = storage({})
  ZenPack.applyPack(manifest, dst)
  assert.deepEqual([...dst._map.keys()], ['zen.cards.v1'])
})

test('ZenBackup 页面导出前脱敏、恢复时过滤', () => {
  const html = readFileSync(new URL('../public/omm-zenbackup.html', import.meta.url), 'utf8')
  assert.ok(html.includes('ZenBackup.redactSecrets('))
  assert.ok(html.includes('ZenBackup.restorableEntries('))
  assert.ok(!html.includes('localStorage.setItem(p.id'))
})
