/* zen/canvas.js — OMM-ZEN 通用画布框架
 *
 * 设计母本：omm-writer.html 的画布系统（是全项目最完善的画布实现）。
 * 抽取原则：
 *   1. 保留 writer 的 DOM 结构、类名、端口语义、贝塞尔/折线路径算法、
 *      世界坐标约定、pan/zoom 数学、连线的 rAF 渲染与逐条隔离策略；
 *   2. 去掉 writer 私有业务（文档 / 图片 / MathJax / 涂鸦 / 云同步），
 *      改为依赖注入：nodeTypes / render / serialize / events / storage；
 *   3. 实例级状态，同一页面可挂多张画布，互不污染。
 *
 * 对外只暴露 ZenCanvas.create(options) -> instance；详见 zen/canvas/README.md。
 */
(function (global, factory) {
  'use strict'
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  global.ZenCanvas = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  var VERSION = '1.0.0'
  var SVG_NS = 'http://www.w3.org/2000/svg'
  var PORT_DIR = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }
  var OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
  var DEFAULT_PORTS = ['top', 'bottom', 'left', 'right']

  var DEFAULTS = {
    scope: 'zc',
    minScale: 0.1,
    maxScale: 4,
    panThreshold: 3,
    portHitRadius: 16,
    historyLimit: 60,
    nodeCounterStart: 0,
    editable: true,
    contextMenu: true,
    notify: function () {},
    onChange: function () {},
    onSelectionChange: function () {},
    onNodeCommand: function () {},
    onConnect: function () {},
    onDisconnect: function () {},
    storage: null,
  }

  // ------------------------------------------------------------------
  // 基础工具
  // ------------------------------------------------------------------
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i] || {}
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k]
    }
    return target
  }
  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v))
  }
  function num(v, fallback) {
    var n = parseFloat(v)
    return isNaN(n) ? fallback : n
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function el(tag, cls, html) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (html != null) n.innerHTML = html
    return n
  }
  function svgEl(tag, cls) {
    var n = document.createElementNS(SVG_NS, tag)
    if (cls) n.setAttribute('class', cls)
    return n
  }

  // 事件总线：产品侧只订阅，不需要碰框架内部对象
  function createBus() {
    var map = {}
    return {
      on: function (name, fn) {
        ;(map[name] || (map[name] = [])).push(fn)
        return function () {
          map[name] = (map[name] || []).filter(function (f) {
            return f !== fn
          })
        }
      },
      off: function (name, fn) {
        map[name] = (map[name] || []).filter(function (f) {
          return f !== fn
        })
      },
      emit: function (name, payload) {
        ;(map[name] || []).slice().forEach(function (fn) {
          try {
            fn(payload)
          } catch (e) {
            console.warn('[ZenCanvas] listener failed: ' + name, e)
          }
        })
      },
    }
  }

  // ------------------------------------------------------------------
  // 纯几何函数（从 writer 的 ConnectionManager 原样抽取）
  // ------------------------------------------------------------------
  function getItemPort(item, portType) {
    var l = item.x, t = item.y, w = item.w, h = item.h
    switch (portType) {
      case 'top':
        return { x: l + w / 2, y: t }
      case 'bottom':
        return { x: l + w / 2, y: t + h }
      case 'left':
        return { x: l, y: t + h / 2 }
      case 'right':
        return { x: l + w, y: t + h / 2 }
      default:
        return { x: l + w / 2, y: t + h / 2 }
    }
  }

  function getPortPosition(node, portType) {
    return getItemPort({
      x: node.offsetLeft,
      y: node.offsetTop,
      w: node.offsetWidth,
      h: node.offsetHeight,
    }, portType)
  }

  function getCurvePath(x1, y1, x2, y2, port1, port2) {
    var dx = x2 - x1,
      dy = y2 - y1
    var h1 = port1 === 'left' || port1 === 'right'
    var h2 = port2 === 'left' || port2 === 'right'
    var v1 = port1 === 'top' || port1 === 'bottom'
    var v2 = port2 === 'top' || port2 === 'bottom'
    var cp1x, cp1y, cp2x, cp2y
    if (h1 && h2) {
      var mx = (x1 + x2) / 2
      cp1x = mx
      cp1y = y1
      cp2x = mx
      cp2y = y2
    } else if (v1 && v2) {
      var my = (y1 + y2) / 2
      cp1x = x1
      cp1y = my
      cp2x = x2
      cp2y = my
    } else if (h1 && v2) {
      cp1x = x1
      cp1y = y1 + dy * 0.5
      cp2x = x1 + dx * 0.5
      cp2y = y2
    } else {
      cp1x = x1 + dx * 0.5
      cp1y = y1
      cp2x = x2
      cp2y = y1 + dy * 0.5
    }
    return 'M ' + x1 + ' ' + y1 + ' C ' + cp1x + ' ' + cp1y + ', ' + cp2x + ' ' + cp2y + ', ' + x2 + ' ' + y2
  }

  // writer 的折线兜底算法：正交折线 + 二次贝塞尔圆角
  function getElbowPath(x1, y1, x2, y2, port1, port2, hint, box) {
    var h = hint || {}
    var d1 = PORT_DIR[port1] || [0, 1]
    var d2 = PORT_DIR[port2] || [0, -1]
    var k = h.k || 0
    var stub = 26 * (1 + k * 0.6)
    var p1 = { x: x1, y: y1 },
      p2 = { x: x2, y: y2 }
    var s1 = { x: p1.x + d1[0] * stub, y: p1.y + d1[1] * stub }
    var s2 = { x: p2.x + d2[0] * stub, y: p2.y + d2[1] * stub }
    var v1 = d1[1] !== 0
    var v2 = d2[1] !== 0
    var laneT =
      k === 1 ? 0.25 : k === 2 ? 0.75 : k === 3 ? 1.3 : k === 4 ? -0.3 : k === 5 ? 1.6 : k === 6 ? -0.6 : 0.5
    var b = box || {
      x0: Math.min(p1.x, p2.x),
      y0: Math.min(p1.y, p2.y),
      x1: Math.max(p1.x, p2.x),
      y1: Math.max(p1.y, p2.y),
    }
    var v = h.v || 'lane'
    var wps
    if (v === 'path' && Array.isArray(h.pts)) {
      var dx = x1 - (h.ax != null ? h.ax : x1)
      var dy = y1 - (h.ay != null ? h.ay : y1)
      wps = [p1]
        .concat(
          h.pts.map(function (pt) {
            return { x: pt[0] + dx, y: pt[1] + dy }
          })
        )
        .concat([p2])
    } else if (v === 'lane' && v1 && v2) {
      var laneY = s1.y + (s2.y - s1.y) * laneT
      wps = [p1, s1, { x: s1.x, y: laneY }, { x: s2.x, y: laneY }, s2, p2]
    } else if (v === 'lane' && !v1 && !v2) {
      var laneX = s1.x + (s2.x - s1.x) * laneT
      wps = [p1, s1, { x: laneX, y: s1.y }, { x: laneX, y: s2.y }, s2, p2]
    } else if (v === 'aroundL' || v === 'aroundR') {
      var m = stub + 30 + k * 70
      if (v1 && v2) {
        var lx = v === 'aroundL' ? b.x0 - m : b.x1 + m
        wps = [p1, s1, { x: lx, y: s1.y }, { x: lx, y: s2.y }, s2, p2]
      } else if (!v1 && !v2) {
        var ly = v === 'aroundL' ? b.y0 - m : b.y1 + m
        wps = [p1, s1, { x: s1.x, y: ly }, { x: s2.x, y: ly }, s2, p2]
      } else {
        var cx = v === 'aroundL' ? b.x0 - m : b.x1 + m
        var cy = v === 'aroundL' ? b.y0 - m : b.y1 + m
        wps = v1
          ? [p1, s1, { x: s1.x, y: cy }, { x: cx, y: cy }, { x: cx, y: s2.y }, s2, p2]
          : [p1, s1, { x: cx, y: s1.y }, { x: cx, y: cy }, { x: s2.x, y: cy }, s2, p2]
      }
    } else if (v === 'L') {
      if (v1 && !v2) wps = [p1, s1, { x: s2.x, y: s1.y }, s2, p2]
      else if (!v1 && v2) wps = [p1, s1, { x: s1.x, y: s2.y }, s2, p2]
      else if (v1 && v2) {
        var vmid = (s1.y + s2.y) / 2
        wps = [p1, s1, { x: s1.x, y: vmid }, { x: s2.x, y: vmid }, s2, p2]
      } else {
        var hmid = (s1.x + s2.x) / 2
        wps = [p1, s1, { x: hmid, y: s1.y }, { x: hmid, y: s2.y }, s2, p2]
      }
    } else {
      wps = [p1, p2]
    }
    var P = []
    wps.forEach(function (p) {
      var q = P[P.length - 1]
      if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 0.5) P.push({ x: p.x, y: p.y })
    })
    if (P.length < 2) return getCurvePath(x1, y1, x2, y2, port1, port2)
    var r = 14
    var d = 'M ' + P[0].x + ' ' + P[0].y
    for (var i = 1; i < P.length - 1; i++) {
      var p = P[i],
        prev = P[i - 1],
        next = P[i + 1]
      var l1 = Math.hypot(p.x - prev.x, p.y - prev.y) || 1
      var l2 = Math.hypot(next.x - p.x, next.y - p.y) || 1
      var rr = Math.min(r, l1 / 2, l2 / 2)
      d +=
        ' L ' + (p.x + ((prev.x - p.x) / l1) * rr) + ' ' + (p.y + ((prev.y - p.y) / l1) * rr) +
        ' Q ' + p.x + ' ' + p.y + ' ' +
        (p.x + ((next.x - p.x) / l2) * rr) + ' ' + (p.y + ((next.y - p.y) / l2) * rr)
    }
    var last = P[P.length - 1]
    d += ' L ' + last.x + ' ' + last.y
    return d
  }

  // ------------------------------------------------------------------
  // 实例
  // ------------------------------------------------------------------
  function ZenCanvasInstance(options) {
    var self = this
    this.opts = assign({}, DEFAULTS, options || {})
    this.scope = String(this.opts.scope || 'zc').replace(/[^a-zA-Z0-9_-]/g, '')
    this.bus = createBus()
    this.types = {}
    this.plugins = []
    this.nodeSeq = this.opts.nodeCounterStart || 0
    this.connSeq = 0
    this.zCounter = 10
    this.state = {
      nodes: [], // { id, type, el, data, locked, minimized }
      connections: [], // { id, from, to, fromPort, toPort, route, routeHint }
      selectedNodeIds: new Set(),
      selectedConnId: null,
      alignBaseId: null,
      scale: 1,
      panX: 0,
      panY: 0,
      portDrag: null,
      tempLine: null,
      renderPending: false,
      portDragPending: false,
      isPanning: false,
      clipboard: null,
    }
    this._history = []
    this._future = []
    this._snapshot = null
    this._muted = false

    // ---- DOM（writer 同构：workspace > canvas-inner > svg-layer + nodes）----
    var mount = this.opts.mount || document.body
    this.workspace = el('div', 'zc-workspace')
    this.workspace.dataset.zenCanvas = this.scope
    this.inner = el('div', 'zc-canvas-inner')
    this.svg = svgEl('svg', 'zc-svg-layer')
    this.svg.setAttribute('width', '10000')
    this.svg.setAttribute('height', '10000')
    this.inner.appendChild(this.svg)
    this.workspace.appendChild(this.inner)
    this.marquee = el('div', 'zc-marquee')
    this.workspace.appendChild(this.marquee)
    mount.appendChild(this.workspace)

    if (this.opts.nodeTypes) {
      Object.keys(this.opts.nodeTypes).forEach(function (key) {
        self.registerNodeType(key, self.opts.nodeTypes[key])
      })
    }

    this._bindCanvasEvents()
    this._bindSelectionEvents()
    this._bindGlobalEvents()
    this._bindResizeObserver()

    // 插件（对齐 / 小地图 / 自定义交互都从这里挂）
    ;(this.opts.plugins || []).forEach(function (p) {
      self.use(p)
    })
  }

  ZenCanvasInstance.prototype._id = function (id) {
    return this.scope + '-' + id
  }

  ZenCanvasInstance.prototype._nodeById = function (id) {
    return this.state.nodes.find(function (n) {
      return n.id === id
    }) || null
  }

  ZenCanvasInstance.prototype._nodeEl = function (id) {
    var n = this._nodeById(id)
    return n ? n.el : null
  }

  ZenCanvasInstance.prototype._getNodes = function () {
    return this.state.nodes.map(function (n) {
      return n.el
    })
  }

  // ---- 变更通知 -------------------------------------------------------
  ZenCanvasInstance.prototype._changed = function (history) {
    if (this._muted) return
    if (history !== false) this._pushHistory()
    this.opts.onChange(this.toJSON())
    this.bus.emit('change', this.toJSON())
    if (this.opts.storage && this.opts.storage.save) {
      try {
        this.opts.storage.save(this.toJSON())
      } catch (e) {
        console.warn('[ZenCanvas] storage.save failed', e)
      }
    }
  }

  ZenCanvasInstance.prototype._silent = function (fn) {
    var prev = this._muted
    this._muted = true
    try {
      return fn()
    } finally {
      this._muted = prev
    }
  }

  // ---- 节点类型注册 ---------------------------------------------------
  ZenCanvasInstance.prototype.registerNodeType = function (key, def) {
    if (!def) throw new Error('node type definition required: ' + key)
    this.types[key] = assign(
      {
        label: key,
        category: '其它',
        glyph: '·',
        ports: DEFAULT_PORTS,
        w: 240,
        h: 110,
        defaults: {},
        render: function (data, host) {
          host.textContent = JSON.stringify(data)
        },
        summary: function () {
          return ''
        },
      },
      def
    )
    this.bus.emit('typeRegistered', { type: key, def: this.types[key] })
    return this
  }

  ZenCanvasInstance.prototype.typesByCategory = function () {
    var out = {}
    var self = this
    Object.keys(this.types).forEach(function (key) {
      var def = self.types[key]
      var cat = def.category || '其它'
      ;(out[cat] || (out[cat] = [])).push(
        assign({ key: key }, def)
      )
    })
    return out
  }

  // ---- 插件 -----------------------------------------------------------
  ZenCanvasInstance.prototype.use = function (plugin) {
    if (!plugin || typeof plugin.install !== 'function') return this
    plugin.install(this)
    this.plugins.push(plugin)
    return this
  }

  // ---- 节点 CRUDL -----------------------------------------------------
  ZenCanvasInstance.prototype.addNode = function (type, data, pos, opts) {
    var def = this.types[type] || this.types._fallback
    if (!def) throw new Error('unknown node type: ' + type)
    data = assign({}, def.defaults || {}, data || {})
    var id = data.id || type + '-' + ++this.nodeSeq
    var num = parseInt(String(id).split('-').pop(), 10)
    if (!isNaN(num) && num > this.nodeSeq) this.nodeSeq = num
    if (this._nodeById(id)) return this._nodeById(id)

    var self = this
    var nodeRec = { id: id, type: type, data: data, locked: !!data.locked, minimized: !!data.minimized }
    var node = el('div', 'node zc-node')
    node.id = this._id(id)
    node.dataset.type = type
    node.dataset.nodeId = id
    node.style.left = (pos && pos.x != null ? pos.x : 120 + this.state.nodes.length * 28) + 'px'
    node.style.top = (pos && pos.y != null ? pos.y : 120 + this.state.nodes.length * 22) + 'px'
    node.style.width = (data.w || def.w) + 'px'
    node.style.height = (data.h || def.h) + 'px'
    node.style.zIndex = ++this.zCounter

    var header = el('div', 'node-header')
    var title = el('span', 'node-title')
    title.innerHTML =
      '<span class="zc-node-glyph">' + escapeHtml(def.glyph || '·') + '</span>' +
      '<span class="title-text">' + escapeHtml(data.title || def.label) + '</span>' +
      '<span class="zc-status" data-role="status"></span>'
    var actions = el('div', 'node-actions')
    if (this.opts.editable) {
      actions.innerHTML =
        '<div class="node-action-btn lock-btn" data-act="lock" title="锁定">○</div>' +
        '<div class="node-action-btn minimize" data-act="minimize" title="折叠">−</div>' +
        '<div class="node-action-btn close" data-act="remove" title="删除">×</div>'
    }
    header.appendChild(title)
    header.appendChild(actions)
    node.appendChild(header)

    ;(def.ports || DEFAULT_PORTS).forEach(function (pt) {
      var port = el('div', 'node-port ' + pt)
      port.dataset.port = pt
      port.dataset.nodeId = id
      port.title = pt === 'left' || pt === 'top' ? '输入端口' : '输出端口'
      node.appendChild(port)
    })

    var content = el('div', 'node-content')
    content.dataset.role = 'content'
    try {
      def.render(data, content, this._nodeApi(nodeRec))
    } catch (e) {
      content.textContent = '节点渲染失败：' + e.message
      console.error('[ZenCanvas] node render failed', type, e)
    }
    node.appendChild(content)

    if (this.opts.editable) node.appendChild(el('div', 'node-resize'))
    this.inner.appendChild(node)
    nodeRec.el = node
    this.state.nodes.push(nodeRec)
    if (nodeRec.locked) node.classList.add('locked')
    if (nodeRec.minimized) this._applyMinimize(nodeRec, true)

    this._initNodeDrag(nodeRec)
    if (this.opts.editable) this._initNodeResize(nodeRec)
    this._initPortEvents(nodeRec)
    this._initNodeActions(nodeRec)
    this.refreshNode(id)
    this.emitNodeCommand(nodeRec, 'created')
    if (!opts || opts.change !== false) this._changed()
    return nodeRec
  }

  ZenCanvasInstance.prototype._nodeApi = function (rec) {
    var self = this
    return {
      id: rec.id,
      type: rec.type,
      data: rec.data,
      setStatus: function (text, state) {
        self.setNodeStatus(rec.id, text, state)
      },
      update: function (patch) {
        self.updateNode(rec.id, patch)
      },
      canvas: self,
    }
  }

  /* Collapse a node down to its header. Generic behaviour: the node box must
     shrink with the content, otherwise hiding .node-content leaves an empty
     body. The original height is kept so expanding restores exact geometry. */
  ZenCanvasInstance.prototype._applyMinimize = function (rec, minimized) {
    minimized = !!minimized
    if (minimized === !!rec.minimized) return this
    var node = rec.el
    if (minimized) {
      rec._restore = {
        h: node.style.height,
        minH: node.style.minHeight,
      }
      node.classList.add('minimized')
      node.style.minHeight = '32px'
      node.style.height = '32px'
      var content = node.querySelector('.node-content')
      var resize = node.querySelector('.node-resize')
      if (content) content.style.display = 'none'
      if (resize) resize.style.display = 'none'
    } else {
      var restore = rec._restore || {}
      node.classList.remove('minimized')
      node.style.height = restore.h || ''
      node.style.minHeight = restore.minH || ''
      var body = node.querySelector('.node-content')
      var grip = node.querySelector('.node-resize')
      if (body) body.style.display = ''
      if (grip) grip.style.display = ''
      rec._restore = null
    }
    rec.minimized = minimized
    this.renderConnections()
    if (typeof this.opts.onMinimize === 'function') this.opts.onMinimize(rec.id, minimized)
    return this
  }

  ZenCanvasInstance.prototype.removeNode = function (id) {
    var self = this
    var rec = this._nodeById(id)
    if (!rec) return this
    if (this.state.alignBaseId === id) this.setAlignBase(null)
    rec.el.remove()
    this.state.nodes = this.state.nodes.filter(function (n) {
      return n.id !== id
    })
    var removed = this.state.connections.filter(function (c) {
      return c.from === id || c.to === id
    })
    this.state.connections = this.state.connections.filter(function (c) {
      return c.from !== id && c.to !== id
    })
    this.state.selectedNodeIds.delete(id)
    if (removed.some(function (c) { return c.id === self.state.selectedConnId })) {
      this.state.selectedConnId = null
    }
    this.renderConnections()
    this.emitNodeCommand(rec, 'removed')
    removed.forEach(function (c) {
      self.bus.emit('disconnect', c)
    })
    this._selectionChanged()
    this._changed()
    return this
  }

  ZenCanvasInstance.prototype.updateNode = function (id, patch) {
    var rec = this._nodeById(id)
    if (!rec) return this
    patch = patch || {}
    if (patch.title != null) {
      rec.data.title = patch.title
      var t = rec.el.querySelector('.title-text')
      if (t) t.textContent = patch.title
    }
    if (patch.data) {
      rec.data = assign({}, rec.data, patch.data)
      var def = this.types[rec.type]
      var host = rec.el.querySelector('.node-content')
      if (def && host) {
        try {
          host.innerHTML = ''
          def.render(rec.data, host, this._nodeApi(rec))
        } catch (e) {
          host.textContent = '节点渲染失败：' + e.message
        }
      }
    }
    if (patch.w != null) rec.el.style.width = patch.w + 'px'
    if (patch.h != null) rec.el.style.height = patch.h + 'px'
    if (patch.locked != null) {
      rec.locked = !!patch.locked
      rec.el.classList.toggle('locked', rec.locked)
    }
    if (patch.minimized != null) this._applyMinimize(rec, !!patch.minimized)
    this.refreshNode(id)
    this.emitNodeCommand(rec, 'updated')
    this._changed()
    return this
  }

  ZenCanvasInstance.prototype.setNodeStatus = function (id, text, state) {
    var node = this._nodeEl(id)
    if (!node) return this
    var badge = node.querySelector('[data-role="status"]')
    if (!badge) return this
    badge.textContent = text || ''
    badge.dataset.state = state || 'idle'
    badge.className = 'zc-status' + (state ? ' is-' + state : '')
    return this
  }

  ZenCanvasInstance.prototype.refreshNode = function (id) {
    var rec = this._nodeById(id)
    if (!rec) return this
    var def = this.types[rec.type] || {}
    var summary = rec.el.querySelector('[data-role="summary"]')
    if (summary) summary.textContent = def.summary ? def.summary(rec.data) : ''
    this.renderConnections()
    return this
  }

  ZenCanvasInstance.prototype.emitNodeCommand = function (rec, action, payload) {
    this.bus.emit('nodeCommand', { node: rec, action: action, payload: payload })
    this.opts.onNodeCommand(rec.id, action, payload || {})
  }

  ZenCanvasInstance.prototype.getNodes = function () {
    return this.state.nodes.map(function (n) {
      return { id: n.id, type: n.type, data: n.data }
    })
  }

  ZenCanvasInstance.prototype.getNode = function (id) {
    var n = this._nodeById(id)
    return n ? { id: n.id, type: n.type, data: n.data } : null
  }

  ZenCanvasInstance.prototype.getNodeElement = function (id) {
    return this._nodeEl(id)
  }

  ZenCanvasInstance.prototype.clear = function () {
    this.state.nodes.slice().forEach(function (n) {
      n.el.remove()
    })
    this.state.nodes = []
    this.state.connections = []
    this.state.selectedNodeIds.clear()
    this.state.selectedConnId = null
    this.state.alignBaseId = null
    this.state.portDrag = null
    this.state.tempLine = null
    this.svg.innerHTML = ''
    this._selectionChanged()
    this._changed()
    return this
  }

  // ---- 节点交互 -------------------------------------------------------
  ZenCanvasInstance.prototype._initNodeDrag = function (rec) {
    var self = this
    var node = rec.el
    var header = node.querySelector('.node-header')
    var sx, sy, ox, oy, dragging, list
    header.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      if (e.target.closest('.node-action-btn') || e.target.closest('.node-port')) return
      if (rec.locked) return
      if (e.altKey) {
        self.setAlignBase(rec.id)
        e.preventDefault()
        return
      }
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        self.toggleSelect(rec.id)
        e.preventDefault()
        return
      }
      if (!self.state.selectedNodeIds.has(rec.id)) {
        self.clearSelection()
        self.select(rec.id)
      }
      list = self._collectMoveNodes(rec.id)
      dragging = true
      sx = e.clientX
      sy = e.clientY
      ox = num(node.style.left, 0)
      oy = num(node.style.top, 0)
      node.style.zIndex = ++self.zCounter
      e.preventDefault()
    })
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return
      var nl = ox + (e.clientX - sx) / self.state.scale
      var nt = oy + (e.clientY - sy) / self.state.scale
      var dx = nl - num(node.style.left, 0)
      var dy = nt - num(node.style.top, 0)
      list.forEach(function (n) {
        if (!n) return
        if (n === node) {
          n.style.left = nl + 'px'
          n.style.top = nt + 'px'
        } else if (!n.classList.contains('locked')) {
          n.style.left = num(n.style.left, 0) + dx + 'px'
          n.style.top = num(n.style.top, 0) + dy + 'px'
        }
      })
      self.renderConnections()
    })
    document.addEventListener('mouseup', function () {
      if (!dragging) return
      dragging = false
      self.renderConnections()
      self._changed()
    })
  }

  ZenCanvasInstance.prototype._initNodeResize = function (rec) {
    var self = this
    var node = rec.el
    var handle = node.querySelector('.node-resize')
    if (!handle) return
    var sx, sy, ow, oh, resizing
    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || rec.locked) return
      resizing = true
      sx = e.clientX
      sy = e.clientY
      ow = node.offsetWidth
      oh = node.offsetHeight
      e.preventDefault()
      e.stopPropagation()
    })
    document.addEventListener('mousemove', function (e) {
      if (!resizing) return
      node.style.width = Math.max(160, ow + (e.clientX - sx)) + 'px'
      node.style.height = Math.max(64, oh + (e.clientY - sy)) + 'px'
      self.renderConnections()
    })
    document.addEventListener('mouseup', function () {
      if (!resizing) return
      resizing = false
      self.renderConnections()
      self._changed()
    })
  }

  ZenCanvasInstance.prototype._initPortEvents = function (rec) {
    var self = this
    var ports = rec.el.querySelectorAll('.node-port')
    Array.prototype.forEach.call(ports, function (port) {
      port.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return
        e.stopPropagation()
        e.preventDefault()
        var pt = port.dataset.port
        var pos = getPortPosition(rec.el, pt)
        self.state.portDrag = { nodeId: rec.id, portType: pt, startX: pos.x, startY: pos.y, port: port }
        port.classList.add('dragging')
        var line = svgEl('path', 'conn-line temp')
        line.setAttribute('d', 'M ' + pos.x + ' ' + pos.y + ' L ' + pos.x + ' ' + pos.y)
        self.svg.appendChild(line)
        self.state.tempLine = line
        document.body.style.cursor = 'crosshair'
        self.bus.emit('portDragStart', self.state.portDrag)
      })
    })
  }

  ZenCanvasInstance.prototype._initNodeActions = function (rec) {
    var self = this
    var node = rec.el
    var actions = node.querySelector('.node-actions')
    if (!actions) return
    actions.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]')
      if (!btn) return
      e.stopPropagation()
      var act = btn.dataset.act
      if (act === 'remove') self.removeNode(rec.id)
      else if (act === 'minimize') self.updateNode(rec.id, { minimized: !rec.minimized })
      else if (act === 'lock') self.updateNode(rec.id, { locked: !rec.locked })
      self.emitNodeCommand(rec, act)
    })
    node.addEventListener('mousedown', function () {
      node.style.zIndex = ++self.zCounter
    })
    node.addEventListener('dblclick', function (e) {
      if (e.target.closest('.node-header')) return
      self.emitNodeCommand(rec, 'dblclick')
    })
  }

  // ---- 连线 -----------------------------------------------------------
  ZenCanvasInstance.prototype.addConnection = function (from, to, fromPort, toPort, extra) {
    fromPort = fromPort || 'right'
    toPort = toPort || 'left'
    if (from === to) return null
    var exists = this.state.connections.some(function (c) {
      return c.from === from && c.to === to && c.fromPort === fromPort && c.toPort === toPort
    })
    if (exists) return null
    var conn = assign(
      { id: 'conn-' + ++this.connSeq, from: from, to: to, fromPort: fromPort, toPort: toPort },
      extra || {}
    )
    var connNum = parseInt(String(conn.id).split('-').pop(), 10)
    if (!isNaN(connNum) && connNum > this.connSeq) this.connSeq = connNum
    this.state.connections.push(conn)
    this.renderConnections()
    this.opts.onConnect(conn)
    this.bus.emit('connect', conn)
    this._changed()
    return conn
  }

  ZenCanvasInstance.prototype.selectConnection = function (id) {
    if (!this.state.connections.some(function (c) { return c.id === id })) return this
    this.state.selectedConnId = id
    var self = this
    this.state.selectedNodeIds.forEach(function (nid) {
      var n = self._nodeEl(nid)
      if (n) n.classList.remove('selected')
    })
    this.state.selectedNodeIds.clear()
    this.renderConnections()
    this.opts.onSelectionChange([])
    this.bus.emit('selection', [])
    return this
  }

  ZenCanvasInstance.prototype.removeConnection = function (id) {
    var conn = this.state.connections.find(function (c) {
      return c.id === id
    })
    if (!conn) return this
    this.state.connections = this.state.connections.filter(function (c) {
      return c.id !== id
    })
    if (this.state.selectedConnId === id) this.state.selectedConnId = null
    this.renderConnections()
    this.opts.onDisconnect(conn)
    this.bus.emit('disconnect', conn)
    this._changed()
    return this
  }

  ZenCanvasInstance.prototype.getConnections = function () {
    return this.state.connections.slice()
  }

  ZenCanvasInstance.prototype._portAt = function (cx, cy) {
    var ports = this.workspace.querySelectorAll('.node-port')
    var r2 = this.opts.portHitRadius * this.opts.portHitRadius
    for (var i = 0; i < ports.length; i++) {
      var p = ports[i]
      var rect = p.getBoundingClientRect()
      var dx = cx - (rect.left + rect.width / 2)
      var dy = cy - (rect.top + rect.height / 2)
      if (dx * dx + dy * dy < r2) return p
    }
    return null
  }

  ZenCanvasInstance.prototype.renderConnections = function () {
    var self = this
    if (this.state.renderPending) return
    this.state.renderPending = true
    requestAnimationFrame(function () {
      self.state.renderPending = false
      try {
        self._renderConnectionsNow()
      } catch (e) {
        console.warn('[ZenCanvas] connection render failed', e)
      }
    })
  }

  ZenCanvasInstance.prototype._renderConnectionsNow = function () {
    var self = this
    Array.prototype.forEach.call(this.svg.querySelectorAll('.conn-line:not(.temp)'), function (n) {
      n.remove()
    })
    Array.prototype.forEach.call(this.svg.querySelectorAll('.conn-delete-hit'), function (n) {
      n.remove()
    })
    this.state.nodes.forEach(function (n) {
      n.el.classList.remove('has-conn')
    })
    this.state.connections.forEach(function (conn) {
      if (!conn || typeof conn.from !== 'string' || typeof conn.to !== 'string') return
      var fn = self._nodeEl(conn.from)
      var tn = self._nodeEl(conn.to)
      if (!fn || !tn) return
      fn.classList.add('has-conn')
      tn.classList.add('has-conn')
      var fp = conn.fromPort || 'right'
      var tp = conn.toPort || 'left'
      var a = getPortPosition(fn, fp)
      var b = getPortPosition(tn, tp)
      var d
      if (conn.route === 'elbow') {
        var fr = { x: fn.offsetLeft, y: fn.offsetTop, w: fn.offsetWidth, h: fn.offsetHeight }
        var tr = { x: tn.offsetLeft, y: tn.offsetTop, w: tn.offsetWidth, h: tn.offsetHeight }
        var box = {
          x0: Math.min(fr.x, tr.x),
          y0: Math.min(fr.y, tr.y),
          x1: Math.max(fr.x + fr.w, tr.x + tr.w),
          y1: Math.max(fr.y + fr.h, tr.y + tr.h),
        }
        d = getElbowPath(a.x, a.y, b.x, b.y, fp, tp, conn.routeHint || {}, box)
      }
      if (!d) d = getCurvePath(a.x, a.y, b.x, b.y, fp, tp)

      var path = svgEl('path', 'conn-line' + (self.state.selectedConnId === conn.id ? ' selected' : ''))
      path.dataset.connId = conn.id
      path.setAttribute('d', d)
      /* The visible stroke is selectable; Delete/Backspace then removes it.
         The transparent hit path below still removes on a direct click. */
      path.addEventListener('click', function (e) {
        e.stopPropagation()
        self.selectConnection(conn.id)
      })
      self.svg.appendChild(path)

      var hit = svgEl('path', 'conn-delete-hit')
      hit.dataset.connId = conn.id
      hit.setAttribute('d', d)
      hit.addEventListener('click', function (e) {
        e.stopPropagation()
        self.removeConnection(conn.id)
      })
      hit.addEventListener('mouseenter', function () {
        path.style.stroke = '#c0392b'
        path.style.strokeWidth = '4px'
      })
      hit.addEventListener('mouseleave', function () {
        path.style.stroke = ''
        path.style.strokeWidth = ''
      })
      self.svg.appendChild(hit)
    })
    this.state.nodes.forEach(function (n) {
      var ports = n.el.querySelectorAll('.node-port')
      Array.prototype.forEach.call(ports, function (p) {
        p.classList.remove('connected')
      })
    })
    this.state.connections.forEach(function (c) {
      var f = self._nodeEl(c.from)
      var t = self._nodeEl(c.to)
      if (f) {
        var p = f.querySelector('.node-port.' + (c.fromPort || 'right'))
        if (p) p.classList.add('connected')
      }
      if (t) {
        var q = t.querySelector('.node-port.' + (c.toPort || 'left'))
        if (q) q.classList.add('connected')
      }
    })
  }

  // ---- 画布变换（writer 同款数学）------------------------------------
  ZenCanvasInstance.prototype.screenToWorld = function (clientX, clientY) {
    var rect = this.workspace.getBoundingClientRect()
    return {
      x: (clientX - rect.left - this.state.panX) / this.state.scale,
      y: (clientY - rect.top - this.state.panY) / this.state.scale,
    }
  }

  ZenCanvasInstance.prototype.worldToScreen = function (x, y) {
    var rect = this.workspace.getBoundingClientRect()
    return {
      x: rect.left + this.state.panX + x * this.state.scale,
      y: rect.top + this.state.panY + y * this.state.scale,
    }
  }

  ZenCanvasInstance.prototype.applyTransform = function () {
    this.inner.style.transform =
      'translate3d(' + this.state.panX + 'px, ' + this.state.panY + 'px, 0) scale(' + this.state.scale + ')'
    this.renderConnections()
    this.bus.emit('viewport', this.getView())
  }

  ZenCanvasInstance.prototype.getView = function () {
    return { scale: this.state.scale, panX: this.state.panX, panY: this.state.panY }
  }

  ZenCanvasInstance.prototype.setView = function (view) {
    if (!view) return this
    this.state.scale = clamp(num(view.scale, 1), this.opts.minScale, this.opts.maxScale)
    this.state.panX = num(view.panX, 0)
    this.state.panY = num(view.panY, 0)
    this.applyTransform()
    return this
  }

  ZenCanvasInstance.prototype.fitView = function (opts) {
    opts = opts || {}
    var rect = this.workspace.getBoundingClientRect()
    var MARGIN = 40
    if (!this.state.nodes.length) {
      this.state.scale = 1
      this.state.panX = rect.width / 2 - 300
      this.state.panY = rect.height / 2 - 200
      this.applyTransform()
      return this
    }
    var minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    var self = this
    this.state.nodes.forEach(function (n) {
      var l = num(n.el.style.left, n.el.offsetLeft)
      var t = num(n.el.style.top, n.el.offsetTop)
      var w = n.el.offsetWidth || num(n.el.style.width, 240)
      var h = n.el.offsetHeight || num(n.el.style.height, 110)
      minX = Math.min(minX, l)
      minY = Math.min(minY, t)
      maxX = Math.max(maxX, l + w)
      maxY = Math.max(maxY, t + h)
    })
    var cw = Math.max(1, maxX - minX)
    var ch = Math.max(1, maxY - minY)
    var aw = Math.max(1, rect.width - 2 * MARGIN)
    var ah = Math.max(1, rect.height - 2 * MARGIN)
    var fit = Math.min(aw / cw, ah / ch)
    var minScale = typeof opts.minScale === 'number' ? Math.max(0.005, opts.minScale) : this.opts.minScale
    this.state.scale = Math.min(1, Math.max(minScale, fit))
    this.state.panX = rect.width / 2 - ((minX + maxX) / 2) * this.state.scale
    this.state.panY = rect.height / 2 - ((minY + maxY) / 2) * this.state.scale
    this.applyTransform()
    return this
  }

  ZenCanvasInstance.prototype.focusNode = function (id) {
    var node = this._nodeEl(id)
    if (!node) return this
    var rect = this.workspace.getBoundingClientRect()
    var w = node.offsetWidth,
      h = node.offsetHeight
    var l = num(node.style.left, node.offsetLeft)
    var t = num(node.style.top, node.offsetTop)
    var scale = clamp(Math.min((rect.width * 0.8) / w, (rect.height * 0.7) / h), this.opts.minScale, 1.4)
    this.state.scale = scale
    this.state.panX = rect.width / 2 - (l + w / 2) * scale
    this.state.panY = rect.height / 2 - (t + h / 2) * scale
    this.applyTransform()
    return this
  }

  ZenCanvasInstance.prototype.beginPan = function (x, y) {
    var s = this.state
    s.isPanning = true
    s.panStartX = x
    s.panStartY = y
    s.panStartPX = s.panX
    s.panStartPY = s.panY
    s.panWasDragging = false
    this.workspace.style.cursor = 'grabbing'
  }

  ZenCanvasInstance.prototype.movePan = function (x, y) {
    var s = this.state
    if (!s.isPanning) return
    var dx = x - s.panStartX,
      dy = y - s.panStartY
    if (!s.panWasDragging && Math.hypot(dx, dy) > this.opts.panThreshold) s.panWasDragging = true
    if (!s.panWasDragging) return
    s.panX = s.panStartPX + dx
    s.panY = s.panStartPY + dy
    this.applyTransform()
  }

  ZenCanvasInstance.prototype.endPan = function () {
    var s = this.state
    if (!s.isPanning) return
    s.isPanning = false
    this.workspace.style.cursor = 'default'
    if (s.panWasDragging) this._changed(false)
  }

  ZenCanvasInstance.prototype.rebasePan = function (x, y) {
    var s = this.state
    if (!s.isPanning) return
    s.panStartX = x
    s.panStartY = y
    s.panStartPX = s.panX
    s.panStartPY = s.panY
  }

  ZenCanvasInstance.prototype.panBy = function (dx, dy) {
    this.state.panX += dx
    this.state.panY += dy
    this.applyTransform()
  }

  ZenCanvasInstance.prototype.zoomAt = function (clientX, clientY, factor) {
    var s = this.state
    var next = clamp(s.scale * factor, this.opts.minScale, this.opts.maxScale)
    if (next === s.scale) return
    var rect = this.workspace.getBoundingClientRect()
    var mx = clientX - rect.left,
      my = clientY - rect.top
    var cx = (mx - s.panX) / s.scale
    var cy = (my - s.panY) / s.scale
    s.scale = next
    s.panX = mx - cx * next
    s.panY = my - cy * next
    this.applyTransform()
  }

  ZenCanvasInstance.prototype.zoomBy = function (factor) {
    var rect = this.workspace.getBoundingClientRect()
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  ZenCanvasInstance.prototype.resetView = function () {
    this.setView({ scale: 1, panX: 0, panY: 0 })
  }

  // ---- 布局 -----------------------------------------------------------
  ZenCanvasInstance.prototype.autoLayout = function (strategy) {
    var self = this
    var root = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null)
    var engine = (root && root.ZenCanvasLayout) || this.opts.layout
    if (!engine || typeof engine.computeCanvasLayout !== 'function') {
      this.opts.notify('未找到布局引擎（zen/canvas/layout.js）')
      return this
    }
    var list = this.state.nodes.map(function (n) {
      return {
        id: n.id,
        w: n.el.offsetWidth || num(n.el.style.width, 240),
        h: n.el.offsetHeight || num(n.el.style.height, 110),
        x0: num(n.el.style.left, 0),
        y0: num(n.el.style.top, 0),
      }
    })
    var conns = this.state.connections.map(function (c) {
      return { from: c.from, to: c.to, fromPort: c.fromPort, toPort: c.toPort }
    })
    var res = engine.computeCanvasLayout(list, conns, { strategy: strategy || 'smart' })
    if (!res || !res.items) return this
    this._silent(function () {
      self.state.nodes.forEach(function (n) {
        var item = res.items.find(function (it) {
          return it.id === n.id
        })
        if (!item) return
        n.el.style.left = item.x + 'px'
        n.el.style.top = item.y + 'px'
      })
      self.state.connections.forEach(function (c) {
        var key = c.from + '>' + c.to + ':' + (c.fromPort || 'right') + ':' + (c.toPort || 'left')
        var port = res.ports && res.ports[key]
        if (port) {
          if (port.fromPort) c.fromPort = port.fromPort
          if (port.toPort) c.toPort = port.toPort
          if (port.route) c.route = port.route
          if (port.hint) c.routeHint = port.hint
        }
      })
    })
    this.renderConnections()
    this.fitView({ minScale: 0.2 })
    this._changed()
    this.opts.notify('已自动排布（' + (strategy || 'smart') + '）')
    return this
  }

  // ---- 选择 / 剪贴板 / 历史 -------------------------------------------
  ZenCanvasInstance.prototype.select = function (id) {
    var rec = this._nodeById(id)
    if (!rec) return this
    this.state.selectedNodeIds.add(id)
    rec.el.classList.add('selected')
    this._selectionChanged()
    return this
  }

  ZenCanvasInstance.prototype.toggleSelect = function (id) {
    if (this.state.selectedNodeIds.has(id)) this.deselect(id)
    else this.select(id)
    return this
  }

  ZenCanvasInstance.prototype.deselect = function (id) {
    var rec = this._nodeById(id)
    this.state.selectedNodeIds.delete(id)
    if (rec) rec.el.classList.remove('selected')
    this._selectionChanged()
    return this
  }

  ZenCanvasInstance.prototype.clearSelection = function () {
    var self = this
    this.state.selectedNodeIds.forEach(function (id) {
      var n = self._nodeEl(id)
      if (n) n.classList.remove('selected')
    })
    this.state.selectedNodeIds.clear()
    this.state.selectedConnId = null
    this._selectionChanged()
    return this
  }

  ZenCanvasInstance.prototype.selectAll = function () {
    var self = this
    this.state.nodes.forEach(function (n) {
      self.state.selectedNodeIds.add(n.id)
      n.el.classList.add('selected')
    })
    this._selectionChanged()
    return this
  }

  ZenCanvasInstance.prototype.getSelection = function () {
    return Array.from(this.state.selectedNodeIds)
  }

  ZenCanvasInstance.prototype._selectionChanged = function () {
    this.renderConnections()
    this.opts.onSelectionChange(this.getSelection())
    this.bus.emit('selection', this.getSelection())
  }

  ZenCanvasInstance.prototype.setAlignBase = function (id) {
    if (this.state.alignBaseId) {
      var old = this._nodeEl(this.state.alignBaseId)
      if (old) old.classList.remove('align-base')
    }
    this.state.alignBaseId = id
    if (id) {
      var node = this._nodeEl(id)
      if (node) node.classList.add('align-base')
    }
    return this
  }

  ZenCanvasInstance.prototype._collectMoveNodes = function (id) {
    var self = this
    var ids = this.state.selectedNodeIds.has(id) ? Array.from(this.state.selectedNodeIds) : [id]
    return ids.map(function (i) {
      return self._nodeEl(i)
    })
  }

  ZenCanvasInstance.prototype.deleteSelection = function () {
    var self = this
    if (this.state.selectedConnId) {
      this.removeConnection(this.state.selectedConnId)
      return this
    }
    var ids = Array.from(this.state.selectedNodeIds)
    if (!ids.length) return this
    this._silent(function () {
      ids.forEach(function (id) {
        self.removeNode(id)
      })
    })
    this._changed()
    return this
  }

  ZenCanvasInstance.prototype.copySelection = function () {
    var self = this
    var ids = Array.from(this.state.selectedNodeIds)
    if (!ids.length) return this
    this.state.clipboard = {
      nodes: ids
        .map(function (id) {
          var rec = self._nodeById(id)
          return rec ? self._serializeNode(rec) : null
        })
        .filter(Boolean),
      connections: this.state.connections.filter(function (c) {
        return ids.indexOf(c.from) >= 0 && ids.indexOf(c.to) >= 0
      }),
    }
    this.opts.notify('已复制 ' + ids.length + ' 个节点')
    return this
  }

  ZenCanvasInstance.prototype.paste = function (at) {
    var clip = this.state.clipboard
    if (!clip || !clip.nodes.length) return this
    var self = this
    var idMap = {}
    var rect = this.workspace.getBoundingClientRect()
    var world = at || this.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
    var minX = Math.min.apply(null, clip.nodes.map(function (n) { return num(n.x, 0) }))
    var minY = Math.min.apply(null, clip.nodes.map(function (n) { return num(n.y, 0) }))
    this._silent(function () {
      clip.nodes.forEach(function (n) {
        var data = assign({}, n.data || {})
        delete data.id
        var rec = self.addNode(n.type, data, {
          x: world.x + num(n.x, 0) - minX + 24,
          y: world.y + num(n.y, 0) - minY + 24,
        }, { change: false })
        idMap[n.id] = rec.id
      })
      clip.connections.forEach(function (c) {
        if (idMap[c.from] && idMap[c.to]) {
          self.addConnection(idMap[c.from], idMap[c.to], c.fromPort, c.toPort)
        }
      })
    })
    this._changed()
    return this
  }

  ZenCanvasInstance.prototype.duplicate = function () {
    this.copySelection()
    var rect = this.workspace.getBoundingClientRect()
    return this.paste(this.screenToWorld(rect.left + rect.width / 2 + 40, rect.top + rect.height / 2 + 40))
  }

  ZenCanvasInstance.prototype._pushHistory = function () {
    // 快照必须在变更前取：_changed() 是变更后调用的，直接存 current 会让
    // 撤销回到“刚刚这一步”，看起来像撤销失效。这里始终保存上一次的状态。
    var current = JSON.stringify(this.toJSON())
    if (this._snapshot == null) this._snapshot = current
    if (this._snapshot !== current) {
      this._history.push(this._snapshot)
      if (this._history.length > this.opts.historyLimit) this._history.shift()
      this._snapshot = current
    }
    this._future = []
  }

  ZenCanvasInstance.prototype.undo = function () {
    if (!this._history.length) {
      this.opts.notify('没有可撤销的操作')
      return this
    }
    var prev = this._history.pop()
    this._future.push(JSON.stringify(this.toJSON()))
    this._snapshot = prev
    this.fromJSON(JSON.parse(prev), { history: false })
    return this
  }

  ZenCanvasInstance.prototype.redo = function () {
    if (!this._future.length) {
      this.opts.notify('没有可重做的操作')
      return this
    }
    var next = this._future.pop()
    this._history.push(JSON.stringify(this.toJSON()))
    this._snapshot = next
    this.fromJSON(JSON.parse(next), { history: false })
    return this
  }

  // ---- 序列化：与 writer 的 {nodes,connections} 格式兼容 --------------
  ZenCanvasInstance.prototype._serializeNode = function (rec) {
    var def = this.types[rec.type] || {}
    var obj = {
      id: rec.id,
      type: rec.type,
      x: rec.el.style.left,
      y: rec.el.style.top,
      w: rec.el.style.width,
      h: rec.minimized && rec._restore ? rec._restore.h : rec.el.style.height,
      title: rec.data.title || def.label || rec.type,
      locked: rec.locked,
      minimized: rec.minimized,
    }
    var data = assign({}, rec.data)
    delete data.id
    delete data.title
    obj.data = def.serialize ? def.serialize(data, rec.el) : data
    return obj
  }

  ZenCanvasInstance.prototype.toJSON = function () {
    var self = this
    return {
      version: 1,
      app: this.scope,
      nodes: this.state.nodes.map(function (n) {
        return self._serializeNode(n)
      }),
      connections: this.state.connections.map(function (c) {
        return {
          id: c.id,
          from: c.from,
          to: c.to,
          fromPort: c.fromPort || 'right',
          toPort: c.toPort || 'left',
          route: c.route === 'elbow' ? 'elbow' : undefined,
          routeHint: c.route === 'elbow' ? c.routeHint : undefined,
        }
      }),
      view: this.getView(),
      meta: this.opts.meta || {},
    }
  }

  ZenCanvasInstance.prototype._validateCanvasData = function (data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('invalid canvas data')
    }
    if (data.app !== this.scope) {
      throw new Error('canvas app mismatch: expected "' + this.scope + '"')
    }
    if (!Array.isArray(data.nodes)) throw new Error('canvas nodes must be an array')
    if (data.connections != null && !Array.isArray(data.connections)) {
      throw new Error('canvas connections must be an array')
    }

    var self = this
    var nodeIds = new Set()
    var connectionIds = new Set()
    var connectionKeys = new Set()
    var nodes = data.nodes.map(function (n, index) {
      if (!n || typeof n !== 'object' || Array.isArray(n)) {
        throw new Error('invalid canvas node at index ' + index)
      }
      if (typeof n.type !== 'string' || !Object.prototype.hasOwnProperty.call(self.types, n.type)) {
        throw new Error('unknown node type at index ' + index + ': ' + n.type)
      }
      if ((typeof n.id !== 'string' && typeof n.id !== 'number') ||
          (typeof n.id === 'number' && !isFinite(n.id)) || String(n.id).trim() === '') {
        throw new Error('canvas node id is required at index ' + index)
      }
      var id = String(n.id)
      if (nodeIds.has(id)) throw new Error('duplicate canvas node id: ' + id)
      nodeIds.add(id)
      return { source: n, id: id }
    })

    var connections = (data.connections || []).map(function (c, index) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        throw new Error('invalid canvas connection at index ' + index)
      }
      var from = c.from == null ? '' : String(c.from)
      var to = c.to == null ? '' : String(c.to)
      if (!nodeIds.has(from)) throw new Error('unknown connection source at index ' + index + ': ' + from)
      if (!nodeIds.has(to)) throw new Error('unknown connection target at index ' + index + ': ' + to)
      if (from === to) throw new Error('canvas connection cannot reference the same node: ' + from)
      var fromPort = c.fromPort || 'right'
      var toPort = c.toPort || 'left'
      var key = from + '\u0000' + to + '\u0000' + fromPort + '\u0000' + toPort
      if (connectionKeys.has(key)) throw new Error('duplicate canvas connection at index ' + index)
      connectionKeys.add(key)

      var id = null
      if (c.id != null) {
        if ((typeof c.id !== 'string' && typeof c.id !== 'number') ||
            (typeof c.id === 'number' && !isFinite(c.id)) || String(c.id).trim() === '') {
          throw new Error('canvas connection id is invalid at index ' + index)
        }
        id = String(c.id)
        if (connectionIds.has(id)) throw new Error('duplicate canvas connection id: ' + id)
        connectionIds.add(id)
      }
      return { source: c, id: id, from: from, to: to, fromPort: fromPort, toPort: toPort }
    })
    return { nodes: nodes, connections: connections }
  }

  ZenCanvasInstance.prototype.fromJSON = function (data, opts) {
    var plan = this._validateCanvasData(data)
    var self = this
    this._silent(function () {
      self.clear()
      plan.nodes.forEach(function (item) {
        var n = item.source
        var payload = assign({}, n.data || {})
        if (n.title != null) payload.title = n.title
        if (n.w != null) payload.w = num(n.w, 240)
        if (n.h != null) payload.h = num(n.h, 110)
        payload.locked = !!n.locked
        payload.minimized = !!n.minimized
        payload.id = item.id
        self.addNode(n.type, payload, { x: num(n.x, 100), y: num(n.y, 100) }, { change: false })
      })
      plan.connections.forEach(function (item) {
        var c = item.source
        var extra = { route: c.route, routeHint: c.routeHint }
        if (item.id != null) extra.id = item.id
        self.addConnection(item.from, item.to, item.fromPort, item.toPort, extra)
      })
      self.setView(data.view || { scale: 1, panX: 0, panY: 0 })
    })
    if (!opts || opts.history !== false) this._changed()
    else this._snapshot = JSON.stringify(this.toJSON())
    return this
  }

  ZenCanvasInstance.prototype.exportFile = function (name) {
    var text = JSON.stringify(this.toJSON(), null, 2)
    var blob = new Blob([text], { type: 'application/json' })
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name || (this.scope + '-canvas.json')
    a.click()
    setTimeout(function () {
      URL.revokeObjectURL(a.href)
    }, 1000)
  }

  // ---- 事件绑定 -------------------------------------------------------
  ZenCanvasInstance.prototype._bindCanvasEvents = function () {
    var self = this
    // 右键平移（writer 同款）
    this.workspace.addEventListener('mousedown', function (e) {
      if (e.button === 2) {
        self.beginPan(e.clientX, e.clientY)
        e.preventDefault()
      }
    })
    document.addEventListener('mousemove', function (e) {
      self.movePan(e.clientX, e.clientY)
      self._updatePortDrag(e)
    })
    document.addEventListener('mouseup', function (e) {
      self.endPan()
      self._finishPortDrag(e)
    })

    // 滚轮 / 触控板判定：完全沿用 writer 的“滚动流”判定
    var lastWheelAt = 0,
      lastWheelDeltaY = 0,
      trackpad = false
    var wheelFactor = function (e) {
      var wd = Math.abs(e.wheelDeltaY)
      var steps
      if (Number.isFinite(wd) && wd > 0) steps = wd / 120
      else if (e.deltaMode === 1) steps = Math.abs(e.deltaY) / 3
      else steps = Math.abs(e.deltaY) / 100
      steps = clamp(steps, 0.02, 4)
      return Math.pow(1.12, -Math.sign(e.deltaY) * steps)
    }
    this.workspace.addEventListener(
      'wheel',
      function (e) {
        var el0 = e.target
        var scrollable =
          el0.closest && el0.closest('[data-zen-noscroll]') ? null : el0.closest && el0.closest('.node-content')
        var pinch = e.ctrlKey || e.metaKey
        if (!pinch && scrollable && scrollable.scrollHeight > scrollable.clientHeight) return
        e.preventDefault()
        var unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
        if (pinch) {
          self.zoomAt(e.clientX, e.clientY, Math.pow(0.999, e.deltaY * unit))
          lastWheelAt = 0
          lastWheelDeltaY = 0
          trackpad = false
          return
        }
        var now = performance.now()
        var inBurst = now - lastWheelAt < 180
        var wd = Math.abs(e.wheelDeltaY)
        var tick = e.deltaMode !== 0 || (Number.isFinite(wd) && wd >= 120 && wd % 120 === 0)
        var isTrackpad = inBurst
          ? e.deltaX !== 0 || e.deltaY !== lastWheelDeltaY || trackpad
          : e.deltaX !== 0 || (Math.abs(e.deltaY) < 40 && !tick)
        lastWheelAt = now
        lastWheelDeltaY = e.deltaY
        trackpad = isTrackpad
        if (isTrackpad) self.panBy(-e.deltaX * unit, -e.deltaY * unit)
        else self.zoomAt(e.clientX, e.clientY, wheelFactor(e))
      },
      { passive: false }
    )

    // 双指触摸：单指拖画布 / 双指捏合缩放
    var touches = {}
    var lastDist = 0
    var lastMid = null
    this.workspace.addEventListener('touchstart', function (e) {
      Array.prototype.forEach.call(e.changedTouches, function (t) {
        touches[t.identifier] = { x: t.clientX, y: t.clientY }
      })
      var ids = Object.keys(touches)
      if (ids.length === 1) self.beginPan(touches[ids[0]].x, touches[ids[0]].y)
      else if (ids.length === 2) {
        self.state.isPanning = false
        var a = touches[ids[0]],
          b = touches[ids[1]]
        lastDist = Math.hypot(a.x - b.x, a.y - b.y)
        lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      }
    }, { passive: true })
    this.workspace.addEventListener('touchmove', function (e) {
      Array.prototype.forEach.call(e.changedTouches, function (t) {
        if (touches[t.identifier]) touches[t.identifier] = { x: t.clientX, y: t.clientY }
      })
      var ids = Object.keys(touches)
      if (ids.length === 1 && self.state.isPanning) {
        self.movePan(touches[ids[0]].x, touches[ids[0]].y)
      } else if (ids.length === 2 && lastMid) {
        var a = touches[ids[0]],
          b = touches[ids[1]]
        var dist = Math.hypot(a.x - b.x, a.y - b.y)
        var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        self.panBy(mid.x - lastMid.x, mid.y - lastMid.y)
        if (lastDist > 0) self.zoomAt(mid.x, mid.y, dist / lastDist)
        lastDist = dist
        lastMid = mid
      }
      e.preventDefault()
    }, { passive: false })
    var endTouch = function (e) {
      Array.prototype.forEach.call(e.changedTouches, function (t) {
        delete touches[t.identifier]
      })
      var ids = Object.keys(touches)
      if (ids.length === 1) self.rebasePan(touches[ids[0]].x, touches[ids[0]].y)
      else if (ids.length === 0) {
        self.endPan()
        lastDist = 0
        lastMid = null
      }
    }
    this.workspace.addEventListener('touchend', endTouch, { passive: true })
    this.workspace.addEventListener('touchcancel', endTouch, { passive: true })

    // 右键菜单
    var self2 = this
    this.workspace.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      if (!self2.opts.contextMenu) return
      if (self2.state.panWasDragging) {
        self2.state.panWasDragging = false
        return
      }
      self2.showContextMenu(e)
    })
    document.addEventListener('mousedown', function (e) {
      if (!e.target.closest('.zenui-popmenu')) window.ZenUI.menu.close()
    })
  }

  ZenCanvasInstance.prototype._updatePortDrag = function (e) {
    var s = this.state
    if (!s.portDrag || !s.tempLine) return
    if (s.portDragPending) return
    s.portDragPending = true
    var self = this
    requestAnimationFrame(function () {
      s.portDragPending = false
      if (!s.portDrag || !s.tempLine) return
      var world = self.screenToWorld(e.clientX, e.clientY)
      var sx = s.portDrag.startX,
        sy = s.portDrag.startY
      var fp = s.portDrag.portType || 'right'
      s.tempLine.setAttribute('d', getCurvePath(sx, sy, world.x, world.y, fp, OPPOSITE[fp] || 'left'))
      Array.prototype.forEach.call(self.workspace.querySelectorAll('.node-port'), function (p) {
        p.classList.remove('port-highlight')
      })
      var target = self._portAt(e.clientX, e.clientY)
      if (target && target.dataset.nodeId !== s.portDrag.nodeId) target.classList.add('port-highlight')
    })
  }

  ZenCanvasInstance.prototype._finishPortDrag = function (e) {
    var s = this.state
    if (!s.portDrag) return
    var self = this
    if (s.tempLine) {
      s.tempLine.remove()
      s.tempLine = null
    }
    Array.prototype.forEach.call(this.workspace.querySelectorAll('.node-port'), function (p) {
      p.classList.remove('dragging', 'port-highlight')
    })
    document.body.style.cursor = 'default'
    var target = this._portAt(e.clientX, e.clientY)
    if (target && target.dataset.nodeId !== s.portDrag.nodeId) {
      this.addConnection(s.portDrag.nodeId, target.dataset.nodeId, s.portDrag.portType, target.dataset.port)
    }
    s.portDrag = null
    this.bus.emit('portDragEnd', {})
  }

  ZenCanvasInstance.prototype._bindSelectionEvents = function () {
    var self = this
    var ws = this.workspace
    var active = false,
      additive = false,
      base = new Set(),
      sx = 0,
      sy = 0
    ws.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      var t = e.target
      if (!t || !t.closest) return
      if (t.closest('.node') || t.closest('.node-port') || t.closest('.zc-context-menu')) return
      if (document.activeElement && document.activeElement.blur) {
        try {
          document.activeElement.blur()
        } catch (_) {}
      }
      e.preventDefault()
      window.ZenUI.menu.close()
      active = true
      additive = !!(e.shiftKey || e.ctrlKey || e.metaKey)
      base = additive ? new Set(self.state.selectedNodeIds) : new Set()
      sx = e.clientX
      sy = e.clientY
      if (!additive) self.clearSelection()
    })
    document.addEventListener('mousemove', function (e) {
      if (!active) return
      var x0 = Math.min(sx, e.clientX),
        y0 = Math.min(sy, e.clientY)
      var x1 = Math.max(sx, e.clientX),
        y1 = Math.max(sy, e.clientY)
      var box = self.marquee
      box.style.display = 'block'
      box.style.left = x0 + 'px'
      box.style.top = y0 + 'px'
      box.style.width = x1 - x0 + 'px'
      box.style.height = y1 - y0 + 'px'
      self._silent(function () {
        self.clearSelection()
        base.forEach(function (id) {
          self.select(id)
        })
        self.state.nodes.forEach(function (n) {
          var r = n.el.getBoundingClientRect()
          if (r.right < x0 || r.left > x1 || r.bottom < y0 || r.top > y1) return
          self.select(n.id)
        })
      })
      self._selectionChanged()
    })
    document.addEventListener('mouseup', function () {
      if (!active) return
      active = false
      self.marquee.style.display = 'none'
    })
  }

  ZenCanvasInstance.prototype._bindGlobalEvents = function () {
    var self = this
    this._keyHandler = function (e) {
      if (!self.workspace.isConnected) return
      var tag = (e.target.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return
      var mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) self.redo()
        else self.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        self.redo()
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        self.selectAll()
      } else if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        self.copySelection()
      } else if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        self.paste()
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        self.duplicate()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        self.deleteSelection()
      } else if (e.key === 'f' || e.key === 'F') {
        self.fitView()
      } else if (e.key === 'l' || e.key === 'L') {
        self.autoLayout()
      } else if (e.key === 'Escape') {
        self.clearSelection()
      }
    }
    document.addEventListener('keydown', this._keyHandler)
  }

  ZenCanvasInstance.prototype._bindResizeObserver = function () {
    if (!window.ResizeObserver) return
    var self = this
    this._ro = new ResizeObserver(function () {
      self.renderConnections()
    })
    var mo = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (n.classList && n.classList.contains('node')) self._ro.observe(n)
        })
      })
    })
    mo.observe(this.inner, { childList: true })
    this._mo = mo
    this.state.nodes.forEach(function (n) {
      self._ro.observe(n.el)
    })
  }

  ZenCanvasInstance.prototype.showContextMenu = function (e) {
    var self = this
    var nodeEl = e.target.closest ? e.target.closest('.node') : null
    var rec = nodeEl ? this._nodeById(nodeEl.dataset.nodeId) : null
    if (rec && !this.state.selectedNodeIds.has(rec.id)) {
      this.clearSelection()
      this.select(rec.id)
    }
    var items = []
    if (this.opts.onContextMenu) {
      items = this.opts.onContextMenu(e, {
        node: rec ? { id: rec.id, type: rec.type, data: rec.data } : null,
        selection: this.getSelection(),
        canvas: this,
      }) || []
    }
    if (!items.length) {
      items = [
        { label: '全选', action: function () { self.selectAll() } },
        { label: '适应视野', action: function () { self.fitView() } },
        { label: '自动排布', action: function () { self.autoLayout() } },
      ]
      if (rec) {
        items.unshift({ label: '复制', action: function () { self.copySelection() } })
        items.unshift({ label: '删除节点', danger: true, action: function () { self.deleteSelection() } })
      }
    }
    /* Menus are a shared UI concern: delegate to ZenUI so every product gets
       the same overlay, keyboard handling and focus behaviour. */
    window.ZenUI.menu.open(items, null, { x: e.clientX, y: e.clientY })
  }

  ZenCanvasInstance.prototype.toast = function (msg, opts) {
    return window.ZenUI.toast(msg, opts)
  }

  ZenCanvasInstance.prototype.destroy = function () {
    document.removeEventListener('keydown', this._keyHandler)
    if (this._ro) this._ro.disconnect()
    if (this._mo) this._mo.disconnect()
    this.workspace.remove()
    this.bus.emit('destroy', {})
  }

  // ------------------------------------------------------------------
  // 静态 API
  // ------------------------------------------------------------------
  function create(options) {
    return new ZenCanvasInstance(options)
  }

  return {
    version: VERSION,
    create: create,
    geometry: {
      getItemPort: getItemPort,
      getPortPosition: getPortPosition,
      getCurvePath: getCurvePath,
      getElbowPath: getElbowPath,
    },
  }
})
