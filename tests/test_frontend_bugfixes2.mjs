/* 第二轮前端缺陷回归：共享消息表、链接监听、日程/表格数据容错（node:test）
 * 运行：node --test tests/test_frontend_bugfixes2.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8')

test('共享已读表在裁剪后仍无原型链（constructor 消息不会丢失）', () => {
  const src = read('public/omm-share.js')
  assert.match(src, /seen: Object\.create\(null\)/)
  assert.doesNotMatch(src, /state\.seen = \{\}/)
  assert.match(src, /state\.seen = Object\.create\(null\)[\r\n]+\s*ack\.forEach/)
})

test('patchLinks 只安装一次，避免重复打开插件', () => {
  const src = read('public/omm-share.js')
  assert.match(src, /function patchLinks\(\) \{[\r\n]+\s*if \(state\.linksPatched\) return/)
  assert.match(src, /linksPatched: false/)
})

test('日程加载不会因为一条 null 事件/规则而清空全部数据', () => {
  const src = read('public/omm-planner.html', 'utf8')
  assert.match(src, /const x = e && typeof e === 'object' \? e : \{\}/)
  assert.match(src, /const x = r && typeof r === 'object' \? r : \{\}/)
  assert.match(src, /src\[ds\]\.filter\(Boolean\)\.map\(normEvent\)/)
  assert.match(src, /rb\[k\]\.filter\(Boolean\)\.map\(normRule\)/)
  assert.match(src, /ev\[ds\]\.filter\(Boolean\)\.map\(normEvent\)/)
})

test('多列 UPDATE 用原始行计算右值，SET a=b,b=a 不再得到 (2,2)', () => {
  const src = read('public/omm-data.html')
  assert.match(src, /var original = r\.slice\(\)/)
  assert.match(src, /r\[t\.col\] = evOp\(t\.val, original, ut\)/)
  assert.doesNotMatch(src, /r\[ci\] = evOp\(s2\.val, r, ut\)/)
})

test('JSON 导入跳过 null 行而不是整体失败', () => {
  const src = read('public/omm-data.html')
  assert.match(src, /arr = arr\.filter\(function \(r\) \{ return r !== null && typeof r === 'object' \}\)/)
})

function extractFunction(text, name) {
  let start = text.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} not found`)
  if (start >= 6 && text.slice(start - 6, start) === 'async ') start -= 6
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error(`unbalanced ${name}`)
}

function loadFunctions(text, names, globals = {}) {
  const context = vm.createContext({ ...globals })
  vm.runInContext(names.map((name) => extractFunction(text, name)).join('\n') +
    `\nthis.api = { ${names.join(', ')} }`, context)
  return context.api
}

const plain = (value) => JSON.parse(JSON.stringify(value))

test('Data localStorage 写入失败不推进缓存与 rev，Ctrl+S 不假成功', () => {
  const source = read('public/omm-data.html')
  const store = new Map([
    ['doc', JSON.stringify({ tables: [{ id: 'old' }], activeId: 'old' })],
    ['set', JSON.stringify({ theme: 'light' })],
    ['rev', '3'],
  ])
  let failKey = 'doc'
  const context = {
    CONFIG: { LS_DOC: 'doc', LS_SET: 'set', LS_REV: 'rev' },
    localStorage: {
      getItem: (key) => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => {
        if (key === failKey) throw new Error('quota')
        store.set(key, value)
      },
    },
  }
  const code = source.slice(source.indexOf('var Storage = {'), source.indexOf('window.ZDStorage = {'))
  vm.runInContext(code + '\nthis.Storage = Storage', vm.createContext(context))
  assert.throws(() => context.Storage.writeDoc([{ id: 'new' }], 'new'), /quota/)
  assert.equal(context.Storage.rev(), '3')
  assert.equal(context.Storage.doc().tables[0].id, 'old')
  failKey = 'set'
  assert.throws(() => context.Storage.writeSettings({ theme: 'dark' }), /quota/)
  assert.equal(context.Storage.rev(), '3')
  assert.equal(context.Storage.settings().theme, 'light')
  const saveBinding = source.slice(source.indexOf("'mod+s':"), source.indexOf("'mod+delete':"))
  assert.match(saveBinding, /try \{/)
  assert.match(saveBinding, /saved !== false && Settings\.save\(\) !== false/)
  assert.match(saveBinding, /notify\(T\('msg\.saveFailed'\)\)/)
  assert.doesNotMatch(saveBinding, /Store\.persist\(\); Settings\.save\(\); notify\(T\('msg\.saved'\)\)/)
})

test('Data Markdown/SQL 转义可往返，假 XML 导入已移除', () => {
  const source = read('public/omm-data.html')
  const parser = source.slice(source.indexOf('function sqlIdent'), source.indexOf('/* SQLite .db read/write')) + '\n' +
    source.slice(source.indexOf('function tokenize'), source.indexOf('function runSQL'))
  const context = {
    isNil: (value) => value == null || value === '',
    uid: () => 'id',
    idxToCol: (index) => String.fromCharCode(65 + index),
    inferTypes: () => {},
  }
  const parserContext = vm.createContext(context)
  vm.runInContext(parser + '\n' + [
    'markdownCell', 'parseMarkdownRow', 'fromMarkdown', 'toMarkdown', 'toSQL', 'fromSQLText',
    'stripName', 'splitTopLevel', 'sqlColumnType', 'sqlCreateColumns', 'sqlNameList',
    'sqlLiteral', 'sqlTuples', 'sqlEnsureColumns',
  ].map((name) => extractFunction(source, name)).join('\n') +
  '\nthis.api = { markdownCell, parseMarkdownRow, fromMarkdown, toMarkdown, toSQL, fromSQLText }', parserContext)
  const mdTable = {
    cols: [{ name: 'a|b' }, { name: ' padded ' }],
    rows: [['x|y\nz\\', '<tag> & stuff']],
  }
  const md = context.api.toMarkdown(mdTable)
  assert.deepEqual(plain(context.api.fromMarkdown(md).rows), mdTable.rows)
  assert.deepEqual(plain(context.api.fromMarkdown(md).cols.map((c) => c.name)), mdTable.cols.map((c) => c.name))
  const sqlTable = {
    name: 'we`ird', cols: [{ name: 'a`b', type: 'text' }],
    rows: [["O'Reilly\n\\`"]],
  }
  const sql = context.api.toSQL([sqlTable])
  assert.match(sql, /CREATE TABLE `we``ird`/)
  assert.match(sql, /`a``b`/)
  assert.doesNotThrow(() => context.api.fromSQLText(sql), sql)
  const restored = context.api.fromSQLText(sql)[0]
  assert.equal(restored.name, sqlTable.name)
  assert.equal(restored.cols[0].name, sqlTable.cols[0].name)
  assert.deepEqual(plain(restored.rows), sqlTable.rows)
  assert.doesNotMatch(source, /ext === 'xml'/)
  assert.doesNotMatch(source, /accept="[^"]*\.xml/)
})

test('Data SQL INSERT/UPDATE 克隆试算后提交，replaceOne 持久化', () => {
  const source = read('public/omm-data.html')
  const runAt = source.indexOf('function runSQL(')
  const update = source.slice(source.indexOf("if (first === 'UPDATE')", runAt), source.indexOf("if (first === 'DELETE')", runAt))
  const insert = source.slice(source.indexOf("if (first === 'INSERT')", runAt), source.indexOf("if (first === 'CREATE')", runAt))
  assert.match(update, /var nextRows = ut\.rows\.map/)
  assert.match(update, /inferTypes\(trial\)[\s\S]*pushUndo\(\)[\s\S]*ut\.rows = nextRows/)
  assert.match(insert, /var newRows = tuples\.map/)
  assert.match(insert, /inferTypes\(insertTrial\)[\s\S]*pushUndo\(\)[\s\S]*it\.rows = insertTrial\.rows/)
  const replace = source.slice(source.indexOf('replaceOne: function'), source.indexOf('replaceAll: function'))
  assert.match(replace, /setCell\(h\.r, h\.c, nv\)[\s\S]*afterChange\(\)/)
})

test('English 备份重建安全 ID 映射，notes/prog/days/books 无原型链', () => {
  const source = read('public/omm-english.html')
  const context = {
    WORDS: [],
    ZenUtil: { clone: plain, uid: () => 'generated' },
    ZenSRS: { createState: (id) => ({ id, reps: 0, ease: 2.5, interval: 0, due: 0, lapses: 0, last: null }) },
  }
  const api = loadFunctions(source, [
    'defaults', 'isRecord', 'safeDict', 'safeId', 'normalizeSrs', 'normalizeState', 'seed',
  ], context)
  const input = JSON.parse('{"books":{"x":{"id":"x","name":"X","w":[]},"fav":{"id":"fav","builtin":true,"w":[]}},"notes":{"__proto__":{"zh":"safe"}},"days":{"__proto__":{"l":1}},"prog":{}}')
  const normalized = api.normalizeState(input, true)
  assert.equal(Object.getPrototypeOf(normalized.notes), null)
  assert.equal(Object.getPrototypeOf(normalized.days), null)
  assert.equal(Object.getPrototypeOf(normalized.books), null)
  assert.equal(Object.hasOwn(normalized.notes, '__proto__'), true)
  assert.equal({}.zh, undefined)
  const remapped = api.normalizeState({ books: { alias: { id: 'real', name: 'R', w: [] } } }, true)
  assert.equal(Object.hasOwn(remapped.books, 'real'), true)
  assert.equal(Object.hasOwn(remapped.books, 'alias'), false)
  assert.throws(() => api.normalizeState({ books: {
    a: { id: 'same', w: [] }, b: { id: 'same', w: [] },
  } }, true), /ID 缺失或重复/)
  assert.throws(() => api.normalizeState({ books: {
    a: { id: 'constructor', w: [] },
  } }, true), /ID 缺失或重复/)
})

test('English SRS 调度统计归 ZenSRS，CSV/TSV 与帮助使用共享模块', () => {
  const source = read('public/omm-english.html')
  assert.match(source, /ZenSRS\.grade\(p, grade, Date\.now\(\)\)/)
  assert.match(source, /ZenSRS\.stats\(/)
  assert.doesNotMatch(source, /const IV =|p\.b\b/)
  assert.match(source, /ZenCSV\.parse\(text, delimiter\)/)
  assert.match(source, /ZenCSV\.stringify\([^\n]+\{ formulaSafe: true \}/)
  assert.match(source, /window\.ZenUI\.shortcuts\.help\(/)
  assert.match(source, /width: 'min\(580px, calc\(100vw - 24px\)\)'/)
  assert.match(source, /esc\(b\.id\)/)
  assert.match(source, /esc\(x\.id\)/)
  assert.doesNotMatch(read('public/zen/products/english.css'), /guide-light|--bg: #ffffff/)
})

test('Planner 备份严格校验并重建映射，远端时间戳与删除不被合并复活', () => {
  const source = read('public/omm-planner.html')
  const backup = source.slice(source.indexOf('importJSON(file)'), source.indexOf('clearAll()'))
  assert.match(backup, /const validId =/)
  assert.match(backup, /const pidMap = Object\.create\(null\)/)
  assert.match(backup, /Store\.planners = planners[\s\S]*Store\.eventsBy = eventsBy[\s\S]*Store\.recursBy = recursBy/)
  assert.doesNotMatch(backup, /Store\.planners\.push/)
  assert.doesNotMatch(source, /function mergeData|function mergeCounts/)
  assert.match(source, /writeLocal\(d, Number\(r\.client_updated_at \|\| 0\)\)/)
  assert.match(source, /mark\(ts \|\| now\(\)\)/)
  assert.match(source, /shortcuts\.help\(/)
  assert.match(source, /esc\(p\.id\)/)
  assert.match(source, /esc\(r\.id\)/)
  assert.equal((source.match(/function ensureChrome\(/g) || []).length, 1)
  assert.doesNotMatch(source, /window\.addEventListener\('resize', function \(\) \{\s*ensureChrome\(\)/)
  const css = read('public/zen/products/planner.css')
  assert.match(css, /#dd-settings \{[\s\S]*max-width: calc\(100vw - 24px\)/)
  assert.match(css, /#dd-search \{[\s\S]*max-width: calc\(100vw - 24px\)/)
})

test('云工作区确认、锁定清空视图和编辑在 Data/English/Planner 接线', () => {
  for (const id of ['data', 'english', 'planner']) {
    const source = read(`public/omm-${id}.html`)
    assert.match(source, /zenCloud\.confirmWorkspace\(session\.user\.id\)/)
    assert.match(source, /zenCloud\.workspaceNeedsConfirmation\(session\.user\.id\)/)
    assert.match(source, /zenCloud\.workspaceMeta\(session\.user\.id\)/)
    const storeName = { data: 'ZDDataStore', english: 'ZEnglishStore', planner: 'ZPlanStore' }[id]
    assert.match(source, new RegExp(`window\\.${storeName}`))
    assert.match(source, /setEditingLocked|\.inert = true/)
    assert.match(source, /function ensureKeyboardControls/)
    assert.match(source, /control\.click\(\)/)
    assert.match(source, /id="(?:zp|ze)-sync-btn"[\s\S]*?type="button"/)
  }
  const data = read('public/omm-data.html')
  const english = read('public/omm-english.html')
  const planner = read('public/omm-planner.html')
  assert.match(data, /S\.sqlHist = \[\]/)
  assert.match(data, /DOM\.sqlInput\.value = ''/)
  assert.match(english, /Flash\.q = \[\]/)
  assert.match(english, /Quiz\.qs = \[\]/)
  assert.match(english, /Typing\.words = \[\]/)
  assert.match(planner, /S\.edSubs = \[\]/)
  assert.match(planner, /CountStore\.records = \[\]/)
  assert.doesNotMatch(read('public/omm-data.html'), /function mergeData/)
  assert.equal((read('public/zen/features/cloud.css').match(/@media \(max-width: 720px\)/g) || []).length, 1)
})

test('Corpus AI 流绑定 convId，切换/删除中止，删除与覆盖使用共享确认', () => {
  const source = read('public/omm-corpus.html')
  assert.match(source, /function stopAIRequest\(\)[\s\S]*aiSessionId \+= 1[\s\S]*\.abort\(\)/)
  assert.match(source, /function switchConversation[\s\S]*stopAIRequest\(\)/)
  assert.match(source, /function deleteConversation[\s\S]*stopAIRequest\(\)/)
  assert.match(source, /const convId = getActiveConv\(\)\.id/)
  assert.match(source, /getActiveConv\(\)\?\.id === convId/)
  assert.match(source, /addChat\('assistant'[\s\S]*\}, convId\)/)
  assert.match(source, /row\.className = 'ai-bubble-row ai-streaming'/)
  assert.match(source, /async function deleteEditor\(\)[\s\S]*confirmAction\(/)
  assert.match(source, /async function importDataText\(\)[\s\S]*confirmAction\(/)
  assert.doesNotMatch(source, /function xConfirm|cfCb|omm-cf-/)
})

test('Message 发送引用优先使用 pendingQuoteId，成功后清除', async () => {
  const source = read('public/omm-message.html')
  const input = { value: '> same text\n\nanswer', focus() {} }
  const sendButton = { disabled: false }
  let inserted = null
  let payload = null
  let added = null
  const toasts = []
  const context = vm.createContext({
    $: (id) => id === 'message-input' ? input : sendButton,
    editingId: null,
    pendingQuoteId: 'target',
    messages: [
      { id: 'target', text: 'same text', deviceName: 'TARGET' },
      { id: 'other', text: 'same text', deviceName: 'OTHER' },
    ],
    session: { user: { id: 'u1' } }, password: 'pw', busy: false, TABLE: 'messages',
    sb: { from: () => ({ insert: (row) => {
      inserted = row
      return { select: async () => ({ data: [{ id: 'new', device_id: 'd1', device_name: 'DEVICE', client_created_at: 1 }] }) }
    } }) },
    deviceId: 'd1', deviceName: 'DEVICE',
    enc: async (data) => { payload = data; return 'cipher' },
    addMessage: (message) => { added = message },
    autoResizeMessageInput() {}, setConn() {}, toast: (message) => toasts.push(message), friendly: (e) => e.message,
    t: (key) => key,
    renderMessages() {}, Date,
  })
  vm.runInContext(extractFunction(source, 'send') + '\nthis.send = send', context)
  await context.send()
  assert.deepEqual(toasts, ['toast.sent'])
  assert.equal(payload.quoteId, 'target')
  assert.equal(payload.quoteDeviceName, 'TARGET')
  assert.equal(added.quoteId, 'target')
  assert.equal(context.pendingQuoteId, null)
  assert.equal(input.value, '')
})

test('Message 引用保存 pendingQuoteId，偏好与子页复用共享模块', () => {
  const source = read('public/omm-message.html')
  assert.match(source, /var prefs = zenCloud\.prefs/)
  assert.match(source, /var savePrefs = zenCloud\.savePrefs/)
  assert.doesNotMatch(source, /function prefs\(|function savePrefs\(|function openWarn\(/)
  assert.match(source, /pendingQuoteId = m\.id/)
  assert.match(source, /pendingQuoteId[\s\S]*messages\.find\(\(m\) => m\.id === pendingQuoteId\)/)
  assert.match(source, /pendingQuoteId = null[\s\S]*autoResizeMessageInput\(\)[\s\S]*toast\(t\('toast\.sent'\)\)/)
  assert.match(source, /html: \$\('tpl-sync'\)\.innerHTML/)
  assert.match(source, /html: \$\('tpl-settings'\)\.innerHTML/)
  assert.doesNotMatch(source, /class="subpage|id="sync-page"|id="settings-page"|tpl-shortcuts/)
  assert.doesNotMatch(read('public/zen/products/message.css'), /\.subpage|\.confirm-kicker|\.confirm-actions/)
})
