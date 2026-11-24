/* Document/writing pipeline regressions. Run: node --test tests/test_document_pipeline.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')
const plain = (value) => JSON.parse(JSON.stringify(value))

function extractFunction(text, name) {
  const marker = `function ${name}(`
  let start = text.indexOf(marker)
  assert.notEqual(start, -1, `${name} not found`)
  if (text.slice(start - 6, start) === 'async ') start -= 6
  const open = text.indexOf('{', start)
  let depth = 0
  for (let index = open; index < text.length; index++) {
    if (text[index] === '{') depth++
    else if (text[index] === '}' && --depth === 0) return text.slice(start, index + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

function classList() {
  const values = new Set()
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
    toggle(name, force) {
      const on = force === undefined ? !values.has(name) : !!force
      if (on) values.add(name)
      else values.delete(name)
      return on
    },
  }
}

test('Writer serializes and restores zenCardId without a global radius preference', () => {
  const writer = read('public/omm-writer.html')
  const build = new Function(
    'getNodeContent',
    'getNodeTitle',
    'ImageManager',
    'window',
    `${extractFunction(writer, 'buildNodeData')}\nreturn buildNodeData`,
  )(
    () => ({ dataset: { source: 'note' } }),
    () => ({ querySelector: () => ({ textContent: '卡片笔记' }) }),
    {},
    {},
  )
  const node = {
    id: 'node-1',
    dataset: { type: 'markdown', zenCardId: 'zc-42' },
    style: { left: '10px', top: '20px', width: '300px', height: '' },
    classList: { contains: () => false },
  }
  assert.equal(build(node).zenCardId, 'zc-42')
  assert.match(writer, /node\.dataset\.zenCardId = String\(data\.zenCardId\)/)
  assert.doesNotMatch(writer, /nodeBorderRadius|sv-node-radius|settingsNodeRadius|setProperty\(['"]--radius['"]/)
  const spec = read('public/json-specs/writer.md')
  assert.match(spec, /zenCardId/)
  assert.equal(spec, read('public/agent_workspace/omm_knowledge/writer.md'))
})

test('Annotate validates every project array and reference before atomic replacement', () => {
  const source = read('public/omm-annotate.html')
  const names = ['prepareProjectImport', 'replaceProject']
  const storage = { 'zencode.project.v1': JSON.stringify({ title: '旧项目', docs: [], codes: [] }) }
  const localStorage = {
    getItem: (key) => (key in storage ? storage[key] : null),
    setItem: (key, value) => { storage[key] = value },
  }
  const P = { title: '旧项目', desc: '', docs: [], codes: [], anns: [], rels: [], memos: [], marks: [], notes: [], cellCodes: [], reliability: [] }
  const S = { docId: 'old', selAnn: 'old', selMark: 'old', pdfLostId: 'old' }
  const context = vm.createContext({
    localStorage,
    LS_P: 'zencode.project.v1',
    P,
    S,
    COLORS: ['#000000'],
    RELS: ['因果', '对立', '递进', '例证', '条件', '并列'],
    MARKC: ['#f6dd8a'],
    ZenUtil: { clone: (value) => structuredClone(value) },
    Store: { remember: () => {} },
  })
  vm.runInContext(names.map((name) => extractFunction(source, name)).join('\n'), context)
  const api = vm.runInContext(`({ ${names.join(', ')} })`, context)
  const valid = {
    title: '新项目',
    desc: '完整备份',
    docs: [
      { id: 'd1', title: '文本', text: 'abcdef', kind: 'text' },
      { id: 'd2', title: '表格', text: '', kind: 'table', columns: ['文本'], rowCount: 1 },
    ],
    codes: [{ id: 'c1', no: '01', name: '主题', level: 'open', parent: '' }],
    anns: [
      { id: 'a1', doc: 'd1', code: 'c1', start: 0, end: 2, quote: 'ab' },
      { id: 'a2', doc: 'd1', code: 'c1', start: 2, end: 4, quote: 'cd' },
    ],
    rels: [{ id: 'r1', a: 'a1', b: 'a2', type: '因果' }],
    memos: [{ id: 'm1', title: '备忘录', body: '', codes: ['c1'] }],
    marks: [{ id: 'k1', doc: 'd1', start: 1, end: 3, quote: 'bc', sty: 'hl' }],
    notes: [{ id: 'n1', kind: 'word', en: 'word', tags: [], doc: 'd1', start: 0, end: 2 }],
    cellCodes: [{ id: 'tc1', table: 'd2', row: 0, col: '文本', code: 'c1', round: 1 }],
    reliability: [{
      id: 'rl1', source: 'text', round: 1, col: '', unmatched: 0, missing: 0, multi: 0,
      jaccard: null, stat: null, disagreements: [{ k: 'a1', a: 'c1', b: 'c1' }],
    }],
  }

  for (const key of ['docs', 'codes', 'anns', 'rels', 'memos', 'marks', 'notes', 'cellCodes', 'reliability']) {
    const broken = structuredClone(valid)
    delete broken[key]
    assert.throws(() => api.prepareProjectImport(broken), new RegExp(key))
  }
  const invalidValues = [
    (project) => { project.docs[0].id = 'd1" onmouseover="alert(1)' },
    (project) => { project.docs[0].id = 'doc1' },
    (project) => { project.docs[1].id = project.docs[0].id },
    (project) => { project.anns[0].quote = 'xy' },
    (project) => { project.anns[0].status = 'pending' },
    (project) => { project.marks[0].color = 'red;background:url(https://evil.example)' },
    (project) => { project.rels[0].type = '未知关系' },
    (project) => { project.reliability[0].stat = { N: 1, po: 0, pe: 0, kappa: 2 } },
  ]
  for (const mutate of invalidValues) {
    const broken = structuredClone(valid)
    mutate(broken)
    assert.throws(() => api.prepareProjectImport(broken))
  }
  const dangling = [
    (project) => { project.anns[0].doc = 'missing' },
    (project) => { project.codes[0].parent = 'missing' },
    (project) => { project.rels[0].b = 'missing' },
    (project) => { project.memos[0].codes = ['missing'] },
    (project) => { project.marks[0].doc = 'missing' },
    (project) => { project.notes[0].doc = 'missing' },
    (project) => { project.cellCodes[0].code = 'missing' },
    (project) => { project.reliability[0].disagreements[0].a = 'missing' },
  ]
  for (const mutate of dangling) {
    const broken = structuredClone(valid)
    mutate(broken)
    assert.throws(() => api.prepareProjectImport(broken))
  }

  const before = storage['zencode.project.v1']
  const invalid = structuredClone(valid)
  invalid.rels[0].b = 'missing'
  assert.throws(() => api.replaceProject(invalid))
  assert.equal(storage['zencode.project.v1'], before)
  assert.equal(P.title, '旧项目')
  localStorage.setItem = () => { throw new Error('quota') }
  assert.throws(() => api.replaceProject(valid), /quota/)
  assert.equal(storage['zencode.project.v1'], before)
  assert.equal(P.title, '旧项目')
  assert.equal(S.docId, 'old')

  localStorage.setItem = (key, value) => { storage[key] = value }
  api.replaceProject(valid)
  assert.equal(P.title, '新项目')
  assert.equal(P.docs.length, 2)
  assert.equal(S.docId, 'd1')
  assert.equal(JSON.parse(storage['zencode.project.v1']).reliability.length, 1)
})

test('Annotate bridge watch callback returns true only after a successful import', async () => {
  const source = read('public/omm-annotate.html')
  let confirmed = true
  let count = 1
  let failImport = false
  const notices = []
  const context = vm.createContext({
    OMM: {
      normalize: (raw) => raw && raw.items ? raw.items : [],
      ask: async () => confirmed,
      recvMsg: (from) => ({ from }),
      nameOf: (from) => from,
    },
    ingestBridge: () => {
      if (failImport) throw new Error('storage failed')
      return count
    },
    notify: (message) => notices.push(message),
    setView: () => {},
    renderNoteList: () => {},
  })
  vm.runInContext(extractFunction(source, 'applyIncomingBridge'), context)
  const apply = vm.runInContext('applyIncomingBridge', context)
  assert.equal(await apply({ from: 'english', env: { items: [{ t: 'word' }] } }), true)
  count = 0
  assert.equal(await apply({ from: 'english', env: { items: [{ t: 'word' }] } }), true)
  confirmed = false
  assert.equal(await apply({ from: 'english', env: { items: [{ t: 'word' }] } }), false)
  assert.equal(await apply({ from: 'english', env: { items: [] } }), false)
  confirmed = true
  failImport = true
  await assert.rejects(apply({ from: 'english', env: { items: [{ t: 'word' }] } }), /storage failed/)
  assert.ok(notices.includes('已取消导入'))
})

test('Annotate CSV import commits all IndexedDB files before one metadata save', async () => {
  const source = read('public/omm-table.js')
  const names = ['parseCSV', 'readCsvFile', 'keyOf', 'importCsvFiles']
  const events = []
  const store = new Map()
  let failIdb = false
  let failSave = false
  let nextId = 0
  const H = {
    P: { docs: [], cellCodes: [], codes: [] },
    S: { docId: '' },
    IDB: {
      get: (key) => Promise.resolve(store.has(key) ? structuredClone(store.get(key)) : null),
      putMany: (entries) => {
        events.push('idb')
        if (failIdb) return Promise.reject(new Error('idb failed'))
        entries.forEach(([key, value]) => {
          if (value == null) store.delete(key)
          else store.set(key, structuredClone(value))
        })
        return Promise.resolve(true)
      },
    },
    Store: {
      save: (project) => {
        events.push('save')
        if (failSave) return false
        H.saved = structuredClone(project)
        return true
      },
    },
    renderAll: () => events.push('render'),
  }
  class FakeFileReader {
    readAsText(file) {
      file.text().then((text) => {
        this.result = text
        this.onload()
      })
    }
  }
  const context = vm.createContext({
    H,
    FileReader: FakeFileReader,
    cache: {},
    ui: { docId: '', col: '' },
    notify: () => {},
    uid: () => `d-${++nextId}`,
    saveStore: (project) => H.Store.save(project),
    saveUI: () => {},
  })
  vm.runInContext(names.map((name) => extractFunction(source, name)).join('\n'), context)
  const api = vm.runInContext(`({ ${names.join(', ')} })`, context)
  const csv = (name, body) => ({ name, text: () => Promise.resolve(body) })

  assert.equal(await api.importCsvFiles([csv('a.csv', '名称,值\n甲,1\n'), csv('b.csv', '名称,值\n乙,2\n')]), true)
  assert.equal(H.P.docs.length, 2)
  assert.equal(events.filter((event) => event === 'idb').length, 1)
  assert.equal(events.filter((event) => event === 'save').length, 1)
  assert.ok(events.indexOf('idb') < events.indexOf('save'))
  assert.ok(events.indexOf('save') < events.indexOf('render'))

  const docsBefore = structuredClone(H.P.docs)
  const storedBefore = structuredClone([...store])
  failIdb = true
  assert.equal(await api.importCsvFiles([csv('c.csv', '列\n值\n')]), false)
  assert.deepEqual(plain(H.P.docs), plain(docsBefore))
  assert.deepEqual([...store], storedBefore)

  failIdb = false
  failSave = true
  const oldDoc = { id: 'd-old', title: 'old', kind: 'table', columns: ['旧列'], rowCount: 1 }
  H.P.docs = [oldDoc]
  store.set('table:d-old', { name: 'old', headers: ['旧列'], rows: [['原值']] })
  assert.equal(await api.importCsvFiles([csv('old.csv', '新列\n新值\n')]), false)
  assert.deepEqual(plain(H.P.docs), [oldDoc])
  assert.deepEqual(store.get('table:d-old'), { name: 'old', headers: ['旧列'], rows: [['原值']] })

  H.P.docs = []
  store.clear()
  assert.equal(await api.importCsvFiles([csv('new.csv', '列\n值\n')]), false)
  assert.deepEqual(plain(H.P.docs), [])
  assert.equal(store.size, 0)
})

test('LaTeX 服务地址只允许同源或 loopback，并在 fetch 前复验', async () => {
  const source = read('public/omm-latex.html')
  const names = ['normBase', 'isLoopbackUrl', 'normalizeServiceBase', 'assertServiceUrl']
  const context = vm.createContext({
    location: { href: 'https://docs.example/omm-latex.html', origin: 'https://docs.example' },
    URL,
  })
  vm.runInContext(names.map((name) => extractFunction(source, name)).join('\n'), context)
  const api = vm.runInContext(`({ ${names.join(', ')} })`, context)
  assert.equal(api.normalizeServiceBase('http://127.0.0.1:8123/'), 'http://127.0.0.1:8123')
  assert.equal(api.normalizeServiceBase('http://localhost:8123'), 'http://localhost:8123')
  assert.equal(api.normalizeServiceBase('https://docs.example/base/'), 'https://docs.example/base')
  for (const value of ['https://evil.example', 'http://127.0.0.1.evil.example:8123', 'file:///C:/x', 'javascript:alert(1)']) {
    assert.throws(() => api.normalizeServiceBase(value))
    assert.throws(() => api.assertServiceUrl(value + '/api/env'))
  }
  assert.doesNotThrow(() => api.assertServiceUrl('/api/env'))
  const fetchWithTimeout = extractFunction(source, 'fetchWithTimeout')
  assert.ok(fetchWithTimeout.indexOf('assertServiceUrl(url)') < fetchWithTimeout.indexOf('await fetch('))
  assert.match(fetchWithTimeout, /redirect: 'error'/)
})

test('LaTeX 编译在首个 await 前互斥，服务检测期间也只允许一个任务', async () => {
  const source = read('public/omm-latex.html')
  const element = () => ({ value: 'source', textContent: '', classList: classList() })
  const elements = {}
  let releaseDetect
  const detecting = new Promise((resolve) => { releaseDetect = resolve })
  const events = []
  const context = vm.createContext({
    compiling: false,
    activeCompile: null,
    compileSeq: 0,
    pendingCompile: null,
    autoTimer: null,
    state: {
      service: null, engine: 'xelatex', passes: 2, editVersion: 1,
      lastCompiledTex: '', lastKey: 'old', pages: 1, ms: 1, errors: [], log: '', compileAfter: false,
    },
    $id: (id) => elements[id] || (elements[id] = element()),
    setBusy: (on) => { events.push(on ? 'busy' : 'idle'); context.compiling = on },
    detectService: () => { events.push('detect'); return detecting },
    cancelPdfRenders() {}, renderToken: 0, clearPdfPages() {}, pdfDoc: null, pdfDocKey: '', pdfLoadTask: null,
    showCompileProgress() {}, setStatus() {}, toast() {}, syncGutter() {}, showErrors() {},
    performance: { now: () => 0 }, setTimeout, scheduleCompile() {},
    AbortController, clearTimeout,
  })
  vm.runInContext(extractFunction(source, 'compile'), context)
  const compile = vm.runInContext('compile', context)
  const first = compile(false)
  const second = compile(false)
  assert.deepEqual(events, ['busy', 'detect'])
  releaseDetect(false)
  await Promise.all([first, second])
  assert.equal(events.filter((event) => event === 'detect').length, 1)
  assert.equal(context.compiling, false)
})

test('LaTeX PDF 加载任务绑定 key，旧任务不会标记新 key', async () => {
  const source = read('public/omm-latex.html')
  const tasks = []
  const makeTask = (key) => {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    const task = { key, promise, destroyed: false, destroy() { this.destroyed = true } }
    tasks.push({ task, resolve })
    return task
  }
  const context = vm.createContext({
    state: { lastKey: 'old' },
    window: { pdfjsLib: { getDocument: ({ url }) => makeTask(url.includes('old') ? 'old' : 'new') } },
    pdfjsLib: { getDocument: ({ url }) => makeTask(url.includes('old') ? 'old' : 'new') },
    pdfDoc: null, pdfDocKey: '', pdfLoadTask: null,
    pdfUrl: () => '/pdf?key=' + context.state.lastKey,
  })
  vm.runInContext(extractFunction(source, 'ensurePdfDoc'), context)
  const ensurePdfDoc = vm.runInContext('ensurePdfDoc', context)
  const oldLoad = ensurePdfDoc()
  context.state.lastKey = 'new'
  const newLoad = ensurePdfDoc()
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].task.destroyed, true)
  const oldDoc = { numPages: 1, destroyed: false, destroy() { this.destroyed = true } }
  tasks[0].resolve(oldDoc)
  await assert.rejects(oldLoad, /PDF 已更新/)
  assert.equal(oldDoc.destroyed, true)
  assert.equal(context.pdfDocKey, '')
  const newDoc = { numPages: 1, destroyed: false, destroy() { this.destroyed = true } }
  tasks[1].resolve(newDoc)
  assert.equal(await newLoad, newDoc)
  assert.equal(context.pdfDocKey, 'new')
})

test('LaTeX 载入模板前确认丢弃未编译修改', async () => {
  const source = read('public/omm-latex.html')
  let confirmed = false
  const loaded = []
  const context = vm.createContext({
    state: { booting: false, tex: 'dirty', lastCompiledTex: '', tplId: '', currentDocId: '', currentDocName: '' },
    templateById: () => ({ id: 'blank', name: '空白', body: 'fresh' }),
    confirmDiscardChanges: async () => confirmed,
    saveCurrentDocument() {}, setTex: (text) => loaded.push(text), buildDropdowns() {}, setStatus() {},
    scheduleCompile() {}, closeDropdowns() {}, $id: () => ({ textContent: '' }), LS: { set() {} },
  })
  vm.runInContext(extractFunction(source, 'loadTemplate'), context)
  const loadTemplate = vm.runInContext('loadTemplate', context)
  assert.equal(await loadTemplate('blank'), false)
  assert.deepEqual(loaded, [])
  confirmed = true
  assert.equal(await loadTemplate('blank'), true)
  assert.deepEqual(loaded, ['fresh'])
})

test('MdForge 草稿配额失败时降级保存正文并显示警告', () => {
  const source = read('public/omm-mdforge.html')
  const stored = []
  const saveHint = { textContent: '', dataset: {} }
  const context = vm.createContext({
    state: {
      draftTimer: 1, filename: 'draft.md', format: 'docx', template: 'academic',
      images: [{ name: 'large.png', file: { type: 'image/png' }, dataUrl: 'data:image/png;base64,AAAA' }],
    },
    dom: { editor: { value: '# 正文' }, saveHint },
    localStorage: {
      setItem(key, value) {
        if (String(value).includes('dataUrl')) throw new Error('quota')
        stored.push([key, value])
      },
    },
    DRAFT_KEY: 'mdforge.draft', ZenUtil: { pad: (n) => String(n).padStart(2, '0') }, clearTimeout() {},
  })
  vm.runInContext(extractFunction(source, 'saveDraft'), context)
  vm.runInContext('saveDraft()', context)
  const payload = JSON.parse(stored[0][1])
  assert.equal(payload.text, '# 正文')
  assert.deepEqual(payload.images, [])
  assert.equal(payload.imagesOmitted, true)
  assert.match(saveHint.textContent, /正文已保存.*图片未保存/)
  assert.equal(saveHint.dataset.state, 'warning')
})

test('MdForge 正文也无法保存时明确显示未保存', () => {
  const source = read('public/omm-mdforge.html')
  const saveHint = { textContent: '', dataset: {} }
  const context = vm.createContext({
    state: { draftTimer: null, filename: 'draft.md', format: 'docx', template: 'academic', images: [] },
    dom: { editor: { value: '# 正文' }, saveHint },
    localStorage: { setItem() { throw new Error('quota') } },
    DRAFT_KEY: 'mdforge.draft', clearTimeout() {},
  })
  vm.runInContext(extractFunction(source, 'saveDraft'), context)
  vm.runInContext('saveDraft()', context)
  assert.match(saveHint.textContent, /正文未保存/)
  assert.equal(saveHint.dataset.state, 'error')
})

test('MdForge 预览视图强制打开预览标签，文档移除旧圆角与 TeX 安全描述', () => {
  const page = read('public/omm-mdforge.html')
  assert.match(page, /if \(view === 'preview'\) switchTab\('preview'\)/)
  assert.doesNotMatch(page, /function setTabPreview\(/)
  const doc = read('public/docs/README-MDFORGE.md')
  assert.doesNotMatch(doc, /统一圆角滑杆（0–14px|原样嵌入 LaTeX，但校验器/)
  assert.match(doc, /网页与 AI 输入禁用原始 `latex-figure` TeX/)
  assert.match(doc, /圆角固定为 `0`/)
})

test('LaTeX same-origin cancel and idle polling do not skip an empty apiBase', async () => {
  const source = read('public/omm-latex.html')
  const names = ['normBase', 'waitServerIdle', 'requestServerCancel']
  const calls = []
  const state = { apiBase: '', service: { engines: {} } }
  const context = vm.createContext({
    state,
    fetchWithTimeout: async (url) => {
      calls.push(url)
      return { ok: true, json: async () => ({ busy: false }) }
    },
    setTimeout,
  })
  vm.runInContext(names.map((name) => extractFunction(source, name)).join('\n'), context)
  const api = vm.runInContext(`({ ${names.join(', ')} })`, context)
  assert.equal(await api.waitServerIdle(1000), true)
  assert.equal(await api.requestServerCancel(), true)
  assert.deepEqual(calls, ['/api/status', '/api/cancel'])

  calls.length = 0
  state.service = null
  context.fetchWithTimeout = async () => { throw new Error('must not fetch') }
  assert.equal(await api.waitServerIdle(1000), true)
  assert.equal(await api.requestServerCancel(), true)
  assert.deepEqual(calls, [])
})

test('Search aborts the previous task and ignores stale chunks, catch and finally', async () => {
  const source = read('public/omm-search.html')
  const names = ['cancelSearchForNavigation', 'runSearch']
  const elements = {}
  for (const id of ['q', 'searchbar', 'statusbar', 'results', 'empty', 'toolbar', 'find-input', 'follow-bar', 'status-text', 'status-dot', 'answer-body']) {
    elements[id] = { value: '', textContent: '', innerHTML: '', classList: classList() }
  }
  const history = []
  const toasts = []
  const statuses = []
  const renders = []
  let oldReadStarted
  const started = new Promise((resolve) => { oldReadStarted = resolve })
  let resolveOldRead
  const oldRead = new Promise((resolve) => { resolveOldRead = resolve })
  let oldReads = 0
  const encoder = new TextEncoder()
  const stream = (text) => {
    let sent = false
    return {
      read: async () => {
        if (sent) return { done: true }
        sent = true
        return { done: false, value: encoder.encode(text) }
      },
      cancel: async () => {},
    }
  }
  const fetchCalls = []
  const context = vm.createContext({
    $: (id) => elements[id],
    S: { settings: { apiKey: 'key', apiBase: 'https://api.example', apiModel: 'model', thinking: false } },
    current: null,
    searching: false,
    abort: null,
    searchGeneration: 0,
    startTime: 0,
    lastRender: 0,
    findText: '',
    AbortController,
    TextDecoder,
    toast: (message) => toasts.push(message),
    toggleDropdown: () => {},
    clone: (value) => structuredClone(value),
    sysPrompt: () => 'system',
    setStatus: (text) => { statuses.push(text); elements['status-text'].textContent = text },
    renderCurrent: () => {
      renders.push(context.current && context.current.query)
      elements['follow-bar'].classList.toggle('hidden', context.searching || !context.current?.assistantMsg)
    },
    renderAnswerOnly: () => { elements['answer-body'].textContent = context.current?.answer || '' },
    mergeSources: () => {},
    addQueries: () => {},
    hostOf: () => '',
    shortErr: (text) => text,
    pushHistory: (entry) => history.push(structuredClone(entry)),
    fetch: async () => {
      fetchCalls.push(1)
      if (fetchCalls.length === 1) {
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: () => {
                oldReads++
                if (oldReads === 1) {
                  oldReadStarted()
                  return oldRead
                }
                return Promise.resolve({ done: true })
              },
              cancel: async () => {},
            }),
          },
        }
      }
      return {
        ok: true,
        status: 200,
        body: { getReader: () => stream('data: {"choices":[{"delta":{"content":"new answer"}}]}\n\n') },
      }
    },
  })
  vm.runInContext(names.map((name) => extractFunction(source, name)).join('\n'), context)
  const api = vm.runInContext(`({ ${names.join(', ')} })`, context)
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    const oldTask = api.runSearch('old query')
    await started
    const newTask = api.runSearch('new query')
    await newTask
    resolveOldRead({ done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"stale answer"}}]}\n\n') })
    await oldTask
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
  assert.equal(context.current.query, 'new query')
  assert.equal(context.current.answer, 'new answer')
  assert.equal(context.searching, false)
  assert.equal(context.abort, null)
  assert.equal(elements.searchbar.classList.contains('searching'), false)
  assert.deepEqual(history.map((entry) => entry.query), ['new query'])
  assert.deepEqual(toasts, [])
  assert.equal(statuses.filter((status) => status === '搜索完成').length, 1)
  assert.deepEqual(unhandled, [])
  assert.equal(renders.at(-1), 'new query')
})

test('Redact streams large UTF-8 TXT and flushes split Chinese/emoji sequences', async () => {
  const source = read('public/omm-redact.html')
  const text = '中文😀'.repeat(150000)
  const blob = new Blob([text])
  const file = { size: blob.size, slice: (start, end) => blob.slice(start, end) }
  class FakeFileReader {
    readAsArrayBuffer(value) {
      value.arrayBuffer().then((buffer) => {
        this.result = buffer
        this.onload({ target: this })
      })
    }
  }
  const context = vm.createContext({
    FileReader: FakeFileReader,
    TextDecoder,
    CONFIG: { CHUNK_SIZE: 64 * 1024 },
    DOM: { statusLeft: { textContent: '' } },
    formatSize: (value) => String(value),
    setProgress: () => {},
    setLoadingInfo: () => {},
    setTimeout,
  })
  vm.runInContext(extractFunction(source, 'loadFileStreaming'), context)
  const load = vm.runInContext('loadFileStreaming', context)
  assert.equal(await load(file), text)
  assert.doesNotMatch(source, /readAsText\(slice\)/)
  assert.match(source, /decoder\.decode\(new Uint8Array\(e\.target\.result\), \{ stream: true \}\)/)
  assert.match(source, /parts\.push\(decoder\.decode\(\)\)/)
})

test('Annotate, LaTeX, MdForge, Redact and Writer have no global UI radius controls', () => {
  const forbidden = {
    'public/omm-annotate.html': /S\.radius|sv-radius|radiusUp|radiusDown|setProperty\(['"]--radius['"]/,
    'public/omm-latex.html': /state\.radius|radiusrow|changeRadius|LS\.get\(['"]radius['"]|setProperty\(['"]--radius['"]/,
    'public/omm-mdforge.html': /sv-radius|data-setting="radius-|s\.radius|settings\.radius|setProperty\(['"]--radius['"]/,
    'public/omm-redact.html': /S\.radius|sv-radius|radiusPlus|setProperty\(['"]--radius['"]/,
    'public/omm-writer.html': /nodeBorderRadius|sv-node-radius|settingsNodeRadius|setProperty\(['"]--radius['"]/,
  }
  for (const [path, pattern] of Object.entries(forbidden)) {
    assert.doesNotMatch(read(path), pattern, path)
  }
  const redact = read('public/omm-redact.html')
  assert.match(redact, /redactStyle\.radius/)
  assert.match(redact, /function drawRedactRect/)
})

test('Annotate CSV 导出加载共享 ZenCSV 并开启公式前缀保护', () => {
  const source = read('public/omm-annotate.html')
  assert.ok(source.indexOf('lib/zen-csv.js') >= 0)
  assert.equal((source.match(/ZenCSV\.stringify\(rows, ',', \{ formulaSafe: true \}\)/g) || []).length, 2)
  assert.doesNotMatch(source, /function csv(?:Cell|Rows)\(/)
  const context = vm.createContext({ window: {} })
  vm.runInContext(read('public/lib/zen-csv.js'), context)
  const rows = [['=1+1', '+SUM(A1)', '-SUM(A1)', '@SUM(A1)', '\t@CMD', '\r@CMD', '-1', 'plain']]
  const encoded = context.window.ZenCSV.stringify(rows, ',', { formulaSafe: true })
  const decoded = context.window.ZenCSV.parse(encoded, ',')
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), [["'=1+1", "'+SUM(A1)", "'-SUM(A1)", "'@SUM(A1)", "'\t@CMD", "'\r@CMD", '-1', 'plain']])
  assert.equal(context.window.ZenCSV.stringify(rows, ',').startsWith('=1+1'), true)
})

test('Annotate 保存失败恢复最后一次成功提交的内存工程', () => {
  const source = read('public/omm-annotate.html')
  const storage = {}
  let fail = false
  const P = { title: '旧项目', desc: '', docs: [{ id: 'd1' }], codes: [], anns: [], rels: [], memos: [], marks: [], notes: [], cellCodes: [], reliability: [] }
  const context = vm.createContext({
    P,
    LS_P: 'project',
    PROJECT_KEYS: ['title', 'desc', 'docs', 'codes', 'anns', 'rels', 'memos', 'marks', 'notes', 'cellCodes', 'reliability'],
    localStorage: {
      setItem: (key, value) => {
        if (fail) throw new Error('quota')
        storage[key] = value
      },
    },
    ZenUtil: { clone: (value) => structuredClone(value) },
    notify: () => {},
  })
  vm.runInContext(['restoreProjectState', 'saveProject'].map((name) => extractFunction(source, name)).join('\n'), context)
  context.Store = {
    _last: structuredClone(P),
    remember(project) { this._last = structuredClone(project || P) },
    save: context.saveProject,
  }
  P.title = '未提交修改'
  fail = true
  assert.equal(context.saveProject(), false)
  assert.equal(P.title, '旧项目')
  assert.equal(P.docs[0].id, 'd1')
})

test('Annotate 删除材料先提交元数据，失败时不删 IndexedDB 文件', async () => {
  const source = read('public/omm-annotate.html')
  const events = []
  let failSave = false
  const P = {
    title: '工程', desc: '', docs: [{ id: 'd1', title: '材料' }], codes: [],
    anns: [{ id: 'a1', doc: 'd1' }], rels: [], memos: [],
    marks: [{ id: 'k1', doc: 'd1' }], notes: [], cellCodes: [], reliability: [],
  }
  const S = { docId: 'd1', selMark: 'k1', pdfLostId: 'd1' }
  const context = vm.createContext({
    P, S, LS_P: 'project',
    PROJECT_KEYS: ['title', 'desc', 'docs', 'codes', 'anns', 'rels', 'memos', 'marks', 'notes', 'cellCodes', 'reliability'],
    localStorage: { setItem: () => { events.push('save'); if (failSave) throw new Error('quota') } },
    ZenUtil: { clone: (value) => structuredClone(value) },
    notify: (message) => events.push('notify:' + message),
    showConfirm: async () => true,
    docById: (id) => P.docs.find((doc) => doc.id === id) || null,
    annCountDoc: () => 1,
    markCountDoc: () => 1,
    markById: (id) => P.marks.find((mark) => mark.id === id) || null,
    PDFV: { drop: () => events.push('pdf-drop') },
    IDB: { del: () => events.push('idb-delete') },
    window: { ZenTable: { onDocDeleted: () => events.push('table-cache-clear') } },
    renderAll: () => {},
  })
  vm.runInContext(['restoreProjectState', 'saveProject', 'commitProjectChange', 'deleteDocById']
    .map((name) => extractFunction(source, name)).join('\n'), context)
  context.Store = { _last: structuredClone(P) }
  vm.runInContext('Store.save = saveProject; Store.remember = function (project) { Store._last = JSON.parse(JSON.stringify(project || P)) }', context)
  const remove = vm.runInContext('deleteDocById', context)
  assert.equal(await remove('d1'), true, events.join(','))
  assert.ok(events.indexOf('save') < events.indexOf('idb-delete'))
  assert.ok(events.includes('pdf-drop'))
  assert.ok(events.includes('table-cache-clear'))

  P.docs = [{ id: 'd1', title: '材料' }]
  P.anns = [{ id: 'a1', doc: 'd1' }]
  P.marks = [{ id: 'k1', doc: 'd1' }]
  S.docId = 'd1'; S.selMark = 'k1'; S.pdfLostId = 'd1'
  context.Store._last = structuredClone(P)
  events.length = 0
  failSave = true
  assert.equal(await remove('d1'), false)
  assert.ok(events.includes('save'))
  assert.ok(!events.includes('idb-delete'))
  assert.ok(!events.includes('pdf-drop'))
  assert.equal(P.docs.length, 1)
  assert.equal(S.docId, 'd1')
  assert.equal(S.pdfLostId, 'd1')
})

test('Annotate 实时快照只接受统一父窗口信任校验并用精确 origin 回复', () => {
  const source = read('public/omm-annotate.html')
  const block = source.slice(source.indexOf('AI 工作区实时上下文'), source.indexOf('</script>', source.indexOf('AI 工作区实时上下文')))
  assert.match(block, /ZenUtil\.isTrustedParentMessage\(ev\)/)
  assert.match(block, /ZenUtil\.parentTargetOrigin\(\)/)
  assert.doesNotMatch(block, /indexOf\(u\.hostname\)/)
  assert.doesNotMatch(block, /hubOrigin \|\| ev\.origin/)
})

test('Redact DOCX 两条渲染路径都委托共享清洗器并清除危险资源', () => {
  const source = read('public/omm-redact.html')
  assert.ok(source.indexOf('lib/zen-html.js') < source.indexOf('vendor/mammoth'))
  assert.match(source, /html = sanitizeDocxHtml\(result\.value \|\| ''\)/)
  assert.match(source, /sanitizeDocxBody\(bodyHost\)/)
  assert.match(source, /sanitizeDocxStyles\(styleHost\)/)
  assert.match(source, /allowExternalLinks: false/)
  assert.match(source, /localImagesOnly: true/)
  assert.doesNotMatch(source, /document\.addEventListener\('drop'/)
  assert.equal((source.match(/ZenUtil\.enableFileDrop\(/g) || []).length, 1)
})

test('Redact 文件指纹稳定且随内容变化', async () => {
  const source = read('public/omm-redact.html')
  const context = vm.createContext({
    ZenUtil: { fingerprint: (value) => 'fallback:' + value },
    crypto: globalThis.crypto,
    FileReader: globalThis.FileReader,
  })
  vm.runInContext(extractFunction(source, 'fileFingerprint'), context)
  const fingerprint = vm.runInContext('fileFingerprint', context)
  const makeFile = (text) => ({
    name: 'a.txt', size: Buffer.byteLength(text), type: 'text/plain', lastModified: 1,
    slice: (start, end) => new Blob([text]).slice(start, end),
  })
  const first = await fingerprint(makeFile('abcdef'))
  const same = await fingerprint(makeFile('abcdef'))
  const changed = await fingerprint(makeFile('abcdeg'))
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(first, same)
  assert.notEqual(first, changed)
})

test('Redact 遮罩记录严格校验并按指纹恢复', () => {
  const source = read('public/omm-redact.html')
  const context = vm.createContext({ CONFIG: { UNDO_LIMIT: 80 } })
  vm.runInContext(extractFunction(source, 'normalizeRedactProjectRecord'), context)
  const normalize = vm.runInContext('normalizeRedactProjectRecord', context)
  const record = {
    version: 1, fingerprint: 'fp', fileName: 'a.txt', fileSize: 1, fileType: 'txt',
    redacts: [{ id: 'r2', pageIdx: 0, nx1: 0.1, ny1: 0.2, nx2: 0.5, ny2: 0.6, applied: true, style: { color: '#000000', radius: 0, opacity: 100 } }],
    undoStack: ['[]'], redoStack: [], redactIdCounter: 2,
  }
  assert.equal(normalize(record, 'fp').redactIdCounter, 2)
  assert.equal(normalize(record, 'other'), null)
  const bad = structuredClone(record)
  bad.redacts[0].style.color = 'red;background:url(https://evil.example)'
  assert.equal(normalize(bad, 'fp'), null)
  const duplicate = structuredClone(record)
  duplicate.redacts.push(structuredClone(duplicate.redacts[0]))
  assert.equal(normalize(duplicate, 'fp'), null)
  const brokenHistory = structuredClone(record)
  brokenHistory.undoStack = ['not-json']
  assert.equal(normalize(brokenHistory, 'fp'), null)
})

test('Redact 两阶段加载取消或失败时恢复旧工程且不释放旧资源', async () => {
  const source = read('public/omm-redact.html')
  const released = []
  const renders = []
  const S = {
    documentLoadToken: 1, projectFingerprint: 'old', projectReady: true,
    redacts: [{ id: 'r1' }], undoStack: ['old'], redoStack: [], redactIdCounter: 1,
    pdfJsDoc: { tag: 'old-pdf', destroy: () => released.push('old-pdf') }, pdfPages: [], totalPages: 1,
  }
  const DOM = { docViewport: { scrollTop: 42 } }
  const queryScopeState = { enabled: false, start: 1, end: 2 }
  const context = vm.createContext({
    S, DOM, queryScopeState,
    ZenUtil: { clone: (value) => structuredClone(value) },
    document: { body: { appendChild: () => {} } },
    releaseRedactResources: (state) => { if (state.pdfJsDoc) released.push(state.pdfJsDoc.tag || 'pdf') },
    disposeNativeDocxState: () => {},
    disposeNativeDocx: () => {},
    renderDocument: () => renders.push(S.projectFingerprint),
    requestAnimationFrame: () => {},
    clearTimeout: () => {},
    setTool: () => {}, redrawRenderedRedactions: () => {}, log: () => {},
  })
  vm.runInContext([
    'captureRedactLoadState', 'beginRedactFileStage', 'commitRedactFileLoad', 'rollbackRedactFileLoad',
  ].map((name) => extractFunction(source, name)).join('\n'), context)
  const tx = {
    token: 2, fingerprint: 'new', file: { name: 'new.txt' },
    stored: { redacts: [{ id: 'r9', pageIdx: 0 }], undoStack: [], redoStack: [], redactIdCounter: 9 },
    previous: context.captureRedactLoadState(),
  }
  S.documentLoadToken = 2
  context.beginRedactFileStage(tx)
  S.pdfJsDoc = { tag: 'new-pdf', destroy: () => released.push('new-pdf') }
  S.totalPages = 1
  assert.equal(context.commitRedactFileLoad(Object.assign({}, tx, { token: 1 }), tx.file), false)
  assert.equal(context.rollbackRedactFileLoad(tx), true)
  assert.equal(S.projectFingerprint, 'old')
  assert.equal(S.redacts[0].id, 'r1')
  assert.equal(DOM.docViewport.scrollTop, 42)
  assert.deepEqual(released, ['new-pdf'])
  assert.deepEqual(renders, ['old'])

  const commitTx = {
    token: 3, fingerprint: 'new', file: { name: 'new.txt' },
    stored: tx.stored, previous: context.captureRedactLoadState(),
  }
  S.documentLoadToken = 3
  S.pdfJsDoc = null
  assert.equal(context.commitRedactFileLoad(commitTx, commitTx.file), true)
  assert.equal(S.projectFingerprint, 'new')
  assert.equal(S.redacts[0].id, 'r9')
  assert.ok(released.includes('old-pdf'))
})

test('Redact 窄屏侧栏入口委托共享 overlay，菜单和工具使用原生按钮', () => {
  const source = read('public/omm-redact.html')
  assert.match(source, /id="mobile-sidebar-open"/)
  assert.match(source, /ZenUI\.layer\.wireOverlay/)
  assert.match(source, /openClass: 'mobile-show'/)
  assert.match(source, /sidebarOverlay\.isOpen\(\)/)
  assert.doesNotMatch(source, /<div class="(?:menu-btn|tool-btn|dd-item)"[^>]*data-action/)
  assert.doesNotMatch(source, /<div class="tool-btn"[^>]*data-tool/)
})

test('三个产品页内联脚本均可解析', () => {
  for (const id of ['annotate', 'redact', 'writer']) {
    const source = read(`public/omm-${id}.html`)
    const scripts = Array.from(source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g), (match) => match[1])
    for (const script of scripts) {
      if (script.trim()) assert.doesNotThrow(() => new Function(script), `${id} 内联脚本语法错误`)
    }
  }
})

test('三个产品样式清理硬编码界面色与 legacy 颜色令牌', () => {
  for (const id of ['annotate', 'redact', 'writer']) {
    const css = read(`public/zen/products/${id}.css`)
    assert.doesNotMatch(css, /var\(--(?:bg|paper|panel|text|text-dim|text-faint|border|border-dim|border-faint|accent(?:-red|-green|-blue|-orange|-purple)?|radius)\b/)
  }
  for (const id of ['annotate', 'redact']) {
    assert.doesNotMatch(read(`public/zen/products/${id}.css`), /#[0-9a-f]{3,8}\b|rgba?\(/i)
  }
  const writer = read('public/zen/products/writer.css')
  const writerValues = writer.replace(/\[data-color=['"][^'"]+['"]\]/g, '')
  assert.doesNotMatch(writerValues, /#[0-9a-f]{3,8}\b|rgba?\(/i)
})
