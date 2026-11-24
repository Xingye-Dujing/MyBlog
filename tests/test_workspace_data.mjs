/* Data / Planner / Message workspace regressions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parse } from 'acorn'

const read = (name) => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8')
const dataSource = read('omm-data.html')
const plannerSource = read('omm-planner.html')
const messageSource = read('omm-message.html')
const plain = (value) => JSON.parse(JSON.stringify(value))
const deepEqual = (actual, expected) => assert.deepEqual(plain(actual), plain(expected))

const scriptLists = new Map([dataSource, plannerSource, messageSource].map((source) => [
  source,
  [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]),
]))
const asts = new Map()

function astFor(script) {
  if (!asts.has(script)) asts.set(script, parse(script, { ecmaVersion: 'latest' }))
  return asts.get(script)
}

function nodes(root) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    out.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((x) => x && typeof x.type === 'string' && stack.push(x))
      else if (value && typeof value.type === 'string') stack.push(value)
    }
  }
  return out
}

function fnSource(source, name) {
  for (const script of scriptLists.get(source)) {
    const node = nodes(astFor(script)).find((x) => x.type === 'FunctionDeclaration' && x.id?.name === name)
    if (node) return script.slice(node.start, node.end)
  }
  assert.fail(`${name} not found`)
}

function methodSource(source, name, needle) {
  for (const script of scriptLists.get(source)) {
    const node = nodes(astFor(script)).find((x) => x.type === 'Property' && x.method &&
      (x.key.name === name || x.key.value === name) && script.slice(x.start, x.end).includes(needle))
    if (node) return script.slice(node.start, node.end)
  }
  assert.fail(`${name} method not found`)
}

function compileFunctions(source, names, globals = {}, extra = '') {
  const context = vm.createContext({ ...globals })
  const code = names.map((name) => fnSource(source, name)).join('\n') + '\n' + extra
  return vm.runInContext(`(function () {\n${code}\nreturn { ${names.join(', ')} }\n})()`, context)
}

let tableId = 0
const dataGlobals = {
  T: (key) => key,
  uid: () => 't' + ++tableId,
  CONFIG: { MIN_ROW_H: 20 },
}
const dataCoreNames = [
  'isNil', 'idxToCol', 'colRefToIdx', 'normAlign', 'normTable', 'inferTypes',
  'tokenize', 'P', 'sqlColumnType', 'sqlCreateColumns', 'sqlNameList', 'sqlLiteral',
  'sqlTuples', 'sqlEnsureColumns', 'fromSQLText', 'detectDelim', 'fromJSON', 'toJSON',
]
const dataCore = compileFunctions(dataSource, dataCoreNames, dataGlobals, dataSource.slice(
  dataSource.indexOf('P.prototype.pk ='),
  dataSource.indexOf('P.prototype.expr ='),
))

test('SQL 导入完整处理类型参数、约束、字符串标点和多语句多行 INSERT', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS "orders" (
      id INTEGER PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      price DECIMAL(10,2),
      note TEXT,
      CONSTRAINT positive CHECK (price > 0 AND price IN (1, 2, 3.5)),
      FOREIGN KEY (id) REFERENCES users(id)
    );
    INSERT INTO [orders] (id, name, price, note) VALUES
      (1, 'semi;colon,comma', 12.5, 'O''Brien'),
      (2, 'multi
line', 0, 'said "hello"');
    INSERT INTO orders (id, name) VALUES (3, 'subset');
  `
  const tables = dataCore.fromSQLText(sql)
  assert.equal(tables.length, 1)
  const table = tables[0]
  deepEqual(table.cols.map((c) => c.name), ['id', 'name', 'price', 'note'])
  deepEqual(table.rows, [
    [1, 'semi;colon,comma', 12.5, "O'Brien"],
    [2, 'multi\nline', 0, 'said "hello"'],
    [3, 'subset', null, null],
  ])
})

test('SQL 导入拒绝不完整语句，不生成空白成功表', () => {
  for (const sql of [
    'CREATE TABLE broken (id INTEGER, name VARCHAR(100)',
    "INSERT INTO broken (id, name) VALUES (1, 'unterminated);",
    "INSERT INTO broken (id, name) VALUES (1, 'x'), (2);",
    'CREATE TABLE empty_table (PRIMARY KEY (id));',
  ]) assert.throws(() => dataCore.fromSQLText(sql))
})

test('自动分隔符只统计引号外计数', () => {
  assert.equal(dataCore.detectDelim('"last, first";age\n"Doe; Jane";30'), ';')
  assert.equal(dataCore.detectDelim('"last; first",age\n"Doe, Jane",30'), ',')
  assert.equal(dataCore.detectDelim('"a,b"\tc'), '\t')
})

test('JSON headers+rows 保真重复列与 __proto__/constructor，并兼容旧对象格式', () => {
  const table = {
    cols: [
      { name: '__proto__', type: 'text' },
      { name: 'constructor', type: 'text' },
      { name: 'dup', type: 'text' },
      { name: 'dup', type: 'text' },
    ],
    rows: [['p', 'c', 'first', 'second']],
  }
  const exported = JSON.parse(dataCore.toJSON(table))
  deepEqual(exported.headers, table.cols.map((c) => c.name))
  const imported = dataCore.fromJSON(JSON.stringify(exported))
  deepEqual(imported.cols.map((c) => c.name), exported.headers)
  deepEqual(imported.rows, table.rows)

  const legacy = dataCore.fromJSON('[{"__proto__":"p"},{"constructor":"c"}]')
  deepEqual(legacy.cols.map((c) => c.name), ['__proto__', 'constructor'])
  deepEqual(legacy.rows, [['p', null], [null, 'c']])
  assert.equal({}.p, undefined)
  assert.throws(() => dataCore.fromJSON(JSON.stringify({
    headers: ['dup', 'dup'], rows: [{ dup: 'ambiguous' }],
  })))
})

class MiniDOMParser {
  parseFromString(text) {
    const decode = (value) => value.replace(/&(#x?[0-9a-f]+|quot|apos|lt|gt|amp);/gi, (_, entity) => {
      if (entity[0] === '#') {
        const hex = entity[1].toLowerCase() === 'x'
        return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10))
      }
      return { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[entity.toLowerCase()]
    })
    const root = { children: [], textContent: '', getAttribute: () => null }
    const stack = [root]
    const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/?([A-Za-z_][\w:.-]*)([^>]*)>|([^<]+)/g
    let match
    while ((match = token.exec(text))) {
      if (match[1] !== undefined) {
        stack.at(-1).children.push({ text: match[1] })
      } else if (match[2]) {
        if (match[0][1] === '/') {
          stack.pop()
          continue
        }
        const attrs = {}
        for (const a of match[3].matchAll(/([:\w.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = decode(a[2])
        const node = {
          name: match[2], attrs, children: [],
          getAttribute: (name) => attrs[name] ?? null,
          getAttributeNS: (_ns, name) => Object.entries(attrs).find(([key]) => key === name || key.endsWith(':' + name))?.[1] ?? null,
          get textContent() { return this.children.map((x) => x.text ?? x.textContent).join('') },
        }
        stack.at(-1).children.push(node)
        if (!match[0].endsWith('/>')) stack.push(node)
      } else if (match[4]) stack.at(-1).children.push({ text: decode(match[4]) })
    }
    const decorate = (node) => {
      node.getElementsByTagNameNS = (_ns, name) => {
        const out = []
        const visit = (current) => {
          for (const child of current.children || []) {
            if (!child.name) continue
            if (name === '*' || child.name === name || child.name.endsWith(':' + name)) out.push(child)
            visit(child)
          }
        }
        visit(node)
        return out
      }
      for (const child of node.children || []) if (child.name) decorate(child)
    }
    decorate(root)
    return root
  }
}

const xlsxNames = [
  'zipStore', 'unzip', 'inflateRaw', 'escXml', 'sheetXml', 'safeSheetName', 'xlsxBlob',
  'xmlDoc', 'tagAll', 'parseSheetXml', 'xlsxRead', 'isNil', 'idxToCol', 'colRefToIdx',
  'inferTypes',
]
const xlsxApi = compileFunctions(dataSource, xlsxNames, {
  ...dataGlobals,
  TextEncoder, TextDecoder, Blob, Response, DecompressionStream, Uint8Array, DataView,
  DOMParser: MiniDOMParser,
  ZenUtil: { esc: (value) => String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]) },
}, dataSource.slice(dataSource.indexOf('var CRC_T ='), dataSource.indexOf('function zipStore')))

test('XLSX sheetXml 始终输出列名表头，空表也保留', () => {
  const xml = xlsxApi.sheetXml({ cols: [{ name: 'A&B' }, { name: 'constructor' }], rows: [] })
  assert.match(xml, /<row r="1">/)
  assert.match(xml, /A&amp;B/)
  assert.match(xml, /constructor/)
})

test('XLSX 导出→导入 round-trip 保留表头、空表与特殊列名', async () => {
  const tables = [
    {
      name: 'Round & Trip',
      cols: [{ name: '__proto__', type: 'text' }, { name: 'constructor', type: 'text' }, { name: 'dup', type: 'text' }],
      rows: [['p', 'c', 'v']],
    },
    { name: 'Empty', cols: [{ name: 'still', type: 'text' }, { name: 'here', type: 'text' }], rows: [] },
  ]
  const blob = xlsxApi.xlsxBlob(tables)
  const imported = await xlsxApi.xlsxRead(await blob.arrayBuffer())
  deepEqual(imported[0].cols.map((c) => c.name), ['__proto__', 'constructor', 'dup'])
  deepEqual(imported[0].rows, [['p', 'c', 'v']])
  deepEqual(imported[1].cols.map((c) => c.name), ['still', 'here'])
  deepEqual(imported[1].rows, [[null, null]])
})

const plannerDateApi = compileFunctions(plannerSource, [
  'addD', 'dowIndex', 'weekdayRow', 'startOfWeek', 'monthMatrix',
], {
  S: { weekStart: 0 },
  t: () => '周一|周二|周三|周四|周五|周六|周日',
})

test('weekStart=0 时表头、日期起点与周末高亮一致', () => {
  const row = plannerDateApi.weekdayRow()
  deepEqual(row.map((x) => x.name), ['周日', '周一', '周二', '周三', '周四', '周五', '周六'])
  deepEqual(row.map((x) => x.wkend), [true, false, false, false, false, false, true])
  const matrix = plannerDateApi.monthMatrix(2026, 11)
  assert.equal(matrix.cells[0].getFullYear(), 2026)
  assert.equal(matrix.cells[0].getMonth(), 10)
  assert.equal(matrix.cells[0].getDate(), 1)
})

const markdownApi = compileFunctions(plannerSource, ['exportableItems', 'markdownExport'], {
  S: { cursor: new Date(2026, 10, 1), lang: 'zh' },
  Store: {
    sorted: (ds) => ds === '2026-11-03' ? [
      { type: 'todo', title: '公开标题', note: '公开备注', done: false },
      { type: 'event', title: '秘密标题', note: '秘密备注', time: '09:00', hidden: true },
    ] : [],
    recurs: [
      { title: '公开重复', rrule: { mode: 'daily', start: '2026-11-01' } },
      { title: '隐藏重复标题', note: '隐藏重复备注', rrule: { mode: 'daily', start: '2026-11-01' }, hidden: true },
    ],
  },
  pd: (ds) => new Date(ds + 'T00:00:00'),
  pad: (n) => String(n).padStart(2, '0'),
  dayInfo: () => ({}),
  t: (key) => ({
    months: '一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月',
    'wd.row': '周一|周二|周三|周四|周五|周六|周日',
    'md.rules': '重复规则',
    'rep.daily': '每天',
  })[key] || key,
})

test('Markdown 导出复用可导出视图，不泄露 hidden 标题和备注', () => {
  const md = markdownApi.markdownExport()
  assert.match(md, /公开标题/)
  assert.match(md, /公开备注/)
  assert.match(md, /公开重复/)
  assert.doesNotMatch(md, /秘密标题|秘密备注|隐藏重复标题|隐藏重复备注/)
})

function plannerStorage(overrides = {}) {
  const values = new Map()
  const localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    ...overrides,
  }
  return { values, localStorage }
}

test('CountStore 从云信封写回 counts；旧快照缺 counts 保留本地', () => {
  const loadMethod = methodSource(plannerSource, 'load', 'LS_COUNT')
  const persistMethod = methodSource(plannerSource, 'persist', 'Store.saveDoc()')
  const factory = new Function('CONFIG', 'localStorage', 'normCount', 'todayDS', 'uid', 'Store',
    `return { records: [], ${loadMethod}, ${persistMethod} }`)
  const { values, localStorage } = plannerStorage()
  values.set('zp-data-v2', JSON.stringify({ planners: [{ id: 'p1' }] }))
  values.set('zp-count-v1', JSON.stringify({ records: [{ id: 'old', title: '本地倒数' }] }))
  let savedDoc = 0
  const store = factory(
    { LS_DATA: 'zp-data-v2', LS_COUNT: 'zp-count-v1' },
    localStorage,
    (raw) => ({ ...raw, id: String(raw.id) }),
    () => '2026-11-24',
    () => 'new',
    { saveDoc: () => { savedDoc++ } },
  )
  store.load()
  deepEqual(store.records.map((x) => x.id), ['old'])
  store.records = [{ id: 'cloud', title: '云端倒数' }]
  store.persist()
  assert.equal(savedDoc, 1)
  deepEqual(JSON.parse(values.get('zp-count-v1')).records.map((x) => x.id), ['cloud'])
})

test('Planner 云快照 counts 按 id 合并，旧远端不清空本地', () => {
  const api = compileFunctions(plannerSource, ['mergeCounts', 'mergeData'], {
    ZenUtil: { clone: (value) => structuredClone(value) },
  })
  const local = { planners: [{ id: 'p1' }], counts: [{ id: 'same', title: 'local' }, { id: 'local', title: 'keep' }] }
  const remote = { planners: [{ id: 'p1' }], counts: [{ id: 'same', title: 'remote' }, { id: 'remote', title: 'new' }] }
  const merged = api.mergeData(local, remote)
  deepEqual(merged.counts.map((x) => x.id), ['same', 'remote', 'local'])
  assert.equal(merged.counts[0].title, 'remote')
  deepEqual(api.mergeData(local, { planners: [{ id: 'p1' }] }).counts, local.counts)
})

test('云写回保留旧快照缺失的 counts，并同步独立计数存储', () => {
  const writes = {}
  const api = compileFunctions(plannerSource, ['mergeCounts', 'localData', 'writeLocal'], {
    DATA_KEY: 'zp-data-v2',
    tr: (key) => key,
    now: () => 123,
    mark: () => {},
    ZenUtil: { clone: (value) => structuredClone(value) },
    localStorage: {
      getItem: (key) => ({
        'zp-data-v2': JSON.stringify({ planners: [{ id: 'p1' }], counts: [{ id: 'local', title: 'keep' }] }),
        'zp-count-v1': JSON.stringify({ records: [{ id: 'legacy', title: 'legacy' }] }),
        'zp-settings-v1': '{}',
      })[key] ?? null,
      setItem: (key, value) => { writes[key] = value },
    },
  })
  api.writeLocal({ planners: [{ id: 'p1' }] })
  const doc = JSON.parse(writes['zp-data-v2'])
  deepEqual(doc.counts.map((x) => x.id), ['local'])
  deepEqual(JSON.parse(writes['zp-count-v1']).records.map((x) => x.id), ['local'])
})

test('saveDoc 同步 flush 暴露存储失败，pagehide/beforeunload 都接线', () => {
  const saveMethod = methodSource(plannerSource, 'saveDoc', 'counts: CountStore.records')
  const notices = []
  const factory = new Function('CONFIG', 'CountStore', 'notify', 't', 'localStorage',
    `return ({ ${saveMethod} }).saveDoc`)
  let saved = ''
  const successful = factory(
    { LS_DATA: 'zp-data-v2' },
    { records: [{ id: 'c1' }] },
    () => {},
    (key) => key,
    { setItem: (_key, value) => { saved = value } },
  )
  assert.equal(successful.call({
    planners: [{ id: 'p1' }], activeId: 'p1', eventsBy: {}, recursBy: {},
  }), true)
  deepEqual(JSON.parse(saved).counts, [{ id: 'c1' }])

  const save = factory(
    { LS_DATA: 'zp-data-v2' },
    { records: [{ id: 'c1' }] },
    (message) => notices.push(message),
    (key) => key,
    { setItem() { throw new Error('quota') } },
  )
  const result = save.call({
    planners: [{ id: 'p1' }], activeId: 'p1', eventsBy: {}, recursBy: {},
  })
  assert.equal(result, false)
  deepEqual(notices, ['notify.saveFailed'])
  const flush = new Function('Store', fnSource(plannerSource, 'flushSaveDoc') + '\nreturn flushSaveDoc')
  let flushed = 0
  assert.equal(flush({ flushSaveDoc: () => { flushed++; return true } })(), true)
  assert.equal(flushed, 1)
  assert.match(plannerSource, /window\.addEventListener\('pagehide', flushSaveDoc\)/)
  assert.match(plannerSource, /window\.addEventListener\('beforeunload', flushSaveDoc\)/)
})

test('Planner 移除主题与圆角控制，仅独立模式固定浅色', () => {
  assert.doesNotMatch(plannerSource, /settingsToggleTheme|radiusDown|radiusUp|sv-theme|sv-radius/)
  assert.match(plannerSource, /if \(!document\.documentElement\.classList\.contains\('omm-embed'\)\) ZenUtil\.themeApply\(false\)/)
  assert.doesNotMatch(plannerSource, /setProperty\('--radius'|setProperty\('--zen-radius'|setAttribute\('data-theme'/)
})

function messageHarness(functions, overrides = {}) {
  const values = new Map()
  const config = { url: 'https://one.supabase.co', key: 'key', email: 'a@example.com' }
  const context = vm.createContext({
    LS: { cache: 'zmsg-message-cache-v1' }, TABLE: 'zmessage_messages', META_TABLE: 'zmessage_message_meta',
    cfg: () => config,
    session: { user: { id: 'u1', email: 'a@example.com' } },
    password: 'pw', sb: {}, realtimeReady: false, syncMode: 'manual', channel: null,
    activeCacheKey: null, messages: [], favoriteIds: new Set(), metaAvailable: false,
    favoriteFilter: false, searchQuery: '', editingId: null, deviceId: 'd1', deviceName: '',
    busy: false, lang: 'zh', renderCount: 0,
    localStorage: {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    ZenUtil: {
      getJSON: (key, fallback) => {
        try { return values.has(key) ? JSON.parse(values.get(key)) : fallback } catch { return fallback }
      },
    },
    lsDel: (key) => values.delete(key),
    $: () => ({ value: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} } }),
    renderMessages: () => { context.renderCount++ },
    normalizeMessage: (m) => ({ ...m }),
    toast: () => {}, t: (key) => key, friendly: (e) => e.message,
    ...overrides,
  })
  const code = functions.map((name) => fnSource(messageSource, name)).join('\n')
  context.api = vm.runInContext(`(function () {\n${code}\nreturn { ${functions.join(', ')} }\n})()`, context)
  return { context, values, config, api: context.api }
}

test('Message 缓存按 project+user+email 命名空间隔离，身份不匹配不渲染', () => {
  const { context, values, config, api } = messageHarness([
    'cacheIdentity', 'cacheKey', 'cacheMatches', 'activateCacheIdentity', 'persistCache', 'loadCache',
  ])
  api.activateCacheIdentity()
  context.messages = [{ id: 'm1', text: 'secret' }]
  context.favoriteIds.add('m1')
  api.persistCache()
  const firstKey = context.activeCacheKey
  assert.match(firstKey, /^zmsg-message-cache-v1:https%3A%2F%2Fone\.supabase\.co:u1:a%40example\.com$/)
  assert.ok(values.has(firstKey))

  config.url = 'https://two.supabase.co'
  context.session = { user: { id: 'u2', email: 'b@example.com' } }
  config.email = 'b@example.com'
  context.activeCacheKey = null
  const before = context.renderCount
  assert.equal(api.loadCache(), false)
  assert.equal(context.renderCount, before + 1)
  deepEqual(context.messages, [])

  config.url = 'https://one.supabase.co'
  context.session = { user: { id: 'u1', email: 'a@example.com' } }
  config.email = 'a@example.com'
  assert.equal(api.loadCache(), true)
  assert.equal(context.messages[0].text, 'secret')

  config.email = 'different@example.com'
  assert.equal(api.cacheIdentity(), null)
  assert.equal(api.loadCache(), false)
  assert.match(fnSource(messageSource, 'logout'), /clearActiveCache\(\)/)
  assert.match(fnSource(messageSource, 'saveConfig'), /if \(changed\)[\s\S]*clearActiveCache\(\)/)
})

test('手动模式 CRUD 只要求 session/password/sb；登出或锁定仍拒绝', () => {
  const { context, api } = messageHarness(['requireCloudAction', 'connState'])
  context.realtimeReady = false
  for (const kind of ['quote', 'edit', 'delete']) assert.equal(api.requireCloudAction(kind), true)
  assert.equal(api.connState(), 'status.manual')
  context.session = null
  assert.equal(api.requireCloudAction('delete'), false)
  context.session = { user: { id: 'u1' } }
  context.password = ''
  assert.equal(api.requireCloudAction('edit'), false)
})

test('历史按时间降序取 250 后反转为显示顺序', async () => {
  const calls = {}
  const rows = [3, 2, 1].map((ts) => ({
    id: 'm' + ts, device_id: 'd', device_name: 'D', client_created_at: ts,
    payload: JSON.stringify({ __zmsg: 1, text: 'message ' + ts }),
  }))
  const chain = {
    select() { return this }, eq() { return this },
    order(column, options) { calls.order = { column, options }; return this },
    limit(limit) { calls.limit = limit; return Promise.resolve({ data: rows }) },
  }
  const { context, api } = messageHarness([
    'normalizeMessage', 'messageFromPayload', 'resolveQuoteStatus', 'fetchHistory',
  ], {
    sb: { from: () => chain },
    dec: async (payload) => JSON.parse(payload),
    persistCache: () => {}, fetchMessageMeta: async () => {},
  })
  await api.fetchHistory()
  deepEqual(calls.order, { column: 'client_created_at', options: { ascending: false } })
  assert.equal(calls.limit, 250)
  deepEqual(context.messages.map((m) => m.ts), [1, 2, 3])
})

test('定位 250 条窗口之外的旧引用目标时不会因裁剪而当作删除', () => {
  const { context, api } = messageHarness(['normalizeMessage', 'addMessage'], {
    persistCache: () => {},
  })
  context.messages = Array.from({ length: 250 }, (_, i) => ({ id: 'm' + (i + 2), ts: i + 2 }))
  api.addMessage({ id: 'old', ts: 1, text: 'older quote target' }, true)
  assert.equal(context.messages.length, 251)
  assert.equal(context.messages[0].id, 'old')
  api.addMessage({ id: 'newest', ts: 252 })
  assert.equal(context.messages.length, 250)
  assert.equal(context.messages.some((m) => m.id === 'old'), false)
})

test('引用目标不在当前页时只有云端确认删除才标记删除', async () => {
  let existing = ['old']
  const chain = {
    select() { return this }, eq() { return this },
    in() { return Promise.resolve({ data: existing.map((id) => ({ id })) }) },
  }
  const { context, api } = messageHarness(['resolveQuoteStatus'], {
    sb: { from: () => chain },
  })
  const list = [{ id: 'new', quoteId: 'old', quoteDeleted: false }]
  assert.equal((await api.resolveQuoteStatus(list))[0].quoteDeleted, false)
  existing = []
  assert.equal((await api.resolveQuoteStatus(list))[0].quoteDeleted, true)
})

test('Message 移除主题与圆角控制，仅独立模式固定浅色', () => {
  assert.doesNotMatch(messageSource, /theme-btn|radius-down|radius-up|radius-value/)
  assert.match(messageSource, /if \(!document\.documentElement\.classList\.contains\('omm-embed'\)\) ZenUtil\.themeApply\(false\)/)
  assert.doesNotMatch(messageSource, /setProperty\('--radius'|setProperty\('--zen-radius'|setAttribute\('data-theme'/)
})
