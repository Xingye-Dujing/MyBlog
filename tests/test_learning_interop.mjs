/* English / Corpus / ZenCard 与直接共享库的跨产品回归。
 * 运行：node --test tests/test_learning_interop.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { ZenCard } from '../public/lib/zen-card.js'
import { ZenSRS } from '../public/lib/zen-srs.js'

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')
const english = read('public/omm-english.html')
const corpus = read('public/omm-corpus.html')
const zencard = read('public/omm-zencard.html')
const bridgeSource = read('public/lib/omm-bridge.js')
const utilSource = read('public/zen/foundation/util.js')
const plain = (value) => JSON.parse(JSON.stringify(value))

function extractFunction(source, name) {
  const match = source.match(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('))
  assert.ok(match, `missing function ${name}`)
  const start = match.index
  const open = source.indexOf('{', start)
  let depth = 0, quote = '', lineComment = false, blockComment = false, canStartRegex = true
  for (let i = open; i < source.length; i++) {
    const ch = source[i], next = source[i + 1]
    if (lineComment) { if (ch === '\n') lineComment = false; continue }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++ } continue }
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; canStartRegex = false; continue }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue }
    if (ch === '/' && canStartRegex) {
      let j = i + 1, inClass = false, closed = false
      for (; j < source.length; j++) {
        if (source[j] === '\\') { j++; continue }
        if (source[j] === '[') inClass = true
        else if (source[j] === ']') inClass = false
        else if (source[j] === '/' && !inClass) { closed = true; break }
        else if (source[j] === '\n') break
      }
      if (closed) { i = j; canStartRegex = false; continue }
    }
    if (ch === '{') { depth++; canStartRegex = true; continue }
    if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
      canStartRegex = false
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1
      while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j++
      const word = source.slice(i, j)
      canStartRegex = /^(return|throw|case|delete|void|typeof|new|in|of|yield|await)$/.test(word)
      i = j - 1
      continue
    }
    if (/\d/.test(ch)) {
      let j = i + 1
      while (j < source.length && /[\w.]/.test(source[j])) j++
      canStartRegex = false
      i = j - 1
      continue
    }
    canStartRegex = !/[\])\.]/.test(ch)
  }
  throw new Error(`unbalanced function ${name}`)
}

function loadFunctions(source, names, context = {}) {
  const code = names.map((name) => extractFunction(source, name)).join('\n') +
    '\n;({' + names.join(',') + '})'
  return vm.runInNewContext(code, context)
}

function memoryStorage() {
  const data = new Map()
  return {
    data,
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  }
}

function loadBridge() {
  let now = 1000
  const storage = memoryStorage()
  const timers = []
  const listeners = {}
  const document = {
    currentScript: { getAttribute: () => 'omm-english' },
    addEventListener: (type, fn) => { listeners['doc:' + type] = fn },
    hidden: false,
  }
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn },
  }
  const ZenUtil = {
    nz: (v) => String(v ?? '').trim(),
    low: (v) => String(v ?? '').trim().toLowerCase(),
    kz: (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
    tags: (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [],
    nowISO: () => new Date(now).toISOString(),
    fileStamp: () => 'stamp',
    download: () => true,
    saveJSON: () => true,
    getJSON: (key, fallback) => {
      try { return JSON.parse(storage.getItem(key) ?? 'null') ?? fallback } catch { return fallback }
    },
  }
  vm.runInNewContext(bridgeSource, {
    window, document, localStorage: storage, ZenUtil,
    Date: { now: () => now },
    Math, console, setTimeout: (fn) => { timers.push(fn); return timers.length },
  })
  return {
    api: window.OMMBridge, storage, timers, listeners,
    setNow: (value) => { now = value },
    box: () => JSON.parse(storage.getItem('omm.bridge.inbox.v1') || '[]'),
  }
}

function packet(id, to = 'omm-english') {
  return { id, to, from: 'omm-corpus', ts: '2026-01-01T00:00:00.000Z', env: { omm: 'bridge', v: 1, items: [] } }
}

function englishApplyContext() {
  let sequence = 0
  const state = { books: {}, listen: [] }
  const context = {
    S: state, WV: {}, DICT: null, Listen: {},
    Date: { now: () => 1000 },
    ZenUtil: { uid: (prefix) => (prefix || '') + (++sequence) },
    OMM: { nz: (v) => String(v ?? '').trim(), nameOf: (id) => id },
    nkey: (v) => String(v || '').trim().toLowerCase(),
    ensureNotes: () => ({}),
    parseSubs: (text) => ({ segs: text.split(/(?<=\.)\s+/).filter(Boolean).map((text) => ({ text })) }),
    save: () => {}, refreshView: () => {}, switchView: () => {}, notify: () => {},
  }
  return { context, state, api: loadFunctions(english, ['zbApply'], context) }
}

function corpusApplyContext() {
  let sequence = 0
  const state = { entries: [], categories: [] }
  const context = {
    S: state,
    OMM: { nz: (v) => String(v ?? '').trim() },
    clean: (v) => String(v || '').trim(),
    norm: (v) => String(v || '').trim().toLowerCase(),
    uid: () => 'c' + (++sequence),
    now: () => '2026-01-01T00:00:00.000Z',
    save: () => {}, populateCats: () => {}, renderAll: () => {},
  }
  return { context, state, api: loadFunctions(corpus, ['ensureCat', 'zbApply'], context) }
}

/* --------------------------------- modules -------------------------------- */

