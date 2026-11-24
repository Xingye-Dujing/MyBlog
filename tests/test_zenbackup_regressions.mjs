/* ZenBackup / ZenPack 安全与搬家回归测试。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ZenBackup } from '../public/lib/zen-backup.js'
import { ZenPack } from '../public/lib/zen-pack.js'

function storage(seed, failKeys) {
  const map = new Map(Object.entries(seed || {}))
  const failing = new Set(failKeys || [])
  return {
    get length() { return map.size },
    key(index) { return [...map.keys()][index] ?? null },
    getItem(key) { return map.has(key) ? map.get(key) : null },
    setItem(key, value) {
      if (failing.has(key)) throw new Error('quota exceeded')
      map.set(key, String(value))
    },
    removeItem(key) { map.delete(key) },
    _map: map,
  }
}

function hubWindow(reply, options) {
  const opts = options || {}
  const origin = opts.origin || 'http://127.0.0.1:8320'
  let listener = null
  const sent = []
  const parent = {
    postMessage(message, targetOrigin) {
      sent.push({ message, targetOrigin })
      const data = typeof reply === 'function' ? reply(message) : reply
      const emit = (eventOrigin, source) => listener?.({
        source: source || parent,
        origin: eventOrigin,
        data,
      })
      if (opts.spoofFirst) emit('https://evil.example')
      queueMicrotask(() => emit(origin))
    },
  }
  return {
    parent,
    location: {
      origin: 'http://127.0.0.1:8327',
      search: '?omm_embed=1&omm_hub_origin=' + encodeURIComponent(origin),
    },
    addEventListener(type, fn) { if (type === 'message') listener = fn },
    removeEventListener(type, fn) { if (type === 'message' && fn === listener) listener = null },
    setTimeout,
    clearTimeout,
    sent,
  }
}

test('跨 origin Hub 采集使用专用协议、精确父窗口与目标 origin', async () => {
  const manifest = ZenBackup.collect([{ id: 'zen.cards.v1', data: [{ id: 'a' }] }])
  const win = hubWindow((request) => ({
    type: 'omm:workspace-backup-reply', token: request.token, ok: true, manifest,
  }), { spoofFirst: true })
  const result = await ZenPack.requestHub('collect', null, { window: win, timeout: 1000 })
  const request = win.sent[0]
  assert.equal(request.message.type, 'omm:workspace-backup-request')
  assert.equal(request.message.action, 'collect')
  assert.match(request.message.token, /^zenbackup-/)
  assert.equal(request.targetOrigin, 'http://127.0.0.1:8320')
  assert.notEqual(request.targetOrigin, win.location.origin)
  assert.equal(result.manifest.products[0].id, 'zen.cards.v1')
})

test('Hub 恢复请求携带 manifest，且缺少明确 Hub origin 时拒绝回退当前 origin', async () => {
  const manifest = ZenBackup.collect([{ id: 'zp-data-v2', data: { planners: [] } }])
  const win = hubWindow((request) => ({
    type: 'omm:workspace-backup-reply', token: request.token, ok: true, results: [{ app: 'planner', ok: true }],
  }))
  await ZenPack.requestHub('restore', manifest, { window: win, timeout: 1000 })
  const request = win.sent[0]
  assert.equal(request.message.action, 'restore')
  assert.deepEqual(request.message.manifest, manifest)
  assert.equal(request.targetOrigin, 'http://127.0.0.1:8320')

  const noOrigin = {
    parent: { postMessage() { throw new Error('must not post') } },
    location: { origin: 'http://127.0.0.1:8327', search: '?omm_embed=1' },
  }
  assert.throws(() => ZenPack.hubTargetOrigin(noOrigin), /Hub origin/)
})

test('工作区目录从显式产品注册表覆盖全部内置产品与动态键', () => {
  const productIds = [
    'ai', 'annotate', 'corpus', 'data', 'english', 'latex', 'mdforge', 'message',
    'planner', 'redact', 'search', 'visualization', 'zencard', 'zenflow', 'zenclip',
    'zenreview', 'zenbackup', 'writer', 'video', 'table', 'lambda', 'hub',
  ]
  assert.deepEqual(ZenPack.WORKSPACE_PRODUCTS.map((product) => product.id).sort(), productIds.sort())
  const requiredKeys = [
    'zen.cards.v1', 'zen.srs.v1', 'zen.inbox.v1', 'zen.clip.v1',
    'zen.flow.rules.v1', 'zen.flow.strategy.v1', 'zp-data-v2', 'zp-count-v1',
    'zp-events-v1', 'zp-settings-v1', 'zenviz.workspace.v2',
    'zenviz.engine.v4.echarts', 'zenviz.engine.v4.chartjs',
    'zenviz.engine.v4.apexcharts', 'zenviz.engine.v4.zen', 'zen.viz.review.v1',
    'zen.video.canvas.v1', 'zen.table.canvas.v1', 'zenmark.table.ui.v1',
    'zencode.project.v1', 'zencode.settings.v1', 'omm-corpus-v1', 'zenglish_v1',
    'zmsg-message-cache-v1', 'zmsg-ui-v1', 'omm-search-v1', 'zc-docs', 'zc-autosave',
    'omm.hub.workspace.v1', 'lambda.ui.v2',
  ]
  requiredKeys.forEach((key) => assert.ok(ZenPack.WORKSPACE_KEYS.includes(key), key))
  for (const key of [
    'zc-doc:doc-1', 'omm.hub.screen-layout.v1.1920x1080x0x0',
    'zenviz.engine.v4.echarts', 'zenviz.engine.v4.chartjs',
    'zenviz.engine.v4.apexcharts', 'zenviz.engine.v4.zen',
  ]) assert.ok(ZenPack.isWorkspaceKey(key), key)
  assert.equal(new Set(ZenPack.WORKSPACE_KEYS).size, ZenPack.WORKSPACE_KEYS.length)

  const pack = ZenPack.collectWorkspace(storage({ 'zen.cards.v1': '[]' }))
  assert.ok(pack.coverage.missingProducts.includes('planner'))
  assert.ok(pack.coverage.missingProducts.includes('message'))
  assert.ok(JSON.stringify(pack).includes('missingProducts'))
})

test('脱敏记录字段路径，恢复保留 history 并只跳过敏感路径', () => {
  const source = storage({
    'omm-search-v1': JSON.stringify({
      settings: { apiKey: 'sk-export-secret', apiBase: 'https://example.test' },
      history: [{ query: 'new search', answer: 'kept' }],
    }),
  })
  const pack = ZenPack.makePack(source)
  const entry = pack.products.find((item) => item.id === 'omm-search-v1')
  assert.ok(entry.maskedPaths.includes('$.settings.apiKey'))
  assert.equal(entry.data.settings.apiKey, ZenBackup.REDACTED)
  assert.deepEqual(entry.data.history, [{ query: 'new search', answer: 'kept' }])
  assert.ok(!JSON.stringify(pack).includes('sk-export-secret'))

  const target = storage({
    'omm-search-v1': JSON.stringify({
      settings: { apiKey: 'sk-local-secret', apiBase: 'https://old.test' },
      history: [{ query: 'old search' }],
    }),
  })
  assert.equal(ZenPack.applyPack(pack, target), 1)
  const restored = JSON.parse(target.getItem('omm-search-v1'))
  assert.equal(restored.settings.apiKey, 'sk-local-secret')
  assert.equal(restored.settings.apiBase, 'https://example.test')
  assert.deepEqual(restored.history, [{ query: 'new search', answer: 'kept' }])

  const empty = storage({})
  ZenPack.applyPack(pack, empty)
  const withoutSecret = JSON.parse(empty.getItem('omm-search-v1'))
  assert.equal(Object.hasOwn(withoutSecret.settings, 'apiKey'), false)
  assert.deepEqual(withoutSecret.history, [{ query: 'new search', answer: 'kept' }])
})

test('raw 与显式 json encoding 的 JSON 字符串、普通字符串、数字、null 往返不失真', () => {
  const values = {
    'zen.cards.v1': '{ "id" : "a", "history" : [1, 2] }',
    'zen.theme': 'dark',
    'zp-count-v1': '0',
    'lambda.hint.narrow': 'null',
    'zc-settings': '"plain JSON string"',
  }
  const pack = ZenPack.readPack(JSON.stringify(ZenPack.makePack(storage(values))))
  const target = storage({})
  ZenPack.applyPack(pack, target)
  for (const [key, value] of Object.entries(values)) assert.equal(target.getItem(key), value, key)

  const jsonString = ZenBackup.collect([{ id: 'zen.theme', encoding: 'json', data: 'dark' }])
  const jsonTarget = storage({})
  ZenPack.applyPack(jsonString, jsonTarget)
  assert.equal(jsonTarget.getItem('zen.theme'), '"dark"')
})

test('applyPack 只统计成功写入，并在部分失败时返回失败列表', () => {
  const pack = ZenPack.makePack(storage({ 'zen.cards.v1': '[]', 'zp-count-v1': '{"records":2}' }))
  const target = storage({}, ['zp-count-v1'])
  const result = ZenPack.applyPack(pack, target)
  assert.equal(typeof result, 'object')
  assert.equal(result.written, 1)
  assert.deepEqual(result.failures.map((failure) => failure.key), ['zp-count-v1'])
  assert.equal(target.getItem('zen.cards.v1'), '[]')
  assert.equal(target.getItem('zp-count-v1'), null)
})

test('恢复白名单不因 knownKeys、非 OMM 键、特殊键或凭据键扩张', () => {
  const manifest = ZenBackup.collect([
    { id: 'zen.cards.v1', data: [] },
    { id: 'my-notes', data: ['bad'] },
    { id: '__proto__', data: { polluted: true } },
    { id: 'zenglish-supabase-config-v1', data: { key: 'secret' } },
  ])
  const target = storage({ 'my-notes': 'original' })
  const entries = ZenBackup.restorableEntries(manifest, ['my-notes'], ZenPack.WORKSPACE_KEYS, target)
  assert.deepEqual(entries.map((entry) => entry.key), ['zen.cards.v1'])
  ZenPack.applyPack(manifest, target)
  assert.equal(target.getItem('my-notes'), 'original')
  assert.equal(Object.hasOwn(target._map, '__proto__'), false)
  assert.equal(target.getItem('zenglish-supabase-config-v1'), null)
})

test('损坏包的格式、版本、校验和、encoding 与遮蔽路径均在写入前拒绝', () => {
  const valid = ZenPack.makePack(storage({ 'zen.cards.v1': '[]' }))
  const variants = []
  const wrongVersion = structuredClone(valid); wrongVersion.v = 2; variants.push(wrongVersion)
  const wrongChecksum = structuredClone(valid); wrongChecksum.products[0].checksum = 'deadbeef'; variants.push(wrongChecksum)
  const wrongEncoding = structuredClone(valid); wrongEncoding.products[0].encoding = 'base64'; variants.push(wrongEncoding)
  const rawMismatch = structuredClone(valid); rawMismatch.products[0].data = { changed: true }; variants.push(rawMismatch)
  for (const broken of variants) {
    const target = storage({ 'zen.cards.v1': 'original' })
    assert.throws(() => ZenPack.readPack(broken))
    assert.throws(() => ZenPack.applyPack(broken, target))
    assert.equal(target.getItem('zen.cards.v1'), 'original')
  }

  const unsafe = ZenBackup.collect([{ id: 'omm-search-v1', data: { apiKey: 'x', history: [] } }])
  const redacted = ZenBackup.redactSecrets(unsafe)
  redacted.products[0].maskedPaths = ['$.__proto__.polluted']
  const target = storage({ 'omm-search-v1': 'original' })
  assert.throws(() => ZenPack.readPack(redacted))
  assert.throws(() => ZenPack.applyPack(redacted, target))
  assert.equal(target.getItem('omm-search-v1'), 'original')
})

test('Hub 产品快照内的 localStorage JSON 也按字段脱敏并可保留当前敏感值', () => {
  const snapshot = {
    version: 1,
    app: 'search',
    localStorage: {
      'omm-search-v1': JSON.stringify({
        settings: { apiKey: 'sk-export-secret', apiBase: 'https://new.example' },
        history: [{ query: 'new' }],
      }),
    },
    sessionStorage: {},
    indexedDB: [],
  }
  const entry = ZenBackup.redactSecrets(ZenBackup.collect([{ id: 'search', data: snapshot }])).products[0]
  const maskedPath = '$.localStorage["omm-search-v1"].settings.apiKey'
  assert.ok(entry.maskedPaths.includes(maskedPath))
  assert.ok(!JSON.stringify(entry).includes('sk-export-secret'))
  assert.deepEqual(ZenBackup.validate(ZenBackup.collect([entry])), { ok: true, errors: [] })

  const current = {
    localStorage: {
      'omm-search-v1': JSON.stringify({
        settings: { apiKey: 'sk-local-secret', apiBase: 'https://old.example' },
        history: [{ query: 'old' }],
      }),
    },
  }
  const restored = ZenBackup.restoreEntryData(entry, current)
  assert.equal(restored.skip, false)
  const value = JSON.parse(restored.value.localStorage['omm-search-v1'])
  assert.equal(value.settings.apiKey, 'sk-local-secret')
  assert.equal(value.settings.apiBase, 'https://new.example')
  assert.deepEqual(value.history, [{ query: 'new' }])
})

test('Hub 部分产品采集失败仍返回清单与明确失败产品', async () => {
  const manifest = ZenBackup.collect([{ id: 'search', data: { localStorage: {}, sessionStorage: {}, indexedDB: [] } }])
  const win = hubWindow((request) => ({
    type: 'omm:workspace-backup-reply', token: request.token, ok: false, manifest,
    results: [
      { app: 'search', ok: true },
      { app: 'planner', ok: false, error: '产品启动超时' },
    ],
    error: '部分产品采集失败',
  }))
  const reply = await ZenPack.requestHub('collect', null, { window: win, timeout: 1000 })
  assert.equal(reply.ok, false)
  assert.deepEqual(reply.coverage.failedProducts, ['planner'])
  assert.equal(reply.coverage.failures[0].error, '产品启动超时')
})

test('本地恢复前快照可在部分写入失败后回滚', () => {
  const pack = ZenPack.makePack(storage({ 'zen.cards.v1': '["new"]', 'zp-count-v1': '2' }))
  const target = storage({ 'zen.cards.v1': '["old"]' }, ['zp-count-v1'])
  const entries = ZenPack.restoreEntries(pack, target)
  const saved = ZenPack.snapshot(entries, target)
  const result = ZenPack.applyPack(pack, target)
  assert.equal(result.failures.length, 1)
  const rollback = ZenPack.rollback(saved, target)
  assert.deepEqual(rollback.failures, [])
  assert.equal(target.getItem('zen.cards.v1'), '["old"]')
  assert.equal(target.getItem('zp-count-v1'), null)
})
