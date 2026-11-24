/* video/table 页面行为回归：运行校验、导入原子性、消息 source 与 AI 投递。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')

// 产品不再自带画布校验器：测试桩直接使用共享引擎导出的 normalizeSpec。
const engineContext = { module: { exports: {} }, console }
vm.runInNewContext(read('public/zen/canvas/engine.js'), engineContext, { filename: 'engine.js' })
const { normalizeSpec } = engineContext.module.exports
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
function response(payload, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: () => Promise.resolve(JSON.stringify(payload)) }
}

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

function harness(product, seedStorage = {}) {
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
      switch: {
        isOn(el) { return el.getAttribute('aria-checked') === 'true' },
        set(el, on) { el.setAttribute('aria-checked', on ? 'true' : 'false') },
      },
    },
    ZenUtil: {
      saveJSON(name, data) { saves.push({ name, data }) },
      isTrustedParentMessage(event) {
        return event.source === parent && event.origin === 'http://127.0.0.1:8300'
      },
    },
    OMMShare: {
      send(options) { sent = options; return Promise.resolve({ id: 'message-1' }) },
      openApp(target) { opened.push(target) },
    },
    addEventListener(name, fn) { (windowListeners[name] ||= []).push(fn) },
    setTimeout() { return 1 },
    clearTimeout() {},
  }

  const canvasOptions = {}
  const canvasListeners = {}
  const canvas = {
    state: { nodes: [], connections: [] }, bus: {
      on(name, fn) { (canvasListeners[name] ||= []).push(fn) },
      emit(name, payload) { (canvasListeners[name] || []).forEach((fn) => fn(payload)) },
    },
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
  window.ZenCanvas = {
    create(options) { Object.assign(canvasOptions, options); return canvas },
    normalizeSpec(obj, config) { return normalizeSpec(obj, config) },
  }

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
  let fetchOverride = null
  function defaultFetch(path, options = {}) {
    requests.push({ path, options })
    let payload = { ok: true }
    if (path === '/api/status') payload = { ok: true, runtime: { version: 'test', bundled: true }, openpyxl: '3.1', sheets: [] }
    else if (path === '/api/run') payload = { ok: true, jobId: 'job-1' }
    else if (path === '/api/job/job-1') payload = { ok: true, status: 'done', progress: 1, nodes: {}, outputs: [], conflicts: [], warnings: [] }
    return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(payload)) })
  }
  function fetch(path, options = {}) {
    return fetchOverride ? fetchOverride(path, options) : defaultFetch(path, options)
  }
  const storage = new Map(Object.entries(seedStorage))
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
  vm.runInNewContext(read('public/lib/zen-job.js'), context, { filename: 'zen-job.js' })
  context.ZenJob = window.ZenJob
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
    setFetch(fn) { fetchOverride = fn },
    change() { canvas.bus.emit('change') },
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
  await settle()
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
  await settle()
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

    h.setImport({ app: id, version: '1', nodes: baseline, connections: [] })
    h.elements.get('btn-open').click()
    assert.equal(h.fromJSONCalls.length, 0)
    assert.ok(h.toasts.some((message) => message.includes('版本不受支持')))
  })

  test(`${id} 本地画布可直接回载且不再提示无效工作流`, () => {
    const saved = {
      version: 1, app: id,
      nodes: [{
        id: 'n1', type: id === 'video' ? 'input' : 'file',
        x: '80px', y: '140px', w: '250px', h: '120px', data: {},
      }],
      connections: [], view: { scale: 1, panX: 0, panY: 0 }, meta: {},
    }
    const h = harness(id, { [`zen.${id}.canvas.v1`]: JSON.stringify(saved) })
    assert.equal(h.fromJSONCalls.length, 1)
    assert.equal(h.fromJSONCalls[0].nodes[0].x, 80)
    assert.ok(!h.toasts.some((message) => message.includes('已忽略无效的本地工作流')))
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

test('video 导入校验与后端一致：probe 多上游和单输入 concat 被拒绝', () => {
  const h = harness('video')
  const baseline = [{ id: 'a', type: 'input', data: { fileId: 'aaaaaaaaaaaa_a.mp4' } }]
  h.setCanvas(baseline)
  h.setImport({ app: 'video', nodes: [
    { id: 'a', type: 'input', data: {} },
    { id: 'b', type: 'input', data: {} },
    { id: 'p', type: 'probe', data: {} },
  ], connections: [{ from: 'a', to: 'p' }, { from: 'b', to: 'p' }] })
  h.elements.get('btn-open').click()
  assert.equal(h.fromJSONCalls.length, 0)
  h.setImport({ app: 'video', nodes: [
    { id: 'a', type: 'input', data: {} },
    { id: 'c', type: 'concat', data: {} },
  ], connections: [{ from: 'a', to: 'c' }] })
  h.elements.get('btn-open').click()
  assert.equal(h.fromJSONCalls.length, 0)
  assert.deepEqual(h.canvas.toJSON().nodes, baseline)
})

test('video 0 音量摘要与 pivot 字符串摘要不再回退为默认值', () => {
  const video = read('public/lib/zen-video.js')
  const table = read('public/lib/zen-table.js')
  assert.ok(video.includes("(d.factor == null ? 1 : d.factor) + '× 音量'"))
  assert.ok(table.includes('rowKeysText(d.rowKeys)'))
})

for (const id of ['video', 'table']) {
  test(`${id} 页面声明应用身份、共享开关且无内联样式`, () => {
    const html = read(`public/omm-${id}.html`)
    const js = read(`public/lib/zen-${id}.js`)
    assert.ok(html.includes(`data-omm-app="${id}"`))
    assert.ok(html.includes('zen/components/switch.js'))
    assert.ok(!/\sstyle=/.test(html))
    assert.ok(js.includes('data-zen-switch'))
    assert.ok(!/type="checkbox"/.test(js))
    assert.ok(!/#c0392b/i.test(js))
  })

  test(`${id} 工作流变化后忽略旧任务结果并恢复控件`, async () => {
    const h = harness(id)
    const node = { id: 'source', type: id === 'video' ? 'input' : 'file',
      data: { fileId: 'abcdef123456_file', filename: 'file' } }
    h.setCanvas([node])
    const pending = deferred()
    h.setFetch((path) => {
      if (path === '/api/run') return Promise.resolve(response({ ok: true, jobId: 'job-1' }))
      if (path === '/api/job/job-1') return pending.promise
      return Promise.resolve(response({ ok: true }))
    })
    h.elements.get('btn-run').click()
    await settle()
    assert.equal(h.elements.get('btn-run').disabled, true)
    h.change()
    assert.ok(h.elements.get('result-body').innerHTML.includes('旧结果已清除'))
    pending.resolve(response({ ok: true, jobId: 'job-1', status: 'done', progress: 1,
      nodes: {}, outputs: [{ name: 'stale.bin', url: '/api/file/job-1/stale.bin' }] }))
    await settle()
    assert.equal(h.elements.get('btn-run').disabled, false)
    assert.equal(h.elements.get('btn-stop').disabled, true)
    assert.ok(!h.elements.get('result-body').innerHTML.includes('stale.bin'))
    assert.ok(h.toasts.some((message) => message.includes('旧任务结果已忽略')))
  })

  test(`${id} 任务 404 是终态并恢复运行控件`, async () => {
    const h = harness(id)
    h.setCanvas([{ id: 'source', type: id === 'video' ? 'input' : 'file',
      data: { fileId: 'abcdef123456_file', filename: 'file' } }])
    h.setFetch((path) => {
      if (path === '/api/run') return Promise.resolve(response({ ok: true, jobId: 'job-1' }))
      if (path === '/api/job/job-1') return Promise.resolve(response({ ok: false, error: '任务不存在' }, 404))
      return Promise.resolve(response({ ok: true }))
    })
    h.elements.get('btn-run').click()
    await settle()
    assert.equal(h.elements.get('btn-run').disabled, false)
    assert.equal(h.elements.get('btn-stop').disabled, true)
    assert.ok(h.toasts.some((message) => message.includes('任务不存在')))
  })

  test(`${id} 旧上传响应不能覆盖较新的上传`, async () => {
    const h = harness(id)
    const type = id === 'video' ? 'input' : 'file'
    const node = { id: 'source', type, data: { fileId: '', filename: '' } }
    h.setCanvas([node])
    const first = deferred()
    const second = deferred()
    const queue = [first, second]
    h.setFetch((path) => {
      if (path.startsWith('/api/upload?')) return queue.shift().promise
      if (path.startsWith('/api/book?')) return Promise.resolve(response({ ok: true, sheets: [] }))
      return Promise.resolve(response({ ok: true }))
    })
    const input = h.elements.get('file-input')
    input.files = [{ name: 'old.bin' }]
    input.dispatch('change')
    input.files = [{ name: 'new.bin' }]
    input.dispatch('change')
    second.resolve(response({ ok: true, fileId: 'bbbbbbbbbbbb_new.bin', name: 'new.bin' }))
    await settle()
    assert.equal(node.data.fileId, 'bbbbbbbbbbbb_new.bin')
    first.resolve(response({ ok: true, fileId: 'aaaaaaaaaaaa_old.bin', name: 'old.bin' }))
    await settle()
    assert.equal(node.data.fileId, 'bbbbbbbbbbbb_new.bin')
    assert.equal(node.data.filename, 'new.bin')
  })
}

function jobRuntime(fetchImpl) {
  const timers = []
  let sequence = 0
  const window = {
    setTimeout(fn, delay) { const timer = { id: ++sequence, fn, delay, cancelled: false }; timers.push(timer); return timer.id },
    clearTimeout(id) { const timer = timers.find((item) => item.id === id); if (timer) timer.cancelled = true },
  }
  const context = { window, fetch: fetchImpl, document: { addEventListener() {} } }
  vm.runInNewContext(read('public/lib/zen-job.js'), context, { filename: 'zen-job.js' })
  return {
    job: window.ZenJob,
    nextTimer() {
      const timer = timers.shift()
      assert.ok(timer && !timer.cancelled, '应存在待执行轮询定时器')
      timer.fn()
    },
    pendingTimers() { return timers.filter((timer) => !timer.cancelled).length },
  }
}

test('ZenJob 统一拒绝 HTTP、JSON 业务错误与非法 JSON', async () => {
  const payloads = [
    response({ ok: false, error: '后端拒绝' }, 400),
    response({ ok: false, error: '服务器错误' }, 500),
    { status: 200, ok: true, text: () => Promise.resolve('not-json') },
  ]
  const runtime = jobRuntime(() => Promise.resolve(payloads.shift()))
  for (const expected of ['后端拒绝', '服务器错误', '请求失败']) {
    await assert.rejects(runtime.job.post('', '/api/run', {}), (error) => error.message.includes(expected))
  }
  const success = jobRuntime(() => Promise.resolve(response({ ok: true, jobId: 'abc' })))
  assert.equal((await success.job.post('', '/api/run', {})).jobId, 'abc')
})

test('ZenJob 取消失败不假成功', async () => {
  const calls = []
  const runtime = jobRuntime((path) => {
    calls.push(path)
    return Promise.resolve(response({ ok: false, error: '任务已结束' }, 409))
  })
  await assert.rejects(runtime.job.cancel('', 'abc', () => {}), /任务已结束/)
  assert.deepEqual(calls, ['/api/cancel/abc'])
  const unconfirmed = jobRuntime(() => Promise.resolve(response({ ok: true, cancelled: false })))
  await assert.rejects(unconfirmed.job.cancel('', 'abc', () => {}), /未确认取消/)
  const toasts = []
  const confirmed = jobRuntime(() => Promise.resolve(response({ ok: true, cancelled: true })))
  await confirmed.job.cancel('', 'abc', (message) => toasts.push(message))
  assert.deepEqual(toasts, ['已请求停止'])
})

test('ZenJob 轮询去重、重试且仅结束一次', async () => {
  const first = deferred()
  const second = deferred()
  const third = deferred()
  const queue = [first, second, third]
  const paths = []
  const runtime = jobRuntime((path) => { paths.push(path); return queue.shift().promise })
  const states = []
  let finishes = 0
  runtime.job.poll('', 'abc', {
    onState(state) { states.push(state.status) },
    onFinish() { finishes += 1 },
  })
  assert.deepEqual(paths, ['/api/job/abc'])
  first.resolve(response({ ok: true, status: 'running' }))
  await settle()
  assert.equal(runtime.pendingTimers(), 1)
  runtime.nextTimer()
  second.resolve(response({ ok: false, error: '暂时失败' }, 500))
  await settle()
  assert.equal(finishes, 0)
  runtime.nextTimer()
  third.resolve(response({ ok: true, status: 'done' }))
  await settle()
  assert.deepEqual(states, ['running', 'done'])
  assert.equal(finishes, 1)
  assert.equal(runtime.pendingTimers(), 0)
})

test('ZenJob 404 轮询直接终态', async () => {
  const runtime = jobRuntime(() => Promise.resolve(response({ ok: false, error: '任务不存在' }, 404)))
  let finished = null
  runtime.job.poll('', 'abc', { onFinish(_state, error) { finished = error } })
  await settle()
  assert.equal(finished.status, 404)
  assert.equal(runtime.pendingTimers(), 0)
})
