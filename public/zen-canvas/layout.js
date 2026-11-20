/* zen-canvas/layout.js — 布局引擎桥接层
 *
 * 布局算法是纯函数、零 DOM 依赖，单文件保存在 public/zen-canvas-layout.js
 * （由 writer 与 zenflow 验证过）。这里只做统一接入与降级，不复制算法：
 *   - 页面引入 <script src="../zen-canvas-layout.js"></script> 后自动生效；
 *   - Node 环境可 require 该文件后调用 bind(engine)；
 *   - 没有引擎时用稳定的网格布局兜底，画布依然可用。
 */
(function (global, factory) {
  'use strict'
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  global.ZenCanvasLayoutBridge = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  var STRATEGIES = ['smart', 'layered', 'force', 'spine', 'radial', 'timeline']

  function bind(engine) {
    if (!engine || typeof engine.computeCanvasLayout !== 'function') return false
    globalThis.ZenCanvasLayout = engine
    return true
  }

  function pick(engine) {
    return engine || globalThis.ZenCanvasLayout || null
  }

  // 兜底：按连线做最长路径分层，同层横排。只保证“能用且可预测”。
  function gridFallback(nodes, conns, opts) {
    opts = opts || {}
    var gapX = opts.colGap || 80
    var gapY = opts.rowGap || 60
    var indeg = {}
    var next = {}
    nodes.forEach(function (n) {
      indeg[n.id] = 0
      next[n.id] = []
    })
    ;(conns || []).forEach(function (c) {
      if (!(c.from in indeg) || !(c.to in indeg)) return
      indeg[c.to]++
      next[c.from].push(c.to)
    })
    var queue = Object.keys(indeg).filter(function (id) { return indeg[id] === 0 })
    var depth = {}
    queue.forEach(function (id) { depth[id] = 0 })
    while (queue.length) {
      var id = queue.shift()
      next[id].forEach(function (n) {
        depth[n] = Math.max(depth[n] || 0, (depth[id] || 0) + 1)
        if (--indeg[n] === 0) queue.push(n)
      })
    }
    var byDepth = {}
    nodes.forEach(function (n) {
      var d = depth[n.id] || 0
      ;(byDepth[d] || (byDepth[d] = [])).push(n)
    })
    var items = []
    var y = 0
    var maxW = 0
    Object.keys(byDepth).sort(function (a, b) { return a - b }).forEach(function (d) {
      var row = byDepth[d]
      var x = 0
      var rowH = 0
      row.forEach(function (n) {
        items.push({ id: n.id, x: x, y: y })
        x += (n.w || 240) + gapX
        rowH = Math.max(rowH, n.h || 110)
      })
      maxW = Math.max(maxW, x)
      y += rowH + gapY
    })
    return { items: items, w: maxW, h: y, ports: {} }
  }

  function compute(nodes, conns, opts) {
    var engine = pick((opts && opts.engine) || null)
    if (engine) return engine.computeCanvasLayout(nodes, conns, opts || {})
    return gridFallback(nodes, conns, opts)
  }

  return {
    STRATEGIES: STRATEGIES,
    bind: bind,
    compute: compute,
    fallback: gridFallback,
  }
})
