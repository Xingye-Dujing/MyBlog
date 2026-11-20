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
  return vm.runInNewContext(`(function () { ${code} })()`, { Math, Object, Array, String, Number, ...extra })
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

/* ------------------------------------------- AI 实时数据快照 */

function liveData(store, flowEvents) {
  const localStorage = { getItem: (k) => (k in store ? store[k] : null) }
  const { collectLiveLocalData } = load(hub, ['annotateLiveSnapshot', 'collectLiveLocalData'],
    { localStorage, JSON, Date, flowEvents: flowEvents || [] })
  return collectLiveLocalData()
}

test('Hub 聚合各产品的同源 localStorage 键', () => {
  const snap = liveData({
    'zen.cards.v1': JSON.stringify([{ content: 'SM-2 算法', kind: 'fact', tags: ['学习'] }]),
    'zen.inbox.v1': JSON.stringify([{ content: '收件箱条目' }]),
    'zc-docs': JSON.stringify([{ title: '我的笔记', content: '正文' }]),
    'omm-search-v1': JSON.stringify([{ query: '卡片盒', answer: '笔记方法' }]),
    'zen.flow.rules.v1': JSON.stringify([{ name: '归档规则', enabled: true }]),
    'zen.clip.v1': JSON.stringify([{ content: '剪藏内容' }]),
  })
  assert.equal(snap.cards.length, 2)
  assert.equal(snap.cards[0].content, 'SM-2 算法')
  assert.equal(snap.cards[0].tags.join(','), '学习')
  assert.equal(snap.notes[0].title, '我的笔记')
  assert.equal(snap.searches[0].query, '卡片盒')
  assert.equal(snap.rules[0].name, '归档规则')
  assert.equal(snap.clips[0].content, '剪藏内容')
})

test('Hub 读取对象形状的真实产品存储（Search/Writer/Planner）', () => {
  const snap = liveData({
    'omm-search-v1': JSON.stringify({ settings: { apiKey: 'secret' }, history: [{ query: '真实检索', answer: '答案' }] }),
    'zc-docs': JSON.stringify({ v: 2, activeId: 'd1', order: ['d1'], meta: { d1: { name: '真实笔记' } } }),
    'zp-data-v2': JSON.stringify({
      planners: [{ id: 'p1' }], activeId: 'p1',
      eventsBy: { p1: { '2026-03-01': [{ title: '真实日程', done: true }] } },
    }),
  })
  assert.equal(snap.searches.length, 1)
  assert.equal(snap.searches[0].query, '真实检索')
  assert.equal(snap.notes[0].title, '真实笔记')
  assert.equal(snap.planner.length, 1)
  assert.equal(snap.planner[0].title, '真实日程')
  assert.equal(snap.planner[0].done, true)
})

test('Hub 损坏的 localStorage 数据被安全忽略', () => {
  const snap = liveData({ anything: '{not-json' })
  for (const key of ['cards', 'notes', 'searches', 'rules', 'clips', 'planner']) {
    assert.equal(snap[key].length, 0)
  }
})

test('Hub 快照包含 Annotate 的只读编码快照', () => {
  const snap = liveData({
    'zencode.project.v1': JSON.stringify({
      title: '论文精读',
      codes: [{ id: 'c1', no: 'C1', name: '论点', level: '主题', def: '作者的核心主张' }],
      docs: [{ id: 'd1', title: '原文', text: '第一行\n第二行\n第三行' }],
      anns: [{ code: 'c1', star: true, quote: '核心论点', doc: 'd1', start: 8, end: 12, memo: '重要' }],
      marks: [{ star: true, quote: '金句', doc: 'd1', text: '批注内容' }],
      cellCodes: [{ code: 'c1', star: true, row: 1, col: 'B', table: 'd1', round: 2 }],
      reliability: [{ stat: { kappa: 0.8, po: 0.9, N: 10 }, source: '双编码' }],
    }),
  })
  const ann = snap.annotate
  assert.equal(ann.title, '论文精读')
  assert.equal(ann.counts.docs, 1)
  assert.equal(ann.counts.codes, 1)
  assert.equal(ann.counts.starred, 3)
  assert.equal(ann.codes[0].name, '论点')
  assert.equal(ann.codes[0].count, 2)
  assert.equal(ann.starred.length, 3)
  assert.ok(ann.starred.some((s) => s.source === '原文'))
  assert.equal(ann.reliability[0].kappa, 0.8)
})

test('Hub 损坏的 Annotate 数据被安全忽略', () => {
  const snap = liveData({ 'zencode.project.v1': '{broken' })
  assert.equal(snap.annotate, null)
})

test('Hub 快照包含 timeline 与 Planner 完成项', () => {
  const snap = liveData({
    'zp-data-v2': JSON.stringify([{ days: {
      '2026-01-01': [{ title: '写周报', done: true }, { title: '未完', done: false }],
    } }]),
  }, [
    { kind: 'card', text: '收到 3 张卡片', at: 1767225600000 },
    { kind: 'snapshot', text: '保存了文档', at: 1767312000000 },
  ])
  assert.equal(snap.timeline.length, 2)
  assert.equal(snap.timeline[0].app, 'card')
  assert.ok(snap.timeline[0].ts)
  assert.equal(snap.planner.length, 2)
  assert.equal(snap.planner[0].title, '写周报')
  assert.equal(snap.planner[0].done, true)
  assert.equal(snap.planner[1].done, false)
})

test('Hub 快照绝不携带 Planner 的隐藏日程', () => {
  const snap = liveData({
    'zp-data-v2': JSON.stringify([{ days: {
      '2026-01-01': [
        { title: '普通待办', done: true },
        { title: '绝密内容', done: false, hidden: true },
        { title: '•••••', done: false, hidden: true },
      ],
    } }]),
  })
  assert.equal(snap.planner.length, 1)
  assert.equal(snap.planner[0].title, '普通待办')
  assert.ok(!JSON.stringify(snap).includes('绝密内容'))
})

test('Viz 送复盘的图表进入 Hub 时间线', () => {
  const snap = liveData({
    'zen.viz.review.v1': JSON.stringify([
      { app: 'visualization', ts: '2026-02-01T10:00:00Z', title: '论文趋势', chartType: 'line', rows: 12 },
    ]),
  })
  const chartEvents = snap.timeline.filter((e) => e.app === 'visualization')
  assert.equal(chartEvents.length, 1)
  assert.ok(chartEvents[0].title.includes('论文趋势'))
  assert.ok(chartEvents[0].title.includes('line'))
  assert.ok(chartEvents[0].title.includes('12 行'))
})

test('live-data 请求用明确 origin、无通配符，并复用卡片协议', () => {
  const segment = hub.slice(hub.indexOf('function respondLiveData('), hub.indexOf('function dedupeGraphCards('))
  assert.ok(segment.includes("type: 'omm:zen-card-request'"))
  assert.ok(segment.includes('frameTargetOrigin(frame)'))
  assert.ok(segment.includes("type: 'omm:live-data-reply'"))
  assert.doesNotMatch(segment, /postMessage\([^,]+,\s*'\*'/)
  assert.ok(hub.includes("data.type === 'omm:live-data-request'"))
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
