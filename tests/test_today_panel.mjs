/* Hub“今日”聚合面板专项测试（node:test）
 * 聚合逻辑抽成纯函数执行；面板复用现有 localStorage 与 activateApp。
 * 运行：node tests/test_today_panel.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const js = readFileSync(new URL('public/omm-hub.js', ROOT), 'utf8')
const html = readFileSync(new URL('public/omm-hub.html', ROOT), 'utf8')

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

const buildTodaySummary = vm.runInNewContext(
  `(function(){ ${extractFunction(js, 'buildTodaySummary')}; return buildTodaySummary })()`,
  { Number, Date, Array, Object, String }
)

test('空输入返回全零且不抛错', () => {
  const s = buildTodaySummary({})
  assert.equal(s.cards, 0)
  assert.equal(s.due, 0)
  assert.equal(s.notes, 0)
  assert.equal(s.rules, 0)
  assert.deepEqual(Array.from(s.recentNotes), [])
  assert.deepEqual(Array.from(s.recentSearches), [])
})

test('待复习只统计到期的 SM-2 状态', () => {
  const now = 1_000_000
  const s = buildTodaySummary({
    now,
    srs: [
      { id: 'a', due: now - 1 },
      { id: 'b', due: now },
      { id: 'c', due: now + 100 },
      null,
    ],
  })
  assert.equal(s.due, 2)
})

test('聚合卡片 / 笔记 / 规则 / 搜索并取最近三条', () => {
  const s = buildTodaySummary({
    now: 100,
    cards: [{ id: '1' }, { id: '2' }],
    docs: { meta: { a: { name: '甲' }, b: { name: '乙' }, c: { name: '丙' }, d: { name: '丁' } } },
    rules: [{ enabled: true }, { enabled: false }],
    search: { history: [{ query: '一' }, { query: '二' }, { query: '三' }, { query: '四' }] },
  })
  assert.equal(s.cards, 2)
  assert.equal(s.notes, 4)
  assert.equal(s.rules, 2)
  assert.equal(s.activeRules, 1)
  assert.deepEqual(Array.from(s.recentNotes, (n) => n.name), ['丁', '丙', '乙'])
  assert.deepEqual(Array.from(s.recentSearches), ['四', '三', '二'])
})

test('坏数据不污染结果', () => {
  const s = buildTodaySummary({ cards: 'bad', srs: null, docs: 42, search: {}, rules: 'x' })
  assert.equal(s.cards, 0)
  assert.equal(s.due, 0)
  assert.equal(s.notes, 0)
})

test('面板按钮与容器存在，入口复用现有动作', () => {
  assert.ok(html.includes('id="today-btn"') && html.includes('data-act="today"'))
  assert.ok(html.includes('id="today-panel"') && html.includes('id="today-body"'))
  assert.ok(js.includes('function openToday()') && js.includes('function closeToday()'))
  assert.ok(js.includes("else if (act === 'today')"))
  assert.ok(js.includes("else if (action === 'today') openToday()"))
  assert.ok(js.includes('data-today-app='))
})

test('今日面板只读各产品既有 localStorage，不新增存储', () => {
  const open = js.slice(js.indexOf('function openToday()'), js.indexOf('function closeToday()'))
  for (const key of ['zen.cards.v1', 'zen.srs.v1', 'zc-docs', 'omm-search-v1', 'zen.flow.rules.v1']) {
    assert.ok(open.includes("'" + key + "'"), key)
  }
  assert.ok(open.includes('todayRead('), '应通过只读封装读取')
  assert.ok(!open.includes('setItem'), '不应写入任何存储')
  const read = js.slice(js.indexOf('function todayRead('), js.indexOf('function renderToday('))
  assert.ok(read.includes('localStorage.getItem('))
})
