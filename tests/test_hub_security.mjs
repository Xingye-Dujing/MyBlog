/* Hub / desktop bridge security and protocol regressions (node:test). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { ZenBackup } from '../public/lib/zen-backup.js'

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
const hub = read('public/omm-hub.js')
const bridge = read('public/viz-bridge.js')
const desktop = read('public/omm-desktop.js')
const share = read('public/omm-share.js')

function extractFunction(text, name) {
  let start = text.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, name + ' 未找到')
  const asyncAt = text.lastIndexOf('async ', start)
  if (asyncAt >= 0 && start - asyncAt < 8) start = asyncAt
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error(name + ' 括号不平衡')
}

function loadFunctions(text, names, extra = {}) {
  const code = names.map((n) => extractFunction(text, n)).join('\n') +
    `\nreturn { ${names.join(', ')} }`
  return vm.runInNewContext(`(function () { ${code} })()`, {
    Math, Object, Array, String, Number, Date, Promise, JSON, Set, Map,
    ...extra,
  })
}

/* ------------------------------- VizBridge ------------------------------ */

function vizContext({ embedded = true, broker = null } = {}) {
  const listeners = []
  const posts = []
  const timers = []
  const store = {}
  const parent = { postMessage: (data, origin) => posts.push({ data, origin }) }
  const location = {
    origin: 'http://127.0.0.1:8320',
    search: embedded
      ? '?omm_embed=1&omm_hub_origin=http%3A%2F%2F127.0.0.1%3A8300'
      : '',
  }
  const window = {
    parent,
    location,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn) },
    removeEventListener: (type, fn) => {
      const at = listeners.indexOf(fn)
      if (at >= 0) listeners.splice(at, 1)
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    clearTimeout: () => {},
    OMMShare: broker,
    console,
  }
  window.window = window
  const context = {
    window, location, URL, URLSearchParams, Promise, console,
    localStorage: {
      getItem: (key) => key in store ? store[key] : null,
      setItem: (key, value) => { store[key] = value },
      removeItem: (key) => { delete store[key] },
    },
  }
  vm.runInNewContext(read('public/zen/foundation/util.js'), context)
  vm.runInNewContext(
    bridge.replace('export const VizBridge =', 'globalThis.VizBridge ='),
    context,
  )
  window.VizBridge = context.VizBridge
  return { window, parent, listeners, posts, timers, VizBridge: context.VizBridge }
}

test('VizBridge 嵌入消息只接受父窗口与精确 Hub origin', () => {
  const env = vizContext()
  const received = []
  env.VizBridge.onData((payload) => received.push(payload))
  const message = { data: { type: 'omm:zenviz-data', payload: { format: 'zenviz-data', csv: 'x' } } }
  env.listeners[0]({ ...message, source: {}, origin: 'http://127.0.0.1:8300' })
  env.listeners[0]({ ...message, source: env.parent, origin: 'http://127.0.0.1:9999' })
  assert.equal(received.length, 0)
  env.listeners[0]({ ...message, source: env.parent, origin: 'http://127.0.0.1:8300' })
  assert.equal(received.length, 1)
})

test('VizBridge 非嵌入窗口只接受同源父窗口，顶层窗口不是消息 peer', () => {
  const env = vizContext({ embedded: false })
  const received = []
  env.VizBridge.onData((payload) => received.push(payload))
  const data = { type: 'omm:zenviz-data', payload: { format: 'zenviz-data' } }
  env.listeners[0]({ data, source: env.parent, origin: 'http://127.0.0.1:8300' })
  assert.equal(received.length, 0)
  env.listeners[0]({ data, source: env.parent, origin: 'http://127.0.0.1:8320' })
  assert.equal(received.length, 1)
  env.window.parent = env.window
  env.listeners[0]({ data, source: env.window, origin: 'http://127.0.0.1:8320' })
  assert.equal(received.length, 1)
})

test('VizBridge.send 的 broker 成功/失败都是真实状态，且不再传 channel', async () => {
  const sent = []
  const ok = vizContext({ broker: { enabled: true, send: (options) => { sent.push(options); return Promise.resolve({ id: 'm' }) } } })
  assert.equal(await ok.VizBridge.send({ format: 'zenviz-data' }), true)
  assert.equal(sent[0].to, 'visualization')
  assert.equal('channel' in sent[0], false)
  const failed = vizContext({ broker: { enabled: true, send: () => Promise.reject(new Error('denied')) } })
  assert.equal(await failed.VizBridge.send({ format: 'zenviz-data' }), false)
  assert.equal(failed.posts.length, 0)
})

test('VizBridge 嵌入回退必须等待 Hub 转发后的可视化回执', async () => {
  const env = vizContext()
  const pending = env.VizBridge.send({ format: 'zenviz-data', csv: 'a,b' })
  const request = env.posts[0]
  assert.equal(request.data.type, 'omm:zenviz-data')
  assert.equal(request.origin, 'http://127.0.0.1:8300')
  const ack = env.listeners[0]
  ack({
    source: env.parent,
    origin: 'http://127.0.0.1:8300',
    data: { type: 'omm:zenviz-data-delivery', token: request.data.token, ok: true },
  })
  assert.equal(await pending, true)
})

