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
    ZenUtil: { clone: (value) => structuredClone(value) },
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
