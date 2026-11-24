/* Hub 数据流面板专项测试（node:test） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const hub = readFileSync(new URL('../public/omm-hub.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../public/omm-hub.html', import.meta.url), 'utf8')

function extractFunction(text, name) {
  const start = text.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, name + ' 未找到')
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error('括号不平衡: ' + name)
}

test('Hub 页面含数据流入口与面板元素', () => {
  assert.ok(html.includes('data-act="flow"'))
  assert.ok(html.includes('id="data-flow"'))
  assert.ok(html.includes('id="flow-channels"'))
  assert.ok(html.includes('id="flow-event-list"'))
  assert.ok(html.includes('id="flow-status"'))
})

test('Hub 注册数据流命令与工具栏分支', () => {
  assert.ok(hub.includes("{ id: 'data-flow', label: '数据流', def: '' }"))
  assert.ok(hub.includes("act === 'flow'"))
  assert.ok(hub.includes("action === 'data-flow'"))
  assert.ok(hub.includes('function openDataFlow()'))
  assert.ok(hub.includes('function flowChannels()'))
})

test('flowChannels 按通道分组并保留角色', () => {
  const fn = new Function('APP_LIST', `return (${extractFunction(hub, 'flowChannels')})()`)([
    { id: 'data', share: { channels: [{ id: 'data.tables', role: 'both' }] } },
    { id: 'visualization', share: { channels: [{ id: 'data.tables', role: 'consume' }, { id: 'documents', role: 'publish' }] } },
    { id: 'writer', share: { channels: [{ id: 'documents', role: 'both' }] } },
    { id: 'search', share: {} },
  ])
  assert.equal(fn.length, 2)
  const tables = fn.find((c) => c.id === 'data.tables')
  assert.deepEqual(tables.apps.map((a) => a.id), ['data', 'visualization'])
  assert.equal(tables.apps[1].role, 'consume')
  const docs = fn.find((c) => c.id === 'documents')
  assert.equal(docs.apps.length, 2)
})

test('共享与卡片事件会写入流转记录', () => {
  assert.ok(hub.includes("pushFlowEvent('card',"))
  assert.ok(hub.includes("pushFlowEvent('share',"))
  const seg = hub.slice(hub.indexOf('function pushFlowEvent('), hub.indexOf('function openDataFlow('))
  assert.ok(seg.includes('flowEvents.unshift'))
  assert.ok(seg.includes('flowEvents.length > 30'))
})

test('renderDataFlow 渲染通道与角色标签', () => {
  assert.ok(hub.includes("roleLabel = { both: '双向', publish: '发布', consume: '消费' }"))
  assert.ok(hub.includes('flow-chip '))
  assert.ok(hub.includes('esc(ch.id)'))
})
