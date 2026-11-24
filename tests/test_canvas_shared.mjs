/* Shared canvas/select/chart regressions (node:test). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { ZenChart } from '../public/lib/zen-chart.js'

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const engineSource = read('public/zen/canvas/engine.js')
const canvasCss = read('public/zen/canvas/canvas.css')
const writerCss = read('public/zen/products/writer.css')
const writerHtml = read('public/omm-writer.html')
const selectSource = read('public/zen/components/select.js')

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.className = ''
    this.dataset = {}
    this.style = {}
    this.children = []
    this.parentNode = null
    this.attributes = {}
    this.listeners = {}
    this.textContent = ''
    this.hidden = false
    this.disabled = false
    this.tabIndex = 0
    this.value = ''
    this.selectedIndex = 0
    this.options = []
    this.scrollHeight = 200
    this.offsetLeft = 0
    this.offsetTop = 0
    this.offsetWidth = 240
    this.offsetHeight = 110
    this.isConnected = true
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.classes(), ...names])].join(' ') },
      remove: (...names) => { this.className = this.classes().filter((name) => !names.includes(name)).join(' ') },
      toggle: (name, force) => {
        const has = this.classes().includes(name)
        const add = force == null ? !has : !!force
        if (add) this.classList.add(name)
        else this.classList.remove(name)
        return add
      },
      contains: (name) => this.classes().includes(name),
    }
  }

  classes() { return this.className.split(/\s+/).filter(Boolean) }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }
  insertBefore(child, reference) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    const index = reference ? this.children.indexOf(reference) : -1
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }
  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null }
  removeAttribute(name) { delete this.attributes[name] }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) }
  setPointerCapture() {}
  releasePointerCapture() {}
  addEventListener(name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn) }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter((item) => item !== fn) }
  dispatchEvent(event) { (this.listeners[event.type] || []).forEach((fn) => fn(event)) }
  matches(selector) {
    return String(selector).split(',').some((part) => {
      const simple = part.trim()
      const tag = simple.match(/^[a-z][\w-]*/i)
      if (tag && this.tagName !== tag[0].toUpperCase()) return false
      const classes = [...simple.matchAll(/\.([\w-]+)/g)]
      if (classes.some((match) => !this.classList.contains(match[1]))) return false
      const attrs = [...simple.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g)]
      return attrs.every((match) => {
        const key = match[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        const value = match[2] ?? match[3] ?? match[4]
        const current = this.dataset[key]
        return value == null ? current != null : String(current) === value
      })
    })
  }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node
    return null
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true
    return false
  }
  querySelectorAll(selector) {
    const found = []
    const visit = (node) => node.children.forEach((child) => {
      if (child.matches(selector)) found.push(child)
      visit(child)
    })
    visit(this)
    return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  getBoundingClientRect() { return { left: 0, top: 0, right: 240, bottom: 110, width: 240, height: 110 } }
  scrollIntoView() {}
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this
    this.dispatchEvent({ type: 'focus' })
  }
  blur() {}
  set innerHTML(value) { this._html = String(value); this.children = []; this.textContent = '' }
  get innerHTML() { return this._html || '' }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body')
    this.documentElement = new FakeElement('html')
    this.documentElement.appendChild(this.body)
    this.body.ownerDocument = this
    this.activeElement = null
    this.listeners = {}
  }
  createElement(tag) { const element = new FakeElement(tag); element.ownerDocument = this; return element }
  createElementNS(_namespace, tag) { return this.createElement(tag) }
  addEventListener(name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn) }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter((item) => item !== fn) }
  dispatchEvent(event) { (this.listeners[event.type] || []).forEach((fn) => fn(event)) }
  querySelectorAll(selector) { return selector === 'select[data-zen-select]' ? this.selects || [] : [] }
  matches() { return false }
}

function canvasContext() {
  const document = new FakeDocument()
  const window = { ZenUI: { menu: { close() {}, open() {} }, toast() {} } }
  const raf = []
  const context = {
    window,
    document,
    console,
    requestAnimationFrame: (fn) => { raf.push(fn); return raf.length },
    setTimeout: () => 0,
  }
  vm.runInNewContext(engineSource, context)
  return {
    canvas: context.ZenCanvas,
    document,
    flushRaf() {
      const pending = raf.splice(0)
      pending.forEach((fn) => fn())
    },
  }
}