test('English 导入的 meaning/example 在持久化后仍只以转义文本进入高亮 HTML', () => {
  const context = {
    ZenUtil: {
      esc: (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      escRe: (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    },
  }
  const api = loadFunctions(english, ['esc', 'highlightExample', 'parseVocab'], context)
  const payload = '<img src=x onerror="globalThis.pwned=1"> & abandon'
  const rows = api.parseVocab(JSON.stringify([{ w: 'abandon', m: payload, ex: 'Use ' + payload }]))
  assert.equal(rows[0][2], payload)
  const meaning = api.esc(rows[0][2])
  const highlighted = api.highlightExample(rows[0][3], rows[0][0])
  assert.ok(meaning.includes('&lt;img'))
  assert.ok(!meaning.includes('<img'))
  assert.ok(highlighted.includes('<em>abandon</em>'))
  assert.ok(highlighted.includes('&lt;img'))
  assert.ok(!highlighted.includes('<img'))
  assert.ok(!highlighted.includes('<script'))
  const block = english.slice(english.indexOf('let hintHtml'), english.indexOf('const modeLabel'))
  assert.match(block, /esc\(meaning\)/)
  assert.doesNotMatch(block, /example\.replace/)
})

test('English 多文件 bridge 导入在同一毫秒生成不同词书与听力 ID', () => {
  const { state, api } = englishApplyContext()
  api.zbApply([{ t: 'word', w: 'one', m: '一' }, { t: 'doc', title: 'A', text: 'First. Second.', zh: '第一。第二。' }], null, null)
  api.zbApply([{ t: 'word', w: 'two', m: '二' }, { t: 'sentence', en: 'Third.', zh: '第三。' }], null, null)
  const books = Object.values(state.books)
  assert.equal(books.length, 2)
  assert.equal(new Set(books.map((book) => book.id)).size, 2)
  assert.equal(state.listen.length, 2)
  assert.equal(new Set(state.listen.map((item) => item.id)).size, 2)
  assert.equal(state.listen[0].segs.length, 1)
  assert.equal(state.listen[0].segs[0].text, 'First. Second.')
  assert.equal(state.listen[0].zh[0], '第一。第二。')
  assert.equal(state.listen[1].zh[0], '第三。')
})

test('English 无译文段落才分句，有译文时整段无损保留', () => {
  const { state, api } = englishApplyContext()
  api.zbApply([{ t: 'doc', title: 'plain', text: 'First. Second.' }], null, null)
  assert.equal(state.listen[0].segs.length, 2)
  assert.deepEqual(plain(state.listen[0].zh), ['', ''])
})

test('Corpus 导出与下载桥接清空 apiKey，但本地状态不变', () => {
  const state = { entries: [], settings: { apiKey: 'sk-secret', aiMainWidth: 0.61 } }
  const api = loadFunctions(corpus, ['exportData'], {
    S: state, clone: (value) => plain(value), now: () => '2026-01-01T00:00:00.000Z',
  })
  const exported = JSON.parse(api.exportData())
  assert.equal(exported.settings.apiKey, '')
  assert.equal(exported.settings.aiMainWidth, 0.61)
  assert.equal(state.settings.apiKey, 'sk-secret')
  assert.match(corpus, /ZenUtil\.download\([^\n]*exportData\(\)/)
  assert.match(corpus, /export:\s*\(\)\s*=>\s*exportData\(\)/)
})

test('Corpus 段落 bridge 往返保留 d.zh', () => {
  const bridge = loadBridge()
  const item = bridge.api.entryToItem({ type: 'paragraph', en: 'First. Second.', zh: '第一。第二。' })
  assert.equal(item.t, 'doc')
  assert.equal(item.zh, '第一。第二。')
  const englishRun = englishApplyContext()
  englishRun.api.zbApply([item], null, null)
  assert.equal(englishRun.state.listen[0].zh[0], item.zh)
  const corpusRun = corpusApplyContext()
  corpusRun.api.zbApply([item], null, null)
  assert.equal(corpusRun.state.entries[0].type, 'paragraph')
  assert.equal(corpusRun.state.entries[0].zh, item.zh)
})

test('ZenCard.parsePack 严格拒绝版本或任意一张非法卡片', () => {
  const card = ZenCard.create({ id: 'a', content: 'A' })
  for (const v of [undefined, '1', 2, true]) {
    assert.throws(() => ZenCard.parsePack({ format: 'zen-card-pack', v, cards: [card] }), /非法 zen-card-pack/)
  }
  assert.throws(() => ZenCard.parsePack({ format: 'zen-card-pack', v: 1, name: {}, cards: [card] }), /name/)
  assert.throws(() => ZenCard.parsePack({ format: 'zen-card-pack', v: 1, cards: [card, { ...card, id: 'b', v: 2 }] }), /cards\[1\]/)
  assert.throws(() => ZenCard.parsePack({ format: 'zen-card-pack', v: 1, cards: [card, { ...card, id: 'b', kind: 'bad' }] }), /cards\[1\]/)
})

test('ZenSRS.deserialize 严格校验版本、id、数值范围和 due/last 类型', () => {
  const state = ZenSRS.createState('a', 0)
  const pack = { format: 'zen-srs', v: 1, states: [state] }
  assert.deepEqual(ZenSRS.deserialize(pack), [state])
  for (const v of [undefined, '1', 2]) {
    assert.throws(() => ZenSRS.deserialize({ ...pack, v }), /非法 zen-srs/)
  }
  const invalid = [
    { id: '' }, { id: 1 }, { reps: -1 }, { reps: 1.5 }, { lapses: -1 },
    { interval: -1 }, { interval: 1.5 }, { ease: 1.2 }, { ease: Infinity },
    { due: '0' }, { due: -1 }, { due: NaN }, { due: 1.5 }, { last: '0' }, { last: -1 }, { last: 1.5 }, { last: undefined },
  ]
  for (const patch of invalid) {
    assert.throws(() => ZenSRS.deserialize({ ...pack, states: [{ ...state, ...patch }] }), /非法 zen-srs/)
  }
  assert.throws(() => ZenSRS.deserialize({ ...pack, states: [state, { ...state }] }), /id 重复/)
  assert.throws(() => ZenSRS.deserialize({ ...pack, states: [state, { ...state, id: 'b', due: 'bad' }] }), /states\[1\]/)
})

test('stripHtml/fromWebSelection 移除 script/style/template/noscript 的正文', () => {
  const html = ' before <ScRiPt data-x=">">alert(1)</sCrIpT>' +
    '<style>.bad{display:none}</style><template><img src=x onerror=alert(1)></template>' +
    '<noscript><b>noscript body</b></noscript><p>safe &amp; sound</p> after '
  assert.equal(ZenCard.stripHtml(html), 'before safe & sound after')
  assert.equal(ZenCard.stripHtml('keep<script src=x>unclosed body'), 'keep')
  const card = ZenCard.fromWebSelection({ text: html })
  assert.equal(card.content, 'before safe & sound after')
  assert.ok(!card.content.includes('alert'))
  assert.ok(!card.content.includes('noscript body'))
})

/* -------------------------------- bridge inbox ------------------------------ */

test('OMMBridge inbox 租约在成功前不删除，过期后可重新租借', () => {
  const run = loadBridge()
  run.storage.setItem('omm.bridge.inbox.v1', JSON.stringify([packet('mine'), packet('other', 'omm-corpus')]))
  const lease = run.api.peek()
  assert.equal(lease.packet.id, 'mine')
  assert.equal(run.box().length, 2)
  assert.equal(run.api.peek(), null)
  run.setNow(1000 + 120001)
  const again = run.api.peek()
  assert.notEqual(again.token, lease.token)
  assert.equal(run.api.release(lease.id, lease.token), false)
  assert.equal(run.api.release(again.id, again.token), true)
  assert.deepEqual(run.box().map((item) => item.id), ['other'])
})

test('OMMBridge watch 取消或应用异常会重入队，仅成功才删除', async () => {
  const run = loadBridge()
  run.storage.setItem('omm.bridge.inbox.v1', JSON.stringify([packet('p1')]))
  let attempts = 0
  run.api.watch(async () => ++attempts === 1 ? false : true)
  await run.timers[0]()
  assert.equal(run.box().length, 1)
  assert.equal(run.box()[0].lease, undefined)
  await run.timers[0]()
  assert.equal(attempts, 2)
  assert.equal(run.box().length, 0)

  run.storage.setItem('omm.bridge.inbox.v1', JSON.stringify([packet('p2')]))
  run.api.watch(() => { throw new Error('apply failed') })
  await run.timers[1]()
  assert.equal(run.box().length, 1)
  assert.equal(run.box()[0].lease, undefined)

  run.storage.setItem('omm.bridge.inbox.v1', JSON.stringify([packet('p3')]))
  run.api.watch(() => {})
  await run.timers[2]()
  assert.equal(run.box().length, 1)
  assert.equal(run.box()[0].lease, undefined)
})

test('OMMBridge 页面关闭后消息仍在，写入失败不假成功', () => {
  const run = loadBridge()
  run.storage.setItem('omm.bridge.inbox.v1', JSON.stringify([packet('p1')]))
  const lease = run.api.peek()
  assert.equal(run.box()[0].id, lease.id)
  const original = run.storage.setItem
  run.storage.setItem = () => { throw new Error('quota') }
  assert.equal(run.api.deliver('omm-corpus', [], {}), false)
  run.storage.setItem = original
  assert.equal(run.box().length, 1)
})

/* -------------------------------- product sends ----------------------------- */

test('English/Corpus 发送等待 OMMShare.send，集中解析 channel 且不假成功', async () => {
  for (const source of [english, corpus]) {
    let resolveSend, rejectSend
    const sends = [], opens = [], toasts = []
    const context = {
      OMM: {
        ask: async () => true,
        sendMsg: () => 'send?', recvMsg: () => 'receive?', nameOf: (id) => id,
        env: (items, meta) => ({ items, meta }),
      },
      window: { OMMShare: {
        send: (options) => { sends.push(options); return new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject }) },
        openApp: (target) => opens.push(target),
      } },
      notify: (message) => toasts.push(message), toast: (message) => toasts.push(message),
    }
    const api = loadFunctions(source, ['zbMeta', 'zbSend'], context)
    const pending = api.zbSend('omm-english', [{ t: 'sentence', en: 'A' }])
    await new Promise(setImmediate)
    assert.equal(sends.length, 1)
    assert.equal(sends[0].format, 'omm.bridge')
    assert.equal(Object.hasOwn(sends[0], 'channel'), false)
    assert.ok(!toasts.some((message) => message.includes('已发送')))
    resolveSend({ id: 'm1' })
    assert.equal(await pending, true)
    assert.deepEqual(opens, ['omm-english'])
    assert.ok(toasts.some((message) => message.includes('已发送')))

    toasts.length = 0
    const failed = api.zbSend('omm-english', [{ t: 'sentence', en: 'B' }])
    await new Promise(setImmediate)
    rejectSend(new Error('offline'))
    assert.equal(await failed, false)
    assert.ok(toasts.some((message) => message.includes('发送失败')))
    assert.ok(!toasts.some((message) => message.includes('已发送')))
  }
})

/* ---------------------------------- ZenCard --------------------------------- */

function zencardContext(confirmResult = true) {
  let saves = 0, renders = 0
  const cards = [ZenCard.create({ id: 'existing', content: 'existing' })]
  const srs = [ZenSRS.grade(ZenSRS.createState('existing', 0), 'good', 0)]
  const toasts = [], confirms = []
  const context = {
    cards, srs, current: null, ZenCard, ZenSRS,
    Date: { now: () => 1000 },
    save: () => { saves++ },
    renderLibrary: () => { renders++ }, renderStats: () => { renders++ }, renderReview: () => { renders++ },
    $: () => ({ textContent: '' }),
    toast: (message) => toasts.push(message),
    window: { ZenUI: { dialog: { confirm: async (message, options) => { confirms.push({ message, options }); return confirmResult } } } },
  }
  const api = loadFunctions(zencard, ['syncSrs', 'renderAll', 'applyArtifact', 'importSrsText', 'removeCard'], context)
  return { context, api, toasts, confirms, saves: () => saves, renders: () => renders }
}

test('ZenCard 接收 zen-card/pack 后合并并同步 SRS、保存和渲染', () => {
  const run = zencardContext()
  run.api.applyArtifact({ format: 'zen-card', payload: ZenCard.create({ id: 'single', content: 'single' }) })
  assert.equal(run.context.cards.length, 2)
  assert.equal(run.context.srs.length, 2)
  const pack = { format: 'zen-card-pack', v: 1, cards: [ZenCard.create({ id: 'packed', content: 'packed' })] }
  run.api.applyArtifact({ format: 'zen-card-pack', payload: pack })
  assert.equal(run.context.cards.length, 3)
  assert.equal(run.context.srs.length, 3)
  assert.equal(run.context.srs.find((state) => state.id === 'existing').reps, 1)
  assert.equal(run.saves(), 2)
  assert.equal(run.renders(), 6)
  assert.match(zencard, /OMMShare\.onArtifact\(applyArtifact\)/)
})

test('ZenCard 非法整包抛出且不改卡片、进度或 inbox 对象', () => {
  const run = zencardContext()
  const beforeCards = plain(run.context.cards), beforeSrs = plain(run.context.srs)
  const artifact = { format: 'zen-card-pack', payload: { format: 'zen-card-pack', v: 2, cards: [ZenCard.create({ id: 'new', content: 'new' })] } }
  const beforeArtifact = plain(artifact)
  assert.throws(() => run.api.applyArtifact(artifact), /非法 zen-card-pack/)
  assert.deepEqual(plain(run.context.cards), beforeCards)
  assert.deepEqual(plain(run.context.srs), beforeSrs)
  assert.deepEqual(plain(artifact), beforeArtifact)
  assert.equal(run.saves(), 0)
  assert.equal(run.renders(), 0)
})

test('ZenCard 非法 SRS 整包拒绝且不覆盖现有进度', () => {
  const run = zencardContext()
  const before = plain(run.context.srs)
  const valid = ZenSRS.createState('existing', 0)
  const invalid = { format: 'zen-srs', v: 1, states: [valid, { ...valid, id: 'other', due: 'tomorrow' }] }
  assert.throws(() => run.api.importSrsText(JSON.stringify(invalid)), /states\[1\]/)
  assert.deepEqual(plain(run.context.srs), before)
  assert.equal(run.saves(), 0)
  assert.equal(run.renders(), 0)
})

test('ZenCard 删除经 ZenUI 确认，取消不删，确认后同步删除 SRS', async () => {
  const cancelled = zencardContext(false)
  assert.equal(await cancelled.api.removeCard('existing'), false)
  assert.equal(cancelled.context.cards.length, 1)
  assert.equal(cancelled.context.srs.length, 1)
  assert.equal(cancelled.saves(), 0)

  const confirmed = zencardContext(true)
  assert.equal(await confirmed.api.removeCard('existing'), true)
  assert.equal(confirmed.context.cards.length, 0)
  assert.equal(confirmed.context.srs.length, 0)
  assert.equal(confirmed.saves(), 1)
  assert.equal(confirmed.confirms[0].options.danger, true)
})

/* ---------------------------- fixed radius / resizer ------------------------ */

test('Corpus/English 删除圆角 UI 与旧字段，固定 --zen-radius:0', () => {
  for (const source of [corpus, english]) {
    assert.doesNotMatch(source, /radius-(?:minus|plus)|sv-radius|radiusDown|radiusUp/)
    assert.doesNotMatch(source, /radius:\s*0\s*,/)
    assert.match(source, /setProperty\('--zen-radius', '0px'\)/)
  }
  assert.match(english, /delete (?:s\.set|S\.set|clone\.set)\.radius/)
  assert.match(corpus, /delete (?:out\.settings|S\.settings)\.radius/)
  assert.match(english, /drawRoundedEraserStamp/)
  assert.match(english, /drawRoundedEraserStroke/)
  assert.match(english, /--sketch-eraser-radius/)
  assert.match(english, /eraseRadius/)
})

test('旧圆角持久化值在读取/序列化时移除', () => {
  const englishContext = {
    LS_KEY: 'zenglish_v1', WORDS: [],
    localStorage: { getItem: () => JSON.stringify({ set: { radius: 12 }, books: {
      cet6: { id: 'cet6', builtin: true, w: [] }, fav: { id: 'fav', builtin: true, w: [] },
    } }) },
    ZenUtil: { clone: plain },
  }
  const englishApi = loadFunctions(english, ['defaults', 'isRecord', 'safeDict', 'safeId', 'normalizeSrs', 'normalizeState', 'seed', 'load', 'serializeS'], englishContext)
  const loaded = englishApi.load()
  assert.equal(Object.hasOwn(loaded.set, 'radius'), false)
  englishContext.S = loaded
  loaded.set.radius = 12
  assert.equal(Object.hasOwn(englishApi.serializeS().set, 'radius'), false)

  const corpusContext = {
    DEFAULT: { settings: { aiMainWidth: 0.58, system: 'new', chatSystemPrompt: '' }, categories: [], entries: [], stats: {}, chat: [] },
    clone: plain, uid: () => 'id', now: () => '2026-01-01T00:00:00.000Z',
  }
  const corpusApi = loadFunctions(corpus, ['fromRaw'], corpusContext)
  const restored = corpusApi.fromRaw({ entries: [], categories: [], settings: { radius: 12, aiMainWidth: 0.62 } })
  assert.equal(Object.hasOwn(restored.settings, 'radius'), false)
  assert.equal(restored.settings.aiMainWidth, 0.62)
})

test('Corpus AI 分隔条只有 pointer 捕获、键盘和持久化宽度', () => {
  const start = corpus.indexOf("const grid = $('.ai-grid')")
  const end = corpus.indexOf('function syncAIFullscreenViewport', start)
  const block = corpus.slice(start, end)
  assert.match(block, /pointerdown/)
  assert.match(block, /pointermove/)
  assert.match(block, /setPointerCapture/)
  assert.match(block, /pointercancel/)
  assert.match(block, /keydown/)
  assert.match(block, /aiMainWidth/)
  assert.match(block, /save\(\)/)
  assert.doesNotMatch(block, /mousedown|mousemove|mouseup|touchstart|touchmove|touchend/)
  assert.doesNotMatch(corpus, /AI resizer: add touch support|onDragStart\(clientX\)/)
})

/* --------------------------------- zen-link --------------------------------- */

test('共享目标由当前频道权限解析，不维护硬编码产品名单', () => {
  const source = read('public/omm-share.js')
  const availableTargets = vm.runInNewContext(
    '(' + extractFunction(source, 'availableTargets') + ')', { Object },
  )
  const space = {
    channels: [
      {
        id: 'documents',
        apps: [
          { app: 'annotate', name: '文本标注', publish: true, consume: true },
          { app: 'writer', name: '所思所想', publish: true, consume: true },
          { app: 'zencard', name: '间隔复习', publish: true, consume: true },
          { app: 'search', name: '智能搜索', publish: true, consume: false },
        ],
      },
      {
        id: 'notes.english',
        apps: [
          { app: 'annotate', name: '文本标注', publish: true, consume: true },
          { app: 'corpus', name: '英语语料库', publish: true, consume: true },
          { app: 'writer', name: '所思所想', publish: false, consume: true },
        ],
      },
    ],
  }
  assert.deepEqual(plain(availableTargets(space, 'annotate')), [
    { id: 'corpus', name: '英语语料库', channels: ['notes.english'] },
    { id: 'writer', name: '所思所想', channels: ['documents', 'notes.english'] },
    { id: 'zencard', name: '间隔复习', channels: ['documents'] },
  ])
  assert.deepEqual(plain(availableTargets(space, 'missing')), [])
})

test('ZenLink 面板使用共享 popover 与 CSS，不注入私有浮层样式', () => {
  const source = read('public/lib/zen-link.js')
  const styles = read('public/zen/components/components.css')
  assert.ok(source.includes('ZenUI.popover.open(panel, trigger'))
  assert.ok(source.includes('OMMShare.targets()'))
  assert.doesNotMatch(source, /style\.cssText|z-index\s*:|['"]zencard['"],\s*['"]writer['"]/)
  assert.doesNotMatch(source, /innerHTML\s*=\s*[^\n]*selected/)
  assert.ok(styles.includes('.zenlink-panel.open'))
  assert.ok(styles.includes('var(--zen-z-popover)'))
  assert.ok(read('public/omm-message.html').includes('zen/components/popover.js'))
  assert.doesNotMatch(read('public/zen/products/planner.css'), /zen-link-toast|#zen-link-panel/)
})

let zenLinkCase = 0
async function loadZenLink(search, { topLevel = false } = {}) {
  const saved = new Map()
  for (const key of ['window', 'document', 'location', 'localStorage', 'ZenUtil', 'CustomEvent', 'ZenLink']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  const restore = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
  try {
    const storage = memoryStorage()
    const replies = []
    const parent = { postMessage: (message, origin) => { replies.push({ message, origin }) } }
    const location = { origin: 'https://product.example', pathname: '/omm-english.html', href: 'https://product.example/omm-english.html', search }
    const docListeners = {}, winListeners = {}, events = [], toasts = [], artifacts = []
    const document = {
      readyState: 'loading', location, body: { appendChild: () => {} },
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: (type, fn) => { docListeners[type] = fn },
      dispatchEvent: (event) => { events.push(event); return true },
      createElement: () => ({
        style: {}, dataset: {}, className: '', setAttribute: () => {},
        addEventListener: () => {}, remove: () => {},
      }),
    }
    const window = {
      parent: topLevel ? null : parent, location, localStorage: storage,
      ZenUI: { toast: (message) => toasts.push(message) },
      OMMShare: { onArtifact: (fn) => { artifacts.push(fn); return () => {} } },
      addEventListener: (type, fn) => { winListeners[type] = fn },
      getSelection: () => '',
    }
    if (topLevel) window.parent = window
    vm.runInNewContext(utilSource, { window, document, location, URL, URLSearchParams, console })
    Object.assign(globalThis, {
      window, document, location, localStorage: storage, ZenUtil: window.ZenUtil,
      CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail } },
    })
    const module = await import('../public/lib/zen-link.js?case=' + (++zenLinkCase))
    docListeners.DOMContentLoaded()
    return { module, window, parent, storage, replies, events, toasts, artifacts, handler: winListeners.message, restore }
  } catch (error) {
    restore()
    throw error
  }
}

test('zen-link 嵌入时仅接受精确 Hub 父窗口，合法请求仍成功', async (t) => {
  const hub = 'http://127.0.0.1:8321'
  const run = await loadZenLink('?omm_embed=1&omm_hub_origin=' + encodeURIComponent(hub))
  t.after(() => run.restore())
  run.handler({ source: run.parent, origin: hub, data: { type: 'omm:zen-card', card: { id: 'legal', content: 'legal card' } } })
  assert.equal(run.module.ZenLink.readInbox().length, 1)
  run.handler({ source: run.parent, origin: 'https://product.example', data: { type: 'omm:zen-card', card: { id: 'same-origin', content: 'bad' } } })
  run.handler({ source: run.parent, origin: 'http://127.0.0.1:9999', data: { type: 'omm:zen-card', card: { id: 'loopback', content: 'bad' } } })
  run.handler({ source: {}, origin: hub, data: { type: 'omm:zen-card', card: { id: 'opener', content: 'bad' } } })
  assert.equal(run.module.ZenLink.readInbox().length, 1)
  run.storage.setItem('zen.cards.v1', JSON.stringify([{ id: 'own', content: 'own card' }]))
  run.handler({ source: run.parent, origin: hub, data: { type: 'omm:zen-card-request', token: 't1' } })
  assert.equal(run.replies.length, 1)
  assert.equal(run.replies[0].origin, hub)
  assert.equal(run.replies[0].message.type, 'omm:zen-card-reply')
  assert.deepEqual(run.replies[0].message.cards.map((card) => card.id).sort(), ['legal', 'own'])
  assert.equal(run.artifacts.length, 1)
})

test('zen-link 独立时只接受同源父窗口，拒绝顶层和其它 loopback', async () => {
  const run = await loadZenLink('')
  try {
    run.handler({ source: run.parent, origin: 'https://product.example', data: { type: 'omm:zen-card', card: { id: 'same', content: 'same' } } })
    run.handler({ source: run.parent, origin: 'http://localhost:8321', data: { type: 'omm:zen-card', card: { id: 'bad', content: 'bad' } } })
    assert.equal(run.module.ZenLink.readInbox().length, 1)
  } finally {
    run.restore()
  }
  const top = await loadZenLink('', { topLevel: true })
  try {
    top.handler({ source: top.window, origin: 'https://product.example', data: { type: 'omm:zen-card', card: { id: 'top', content: 'top' } } })
    assert.equal(top.module.ZenLink.readInbox().length, 0)
  } finally {
    top.restore()
  }
})

test('zen-link 发送等待共享总线，失败回退本地且不假成功', async (t) => {
  const run = await loadZenLink('')
  t.after(() => run.restore())
  let resolveSend
  run.window.OMMShare.send = (options) => new Promise((resolve) => { resolveSend = resolve })
  const pending = run.module.ZenLink.publish({ content: 'shared' }, 'corpus')
  assert.ok(!run.toasts.some((message) => message.includes('已发送')))
  resolveSend({ id: 'm1' })
  await pending
  assert.ok(run.toasts.some((message) => message.includes('已发送到 corpus')))

  run.toasts.length = 0
  run.window.OMMShare.send = async () => { throw new Error('offline') }
  await run.module.ZenLink.publish({ content: 'fallback' }, 'corpus')
  const local = JSON.parse(run.storage.getItem('zen.cards.v1'))
  assert.equal(local.length, 1)
  assert.equal(local[0].content, 'fallback')
  assert.ok(!run.toasts.some((message) => message.includes('已发送到')))

  run.storage.setItem = () => { throw new Error('quota') }
  assert.equal(await run.module.ZenLink.publish({ content: 'lost' }, ''), null)
  assert.ok(run.toasts.some((message) => message.includes('本地保存也失败')))
})
