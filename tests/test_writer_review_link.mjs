/* Writer 引用回链复习 + 今日复习画布测试（node:test）。
 * 覆盖：Hub 跳转协议、ZenCard 高亮、Writer 操作按钮、到期筛选纯函数。
 * 运行：node tests/test_writer_review_link.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const hub = read('public/omm-hub.js')
const zencard = read('public/omm-zencard.html')
const writer = read('public/omm-writer.html')

function extractFunction(text, name) {
  let start = text.indexOf('function ' + name + '(')
  if (start === -1) {
    // object method: `name(now) {` -> synthesize a function declaration
    const m = text.indexOf('\n          ' + name + '(')
    assert.notEqual(m, -1, name + ' 未找到')
    const open = text.indexOf('{', m)
    let depth = 0
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) {
        return 'function ' + text.slice(m + 11, i + 1)
      }
    }
    throw new Error('括号不平衡: ' + name)
  }
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error('括号不平衡: ' + name)
}

/* ------------------------------------------- Hub protocol */

test('Hub 收到 review-card 后激活 zencard 并转发 focus-card', () => {
  const seg = hub.slice(hub.indexOf("if (data.type === 'omm:review-card')"), hub.indexOf("if (data.type === 'omm:saved')"))
  assert.ok(seg.includes("activateApp('zencard')"))
  assert.ok(seg.includes("type: 'omm:focus-card'"))
  assert.ok(seg.includes('frameTargetOrigin(frame)'))
  assert.doesNotMatch(seg, /postMessage\([^,]+,\s*'\*'/)
})

/* ------------------------------------------- ZenCard focus */

test('ZenCard 监听 focus-card 且校验父窗口来源', () => {
  assert.ok(zencard.includes("d.type === 'omm:focus-card'"))
  assert.ok(zencard.includes('event.source !== window.parent'))
  assert.ok(zencard.includes('function focusCard(cardId)'))
  const cardCss = read('public/zen-style/products/zencard.css')
  assert.ok(cardCss.includes('.item.focused'))
})

test('focusCard 拒绝不存在的卡片 id', () => {
  const fn = new Function('cards', '$', 'document', 'CSS', 'renderLibrary',
    extractFunction(zencard, 'focusCard') + '\nreturn focusCard;'
  )(
    [{ id: 'a', content: 'A' }],
    () => ({ value: '', querySelectorAll: () => [] }),
    { querySelectorAll: () => [] },
    { escape: (s) => s },
    () => {}
  )
  assert.equal(fn('missing'), false)
})

/* ------------------------------------------- Writer review action */

test('Writer 引用节点有 reviewCard 按钮与分发分支', () => {
  assert.ok(writer.includes('data-action="reviewCard"'))
  assert.ok(writer.includes("case 'reviewCard':"))
  assert.ok(writer.includes("type: 'omm:review-card', cardId: rcId"))
  assert.ok(writer.includes('window.parent.postMessage('))
  assert.doesNotMatch(writer, /omm:review-card[\s\S]{0,200}postMessage\([^,]+,\s*'\*'/)
})

test('只有带 zenCardId 的引用节点才渲染复习按钮', () => {
  assert.ok(writer.includes('if (data && data.zenCardId)'))
  assert.ok(writer.includes('zenCardId: c.id ? String(c.id) :'))
})

/* ------------------------------------------- Today review canvas */

test('Writer card picker 提供今日到期筛选', () => {
  assert.ok(writer.includes('id="zw-zen-due"'))
  assert.ok(writer.includes('只看今日到期'))
  assert.ok(writer.includes('dueCardIds(now)'))
  assert.ok(writer.includes('zen.srs.v1'))
})

test('dueCardIds 只选出期到期的卡片', () => {
  const store = { 'zen.srs.v1': JSON.stringify([
    { id: 'due1', due: 100 }, { id: 'due2', due: 200 }, { id: 'future', due: 9999 },
  ]) }
  const localStorage = { getItem: (k) => (k in store ? store[k] : null) }
  const fn = new Function('localStorage', 'Number', 'Object', 'Date',
    extractFunction(writer, 'dueCardIds') + '\nreturn dueCardIds;'
  )(localStorage, Number, Object, { now: () => 500 })
  const due = fn(500)
  assert.ok(due.due1 && due.due2)
  assert.ok(!due.future)
})

test('dueCardIds 对损坏的 SRS 数据容错', () => {
  const localStorage = { getItem: () => '{not-json' }
  const fn = new Function('localStorage', 'Number', 'Object', 'Date',
    extractFunction(writer, 'dueCardIds') + '\nreturn dueCardIds;'
  )(localStorage, Number, Object, Date)
  assert.deepEqual(Object.keys(fn(Date.now())), [])
})