function makeCanvas(ZenCanvas) {
  const selections = []
  let inspectorId = null
  const mount = new FakeElement('div')
  const canvas = ZenCanvas.create({
    scope: 'demo',
    mount,
    nodeTypes: {
      note: {
        label: 'Note',
        defaults: {},
        render(data, host) { host.textContent = data.text || '' },
      },
    },
    onSelectionChange(ids) {
      selections.push(Array.from(ids))
      inspectorId = ids.length === 1 ? ids[0] : null
    },
  })
  return { canvas, selections, inspectorId: () => inspectorId }
}

function pointer(target, type, init = {}) {
  const event = {
    type,
    target,
    button: 0,
    pointerId: 7,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: 0,
    clientY: 0,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    ...init,
  }
  target.dispatchEvent(event)
  return event
}

function keydown(target, key, init = {}) {
  const event = {
    type: 'keydown',
    target,
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    ...init,
  }
  target.dispatchEvent(event)
  return event
}

function sampleJSON() {
  return {
    version: 1,
    app: 'demo',
    nodes: [
      { id: 'a', type: 'note', x: 10, y: 20, data: { text: 'A' } },
      { id: 'b', type: 'note', x: 30, y: 40, data: { text: 'B' } },
    ],
    connections: [{ id: 'c1', from: 'a', to: 'b', fromPort: 'right', toPort: 'left' }],
    view: { scale: 1, panX: 0, panY: 0 },
  }
}

test('ZenCanvas.fromJSON validates the complete document before replacing current state', () => {
  const { canvas: ZenCanvas } = canvasContext()
  const { canvas } = makeCanvas(ZenCanvas)
  canvas.addNode('note', { text: 'old A' }, { x: 1, y: 2 })
  canvas.addNode('note', { text: 'old B' }, { x: 3, y: 4 })
  canvas.addConnection('note-1', 'note-2')
  const before = canvas.toJSON()
  const beforeNodes = canvas.state.nodes.slice()
  const invalid = [null, {}]

  const wrongApp = sampleJSON(); wrongApp.app = 'other'; invalid.push(wrongApp)
  const missingApp = sampleJSON(); delete missingApp.app; invalid.push(missingApp)
  const unknownType = sampleJSON(); unknownType.nodes[0].type = 'missing'; invalid.push(unknownType)
  const duplicateId = sampleJSON(); duplicateId.nodes[1].id = 'a'; invalid.push(duplicateId)
  const numericDuplicateId = sampleJSON(); numericDuplicateId.nodes[0].id = 1; numericDuplicateId.nodes[1].id = '1'; invalid.push(numericDuplicateId)
  const emptyId = sampleJSON(); emptyId.nodes[0].id = ' '; invalid.push(emptyId)
  const nonFiniteId = sampleJSON(); nonFiniteId.nodes[0].id = NaN; invalid.push(nonFiniteId)
  const unknownSource = sampleJSON(); unknownSource.connections[0].from = 'missing'; invalid.push(unknownSource)
  const unknownTarget = sampleJSON(); unknownTarget.connections[0].to = 'missing'; invalid.push(unknownTarget)
  const badConnections = sampleJSON(); badConnections.connections = {}; invalid.push(badConnections)
  const duplicateConnectionId = sampleJSON()
  duplicateConnectionId.connections.push({ id: 'c1', from: 'b', to: 'a', fromPort: 'left', toPort: 'right' })
  invalid.push(duplicateConnectionId)

  for (const data of invalid) {
    assert.throws(() => canvas.fromJSON(data, { history: false }))
    assert.deepEqual(canvas.toJSON(), before)
    assert.deepEqual(canvas.state.nodes, beforeNodes)
  }
})

