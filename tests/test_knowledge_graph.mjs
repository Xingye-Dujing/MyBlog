/* Hub 原生知识图谱专项测试（node:test）
 * 从实际源码抽取纯函数在 VM 中执行，并做协议 / 静态护栏断言。
 * 运行：node tests/test_knowledge_graph.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const hub = read('public/omm-hub.js')
const html = read('public/omm-hub.html')
const link = read('public/zen-link.js')

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

function load(text, names, extra = {}) {
  const code = names.map((n) => extractFunction(text, n)).join('\n') +
    `\nreturn { ${names.join(', ')} }`
  return vm.runInNewContext(`(function () { ${code} })()`, { Math, Object, Array, String, ...extra })
}

test('Hub 页面包含图谱入口与面板元素', () => {
  assert.ok(html.includes('data-act="graph"'))
  assert.ok(html.includes('id="knowledge-graph"'))
  assert.ok(html.includes('id="kg-canvas"'))
  assert.ok(html.includes('id="kg-list"'))
  assert.ok(html.includes('id="kg-detail"'))
})

test('Hub 注册了图谱命令与工具栏分支', () => {
  assert.ok(hub.includes("{ id: 'knowledge-graph', label: '知识图谱', def: '' }"))
  assert.ok(hub.includes("act === 'graph'"))
  assert.ok(hub.includes("action === 'knowledge-graph'"))
  assert.ok(hub.includes('function openKnowledgeGraph()'))
  assert.ok(hub.includes('function renderKnowledgeGraph()'))
})

test('所有跨 iframe 的卡片请求都使用 frameTargetOrigin（无通配符）', () => {
  const segment = hub.slice(hub.indexOf('function collectGraphCards()'), hub.indexOf('function dedupeGraphCards()'))
  assert.ok(segment.includes("type: 'omm:zen-card-request'"))
  assert.ok(segment.includes('frameTargetOrigin(frame)'))
  assert.doesNotMatch(segment, /postMessage\([^,]+,\s*'\*'/)
})

test('Hub 处理产品回传的卡片', () => {
  assert.ok(hub.includes("data.type === 'omm:zen-card-reply'"))
  assert.ok(hub.includes('graphCards = dedupeGraphCards'))
})

test('kgNormalize 归一化并过滤空内容', () => {
  const { kgNormalize } = load(hub, ['kgNormalize'])
  const card = kgNormalize({ id: 'zc-1', kind: 'quote', source: 'annotate', content: '句子', tags: ['a'], links: [{ id: 'zc-2' }], color: '#f00' })
  assert.equal(card.id, 'zc-1')
  assert.equal(card.kind, 'quote')
  assert.deepEqual(card.tags, ['a'])
  assert.equal(card.links.length, 1)
  assert.equal(kgNormalize({ content: '' }), null)
  assert.equal(kgNormalize(null), null)
  const noId = kgNormalize({ content: 'x' })
  assert.ok(noId.id.startsWith('kg-'))
})

test('kgNormalize 截断超过 8 个的标签', () => {
  const { kgNormalize } = load(hub, ['kgNormalize'])
  const tags = Array.from({ length: 12 }, (_, i) => 't' + i)
  assert.equal(kgNormalize({ content: 'x', tags }).tags.length, 8)
})

test('dedupeGraphCards 按 id 去重并保持顺序', () => {
  const { dedupeGraphCards } = load(hub, ['dedupeGraphCards'])
  const out = dedupeGraphCards([{ id: 'a', content: '1' }, { id: 'b', content: '2' }, { id: 'a', content: '3' }])
  assert.deepEqual(out.map((c) => c.id), ['a', 'b'])
  assert.equal(dedupeGraphCards(null).length, 0)
})

test('kgEscape 转义 HTML', () => {
  const { kgEscape } = load(hub, ['kgEscape'])
  assert.equal(kgEscape('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;')
})

test('产品端响应收集请求，并以明确 origin 回传', () => {
  assert.ok(link.includes("d.type === 'omm:zen-card-request'"))
  assert.ok(link.includes("type: 'omm:zen-card-reply'"))
  assert.ok(link.includes('parentTarget()'))
  assert.doesNotMatch(link, /postMessage\([^,]+,\s*'\*'/)
})

test('Hub 本地卡片来源覆盖 card/inbox/clip', () => {
  assert.ok(hub.includes("'zen.cards.v1', 'zen.inbox.v1', 'zen.clip.v1'"))
})