test('VizBridge 回退超时返回 false，localStorage 队列不算投递成功', async () => {
  const env = vizContext()
  const pending = env.VizBridge.send({ format: 'zenviz-data' })
  env.timers[0]()
  assert.equal(await pending, false)
})

test('VizBridge 接收成功后向精确 Hub 回执', () => {
  const env = vizContext()
  env.VizBridge.onData(() => {})
  env.listeners[0]({
    source: env.parent,
    origin: 'http://127.0.0.1:8300',
    data: { type: 'omm:zenviz-data', token: 'viz-token-1', payload: { format: 'zenviz-data' } },
  })
  assert.equal(env.posts[0].data.type, 'omm:zenviz-data-received')
  assert.equal(env.posts[0].data.token, 'viz-token-1')
  assert.equal(env.posts[0].origin, 'http://127.0.0.1:8300')
})

test('Hub 只转发 data 来源的 Viz 请求并回报真实投递结果', () => {
  const posts = []
  let activated = ''
  const dataFrame = { contentWindow: { postMessage: (data, origin) => posts.push({ data, origin }) } }
  const vizFrame = { contentWindow: { postMessage: (data, origin) => posts.push({ data, origin }) } }
  const { relayVizData, finishVizDelivery } = loadFunctions(hub,
    ['relayVizData', 'finishVizDelivery'], {
      vizDeliveries: Object.create(null),
      appOf: (id) => id === 'visualization' ? { id } : null,
      activateApp: (id) => { activated = id },
      whenAppReady: (id, done) => done(vizFrame),
      frameTargetOrigin: () => 'http://127.0.0.1:8320',
      window: { clearTimeout: () => {}, setTimeout: () => 1 },
    })
  relayVizData(dataFrame, 'http://127.0.0.1:8313', 'corpus', {
    token: 'viz-token-1', payload: { format: 'zenviz-data' },
  })
  assert.equal(activated, '')
  relayVizData(dataFrame, 'http://127.0.0.1:8313', 'data', {
    token: 'viz-token-1', payload: { format: 'zenviz-data' },
  })
  assert.equal(activated, 'visualization')
  assert.equal(posts[0].data.type, 'omm:zenviz-data')
  finishVizDelivery('viz-token-1', true, '')
  assert.equal(posts[1].data.type, 'omm:zenviz-data-delivery')
  assert.equal(posts[1].data.ok, true)
  assert.equal(posts[1].origin, 'http://127.0.0.1:8313')
})

/* ------------------------------ OMMShare JS ----------------------------- */

function deliverContext(handlers, apiGet) {
  const emitted = []
  const fn = loadFunctions(share, ['deliverMessage'], {
    state: { handlers, toast: () => {} },
    fetchFile: async () => { throw new Error('offline') },
    apiGet,
    emit: (item) => emitted.push(item),
    notifyReceived: () => {},
    window: { OMMDesktop: { loadBlob: () => {} } },
  })
  return { deliver: fn.deliverMessage, emitted }
}

test('OMMShare 零 handler 时保留 inbox，不读取也不 ack', async () => {
  let reads = 0
  const env = deliverContext([], async () => { reads++; return {} })
  assert.equal(await env.deliver({ format: 'omm.bridge', payload: {} }), false)
  assert.equal(reads, 0)
})

test('OMMShare /item 临时失败不 emit 空 payload，也不确认消息', async () => {
  const message = {
    id: 'm1', format: 'x', artifact: { id: 'a1', kind: 'record', title: 't' },
  }
  for (const apiGet of [
    async () => { throw new Error('temporary') },
    async () => ({}),
  ]) {
    const env = deliverContext([() => {}], apiGet)
    assert.equal(await env.deliver(message), false)
    assert.equal(env.emitted.length, 0)
  }
})

function asyncDeliverContext(handlers, apiGet) {
  const emitted = []
  const notified = []
  const fn = loadFunctions(share, ['emit', 'deliverMessage'], {
    state: { handlers, toast: () => {} },
    fetchFile: async () => { throw new Error('offline') },
    apiGet,
    notifyReceived: (message) => notified.push(message),
    window: {
      OMMDesktop: { loadBlob: () => {} },
      dispatchEvent: (event) => emitted.push(event.detail),
      console,
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail } },
  })
  return { deliver: fn.deliverMessage, emitted, notified }
}

test('OMMShare emit 等待异步 handler，完成后才确认消息', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const env = asyncDeliverContext([async () => { await gate }], async () => ({}))
  let settled = false
  const delivering = env.deliver({ id: 'm1', format: 'x', payload: { a: 1 } }).then((value) => {
    settled = true
    return value
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settled, false)
  release()
  assert.equal(await delivering, true)
  assert.equal(env.notified.length, 1)
})

test('OMMShare 异步 handler reject 时 deliverMessage 返回 false 并保留 inbox', async () => {
  const env = asyncDeliverContext([
    async () => { throw new Error('async import failed') },
    async () => {},
  ], async () => ({}))
  assert.equal(await env.deliver({ id: 'm1', format: 'x', payload: {} }), false)
  assert.equal(env.notified.length, 0)
  assert.equal(env.emitted.length, 0)
})

test('OMMShare 记录类消息的异步 handler reject 也不会 ack', async () => {
  const env = asyncDeliverContext([async () => { throw new Error('handler failed') }],
    async () => ({ item: { id: 'a1', payload: { x: 1 } } }))
  const message = { id: 'm1', artifact: { id: 'a1', kind: 'record' } }
  assert.equal(await env.deliver(message), false)
  assert.equal(env.notified.length, 0)
})