test('ZenCanvas.fromJSON accepts valid data and generates missing connection ids', () => {
  const { canvas: ZenCanvas } = canvasContext()
  const { canvas, selections } = makeCanvas(ZenCanvas)
  canvas.addNode('note', { text: 'old' })
  canvas.select('note-1')
  const data = sampleJSON()
  delete data.connections[0].id
  canvas.fromJSON(data, { history: false })
  assert.deepEqual(Array.from(canvas.getNodes(), (node) => node.id), ['a', 'b'])
  assert.equal(canvas.getConnections().length, 1)
  assert.equal(canvas.getConnections()[0].id, 'conn-1')
  assert.deepEqual(selections.at(-1), [])
  assert.equal(canvas.getNodeElement('note-1'), null)
})

test('imported connection ids advance the generated id sequence', () => {
  const { canvas: ZenCanvas } = canvasContext()
  const { canvas } = makeCanvas(ZenCanvas)
  const data = sampleJSON()
  data.connections[0].id = 'conn-41'
  canvas.fromJSON(data, { history: false })
  const next = canvas.addConnection('b', 'a', 'right', 'left')
  assert.equal(next.id, 'conn-42')
})

test('CSS pixel coordinates from toJSON round-trip through the shared loader', () => {
  const { canvas: ZenCanvas } = canvasContext()
  const { canvas } = makeCanvas(ZenCanvas)
  canvas.addNode('note', { text: 'A' }, { x: 80, y: 140 })
  canvas.addNode('note', { text: 'B' }, { x: 420, y: 140 })
  canvas.addConnection('note-1', 'note-2')
  const saved = JSON.parse(JSON.stringify(canvas.toJSON()))
  assert.equal(saved.nodes[0].x, '80px')

  const restored = ZenCanvas.normalizeSpec(saved, { scope: 'demo', types: canvas.types })
  assert.equal(restored.nodes[0].x, 80)
  canvas.fromJSON(restored, { history: false })
  assert.deepEqual(JSON.parse(JSON.stringify(canvas.toJSON().nodes.map((n) => n.id))), ['note-1', 'note-2'])
  assert.equal(canvas.getConnections().length, 1)

  const spec = {
    format: 'demo-workflow',
    nodes: saved.nodes.map((n) => ({ id: n.id, type: n.type, data: n.data })),
    connections: saved.connections,
  }
  const imported = ZenCanvas.normalizeSpec(spec, {
    scope: 'demo', format: 'demo-workflow', types: canvas.types,
  })
  assert.equal(imported.nodes[0].x, 100)
  canvas.fromJSON(imported, { history: false })
  assert.equal(canvas.getConnections().length, 1)
})

