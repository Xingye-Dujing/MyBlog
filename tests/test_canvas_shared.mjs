/* Shared canvas/select/chart regressions (node:test). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { ZenChart } from '../public/lib/zen-chart.js'

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const engineSource = read('public/zen/canvas/engine.js')
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
  addEventListener(name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn) }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter((item) => item !== fn) }
  dispatchEvent(event) { (this.listeners[event.type] || []).forEach((fn) => fn(event)) }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    if (selector.startsWith('[')) {
      const match = selector.match(/^\[([^=\]]+)(?:=["']([^"']*)["'])?\]$/)
      if (!match) return false
      const value = this.dataset[match[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
      return match[2] == null ? value != null : String(value) === match[2]
    }
    return this.tagName === selector.toUpperCase()
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
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this }
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
  querySelectorAll(selector) { return selector === 'select[data-zen-select]' ? this.selects || [] : [] }
  matches() { return false }
}

function canvasContext() {
  const document = new FakeDocument()
  const window = { ZenUI: { menu: { close() {} }, toast() {} } }
  const context = {
    window,
    document,
    console,
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
  }
  vm.runInNewContext(engineSource, context)
  return { canvas: context.ZenCanvas, document }
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

function selectHarness() {
  const document = new FakeDocument()
  const menu = new FakeElement('div')
  menu.hidden = true
  const layer = { menu, get: () => layer, push() {}, pop() {}, blurAll() {} }
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