test('OMMShare data-omm-app 标记优先于 index.html 文件名推断', () => {
  const { detectAppId } = loadFunctions(share, ['detectAppId'], {
    document: { querySelector: () => ({ getAttribute: () => 'lambda' }) },
    location: { pathname: '/index.html' },
  })
  assert.equal(detectAppId(), 'lambda')
  assert.ok(desktop.includes("document.querySelector('[data-omm-app]')"))
})

/* --------------------------- applyState atomicity ----------------------- */

function applyContext(overrides = {}) {
  const events = []
  let reloads = 0
  const context = {
    decodeValue: (value) => {
      if (value && value.__omm_type === 'bad') throw new Error('bad snapshot')
      return value
    },
    captureRollbackState: async () => { events.push('backup'); return { localStorage: {}, sessionStorage: {}, indexedDB: [] } },
    restoreDatabases: async () => { events.push('db') },
    replaceStorage: () => { events.push('storage') },
    rollbackState: async () => { events.push('rollback') },
    location: { reload: () => { reloads++; events.push('reload') } },
    window: {},
    ...overrides,
  }
  const fn = loadFunctions(desktop,
    ['validateSnapshot', 'applyState'], context)
  return { ...fn, events, get reloads() { return reloads } }
}

const validSnapshot = () => ({
  localStorage: { 'zen.cards.v1': '[]' },
  sessionStorage: {},
  indexedDB: [{ name: 'db', version: 1, stores: [{ name: 's', keyPath: 'id', records: [{ key: '1', value: { id: '1' } }] }] }],
})

test('恢复 IndexedDB 时删除快照未包含的数据库', async () => {
  const events = []
  const { restoreDatabases } = loadFunctions(desktop, ['restoreDatabases'], {
    deleteDatabase: async (name) => { events.push('delete:' + name) },
    restoreDatabase: async (info) => { events.push('restore:' + info.name) },
  })
  await restoreDatabases([{ name: 'keep' }], ['keep', 'obsolete'])
  assert.deepEqual(events, ['delete:obsolete', 'restore:keep'])
})

test('自动快照指纹覆盖完整序列化状态', () => {
  assert.ok(desktop.includes('ZenUtil.fingerprint(JSON.stringify(snapshot))'))
  assert.doesNotMatch(desktop, /text\.slice\(0,\s*2048\)/)
})

test('applyState 先验证快照，非法内容在任何写入前失败', async () => {
  let backups = 0
  const env = applyContext({ captureRollbackState: async () => { backups++; return {} } })
  const bad = validSnapshot()
  bad.indexedDB[0].stores[0].records[0].value = { __omm_type: 'bad' }
  await assert.rejects(env.applyState(bad), /bad snapshot/)
  assert.equal(backups, 0)
  assert.equal(env.reloads, 0)
})

test('applyState 全部 DB 成功后才提交 localStorage，成功才 reload', async () => {
  const env = applyContext()
  await env.applyState(validSnapshot())
  assert.deepEqual(env.events, ['backup', 'db', 'storage', 'reload'])
})

test('applyState DB 失败时回滚且不提交 localStorage、不 reload', async () => {
  const env = applyContext({
    restoreDatabases: async () => { env.events.push('db'); throw new Error('db failed') },
  })
  await assert.rejects(env.applyState(validSnapshot()), /已回滚/)
  assert.deepEqual(env.events, ['backup', 'db', 'rollback'])
  assert.equal(env.reloads, 0)
})

test('applyState localStorage 提交失败也回滚 DB，且不 reload', async () => {
  const env = applyContext({
    replaceStorage: () => { env.events.push('storage'); throw new Error('quota') },
  })
  await assert.rejects(env.applyState(validSnapshot()), /已回滚/)
  assert.deepEqual(env.events, ['backup', 'db', 'storage', 'rollback'])
  assert.equal(env.reloads, 0)
})

test('captureRollbackState 完整备份当前 localStorage 与 IndexedDB', async () => {
  const localStorage = { 0: 'zen.a', length: 1, key: () => 'zen.a', getItem: () => 'old' }
  const sessionStorage = { length: 0, key: () => null }
  const fn = loadFunctions(desktop, ['captureRollbackState'], {
    localStorage,
    sessionStorage,
    window: { indexedDB: {} },
    indexedDB: { databases: async () => [{ name: 'current' }] },
    captureDatabase: async (name) => ({ name, stores: [{ name: 's', records: [] }] }),
  })
  const backup = await fn.captureRollbackState({ indexedDB: [{ name: 'target' }] })
  assert.equal(backup.localStorage['zen.a'], 'old')
  assert.equal(backup.indexedDB[0].name, 'current')
})

/* ------------------------------ live data ------------------------------- */

