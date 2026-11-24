/* video/table 页面行为回归：运行校验、导入原子性、消息 source 与 AI 投递。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

function decode(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function factorInputs(html) {
  const inputs = []
  const re = /<input\b([^>]*\bdata-factor="([^"]+)"[^>]*)>/g
  let match
  while ((match = re.exec(html))) {
    const attrs = match[1]
    const type = (attrs.match(/\btype="([^"]+)"/) || [null, 'text'])[1]
    const value = decode((attrs.match(/\bvalue="([^"]*)"/) || [null, ''])[1])
    const listeners = {}
    inputs.push({
      type, value, dataset: { factor: match[2] },
      addEventListener(name, fn) { (listeners[name] ||= []).push(fn) },
      dispatch(name) { (listeners[name] || []).forEach((fn) => fn()) },
    })
  }
  return inputs
}

function harness(product) {
  const id = product
  const elements = new Map()
  const requests = []
  const toasts = []
  const saves = []
  const parentMessages = []
  const fromJSONCalls = []
  const windowListeners = {}
  const documentListeners = {}
  const opened = []
  let init = null
  let importFile = null
  let sent = null
  let sequence = 0
  let current = { version: 1, app: id, nodes: [], connections: [], view: { scale: 1, panX: 0, panY: 0 }, meta: {} }

  function element(key) {
    if (elements.has(key)) return elements.get(key)
    const listeners = {}
    const node = {
      id: key, innerHTML: '', textContent: '', value: '', disabled: false,
      files: [], dataset: {}, style: {}, hidden: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
      addEventListener(name, fn) { (listeners[name] ||= []).push(fn) },
      dispatch(name, event = {}) { (listeners[name] || []).forEach((fn) => fn({ target: node, ...event })) },
      click() { this.dispatch('click') },
      querySelector() { return null },
      querySelectorAll() { return [] },
      appendChild() {}, remove() {}, focus() {}, getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 } },
    }
    if (key === 'inspector-body') {
      let factorHTML = ''
      let factorValues = []
      let cellHTML = ''
      let cellValues = []
      node.querySelectorAll = (selector) => {
        if (selector === '[data-factor]') {
          if (factorHTML !== node.innerHTML) {
            factorHTML = node.innerHTML
            factorValues = factorInputs(factorHTML)
          }
          return factorValues
        }
        if (selector === '[data-tcell]') {
          if (cellHTML !== node.innerHTML) {
            cellHTML = node.innerHTML
            cellValues = []
            const re = /<input\b([^>]*\bdata-tcell="([^"]+)"[^>]*\bdata-row="([^"]+)"[^>]*\bdata-col="([^"]+)"[^>]*)>/g
            let match
            while ((match = re.exec(cellHTML))) {
              const listeners = {}
              cellValues.push({
                value: decode((match[1].match(/\bvalue="([^"]*)"/) || [null, ''])[1]),
                dataset: { tcell: match[2], row: match[3], col: match[4] },
                addEventListener(name, fn) { (listeners[name] ||= []).push(fn) },
                dispatch(name) { (listeners[name] || []).forEach((fn) => fn()) },
              })
            }
          }
          return cellValues
        }
        return []
      }
    }
    elements.set(key, node)
    return node
  }

  const parent = { postMessage(message, origin) { parentMessages.push({ message, origin }) } }
  const window = {
    parent,
    ZenUI: {
      toast(message) { toasts.push(String(message)) },
      dialog: { confirm: () => Promise.resolve(true), prompt: () => Promise.resolve('1'), alert: () => Promise.resolve() },
      modal: { open() {}, close() {} },
    },
    ZenUtil: {
      saveJSON(name, data) { saves.push({ name, data }) },
      isTrustedParentMessage(event) {
        return event.source === parent && event.origin === 'http://127.0.0.1:8300'
      },
    },
    ZenJob: {
      post(api, path, body) {
        return fetch(api + path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body || {}) })
          .then((response) => response.json())
      },
      cancel() { return Promise.resolve() },
      addAtCenter() {},
    },
    OMMShare: {
      send(options) { sent = options; return Promise.resolve({ id: 'message-1' }) },
      openApp(target) { opened.push(target) },
    },
    addEventListener(name, fn) { (windowListeners[name] ||= []).push(fn) },
  }

  const canvasOptions = {}
  const canvas = {
    state: { nodes: [], connections: [] }, bus: { on() {} },
    typesByCategory() {
      const groups = {}
      Object.values(canvasOptions.nodeTypes || {}).forEach((def) => { (groups[def.category] ||= []).push(def) })
      return groups
    },
    toJSON() { return current },
    getNodes() { return current.nodes },
    getNode(nodeId) { return current.nodes.find((node) => node.id === nodeId) || null },
    getNodeElement() { return null },
    updateNode(nodeId, patch) {
      const node = this.getNode(nodeId)
      if (node) Object.assign(node, patch, { data: Object.assign({}, node.data || {}, patch.data || {}) })
      return node
    },
    addNode(type, data = {}, pos = {}) {
      const node = { id: `${type}-${++sequence}`, type, x: pos.x || 0, y: pos.y || 0,
        w: 250, h: 120, title: type, locked: false, minimized: false, data: { ...data } }
      current.nodes.push(node)
      return node
    },
    addConnection(from, to, fromPort = 'right', toPort = 'left') {
      const connection = { id: `conn-${++sequence}`, from, to, fromPort, toPort }
      current.connections.push(connection)
      return connection
    },
    clear() { current.nodes = []; current.connections = [] },
    fromJSON(data) { fromJSONCalls.push(data); current = JSON.parse(JSON.stringify(data)); return this },
    fitView() {}, _changed() {}, select() {}, duplicate() {}, removeNode() {}, paste() {},
    selectAll() {}, autoLayout() {}, screenToWorld() { return { x: 0, y: 0 } },
  }
  window.ZenCanvas = { create(options) { Object.assign(canvasOptions, options); return canvas } }

  const document = {
    readyState: 'loading', body: element('body'),
    getElementById(key) { return element(key) },
    addEventListener(name, fn) { (documentListeners[name] ||= []).push(fn) },
    createElement(tag) {
      const node = element(`created-${tag}-${++sequence}`)
      if (tag === 'input') node.click = () => { node.files = [importFile]; if (node.onchange) node.onchange() }
      return node
    },
  }
  class FileReader {
    readAsText(file) { this.result = file.content; if (this.onload) this.onload() }
  }
  function fetch(path, options = {}) {
    requests.push({ path, options })
    let payload = { ok: true }
    if (path === '/api/status') payload = { ok: true, runtime: { version: 'test', bundled: true }, openpyxl: '3.1', sheets: [] }
    else if (path === '/api/run') payload = { ok: true, jobId: 'job-1' }
    else if (path === '/api/job/job-1') payload = { ok: true, status: 'done', progress: 1, nodes: {}, outputs: [], conflicts: [], warnings: [] }
    return Promise.resolve({ json: () => Promise.resolve(payload) })
  }
  const storage = new Map()
  const localStorage = {
    getItem(key) { return storage.get(key) || null },
    setItem(key, value) { storage.set(key, value) },
  }
  const context = {
    window, document, localStorage, FileReader, fetch, URL, URLSearchParams, console,
    ZenCanvas: window.ZenCanvas, ZenUtil: window.ZenUtil, ZenUI: window.ZenUI,
    ZenJob: window.ZenJob, OMMShare: window.OMMShare,
    setTimeout() { return 1 }, clearTimeout() {},
  }
  vm.runInNewContext(read(`public/lib/zen-${id}.js`), context, { filename: `zen-${id}.js` })
  ;(documentListeners.DOMContentLoaded || []).forEach((fn) => fn())
  init = true

  function setCanvas(nodes, connections = []) {
    current = { version: 1, app: id, nodes, connections, view: { scale: 1, panX: 0, panY: 0 }, meta: {} }
    canvas.state.nodes = current.nodes
    canvas.state.connections = current.connections
  }
  return {
    id, window, document, canvas, canvasOptions, elements, requests, toasts, saves,
    parentMessages, fromJSONCalls, opened, setCanvas,
    get sent() { return sent },
    setSender(fn) { window.OMMShare.send = fn },
    setImport(value) { importFile = { name: 'workflow.json', content: typeof value === 'string' ? value : JSON.stringify(value) } },
    message(data) { (windowListeners.message || []).forEach((fn) => fn(data)) },
    assertReady() { assert.equal(init, true) },
  }
}

for (const id of ['video', 'table']) {
  test(`${id} 页面脚本使用共享画布、作业与受信父消息`, () => {
    const html = read(`public/omm-${id}.html`)
    const js = read(`public/lib/zen-${id}.js`)
    for (const asset of ['omm-embed.js', 'omm-desktop.js', 'omm-share.js', 'zen/canvas/engine.js', 'lib/zen-job.js']) {
      assert.ok(html.includes(asset), `${id} 缺少 ${asset}`)
    }
    assert.ok(js.includes('ZenUtil.isTrustedParentMessage(ev)'))
    assert.ok(!js.includes('ZenUtil.isLocalOrigin(ev.origin)'))
    assert.doesNotThrow(() => new Function(js))
  })
}

test('video 合法 input(fileId) 可提交，无文件 input 在本地拦截', async () => {
  const h = harness('video')
  h.setCanvas([{ id: 'in', type: 'input', data: { fileId: 'abcdef123456_clip.mp4', filename: 'clip.mp4' } }])
  h.elements.get('btn-run').click()
  await flush()
  const request = h.requests.find((item) => item.path === '/api/run')
  assert.ok(request)
  const spec = JSON.parse(request.options.body)
  assert.equal(spec.nodes[0].type, 'input')
  assert.equal(spec.nodes[0].data.fileId, 'abcdef123456_clip.mp4')

  h.setCanvas([{ id: 'in', type: 'input', data: { fileId: '', filename: '' } }])
  h.requests.length = 0
  h.elements.get('btn-run').click()
  await flush()
  assert.equal(h.requests.some((item) => item.path === '/api/run'), false)
  assert.ok(h.toasts.some((message) => message.includes('请先给“视频输入”节点选择文件')))
})

test('table 合法 file(fileId) 可提交，无文件 file 在本地拦截', async () => {
  const h = harness('table')
  h.setCanvas([{ id: 'file', type: 'file', data: { fileId: 'abcdef123456_book.xlsx', filename: 'book.xlsx' } }])
  h.elements.get('btn-run').click()
  await flush()
  const request = h.requests.find((item) => item.path === '/api/run')
  assert.ok(request)
  assert.equal(JSON.parse(request.options.body).spec.nodes[0].data.fileId, 'abcdef123456_book.xlsx')

  h.setCanvas([{ id: 'file', type: 'file', data: { fileId: '', filename: '' } }])
  h.requests.length = 0
  h.elements.get('btn-run').click()
  await flush()
  assert.equal(h.requests.some((item) => item.path === '/api/run'), false)
  assert.ok(h.toasts.some((message) => message.includes('请先给 Excel 文件节点导入文件')))
})

for (const id of ['video', 'table']) {
  test(`${id} 非法工作流导入不会清空当前画布`, () => {
    const h = harness(id)
    const baseline = [{ id: 'keep', type: id === 'video' ? 'input' : 'file', data: {} }]
    h.setCanvas(baseline)
    h.setImport({ app: id, nodes: [{ id: 'bad', type: 'unknown', data: {} }], connections: [] })
    h.elements.get('btn-open').click()
    assert.equal(h.fromJSONCalls.length, 0)
    assert.deepEqual(h.canvas.toJSON().nodes, baseline)
    assert.ok(h.toasts.some((message) => message.includes('文件解析失败')))

    h.setImport({ app: id, nodes: baseline, connections: [{ from: 'keep', to: 'missing' }] })
    h.elements.get('btn-open').click()
    assert.equal(h.fromJSONCalls.length, 0)
    assert.deepEqual(h.canvas.toJSON().nodes, baseline)
  })

  test(`${id} 卡片消息同时校验 parent source 与 origin`, () => {
    const h = harness(id)
    h.setCanvas([{ id: 'keep', type: id === 'video' ? 'input' : 'file', data: {} }])
    const data = { type: 'omm:zen-card-request', token: 'token-1' }
    h.message({ data, source: {}, origin: 'http://127.0.0.1:8300' })
    h.message({ data, source: h.window.parent, origin: 'http://127.0.0.1:9999' })
    assert.equal(h.parentMessages.length, 0)
    h.message({ data, source: h.window.parent, origin: 'http://127.0.0.1:8300' })
    assert.equal(h.parentMessages.length, 1)
    assert.equal(h.parentMessages[0].origin, 'http://127.0.0.1:8300')
  })

  test(`${id} AI workflow 由 OMMShare 投递且未确认时不假成功`, async () => {
    const h = harness(id)
    h.setCanvas([{ id: 'keep', type: id === 'video' ? 'input' : 'file', data: { fileId: 'abcdef123456_file' } }])
    h.elements.get('btn-ai').click()
    await flush()
    assert.equal(h.sent.to, 'ai')
    assert.equal(h.sent.format, `omm.${id}.workflow`)
    assert.equal(h.sent.payload.workflow.format, `omm-${id}-workflow`)
    assert.ok(h.toasts.some((message) => message.includes('已发给 AI 工作区')))
    assert.deepEqual(h.opened, ['ai'])

    h.toasts.length = 0
    h.opened.length = 0
    h.saves.length = 0
    h.setSender(() => Promise.resolve(null))
    h.elements.get('btn-ai').click()
    await flush()
    assert.equal(h.toasts.some((message) => message.includes('已发给 AI 工作区')), false)
    assert.deepEqual(h.opened, [])
    assert.equal(h.saves.length, 1)
  })
}

test('table exact 编辑器写 value，numeric/time 输入按类型归一化并支持文本结果', () => {
  const h = harness('table')
  const node = { id: 'map', type: 'mapCells', data: {
    op: 'lookup', lookupKind: 'exact', lookup: [{ value: '001', result: '低' }], defaultResult: '高',
  } }
  h.setCanvas([node])
  h.canvasOptions.onSelectionChange(['map'])
  let html = h.elements.get('inspector-body').innerHTML
  assert.ok(html.includes('data-col="value"'))
  assert.ok(!html.includes('data-col="min"'))
  assert.ok(html.includes('data-lookup-result-type'))
  const exactValue = h.elements.get('inspector-body').querySelectorAll('[data-tcell]')
    .find((item) => item.dataset.col === 'value')
  exactValue.value = '002'
  exactValue.dispatch('change')
  assert.equal(node.data.lookup[0].value, '002')

  node.data.lookupKind = 'numeric'
  node.data.lookupResultType = 'number'
  node.data.lookup = [{ min: '0', max: '10', result: '2.0' }]
  h.canvasOptions.onSelectionChange(['map'])
  html = h.elements.get('inspector-body').innerHTML
  assert.match(html, /type="number"[^>]*data-tcell="lookup"[^>]*data-col="min"/)
  assert.match(html, /type="number"[^>]*data-tcell="lookup"[^>]*data-col="result"/)

  node.data.lookupKind = 'time'
  h.canvasOptions.onSelectionChange(['map'])
  html = h.elements.get('inspector-body').innerHTML
  assert.match(html, /type="text"[^>]*data-tcell="lookup"[^>]*data-col="min"/)
  assert.match(html, /type="number"[^>]*data-tcell="lookup"[^>]*data-col="result"/)

  node.data.lookupResultType = 'text'
  node.data.defaultResult = '未命中'
  h.canvasOptions.onSelectionChange(['map'])
  html = h.elements.get('inspector-body').innerHTML
  assert.match(html, /type="text"[^>]*data-tcell="lookup"[^>]*data-col="result"/)
  assert.match(html, /type="text"[^>]*data-key="defaultResult"/)
})

test('table factor header 模式写入 factor.header', () => {
  const h = harness('table')
  const node = { id: 'map', type: 'mapColumns', data: {
    op: 'multiply', factor: { mode: 'header', header: '旧表头', value: 1 },
  } }
  h.setCanvas([node])
  h.canvasOptions.onSelectionChange(['map'])
  const input = h.elements.get('inspector-body').querySelectorAll('[data-factor]')
    .find((item) => item.dataset.factor === 'header')
  assert.ok(input)
  input.value = '新表头'
  input.dispatch('change')
  assert.equal(node.data.factor.header, '新表头')
})

test('video 0 音量摘要与 pivot 字符串摘要不再回退为默认值', () => {
  const video = read('public/lib/zen-video.js')
  const table = read('public/lib/zen-table.js')
  assert.ok(video.includes("(d.factor == null ? 1 : d.factor) + '× 音量'"))
  assert.ok(table.includes('rowKeysText(d.rowKeys)'))
})
