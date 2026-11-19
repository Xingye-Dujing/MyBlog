/* zen-canvas-layout.js 通用布局引擎专项测试（node:test）
 * 验证从 Writer 原样抽取的纯函数可独立运行，且 Writer / ZenFlow 双方都调用同一模块。
 * 运行：node tests/test_canvas_layout.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import '../public/zen-canvas-layout.js'
const Layout = globalThis.ZenCanvasLayout

const ROOT = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const writer = read('public/omm-writer.html')
const flow = read('public/omm-zenflow.html')

function chain(n) {
  const nodes = []
  const conns = []
  for (let i = 0; i < n; i++) nodes.push({ id: 'n' + i, w: 180, h: 90 })
  for (let i = 0; i < n - 1; i++) conns.push({ from: 'n' + i, to: 'n' + (i + 1) })
  return { nodes, conns }
}

function assertLayout(res, n) {
  assert.ok(res && Array.isArray(res.items), '应返回 items 数组')
  assert.equal(res.items.length, n)
  const ids = new Set(res.items.map((it) => it.id))
  assert.equal(ids.size, n, '节点 id 不可重复或丢失')
  for (const it of res.items) {
    assert.ok(Number.isFinite(it.x) && Number.isFinite(it.y), '坐标必须是有限数字: ' + it.id)
  }
  // 任意两个节点不得完全重叠。
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = res.items[i], b = res.items[j]
      assert.ok(a.x !== b.x || a.y !== b.y, '节点不得重叠: ' + a.id + '/' + b.id)
    }
  }
}

test('通用模块导出两个纯函数', () => {
  assert.equal(typeof Layout.computeCanvasLayout, 'function')
  assert.equal(typeof Layout.computeRadialOrTimeline, 'function')
})

test('computeCanvasLayout 各策略均可产出无重叠布局', () => {
  const { nodes, conns } = chain(6)
  for (const strategy of ['layered', 'force', 'spine', 'radial', 'timeline', 'smart']) {
    const res = Layout.computeCanvasLayout(nodes, conns, { strategy })
    assertLayout(res, 6)
  }
})

test('computeCanvasLayout 处理孤立节点与空连线', () => {
  const nodes = [{ id: 'a', w: 120, h: 60 }, { id: 'b', w: 120, h: 60 }]
  assertLayout(Layout.computeCanvasLayout(nodes, [], { strategy: 'layered' }), 2)
  assertLayout(Layout.computeCanvasLayout([], [], {}), 0)
})

test('computeRadialOrTimeline 直接可用', () => {
  const { nodes, conns } = chain(5)
  assertLayout(Layout.computeRadialOrTimeline(nodes, conns, 'radial', {}), 5)
  assertLayout(Layout.computeRadialOrTimeline(nodes, conns, 'timeline', {}), 5)
})

test('布局是确定性的：相同输入得到相同坐标', () => {
  const { nodes, conns } = chain(4)
  const a = Layout.computeCanvasLayout(nodes, conns, { strategy: 'layered' })
  const b = Layout.computeCanvasLayout(nodes, conns, { strategy: 'layered' })
  assert.deepEqual(a.items, b.items)
})

test('Writer 不再内联布局实现，改为加载通用模块', () => {
  assert.ok(writer.includes('<script src="zen-canvas-layout.js"></script>'))
  assert.ok(writer.includes('const { computeCanvasLayout, computeRadialOrTimeline } = window.ZenCanvasLayout'))
  assert.doesNotMatch(writer, /function computeCanvasLayout\(/)
  assert.doesNotMatch(writer, /function computeRadialOrTimeline\(/)
})

test('ZenFlow 流程编辑器同样直接调用通用模块', () => {
  assert.ok(flow.includes('zen-canvas-layout.js'))
  assert.ok(flow.includes('ZenCanvasLayout.computeCanvasLayout'))
})