function liveContext(store) {
  const posts = []
  const frames = new Map([
    ['writer', { contentWindow: { postMessage: (data) => posts.push({ app: 'writer', data }) } }],
  ])
  const context = {
    localStorage: { getItem: (key) => key in store ? store[key] : null },
    ZenUtil: {
      getJSON(key, fallback) {
        const raw = key in store ? store[key] : null
        if (raw == null) return fallback
        try { return JSON.parse(raw) } catch { return fallback }
      },
    },
    flowEvents: [{ kind: 'snapshot', text: 'saved', at: 1767225600000 }],
    frames,
    frameTargetOrigin: () => 'http://127.0.0.1:8321',
    liveDataWaiters: Object.create(null),
    liveDataSeq: 0,
    window: { setTimeout: () => 1, clearTimeout: () => {} },
    JSON, Date, Object, Array, String, Number,
  }
  const fn = loadFunctions(hub,
    ['liveCardDTO', 'dedupeLiveCards', 'readLiveCards', 'annotateLiveSnapshot',
      'collectLiveLocalData', 'respondLiveData', 'finishLiveData'], context)
  return { ...fn, posts, waiters: context.liveDataWaiters }
}

const sensitiveStore = {
  'zen.cards.v1': JSON.stringify([{ content: 'card', kind: 'note', tags: [] }]),
  'omm-search-v1': JSON.stringify({ history: [{ query: 'private-search', answer: 'private-answer' }] }),
  'zp-data-v2': JSON.stringify({ days: { '2026-01-01': [{ title: 'task', done: true }] } }),
  'zencode.project.v1': JSON.stringify({ title: 'private-doc', codes: [], anns: [], marks: [], cellCodes: [], reliability: [], docs: [] }),
}

test('live-data ZenReview 只有 cards+timeline+planner，不含 searches/annotate', () => {
  const env = liveContext(sensitiveStore)
  const snap = env.collectLiveLocalData('review')
  assert.deepEqual(Object.keys(snap).sort(), ['cards', 'planner', 'timeline'])
  assert.ok(!JSON.stringify(snap).includes('private-search'))
  assert.ok(!JSON.stringify(snap).includes('private-doc'))
})

test('live-data ZenFlow 只有 cards，AI 仍可完整快照', () => {
  const env = liveContext(sensitiveStore)
  assert.deepEqual(Object.keys(env.collectLiveLocalData('cards')), ['cards'])
  const full = env.collectLiveLocalData('full')
  assert.ok(full.searches.length)
  assert.ok(full.annotate)
})

test('live-data 其它 sourceApp 被拒绝且不广播卡片请求', () => {
  const env = liveContext(sensitiveStore)
  assert.equal(env.respondLiveData({ contentWindow: {} }, 'http://127.0.0.1:8313', 'data'), false)
  assert.equal(env.posts.length, 0)
  assert.equal(Object.keys(env.waiters).length, 0)
})

test('live-data ZenFlow 广播卡片请求，但回复仍只有 cards', () => {
  const env = liveContext(sensitiveStore)
  assert.equal(env.respondLiveData({ contentWindow: { postMessage: () => {} } }, 'http://127.0.0.1:8324', 'zenflow'), true)
  assert.equal(env.posts[0].data.type, 'omm:zen-card-request')
  const token = env.posts[0].data.token
  env.finishLiveData(token)
  const reply = []
  // finishLiveData used the source frame above; capture by replacing it is not possible,
  // so validate the waiter snapshot directly before completion in a second request.
  assert.equal(env.waiters[token], undefined)
  assert.equal(reply.length, 0)
  const env2 = liveContext(sensitiveStore)
  let replyData = null
  const requestToken = 'live-request-token'
  env2.respondLiveData({ contentWindow: { postMessage: (data) => { replyData = data } } }, 'http://127.0.0.1:8324', 'zenflow', requestToken)
  env2.finishLiveData(env2.posts[0].data.token)
  assert.equal(replyData.token, requestToken)
  assert.deepEqual(Object.keys(replyData.data), ['cards'])
})

/* --------------------------- ZenBackup protocol ------------------------- */

function workspaceJob() {
  const replies = []
  return {
    token: 'workspace-token-1',
    frame: { contentWindow: { postMessage: (data) => replies.push(data) } },
    origin: 'http://127.0.0.1:8327',
    done: false,
    timer: 0,
    replies,
  }
}

test('ZenBackup 协议拒绝非 zenbackup 来源与非法 token', () => {
  const jobs = Object.create(null)
  const replies = []
  const { handleWorkspaceBackupRequest } = loadFunctions(hub,
    ['handleWorkspaceBackupRequest'], {
      workspaceBackupJobs: jobs,
      window: { setTimeout: () => 1 },
    })
  const frame = { contentWindow: { postMessage: (data) => replies.push(data) } }
  handleWorkspaceBackupRequest(frame, 'http://127.0.0.1:8313', 'data', {
    token: 'workspace-token-1', action: 'collect',
  })
  handleWorkspaceBackupRequest(frame, 'http://127.0.0.1:8327', 'zenbackup', {
    token: 'short', action: 'collect',
  })
  assert.equal(Object.keys(jobs).length, 0)
  assert.equal(replies.length, 0)
})