test('Writer connection layer reuses the shared canvas SVG styles', () => {
  assert.match(writerHtml, /<svg id="svg-layer" class="zc-svg-layer"><\/svg>/)
  assert.doesNotMatch(canvasCss, /#svg-layer/)
  assert.match(canvasCss, /\.zc-svg-layer \.conn-line \{[\s\S]*?stroke: var\(--conn-color\)/)
  assert.match(writerCss, /body\.focus-mode #svg-layer \.conn-line/)
})

test('removeNode and clear publish empty selection so inspectors drop dead bindings', () => {
  const { canvas: ZenCanvas } = canvasContext()
  const { canvas, selections, inspectorId } = makeCanvas(ZenCanvas)
  canvas.addNode('note', { text: 'A' })
  canvas.addNode('note', { text: 'B' })
  const connection = canvas.addConnection('note-1', 'note-2')
  canvas.select('note-1')
  assert.equal(inspectorId(), 'note-1')
  canvas.setAlignBase('note-1')
  canvas.selectConnection(connection.id)
  canvas.removeNode('note-1')
  assert.deepEqual(selections.at(-1), [])
  assert.equal(inspectorId(), null)
  assert.equal(canvas.state.alignBaseId, null)
  assert.equal(canvas.state.selectedConnId, null)
  assert.equal(canvas.getConnections().length, 0)

  canvas.select('note-2')
  assert.equal(inspectorId(), 'note-2')
  canvas.clear()
  assert.deepEqual(selections.at(-1), [])
  assert.equal(inspectorId(), null)
  assert.deepEqual(Array.from(canvas.getNodes()), [])
  assert.deepEqual(Array.from(canvas.getConnections()), [])
})

test('ZenCanvas nodes and ports expose semantic keyboard controls', () => {
  const { canvas: ZenCanvas } = canvasContext()
  const { canvas } = makeCanvas(ZenCanvas)
  const rec = canvas.addNode('note', { title: 'A', locked: true, minimized: true }, { x: 10, y: 20 })
  const node = rec.el

  assert.equal(node.tabIndex, 0)
  assert.equal(node.getAttribute('role'), 'group')
  assert.match(node.getAttribute('aria-label'), /节点：A/)
  assert.equal(node.classList.contains('minimized'), true)
  assert.equal(node.style.height, '32px')

  const actions = node.querySelector('.node-actions')
  const lock = node.querySelector('[data-act="lock"]')
  const minimize = node.querySelector('[data-act="minimize"]')
  const remove = node.querySelector('[data-act="remove"]')
  for (const button of [lock, minimize, remove]) {
    assert.equal(button.tagName, 'BUTTON')
    assert.equal(button.type, 'button')
    assert.ok(button.getAttribute('aria-label'))
  }
  assert.equal(lock.getAttribute('aria-pressed'), 'true')
  assert.equal(minimize.getAttribute('aria-expanded'), 'false')
  assert.equal(minimize.disabled, true)
  assert.equal(remove.disabled, true)
  assert.equal(node.querySelector('.node-port.right').tagName, 'BUTTON')
  assert.equal(node.querySelector('.node-port.right').disabled, true)

  actions.dispatchEvent({ type: 'click', target: lock, stopPropagation() {} })
  assert.equal(rec.locked, false)
  assert.equal(lock.getAttribute('aria-pressed'), 'false')
  assert.equal(node.querySelector('.node-port.right').disabled, false)

  actions.dispatchEvent({ type: 'click', target: minimize, stopPropagation() {} })
  assert.equal(rec.minimized, false)
  assert.equal(minimize.getAttribute('aria-expanded'), 'true')
})

test('ZenCanvas pointer drag, resize and port linking work for mouse and touch', () => {
  assert.doesNotMatch(engineSource, /addEventListener\(['"](?:mouse|touch)(?:down|move|up|start|end|cancel)['"]/)
  for (const pointerType of ['mouse', 'touch']) {
    const { canvas: ZenCanvas, flushRaf } = canvasContext()
    const { canvas } = makeCanvas(ZenCanvas)
    const source = canvas.addNode('note', { title: 'Source' }, { x: 10, y: 20 })
    const target = canvas.addNode('note', { title: 'Target' }, { x: 300, y: 40 })
    const header = source.el.querySelector('.node-header')

    pointer(header, 'pointerdown', { pointerType, clientX: 100, clientY: 100 })
    assert.ok(canvas.state.nodeDrag)
    pointer(canvas.workspace.ownerDocument, 'pointermove', { pointerType, clientX: 130, clientY: 125 })
    assert.equal(source.el.style.left, '40px')
    assert.equal(source.el.style.top, '45px')
    pointer(canvas.workspace.ownerDocument, 'pointerup', { pointerType, clientX: 130, clientY: 125 })
    assert.equal(canvas.state.nodeDrag, null)

    const handle = source.el.querySelector('.node-resize')
    pointer(handle, 'pointerdown', { pointerType, clientX: 200, clientY: 200 })
    pointer(canvas.workspace.ownerDocument, 'pointermove', { pointerType, clientX: 250, clientY: 230 })
    pointer(canvas.workspace.ownerDocument, 'pointerup', { pointerType, clientX: 250, clientY: 230 })
    assert.equal(source.el.style.width, '290px')
    assert.equal(source.el.style.height, '140px')

    const sourcePort = source.el.querySelector('.node-port.right')
    const targetPort = target.el.querySelector('.node-port.left')
    canvas._portAt = () => targetPort
    pointer(sourcePort, 'pointerdown', { pointerType, clientX: 250, clientY: 90 })
    assert.equal(canvas.state.portDrag.keyboard, false)
    pointer(canvas.workspace.ownerDocument, 'pointermove', { pointerType, clientX: 300, clientY: 90 })
    flushRaf()
    pointer(canvas.workspace.ownerDocument, 'pointerup', { pointerType, clientX: 300, clientY: 90 })
    assert.equal(canvas.state.portDrag, null)
    assert.equal(canvas.getConnections().length, 1)
    assert.equal(canvas.getConnections()[0].from, source.id)
    assert.equal(canvas.getConnections()[0].to, target.id)
  }
})

test('ZenCanvas touch pan and pinch use the same pointer stream', () => {
  const { canvas: ZenCanvas } = canvasContext()
  const { canvas } = makeCanvas(ZenCanvas)
  const document = canvas.workspace.ownerDocument
  pointer(canvas.workspace, 'pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 10 })
  pointer(document, 'pointermove', { pointerType: 'touch', pointerId: 1, clientX: 40, clientY: 25 })
  assert.equal(canvas.state.panX, 30)
  assert.equal(canvas.state.panY, 15)
  pointer(document, 'pointerup', { pointerType: 'touch', pointerId: 1, clientX: 40, clientY: 25 })
  assert.equal(canvas.state.isPanning, false)

  pointer(canvas.workspace, 'pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 100 })
  pointer(canvas.workspace, 'pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 100 })
  assert.ok(canvas._pinch)
  pointer(document, 'pointermove', { pointerType: 'touch', pointerId: 1, clientX: 50, clientY: 100 })
  assert.equal(canvas.state.scale, 0.5)
  pointer(document, 'pointerup', { pointerType: 'touch', pointerId: 1, clientX: 50, clientY: 100 })
  assert.equal(canvas.state.isPanning, true)
  pointer(document, 'pointermove', { pointerType: 'touch', pointerId: 2, clientX: 120, clientY: 110 })
  assert.equal(canvas.state.panX, 85)
  pointer(document, 'pointerup', { pointerType: 'touch', pointerId: 2, clientX: 120, clientY: 110 })
})

test('ZenCanvas supports node keyboard movement, selection, deletion and scoped shortcuts', () => {
  const { canvas: ZenCanvas } = canvasContext()
  const { canvas } = makeCanvas(ZenCanvas)
  const document = canvas.workspace.ownerDocument
  const first = canvas.addNode('note', { title: 'A' }, { x: 10, y: 20 })
  const second = canvas.addNode('note', { title: 'B' }, { x: 100, y: 120 })
  const node = first.el

  node.focus()
  assert.deepEqual(Array.from(canvas.getSelection()), [first.id])
  keydown(node, 'ArrowRight')
  keydown(node, 'ArrowDown', { shiftKey: true })
  assert.equal(node.style.left, '11px')
  assert.equal(node.style.top, '30px')

  canvas.clearSelection()
  keydown(node, 'Enter')
  assert.deepEqual(Array.from(canvas.getSelection()), [first.id])
  canvas.clearSelection()
  keydown(node, ' ')
  assert.deepEqual(Array.from(canvas.getSelection()), [first.id])

  keydown(document, 'a', { ctrlKey: true, target: node })
  assert.deepEqual(Array.from(canvas.getSelection()).sort(), [first.id, second.id].sort())
  keydown(document, 'd', { ctrlKey: true, target: node })
  assert.equal(canvas.getNodes().length, 4)
  keydown(document, 'z', { ctrlKey: true, target: node })
  assert.equal(canvas.getNodes().length, 2)

  const outside = document.createElement('button')
  keydown(document, 'a', { ctrlKey: true, target: outside })
  assert.deepEqual(Array.from(canvas.getSelection()), [])

  const currentNode = canvas.getNodeElement(first.id)
  currentNode.focus()
  const input = document.createElement('input')
  currentNode.querySelector('.node-content').appendChild(input)
  keydown(document, 'a', { ctrlKey: true, target: input })
  assert.deepEqual(Array.from(canvas.getSelection()), [first.id])

  keydown(currentNode, 'Delete')
  assert.equal(canvas.getNode(first.id), null)
  assert.equal(canvas.getNode(second.id).id, second.id)
})

test('ZenCanvas ports provide a keyboard connection mode with Escape cancellation', () => {
  const { canvas: ZenCanvas } = canvasContext()
  const { canvas } = makeCanvas(ZenCanvas)
  const source = canvas.addNode('note', { title: 'Source' }, { x: 10, y: 20 })
  const target = canvas.addNode('note', { title: 'Target' }, { x: 300, y: 40 })
  const sourcePort = source.el.querySelector('.node-port.right')
  const targetPort = target.el.querySelector('.node-port.left')

  keydown(sourcePort, 'Enter')
  assert.equal(canvas.state.portDrag.keyboard, true)
  assert.equal(canvas.workspace.dataset.connecting, 'true')
  assert.equal(sourcePort.getAttribute('aria-pressed'), 'true')
  assert.match(canvas.status.textContent, /Tab.*Enter.*Space.*Escape/)
  targetPort.dispatchEvent({ type: 'focus' })
  assert.notEqual(canvas.state.tempLine.getAttribute('d'), 'M 250 75 L 250 75')
  keydown(targetPort, ' ')
  assert.equal(canvas.getConnections().length, 1)
  assert.equal(canvas.state.portDrag, null)
  assert.equal(canvas.workspace.dataset.connecting, 'false')

  keydown(sourcePort, 'Enter')
  keydown(canvas.workspace.ownerDocument, 'Escape', { target: sourcePort })
  assert.equal(canvas.state.portDrag, null)
  assert.equal(canvas.getConnections().length, 1)
})

test('shared canvas CSS owns generic nodes while Writer private rules live in the product layer', () => {
  for (const selector of ['#outline', '.nbp-', '.node-markdown', '.node-todo', '.ft-color-dot', '#floating-toolbar']) {
    assert.doesNotMatch(canvasCss, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `shared canvas CSS retains ${selector}`)
    assert.match(writerCss, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Writer CSS is missing ${selector}`)
  }
  assert.doesNotMatch(canvasCss, /\.zc-context-menu|\.zc-toast/)
  assert.doesNotMatch(writerCss, /\.zc-context-menu|\.zc-toast/)
  assert.doesNotMatch(canvasCss, /accent-green|#339933/)
  assert.match(canvasCss, /--port-color: var\(--zen-canvas-port\)/)
  assert.match(canvasCss, /--conn-color: var\(--zen-canvas-conn\)/)
  assert.match(canvasCss, /--node-bg: var\(--zen-canvas-node\)/)
  assert.match(canvasCss, /--title-color: var\(--zen-canvas-title\)/)
  assert.match(canvasCss, /\.node\.selected \{\s*outline: 2px solid var\(--zen-accent\)/)
  assert.match(canvasCss, /\.node\[data-state='done'\] \{\s*border-color: var\(--zen-accent\)/)
  assert.equal((canvasCss.match(/\.node\.zc-node \{/g) || []).length, 1)
  assert.doesNotMatch(canvasCss, /\.node\.zc-node \{\s*position: absolute/)
  assert.match(canvasCss, /:focus-visible/)
  assert.match(canvasCss, /@media \(prefers-reduced-motion: reduce\)/)

  const mobileStart = canvasCss.indexOf('@media (max-width: 760px)')
  const mobileEnd = canvasCss.indexOf('@media (max-width: 420px)', mobileStart)
  const mobile = canvasCss.slice(mobileStart, mobileEnd)
  assert.match(mobile, /\.workspace-body \{\s*display: flex;\s*flex-direction: column;/)
  assert.match(mobile, /#canvas-host \{\s*min-height: 320px;/)

  const coarseStart = canvasCss.indexOf('@media (hover: none), (pointer: coarse)')
  const coarseEnd = canvasCss.indexOf('@media (prefers-reduced-motion: reduce)', coarseStart)
  const coarse = canvasCss.slice(coarseStart, coarseEnd)
  assert.match(coarse, /\.node \.node-header \{\s*opacity: 1;/)
  assert.match(coarse, /\.node \.node-port \{\s*opacity: 0\.85;/)
  assert.match(coarse, /\.node \.node-resize \{\s*opacity: 1;/)
})

function selectHarness() {
  const document = new FakeDocument()
  const menu = new FakeElement('div')
  menu.hidden = true
  const layer = { menu, get: () => layer, push() {}, pop() {}, blurAll() {}, restoreFocus() {} }
  const window = {
    ZenUI: { layer },
    ZenUtil: { esc: (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;') },
    innerWidth: 1000,
    innerHeight: 800,
    setTimeout: () => 0,
  }
  const context = { window, document, Event: class { constructor(type) { this.type = type } }, MutationObserver: undefined }
  vm.runInNewContext(selectSource, context)

  const ownerLabel = new FakeElement('label')
  const container = new FakeElement('div')
  ownerLabel.appendChild(container)
  const select = document.createElement('select')
  select.dataset.zenSelect = ''
  select.options = [{ value: 'keep', textContent: 'Keep' }, { value: 'other', textContent: 'Other' }]
  select.selectedIndex = 0
  select.value = 'keep'
  container.appendChild(select)
  document.selects = [select]
  const focusTarget = document.createElement('input')
  document.activeElement = focusTarget
  window.ZenUI.select.enhance(document)
  const click = ownerLabel.listeners.click[0]
  return { click, close: () => window.ZenUI.select.close(), layer, menu, select, ownerLabel, document, focusTarget }
}

test('shared select label proxy opens only for non-interactive text and preserves focus/value', () => {
  for (const token of ['input', 'textarea', 'button', 'select', 'a[href]', '[contenteditable]', '[role="button"]']) {
    assert.ok(selectSource.includes(token), `interactive selector missing ${token}`)
  }
  const harness = selectHarness()
  const text = new FakeElement('span')
  harness.ownerLabel.appendChild(text)
  let prevented = false
  harness.click({ target: text, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(harness.menu.hidden, false)
  assert.equal(harness.select.value, 'keep')
  assert.equal(harness.document.activeElement, harness.focusTarget)
  assert.equal(harness.ownerLabel.getAttribute('for'), null)
  harness.close()

  const interactiveTags = ['input', 'textarea', 'button', 'select', 'a', 'div']
  for (const tag of interactiveTags) {
    const target = new FakeElement(tag)
    target.closest = () => target
    harness.ownerLabel.appendChild(target)
    prevented = false
    harness.click({ target, preventDefault() { prevented = true } })
    assert.equal(prevented, false, `${tag} must retain its own interaction`)
    assert.equal(harness.menu.hidden, true, `${tag} must not open the proxy`)
    assert.equal(harness.document.activeElement, harness.focusTarget)
    assert.equal(harness.select.value, 'keep')
  }
})

test('ZenChart draws negative bars from zeroY with positive height', () => {
  const svg = ZenChart.renderSVG({
    kind: 'bar',
    labels: ['negative', 'positive'],
    series: [{ name: 's', values: [-4, 4] }],
  })
  const bars = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"[^>]*><title>s: (-?[\d.]+)<\/title><\/rect>/g)]
    .map((match) => ({ y: Number(match[1]), height: Number(match[2]), value: Number(match[3]) }))
  assert.equal(bars.length, 2)
  const negative = bars.find((bar) => bar.value < 0)
  const positive = bars.find((bar) => bar.value > 0)
  assert.ok(negative.height > 0)
  assert.ok(positive.height > 0)
  const zeroY = positive.y + positive.height
  assert.ok(Math.abs(negative.y - zeroY) < 1e-9, 'negative bar must start at zeroY')
  assert.ok(negative.y + negative.height > zeroY, 'negative bar must extend below zeroY')

  const allNegative = ZenChart.renderSVG({ kind: 'bar', labels: ['a', 'b'], series: [{ name: 's', values: [-2, -5] }] })
  const heights = [...allNegative.matchAll(/<title>s: -\d+<\/title><\/rect>/g)]
  assert.equal(heights.length, 2)
  assert.ok([...allNegative.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"[^>]*><title>s: -\d+/g)]
    .every((match) => Number(match[2]) > 0))
})
