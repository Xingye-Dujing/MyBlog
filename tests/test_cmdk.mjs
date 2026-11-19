/* Cmd+K 全局命令面板扩展专项测试（node:test）
 * 面板本体不重写：在既有 buildCmdkItems 上增加卡片 / 笔记 / 搜索历史三类来源。
 * 运行：node tests/test_cmdk.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const hub = read('public/omm-hub.js')

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

test('命令面板读取产品既有的 localStorage 键', () => {
  const seg = hub.slice(hub.indexOf('function buildCmdkItems()'), hub.indexOf('function loadCmdkShares()'))
  for (const key of ['zen.cards.v1', 'zen.inbox.v1', 'zen.clip.v1', 'zc-docs', 'omm-search-v1']) {
    assert.ok(seg.includes("'" + key + "'"), '缺少来源: ' + key)
  }
})

test('新增三组复用既有动作函数，未引入新协议', () => {
  const seg = hub.slice(hub.indexOf('function buildCmdkItems()'), hub.indexOf('function loadCmdkShares()'))
  assert.ok(seg.includes("group: '知识卡片'"))
  assert.ok(seg.includes("group: '笔记'"))
  assert.ok(seg.includes("group: '搜索历史'"))
  assert.ok(seg.includes('openKnowledgeGraph()'))
  assert.ok(seg.includes('showKgDetail(c)'))
  assert.ok(seg.includes("activateApp('writer')"))
  assert.ok(seg.includes("activateApp('search')"))
})

test('渲染分组顺序包含新增三组', () => {
  const seg = hub.slice(hub.indexOf('var groups = ['), hub.indexOf('var html =', hub.indexOf('var groups = [')))
  for (const g of ['知识卡片', '笔记', '搜索历史']) assert.ok(seg.includes("'" + g + "'"), g)
})

test('cmdkRead 正确解析 JSON，损坏时回退默认值', () => {
  const fn = extractFunction(hub, 'cmdkRead')
  const store = { good: '[{"a":1}]', bad: '{not-json' }
  const localStorage = { getItem: (k) => store[k] || null }
  const { cmdkRead } = vm.runInNewContext(
    `(function(){ ${fn}; return { cmdkRead: cmdkRead } })()`,
    { JSON, localStorage }
  )
  assert.deepEqual(cmdkRead('good', []), [{ a: 1 }])
  assert.deepEqual(cmdkRead('bad', []), [])
  assert.deepEqual(cmdkRead('missing', { x: 2 }), { x: 2 })
})

test('Ctrl+K 绑定与命令项仍在', () => {
  assert.ok(hub.includes("{ id: 'command-palette', label: '命令面板', def: 'Ctrl+K' }"))
  assert.ok(hub.includes('function openCommandPalette('))
})