test('ZenBackup collect 逐产品报告失败，manifest 只含成功产品且不全量成功', async () => {
  const job = workspaceJob()
  let cleaned = []
  const finished = []
  const fn = loadFunctions(hub, ['collectWorkspaceBackup'], {
    APP_LIST: [{ id: 'writer', name: 'Writer', version: '1' }, { id: 'broken', name: 'Broken' }],
    loadZenBackupModule: async () => ZenBackup,
    ensureWorkspaceFrame: async (id) => { if (id === 'broken') throw new Error('boot failed') },
    captureWorkspaceProduct: async () => '/tmp/snapshot.json',
    readWorkspaceSnapshot: async () => validSnapshot(),
    finishWorkspaceBackup: (token, body) => finished.push(body),
    cleanupWorkspaceFrames: (ids) => { cleaned = ids },
    window: {},
    Date, JSON, Object, Array, String, Number, Promise,
  })
  await fn.collectWorkspaceBackup(job)
  const result = finished[0]
  assert.equal(result.ok, false)
  assert.deepEqual(JSON.parse(JSON.stringify(result.results.map((r) => [r.app, r.ok]))), [['broken', false], ['writer', true]])
  assert.equal(ZenBackup.validate(result.manifest).ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(result.manifest.products.map((p) => p.id))), ['writer'])
  assert.equal(cleaned.length, 0)
})

test('ZenBackup restore 拒绝未注册产品 id，合法产品写快照后等待 iframe 回执', async () => {
  const job = workspaceJob()
  const finished = []
  const calls = []
  const fn = loadFunctions(hub, ['restoreWorkspaceBackup'], {
    loadZenBackupModule: async () => ZenBackup,
    appOf: (id) => id === 'writer' ? { id } : null,
    fetch: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, json: async () => ({ ok: true, path: '/tmp/restored.json' }) }
    },
    ensureWorkspaceFrame: async () => ({}),
    restoreWorkspaceProduct: async (id, path) => { calls.push({ restored: id, path }) },
    finishWorkspaceBackup: (token, body) => finished.push(body),
    cleanupWorkspaceFrames: () => {},
    window: {}, Date, JSON, Object, Array, String, Number, Promise,
  })
  const manifest = ZenBackup.collect([
    { id: 'writer', data: validSnapshot() },
    { id: 'not-registered', data: validSnapshot() },
  ])
  await fn.restoreWorkspaceBackup(job, manifest)
  const result = finished[0]
  assert.equal(result.ok, false)
  assert.deepEqual(JSON.parse(JSON.stringify(result.results.map((r) => [r.app, r.ok]))), [['not-registered', false], ['writer', true]])
  assert.equal(calls[0].url, '/__omm/fs/snapshot')
  assert.equal(JSON.parse(calls[0].options.body).app, 'writer')
  assert.equal(calls[1].restored, 'writer')
})

test('ZenBackup restore 复用 maskedPaths 合并当前设备敏感字段', async () => {
  const job = workspaceJob()
  const finished = []
  const posted = []
  const incoming = {
    localStorage: {
      'omm-search-v1': JSON.stringify({
        settings: { apiKey: 'export-secret', apiBase: 'https://new.example' },
        history: [{ query: 'new' }],
      }),
    },
    sessionStorage: {},
    indexedDB: [],
  }
  const entry = ZenBackup.redactSecrets(ZenBackup.collect([{ id: 'search', data: incoming }])).products[0]
  const manifest = ZenBackup.collect([entry])
  const current = {
    localStorage: {
      'omm-search-v1': JSON.stringify({
        settings: { apiKey: 'local-secret', apiBase: 'https://old.example' },
        history: [{ query: 'old' }],
      }),
    },
    sessionStorage: {},
    indexedDB: [],
  }
  const fn = loadFunctions(hub, ['restoreWorkspaceBackup'], {
    loadZenBackupModule: async () => ZenBackup,
    appOf: (id) => id === 'search' ? { id } : null,
    ensureWorkspaceFrame: async () => ({}),
    captureWorkspaceProduct: async () => '/tmp/current.json',
    readWorkspaceSnapshot: async () => current,
    fetch: async (url, options) => {
      posted.push({ url, body: JSON.parse(options.body) })
      return { ok: true, json: async () => ({ ok: true, path: '/tmp/restored.json' }) }
    },
    restoreWorkspaceProduct: async () => {},
    finishWorkspaceBackup: (token, body) => finished.push(body),
    cleanupWorkspaceFrames: () => {},
    window: {}, Date, JSON, Object, Array, String, Number, Promise,
  })
  await fn.restoreWorkspaceBackup(job, manifest)
  assert.equal(finished[0].ok, true)
  const restored = JSON.parse(posted[0].body.state.localStorage['omm-search-v1'])
  assert.equal(restored.settings.apiKey, 'local-secret')
  assert.equal(restored.settings.apiBase, 'https://new.example')
  assert.deepEqual(restored.history, [{ query: 'new' }])
  assert.equal(JSON.stringify(posted).includes('export-secret'), false)
})

test('ZenBackup restore 仍拒绝纯凭据条目', async () => {
  const job = workspaceJob()
  const finished = []
  let writes = 0
  const manifest = ZenBackup.collect([{
    id: 'apiKey', data: { localStorage: {}, sessionStorage: {}, indexedDB: [] },
  }])
  const fn = loadFunctions(hub, ['restoreWorkspaceBackup'], {
    loadZenBackupModule: async () => ZenBackup,
    appOf: () => ({ id: 'apiKey' }),
    fetch: async () => { writes++; throw new Error('must not write') },
    finishWorkspaceBackup: (token, body) => finished.push(body),
    cleanupWorkspaceFrames: () => {},
    window: {}, Date, JSON, Object, Array, String, Number, Promise,
  })
  await fn.restoreWorkspaceBackup(job, manifest)
  assert.equal(finished[0].ok, false)
  assert.match(finished[0].results[0].error, /纯凭据/)
  assert.equal(writes, 0)
})

