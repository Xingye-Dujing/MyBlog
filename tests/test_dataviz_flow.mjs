/* Data → Viz 一键出图集成测试（node:test） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const data = readFileSync(new URL('../public/omm-data.html', import.meta.url), 'utf8')
const viz = readFileSync(new URL('../public/omm-visualization.html', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../public/viz-bridge.js', import.meta.url), 'utf8')

function biggestScript(text) {
  const re = /<script>([\s\S]*?)<\/script>/g
  let m
  let out = ''
  while ((m = re.exec(text))) if (m[1].length > out.length) out = m[1]
  return out
}

test('Data 引入出图模块与桥接', () => {
  assert.ok(data.includes('src="data-viz.js"'))
  assert.ok(data.includes('src="viz-bridge.js"'))
})

test('Data 有“一键出图”菜单与动作', () => {
  assert.ok(data.includes('data-action="sendToViz"'))
  assert.ok(data.includes('sendToViz: function ()'))
  assert.ok(data.includes('window.DataViz.toPayload(t, { name: t.name })'))
  assert.ok(data.includes('window.VizBridge.send(payload)'))
})

test('Data 在嵌入模式下用明确 origin 请求打开可视化', () => {
  const seg = data.slice(data.indexOf('sendToViz: function ()'), data.indexOf('showTextOut: function ()'))
  assert.ok(seg.includes("omm_hub_origin"))
  assert.doesNotMatch(seg, /postMessage\([^,]+,\s*'\*'/)
})

test('Viz 引入桥接并注册接收处理', () => {
  assert.ok(viz.includes('src="viz-bridge.js"'))
  assert.ok(viz.includes('window.VizBridge.onData(function (payload)'))
  assert.ok(viz.includes('state.data = parseTextData(String(csv || \'\'))'))
  assert.ok(viz.includes("setStatus('已接收 · '"))
})

test('VizBridge 三种投递路径与 origin 校验', () => {
  assert.ok(bridge.includes("localStorage.setItem(KEY, JSON.stringify(payload))"))
  assert.ok(bridge.includes("to: 'visualization'"))
  assert.ok(bridge.includes("type: 'omm:zenviz-data'"))
  assert.ok(bridge.includes('isTrusted(e.origin)'))
  assert.doesNotMatch(bridge, /postMessage\([^,]+,\s*'\*'/)
})

test('Data / Viz 主脚本语法可解析', () => {
  assert.doesNotThrow(() => new Function(biggestScript(data)))
  assert.doesNotThrow(() => new Function(biggestScript(viz)))
})

/* ------------------------------------------- Viz -> Report */

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

test('Viz 有送复盘按钮与 exportReview 入口', () => {
  assert.ok(viz.includes('id="save-review-btn"'))
  assert.ok(viz.includes("$('#save-review-btn').onclick = exportReview"))
  assert.ok(viz.includes('function exportReview()'))
  assert.ok(viz.includes("'zen.viz.review.v1'"))
})

test('exportReview 把图表摘要追加到复盘键并限量 50 条', () => {
  const store = { 'zen.viz.review.v1': JSON.stringify([{ title: '旧图' }]) }
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v },
  }
  const status = []
  const fn = new Function('localStorage', 'state', 'setStatus', 'Date', 'String',
    extractFunction(viz, 'exportReview') + '\nreturn exportReview;'
  )(localStorage, { title: '新趋势', type: 'bar', data: { headers: ['a', 'b'], rows: [{ a: 1, b: 2 }] } },
    (m) => status.push(m), Date, String)
  fn()
  const list = JSON.parse(store['zen.viz.review.v1'])
  assert.equal(list.length, 2)
  assert.equal(list[0].title, '旧图')
  assert.equal(list[1].title, '新趋势')
  assert.equal(list[1].app, 'visualization')
  assert.equal(list[1].rows, 1)
  assert.equal(list[1].cols, 2)
  assert.ok(status[0].includes('新趋势'))
})