test('ZenBackup restore 发送 omm:restore-snapshot 并以同源产品 token 回执完成', async () => {
  const posts = []
  const pending = Object.create(null)
  const frame = { contentWindow: { postMessage: (data) => posts.push(data) } }
  const fn = loadFunctions(hub, ['restoreWorkspaceProduct'], {
    waitForWorkspaceFrame: async () => frame,
    pendingRestores: pending,
    frameTargetOrigin: () => 'http://127.0.0.1:8321',
    window: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 2, clearTimeout: () => {} },
    Date, Math, Promise,
  })
  const restoring = fn.restoreWorkspaceProduct('writer', '/tmp/restored.json')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(posts[0].type, 'omm:restore-snapshot')
  const token = posts[0].token
  pending[token].done({ ok: true })
  await restoring
})

test('ZenBackup 隐藏 iframe 完成后清理，不删除用户已打开的窗格', () => {
  const destroyed = []
  const frames = new Map([['writer', { dataset: { workspaceHidden: '1' } }]])
  const { cleanupWorkspaceFrames } = loadFunctions(hub, ['cleanupWorkspaceFrames'], {
    findPaneByApp: () => null,
    frames,
    workspaceHiddenLeases: Object.create(null),
    destroyFrame: (id) => destroyed.push(id),
    appStatus: {},
  })
  cleanupWorkspaceFrames(['writer'])
  assert.deepEqual(destroyed, ['writer'])
})

/* ------------------------- Hub credential bootstrap -------------------- */

test('Hub 同源 fetch 使用能力 header，不把凭证放入 URL', () => {
  assert.ok(hub.includes("headers.set('X-OMM-Hub-Capability', token)"))
  assert.ok(hub.includes('url.origin === window.location.origin'))
  assert.ok(hub.includes('window.__ommHubCapabilityToken'))
  assert.doesNotMatch(hub, /__ommHubCapabilityToken[^\n]*location\.search/)
})

test('Hub AI 设置不缓存或读取密钥，留空提交时省略 apiKey', () => {
  assert.equal(hub.includes('aiSavedKey'), false)
  const block = hub.slice(hub.indexOf('function saveAIConfig('), hub.indexOf('function openHubSettings('))
  assert.ok(block.includes("if (clearKey || nextKey) ai.apiKey = clearKey ? '' : nextKey"))
  assert.ok(block.includes('data && data.hasStoredKey'))
})

/* ---------------------- Hub layout / accessibility regressions ---------- */

test('detach 窗口只显示目标产品且不写主布局或多屏布局', () => {
  const writes = []
  const state = { open: ['writer', 'data'], tree: {}, panes: {}, focused: 'p1', dock: false, maximized: null }
  const fn = loadFunctions(hub,
    ['defaultState', 'applyDetachAndScreenLayout', 'saveNow', 'saveScreenLayout'], {
      DETACHED_APP_ID: 'writer',
      APP_BY_ID: { writer: { id: 'writer' } },
      hubAppearance: { restore: true, multiMonitor: true },
      state,
      STORAGE_KEY: 'main-layout',
      SCREEN_KEY_PREFIX: 'screen-layout.',
      screenKey: () => 'display-1',
      ZenUtil: {
        getJSON: () => { throw new Error('detach must not read layouts') },
        setJSON: (key, value) => writes.push({ key, value }),
      },
    })
  fn.applyDetachAndScreenLayout()
  assert.deepEqual(Array.from(state.open), ['writer'])
  assert.equal(state.panes.p1, 'writer')
  fn.saveNow()
  fn.saveScreenLayout()
  assert.deepEqual(writes, [])
})

test('restore=false 不读取显示器布局', () => {
  const state = { open: [], tree: { type: 'leaf', id: 'p1' }, panes: { p1: null }, focused: 'p1', dock: true }
  const fn = loadFunctions(hub, ['applyDetachAndScreenLayout'], {
    DETACHED_APP_ID: '',
    APP_BY_ID: {},
    hubAppearance: { restore: false, multiMonitor: true },
    state,
    ZenUtil: { getJSON: () => { throw new Error('must not restore screen layout') } },
  })
  fn.applyDetachAndScreenLayout()
  assert.deepEqual(Array.from(state.open), [])
})

test('恢复快照按钮与时间线都经过同一确认入口', async () => {
  const events = []
  let confirmed = false
  const fn = loadFunctions(hub, ['requestSnapshotRestore', 'restoreSnapshotFor'], {
    APP_BY_ID: { writer: { id: 'writer', name: 'Writer' } },
    lastSnapshotByApp: { writer: { path: '/tmp/snap.json', name: 'snap.json', label: '手动快照' } },
    ommConfirm: () => Promise.resolve(confirmed),
    closeTimeline: () => {},
    toast: () => {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail } },
    window: { dispatchEvent: (event) => events.push(event) },
  })
  fn.restoreSnapshotFor('writer')
  await Promise.resolve()
  assert.equal(events.length, 0)
  confirmed = true
  fn.restoreSnapshotFor('writer')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'omm:restore-snapshot')
  assert.equal(events[0].detail.path, '/tmp/snap.json')
  const paneHandler = hub.slice(hub.indexOf('/* panes */'), hub.indexOf('/* splitters */'))
  assert.ok(paneHandler.includes("action.dataset.act === 'restore-snap'"))
  const timeline = hub.slice(hub.indexOf('function openTimelineItem('), hub.indexOf('function showTabMenu('))
  assert.ok(timeline.includes('requestSnapshotRestore('))
})

test('恢复外观默认只重置视觉与无障碍，不碰快捷键、宏和云凭据', () => {
  const keymap = { 'open-0': 'Alt+0' }
  const macros = [{ name: '写作', key: 'Ctrl+Alt+W', actions: ['open-1'] }]
  const cloud = { enabled: true, url: 'https://dav.example', user: 'u', password: 'secret' }
  const hubAppearance = {
    topbar: false,
    a11y: { fontScale: 1.5, highContrast: true, reduceMotion: true, ariaLabels: false },
    keymap, macros, cloud,
    focus: { pomodoro: 45 }, restore: false, snap: 30,
  }
  const saved = []
  loadFunctions(hub, ['normalizeA11y', 'resetVisualDefaults'], {
    hubAppearance,
    saveHubAppearance: () => saved.push(hubAppearance),
    applyHubAppearance: () => {},
    scheduleLayout: () => {},
    toast: () => {},
  }).resetVisualDefaults()
  assert.equal(hubAppearance.topbar, true)
  assert.deepEqual(JSON.parse(JSON.stringify(hubAppearance.a11y)),
    { fontScale: 1, highContrast: false, reduceMotion: false, ariaLabels: true })
  assert.equal(hubAppearance.keymap, keymap)
  assert.equal(hubAppearance.macros, macros)
  assert.equal(hubAppearance.cloud, cloud)
  assert.equal(hubAppearance.focus.pomodoro, 45)
  assert.equal(saved.length, 1)
})

test('Hub 全局快捷键避开共享浮层与可编辑控件，自定义组合必须带修饰键', () => {
  let open = true
  let prevented = 0
  const event = { ctrlKey: true, key: 'k', target: { nodeType: 1, tagName: 'BODY' }, preventDefault: () => prevented++ }
  const fn = loadFunctions(hub, ['hasModifier', 'isEditableTarget', 'onKeyDown'], {
    comboCapturing: false,
    window: { ZenUI: { layer: { hasOpen: () => open } } },
  })
  fn.onKeyDown(event)
  assert.equal(prevented, 0)
  open = false
  fn.onKeyDown({ ...event, target: { nodeType: 1, tagName: 'INPUT' } })
  assert.equal(prevented, 0)
  assert.equal(fn.hasModifier('Ctrl+K'), true)
  assert.equal(fn.hasModifier('Shift+F10'), true)
  assert.equal(fn.hasModifier('K'), false)
  assert.ok(hub.includes('if (!combo || !hasModifier(combo))'))
  const keymap = loadFunctions(hub, ['hasModifier', 'normalizeKeymap'], {
    COMMANDS: [{ id: 'command-palette', def: 'Ctrl+K' }],
  })
  assert.equal(keymap.normalizeKeymap({ 'command-palette': 'K' })['command-palette'], 'Ctrl+K')
})

test('安装器键盘选择不重建网格，完成页与启动失败反馈走共享模态', async () => {
  const installer = read('public/installer.js')
  const page = read('public/installer.html')
  const render = installer.slice(installer.indexOf('function renderPlugins()'), installer.indexOf('function syncPluginSelection()'))
  assert.ok(!/\.addEventListener|renderPlugins\(\);/.test(render), '选择产品不应整表重建')
  assert.ok(installer.includes("els.grid.addEventListener('change'"))
  assert.ok(installer.includes('syncPluginSelection();'))
  assert.ok(page.includes('id="done-tpl"'))
  assert.ok(!page.includes('id="done"'))
  assert.ok(installer.includes('doneModal = window.ZenUI.modal.open('))
  assert.ok(installer.includes("error.hidden = false"))
  assert.ok(installer.includes("error.textContent = '启动失败：'"))
  const button = { disabled: false, textContent: '', focus: () => {} }
  const error = { hidden: true, textContent: '' }
  const fn = loadFunctions(installer, ['launch'], {
    document: { getElementById: (id) => id === 'launch' ? button : error },
    api: () => Promise.reject(new Error('denied')),
    els: { summaryState: { textContent: '' } },
    doneModal: null,
  })
  fn.launch()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(button.disabled, false)
  assert.equal(error.hidden, false)
  assert.match(error.textContent, /启动失败：denied/)
})

test('安装器删除圆角设置与旧 radius 持久化，固定 ZEN 直角', () => {
  const installer = read('public/installer.js')
  const page = read('public/installer.html')
  const css = read('public/zen/products/installer.css')
  assert.ok(!/data-radius|radius-options|appearance\.radius|setProperty\(['"]--radius/.test(installer + page))
  assert.ok(installer.includes("hasOwnProperty.call(data, 'radius')"))
  assert.ok(installer.includes('ZenUtil.setJSON(APPEARANCE_KEY, appearance)'))
  const radii = Array.from(css.matchAll(/border-radius\s*:\s*([^;]+)/g), (match) => match[1].trim())
  assert.ok(radii.every((value) => value.includes('var(--zen-radius)') || value === '50%'))
})

test('Hub CSS 清理死选择器并修正设置页脚、共享 select 与无障碍 targeting', () => {
  const css = read('public/zen/products/hub.css')
  assert.ok(!css.includes('never contains hard-coded colour values'))
  assert.ok(!/\.plugin-panel\b|\.pp-card\s*\{/.test(css))
  assert.ok(!css.includes('.oui-select'))
  assert.ok(css.includes('.setting-inline .zenui-select-trigger'))
  assert.ok(/\.settings-foot\s*\{/.test(css))
  assert.ok(css.includes("html[data-zen-high-contrast='true']"))
  assert.ok(css.includes("html[data-zen-reduce-motion='true']"))
  assert.ok(css.includes('.tab { font-size: calc(12px * var(--zen-fscale))'))
  assert.ok(css.includes('#dock { font-size: calc(10px * var(--zen-fscale))'))
  assert.ok(!/--ui-scale|\.tab \.tab-name|\.dock-label|body\.(?:hc|reduce-motion|no-motion)/.test(css))
  const apply = hub.slice(hub.indexOf('function applyHubAppearance()'), hub.indexOf('function cloudConfigFromForm()'))
  assert.ok(apply.includes("root.dataset.zenHighContrast = String(!!a11y.highContrast)"))
  assert.ok(apply.includes("root.dataset.zenReduceMotion = String(!!a11y.reduceMotion)"))
  assert.ok(apply.includes("'--zen-fscale'"))
})

test('launcher pin 键盘不打开应用，tabs 使用真实关闭按钮与 roving focus', () => {
  const launcherKey = hub.slice(hub.indexOf("els.launcher.addEventListener('keydown'"), hub.indexOf('/* layout menu */'))
  assert.ok(launcherKey.indexOf("if (event.target.closest('[data-pin]')) return") < launcherKey.indexOf("if (event.key === 'Enter')"))
  const launcherItem = hub.slice(hub.indexOf('function launcherApp('), hub.indexOf('function renderLauncher('))
  assert.ok(launcherItem.includes('<button class="launcher-open"'))
  assert.ok(!launcherItem.includes('role="button" tabindex="0" data-app='))
  const tabs = hub.slice(hub.indexOf('function renderTabs()'), hub.indexOf('function updateTabsOverflow()'))
  assert.ok(tabs.includes('aria-selected="'))
  assert.ok(tabs.includes("(appId === rovingApp ? '0' : '-1')"))
  assert.ok(tabs.includes("'</button>' +\n          '<button class=\"tab-close\""))
  assert.ok(!tabs.includes('<span class="tab-close"'))
  assert.ok(hub.includes("event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')"))
})

test('插件规范请求失败不会覆盖已切换标签', async () => {
  let rejectRequest
  const body = { innerHTML: '' }
  const context = {
    fetch: () => new Promise((resolve, reject) => { rejectRequest = reject }),
    pluginPanelTab: 'spec',
    pluginSpecSeq: 0,
    els: { ppBody: body, pluginPanel: { hidden: false } },
    esc: (value) => String(value),
  }
  vm.createContext(context)
  vm.runInContext(`(${extractFunction(hub, 'renderPluginSpec')})()`, context)
  body.innerHTML = 'installed-tab'
  context.pluginPanelTab = 'installed'
  rejectRequest(new Error('offline'))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(body.innerHTML, 'installed-tab')
})

test('Hub 隐藏采集 ZenCard / ZenClip，完成后按租约清理且不伪造失败数据', async () => {
  const requested = []
  const cleaned = []
  const fn = loadFunctions(hub,
    ['dedupeLiveCards', 'loadProductCards'], {
      APP_BY_ID: { zencard: {}, zenclip: {} },
      productCardsPromise: null,
      productCards: [],
      productCardErrors: [],
      ensureWorkspaceFrame: async (id, list) => { requested.push(id); list.push(id); return { id } },
      requestCardFrame: async (id) => id === 'zencard'
        ? { app: id, ok: true, cards: [{ id: 'c1', content: 'card' }] }
        : { app: id, ok: false, cards: [], error: 'offline' },
      cleanupWorkspaceFrames: (ids) => cleaned.push(...ids),
      refreshOpenCardSurfaces: () => {},
      Promise, Object, Array, String,
    })
  const result = await fn.loadProductCards()
  assert.deepEqual(Array.from(requested), ['zencard', 'zenclip'])
  assert.deepEqual(Array.from(cleaned), ['zencard', 'zenclip'])
  assert.deepEqual(Array.from(result.cards, (card) => card.id), ['c1'])
  assert.equal(result.complete, false)
  assert.match(result.errors.join(' '), /zenclip: offline/)
})

test('隐藏 iframe 多租约时最后一次清理才销毁', () => {
  const destroyed = []
  const frames = new Map([['writer', { dataset: { workspaceHidden: '1' } }]])
  const leases = { writer: 2 }
  const { cleanupWorkspaceFrames } = loadFunctions(hub, ['cleanupWorkspaceFrames'], {
    findPaneByApp: () => null,
    frames,
    workspaceHiddenLeases: leases,
    destroyFrame: (id) => destroyed.push(id),
    appStatus: {},
  })
  cleanupWorkspaceFrames(['writer'])
  assert.deepEqual(destroyed, [])
  cleanupWorkspaceFrames(['writer'])
  assert.deepEqual(destroyed, ['writer'])
})
