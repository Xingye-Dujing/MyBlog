/* zen-video.js — 视频分析与处理工作台（通用画布框架的接入实现）
 *
 * 这一层只做三件事：
 *   1. 用 ZenCanvas.registerNodeType 声明业务节点（字段简单、带默认值）；
 *   2. 把画布图编译成后端工作流 JSON，并轮询执行状态；
 *   3. 渲染节点库 / 检查器 / 结果面板。
 * 所有画布交互本身都在 zen/canvas/ 里，本文件不实现拖拽、连线、缩放。
 */
(function () {
  'use strict'

  var API = ''
  var canvas = null
  var jobId = null
  var selectedId = null
  var fileInput = document.getElementById('file-input')
  var pendingFileNode = null
  var workflowRevision = 0
  var activeRevision = -1
  var uploadGeneration = 0
  var starting = false

  function $(id) {
    return document.getElementById(id)
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function toast(msg) { return window.ZenUI.toast(msg) }
  function fmtTime(sec) {
    var n = Number(sec || 0)
    if (!isFinite(n)) return '—'
    var m = Math.floor(n / 60)
    var s = (n % 60).toFixed(1)
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
  }

  // --------------------------------------------------------------------
  // 节点定义：字段即设置面板，默认值让每个节点开箱可用
  // --------------------------------------------------------------------
  function f(key, label, type, extra) {
    return Object.assign({ key: key, label: label, type: type || 'text' }, extra || {})
  }

  var DEFS = {
    input: {
      label: '视频输入', category: '输入', glyph: '入', ports: ['right'], kind: 'k-in',
      w: 250, h: 116,
      defaults: { fileId: '', filename: '' },
      fields: [f('fileId', '视频文件', 'file', { hint: '支持 mp4 / mov / mkv / webm / mp3 等；文件随任务上传到本地工作区。' })],
      summary: function (d) { return d.filename ? d.filename : '未选择文件' },
      meta: function (d) { return d.fileId ? '已就绪 · ' + d.fileId.slice(0, 8) : '请先导入视频' },
    },
    probe: {
      label: '媒体信息', category: '分析', glyph: '析', ports: ['left', 'right'], kind: 'k-analysis',
      w: 250, h: 132,
      defaults: { fileId: '', filename: '' },
      fields: [f('fileId', '视频文件', 'file', { hint: '连接上游时忽略此项；未连线时可直接选择文件。' })],
      summary: function (d) { return d.filename || '读取时长 / 分辨率 / 编码 / 帧率' },
      meta: function () { return '分析节点 · 不改变视频内容' },
    },
    scene: {
      label: '场景检测', category: '分析', glyph: '景', ports: ['left', 'right'], kind: 'k-analysis',
      w: 250, h: 140,
      defaults: { threshold: 0.3 },
      fields: [f('threshold', '场景变化阈值', 'range', { min: 0.05, max: 1, step: 0.05, hint: '越小越敏感，常用 0.25 – 0.4。' })],
      summary: function (d) { return '阈值 ' + (d.threshold || 0.3) + ' · 输出切镜时间点' },
      meta: function () { return '基于 ffmpeg scene score' },
    },
    silence: {
      label: '静音检测', category: '分析', glyph: '默', ports: ['left', 'right'], kind: 'k-analysis',
      w: 250, h: 140,
      defaults: { noise: '-40dB', duration: 0.5 },
      fields: [
        f('noise', '静音门限', 'select', { options: ['-30dB', '-35dB', '-40dB', '-45dB', '-50dB'] }),
        f('duration', '最短时长（秒）', 'number', { min: 0.1, max: 10, step: 0.1 }),
      ],
      summary: function (d) { return '门限 ' + (d.noise || '-40dB') + ' · 至少 ' + (d.duration || 0.5) + 's' },
      meta: function () { return 'silencedetect' },
    },
    black: {
      label: '黑场检测', category: '分析', glyph: '黑', ports: ['left', 'right'], kind: 'k-analysis',
      w: 250, h: 140,
      defaults: { duration: 0.5 },
      fields: [f('duration', '最短黑场（秒）', 'number', { min: 0.1, max: 10, step: 0.1 })],
      summary: function (d) { return '黑场 ≥ ' + (d.duration || 0.5) + 's' },
      meta: function () { return 'blackdetect' },
    },
    thumbnail: {
      label: '批量缩略图', category: '分析', glyph: '图', ports: ['left', 'right'], kind: 'k-analysis',
      w: 250, h: 140,
      defaults: { interval: 5, count: 8 },
      fields: [
        f('interval', '每隔几秒一张', 'number', { min: 0.2, max: 60, step: 0.5 }),
        f('count', '最多张数', 'number', { min: 1, max: 30, step: 1 }),
      ],
      summary: function (d) { return '每 ' + (d.interval || 5) + 's 一张 · 最多 ' + (d.count || 8) + ' 张' },
      meta: function () { return '输出可在右侧预览' },
    },
    trim: {
      label: '片段裁剪', category: '处理', glyph: '剪', ports: ['left', 'right'], kind: '',
      w: 250, h: 138,
      defaults: { start: 0, duration: 10 },
      fields: [
        f('start', '起始时间（秒）', 'number', { min: 0, step: 0.5, hint: '从视频开头算起。' }),
        f('duration', '截取时长（秒）', 'number', { min: 0.1, step: 0.5, hint: '0 表示一直到结尾。' }),
      ],
      summary: function (d) { return fmtTime(d.start) + ' 起 · ' + (d.duration || '至结尾') + 's' },
      meta: function () { return '无损裁剪（-c copy）' },
    },
    crop: {
      label: '画面裁切', category: '处理', glyph: '裁', ports: ['left', 'right'], kind: '',
      w: 250, h: 150,
      defaults: { w: 0, h: 0, x: 0, y: 0 },
      fields: [
        f('w', '目标宽度', 'number', { min: 0, step: 10, hint: '0 = 保持原宽。' }),
        f('h', '目标高度', 'number', { min: 0, step: 10 }),
        f('x', '左下起点 X', 'number', { min: 0, step: 10 }),
        f('y', '左上起点 Y', 'number', { min: 0, step: 10 }),
      ],
      summary: function (d) { return (d.w || '原宽') + ' × ' + (d.h || '原高') + ' @ ' + (d.x || 0) + ',' + (d.y || 0) },
      meta: function () { return 'crop 滤镜' },
    },
    scale: {
      label: '尺寸缩放', category: '处理', glyph: '缩', ports: ['left', 'right'], kind: '',
      w: 250, h: 150,
      defaults: { w: 1280, h: 720, fit: 'contain' },
      fields: [
        f('w', '宽度', 'number', { min: 0, step: 10 }),
        f('h', '高度', 'number', { min: 0, step: 10 }),
        f('fit', '比例', 'select', { options: ['contain', 'stretch'],
          optionsLabel: { contain: '保持比例（补边）', stretch: '拉伸填满' } }),
      ],
      summary: function (d) { return (d.w || '?') + ' × ' + (d.h || '?') + ' · ' + (d.fit === 'stretch' ? '拉伸' : '保持比例') },
      meta: function () { return 'scale / pad 滤镜' },
    },
    rotate: {
      label: '旋转与翻转', category: '处理', glyph: '转', ports: ['left', 'right'], kind: '',
      w: 250, h: 156,
      defaults: { degrees: 0, hflip: false, vflip: false },
      fields: [
        f('degrees', '旋转角度', 'select', { options: ['0', '90', '180', '270'],
          optionsLabel: { '0': '不旋转', '90': '顺时针 90°', '180': '180°', '270': '逆时针 90°' } }),
        f('hflip', '水平镜像', 'checkbox'),
        f('vflip', '垂直镜像', 'checkbox'),
      ],
      summary: function (d) {
        var s = (d.degrees || 0) + '°'
        if (d.hflip) s += ' · 左右翻转'
        if (d.vflip) s += ' · 上下翻转'
        return s
      },
      meta: function () { return 'transpose / hflip / vflip' },
    },
    speed: {
      label: '播放速度', category: '处理', glyph: '速', ports: ['left', 'right'], kind: '',
      w: 250, h: 130,
      defaults: { factor: 1 },
      fields: [f('factor', '速度倍数', 'range', { min: 0.25, max: 4, step: 0.25, hint: '0.5 = 慢一倍；2 = 快一倍。音频同步调速。' })],
      summary: function (d) { return (d.factor || 1) + '× 速度' },
      meta: function () { return 'setpts + atempo' },
    },
    volume: {
      label: '音量调整', category: '处理', glyph: '音', ports: ['left', 'right'], kind: '',
      w: 250, h: 126,
      defaults: { factor: 1 },
      fields: [f('factor', '音量倍数', 'range', { min: 0, max: 4, step: 0.1, hint: '0 = 静音，1 = 原音量。' })],
      summary: function (d) { return (d.factor == null ? 1 : d.factor) + '× 音量' },
      meta: function () { return 'volume 滤镜' },
    },
    mute: {
      label: '去除音轨', category: '处理', glyph: '静', ports: ['left', 'right'], kind: '',
      w: 230, h: 104,
      defaults: {}, fields: [],
      summary: function () { return '移除全部音频流' },
      meta: function () { return '-an' },
    },
    fade: {
      label: '淡入淡出', category: '处理', glyph: '淡', ports: ['left', 'right'], kind: '',
      w: 250, h: 150,
      defaults: { type: 'in', start: 0, duration: 1 },
      fields: [
        f('type', '类型', 'select', { options: ['in', 'out'], optionsLabel: { in: '淡入', out: '淡出' } }),
        f('start', '开始时间（秒）', 'number', { min: 0, step: 0.5 }),
        f('duration', '持续（秒）', 'number', { min: 0.1, step: 0.5 }),
      ],
      summary: function (d) { return (d.type === 'out' ? '淡出' : '淡入') + ' · ' + (d.start || 0) + 's 起 ' + (d.duration || 1) + 's' },
      meta: function () { return 'fade 滤镜' },
    },
    drawtext: {
      label: '叠加文字', category: '处理', glyph: '字', ports: ['left', 'right'], kind: '',
      w: 250, h: 172,
      defaults: { text: 'OMM-ZEN', fontsize: 28, color: 'white', x: '(w-text_w)/2', y: '(h-text_h)/2' },
      fields: [
        f('text', '文字内容', 'text'),
        f('fontsize', '字号', 'number', { min: 10, max: 120, step: 2 }),
        f('color', '颜色', 'text', { hint: 'white / black / #ffcc00 等 ffmpeg 颜色写法。' }),
        f('x', '横坐标', 'text', { hint: '可写表达式，如 (w-text_w)/2。' }),
        f('y', '纵坐标', 'text'),
      ],
      summary: function (d) { return '“' + (d.text || '') + '” · ' + (d.fontsize || 28) + 'px' },
      meta: function () { return 'drawtext 滤镜' },
    },
    audio: {
      label: '提取音频', category: '处理', glyph: '乐', ports: ['left', 'right'], kind: '',
      w: 250, h: 128,
      defaults: { format: 'mp3' },
      fields: [f('format', '音频格式', 'select', { options: ['mp3', 'm4a'] })],
      summary: function (d) { return '导出 ' + (d.format || 'mp3') + ' 音轨' },
      meta: function () { return '-vn' },
    },
    concat: {
      label: '视频拼接', category: '处理', glyph: '接', ports: ['left', 'right'], kind: '',
      w: 250, h: 126,
      defaults: {}, fields: [],
      summary: function () { return '把接入的多条视频顺序拼接' },
      meta: function () { return '至少连接 2 个上游节点' },
    },
    format: {
      label: '编码与格式', category: '处理', glyph: '码', ports: ['left', 'right'], kind: '',
      w: 250, h: 158,
      defaults: { format: 'mp4', crf: 23, preset: 'medium' },
      fields: [
        f('format', '容器格式', 'select', { options: ['mp4', 'mkv', 'webm', 'mov', 'gif'] }),
        f('crf', '画质 CRF', 'range', { min: 18, max: 35, step: 1, hint: '越小越清晰、体积越大；23 是常用值。' }),
        f('preset', '编码预设', 'select', { options: ['ultrafast', 'fast', 'medium', 'slow'] }),
      ],
      summary: function (d) { return (d.format || 'mp4').toUpperCase() + ' · CRF ' + (d.crf || 23) + ' · ' + (d.preset || 'medium') },
      meta: function (d) {
        if (d.format === 'webm') return 'VP9 / Opus'
        if (d.format === 'gif') return 'GIF 调色板链'
        return 'H.264 / AAC'
      },
    },
    export: {
      label: '导出文件', category: '输出', glyph: '出', ports: ['left'], kind: 'k-out',
      w: 250, h: 132,
      defaults: { filename: 'output.mp4', format: 'mp4' },
      fields: [
        f('filename', '文件名', 'text', { hint: '任务输出目录内，可直接点开预览或下载。' }),
        f('format', '格式', 'select', { options: ['mp4', 'mkv', 'webm', 'mp3', 'gif'] }),
      ],
      summary: function (d) { return d.filename || 'output.mp4' },
      meta: function () { return '终点节点 · 无需再连出' },
    },
  }

  // --------------------------------------------------------------------
  // 节点正文（框架只提供外壳，内容由产品定义）
  // --------------------------------------------------------------------
  function renderBody(def, data, host, api) {
    host.innerHTML =
      '<div class="zv-kind ' + (def.kind || '') + '"><i></i>' + esc(def.category) + ' · ' + esc(def.label) + '</div>' +
      '<div class="zv-summary" data-role="summary"></div>' +
      '<div class="zv-meta" data-role="meta"></div>' +
      '<div class="zv-progress" data-role="progress"><i></i></div>' +
      '<div class="zv-result" data-role="result"></div>'
    var summary = host.querySelector('[data-role="summary"]')
    summary.textContent = def.summary ? def.summary(data) : ''
    host.querySelector('[data-role="meta"]').textContent = def.meta ? def.meta(data) : ''
  }

  // --------------------------------------------------------------------
  // 检查器
  // --------------------------------------------------------------------
  function renderInspector() {
    var body = $('inspector-body')
    var id = selectedId
    var rec = id && canvas ? canvas.getNode(id) : null
    if (!rec) {
      $('inspect-kind').textContent = '未选中'
      body.innerHTML = '<div class="empty">选中一个节点后在这里设置参数。<br />所有参数都有默认值，直接运行也可以。</div>'
      return
    }
    var def = DEFS[rec.type]
    $('inspect-kind').textContent = def ? def.label : rec.type
    var html = '<h3 class="title">' + esc(def ? def.label : rec.type) + '</h3>' +
      '<div class="node-id">' + esc(rec.id) + ' · ' + esc(def ? def.category : '') + '</div>'
    var fields = (def && def.fields) || []
    if (!fields.length) {
      html += '<div class="hintline">这个节点无需额外设置，连接上下游即可。</div>'
    }
    fields.forEach(function (fd) {
      var value = rec.data[fd.key]
      html += '<label class="field"><span>' + esc(fd.label) + '</span>'
      if (fd.type === 'select') {
        html += '<select data-zen-select data-key="' + esc(fd.key) + '">'
        ;(fd.options || []).forEach(function (opt) {
          var label = (fd.optionsLabel && fd.optionsLabel[opt]) || opt
          html += '<option value="' + esc(opt) + '"' + (String(value) === String(opt) ? ' selected' : '') + '>' + esc(label) + '</option>'
        })
        html += '</select>'
      } else if (fd.type === 'checkbox') {
        html += '<button type="button" class="switch" role="switch" data-zen-switch data-key="' + esc(fd.key) + '" aria-checked="' + (value ? 'true' : 'false') + '">' +
          '<span class="switch-track" aria-hidden="true"></span><span>启用</span></button>'
      } else if (fd.type === 'range') {
        html += '<input type="range" data-key="' + esc(fd.key) + '" min="' + fd.min + '" max="' + fd.max + '" step="' + fd.step + '" value="' + esc(value != null ? value : fd.min) + '" />' +
          '<div class="hintline" data-range-label="' + esc(fd.key) + '">' + esc(value != null ? value : fd.min) + '</div>'
      } else if (fd.type === 'file') {
        html += '<button class="menu-btn" data-file-key="' + esc(fd.key) + '">' + (rec.data.filename ? '更换视频：' + esc(rec.data.filename) : '选择视频文件…') + '</button>' +
          '<div class="hintline">' + esc(value || '尚未选择文件') + '</div>'
      } else {
        html += '<input type="' + (fd.type === 'number' ? 'number' : 'text') + '" data-key="' + esc(fd.key) + '"' +
          (fd.min != null ? ' min="' + fd.min + '"' : '') + (fd.max != null ? ' max="' + fd.max + '"' : '') +
          (fd.step != null ? ' step="' + fd.step + '"' : '') + ' value="' + esc(value != null ? value : '') + '" />'
      }
      if (fd.hint) html += '<div class="hintline">' + esc(fd.hint) + '</div>'
      html += '</label>'
    })
    html += '<div class="section-title">操作</div>' +
      '<div class="field-row"><button class="menu-btn" data-act="duplicate">复制节点</button>' +
      '<button class="menu-btn danger" data-act="remove">删除节点</button></div>'
    body.innerHTML = html

    body.querySelectorAll('[data-key]').forEach(function (input) {
      var handler = function () {
        var key = input.dataset.key
        var val
        if (input.hasAttribute('data-zen-switch')) val = window.ZenUI.switch.isOn(input)
        else if (input.type === 'checkbox') val = input.checked
        else if (input.type === 'range' || input.type === 'number') val = Number(input.value)
        else val = input.value
        var patch = {}
        patch[key] = val
        canvas.updateNode(id, { data: patch })
        var label = body.querySelector('[data-range-label="' + key + '"]')
        if (label) label.textContent = val
      }
      input.addEventListener(input.hasAttribute('data-zen-switch') ? 'click' :
        (input.type === 'range' ? 'input' : 'change'), handler)
    })
    var fileBtn = body.querySelector('[data-file-key]')
    if (fileBtn) {
      fileBtn.addEventListener('click', function () {
        pendingFileNode = id
        fileInput.value = ''
        fileInput.click()
      })
    }
    body.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.act === 'remove') canvas.removeNode(id)
        else if (btn.dataset.act === 'duplicate') {
          canvas.select(id)
          canvas.duplicate()
        }
      })
    })
  }

  // --------------------------------------------------------------------
  // 节点库
  // --------------------------------------------------------------------
  function renderPalette() {
    var host = $('palette-body')
    var groups = canvas.typesByCategory()
    var order = ['输入', '分析', '处理', '输出', '其它']
    var html = ''
    order.concat(Object.keys(groups).filter(function (g) { return order.indexOf(g) < 0 })).forEach(function (cat) {
      var items = groups[cat]
      if (!items || !items.length) return
      html += '<div class="group-title">' + esc(cat) + '</div>'
      items.forEach(function (def) {
        html += '<button class="palette-item" draggable="true" data-type="' + esc(def.key) + '" title="点击添加，或拖到画布指定位置">' +
          '<span class="pi-glyph">' + esc(def.glyph) + '</span>' +
          '<span>' + esc(def.label) + '<span class="pi-desc">' + esc(def.ports.indexOf('left') >= 0 ? '入 / 出' : '仅输出') + '</span></span></button>'
      })
    })
    host.innerHTML = html
    host.querySelectorAll('.palette-item').forEach(function (btn) {
      btn.addEventListener('click', function () { addAtCenter(btn.dataset.type) })
      btn.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/zen-node', btn.dataset.type)
        e.dataTransfer.effectAllowed = 'copy'
      })
    })
  }

  function addAtCenter(type) {
    ZenJob.addAtCenter({ canvas: canvas, host: 'canvas-host', type: type, label: DEFS[type].label, toast: toast })
  }

  // --------------------------------------------------------------------
  // 执行
  // --------------------------------------------------------------------
  function buildSpec() {
    var data = canvas.toJSON()
    return {
      format: 'omm-video-workflow',
      version: 1,
      nodes: data.nodes.map(function (n) {
        var params = Object.assign({}, n.data || {})
        delete params.id
        delete params.title
        delete params.w
        delete params.h
        delete params.locked
        delete params.minimized
        return { id: n.id, type: n.type, data: params }
      }),
      connections: data.connections.map(function (c) {
        return { from: c.from, to: c.to, fromPort: c.fromPort, toPort: c.toPort }
      }),
    }
  }

  // 产品业务规则；结构与坐标校验由 zen/canvas/engine.js 的 normalizeSpec 统一负责。
  var SPEC = {
    scope: 'video',
    format: 'omm-video-workflow',
    types: DEFS,
    acyclic: true,
    validate: function (nodes, connections) {
      function invalid(message) { throw new Error('工作流无效：' + message) }
      nodes.forEach(function (node) {
        var incoming = connections.filter(function (connection) { return connection.to === node.id })
        if (node.type === 'input') {
          if (incoming.length) invalid('input 节点不能有上游输入')
        } else if (node.type === 'probe') {
          if (incoming.length > 1) invalid('probe 节点最多接受一个上游输入')
        } else if (node.type === 'concat') {
          if (incoming.length < 2) invalid('concat 节点至少需要 2 个上游输入')
        } else if (incoming.length !== 1) {
          invalid('节点必须且只能有一个上游输入：' + node.id)
        }
      })
    },
  }

  function saveWorkflowFile() {
    ZenUtil.saveJSON('video-workflow.json', buildSpec())
    toast('已导出工作流 video-workflow.json')
  }

  // --------------------------------------------------------------------
  // AI 桥接（window.ZenVideoAI）
  // --------------------------------------------------------------------
  function _summary(type, data) {
    var def = DEFS[type]
    return def && def.summary ? def.summary(data || {}) : ''
  }
  function _meta(type, data) {
    var def = DEFS[type]
    return def && def.meta ? def.meta(data || {}) : ''
  }

  function snapshot() {
    if (!canvas) {
      return { version: 1, app: 'video', nodeCount: 0, connectionCount: 0, nodes: [], connections: [], output: [] }
    }
    var data = canvas.toJSON()
    return {
      version: 1,
      app: 'video',
      nodeCount: data.nodes.length,
      connectionCount: data.connections.length,
      nodes: data.nodes.map(function (n) {
        return { id: n.id, type: n.type, title: n.title || n.type, summary: _summary(n.type, n.data), data: n.data }
      }),
      connections: data.connections.map(function (c) {
        return { from: c.from, to: c.to, fromPort: c.fromPort, toPort: c.toPort }
      }),
      output: data.nodes.filter(function (n) { return n.type === 'export' }).map(function (n) { return n.data }),
    }
  }

  function snapshotMarkdown() {
    if (!canvas) return ''
    var data = canvas.toJSON()
    var idToType = {}
    data.nodes.forEach(function (n) { idToType[n.id] = n.type })
    var lines = ['视频工作台画布 · ' + data.nodes.length + ' 个节点 · ' + data.connections.length + ' 条连线']
    data.nodes.forEach(function (n) {
      var meta = _meta(n.type, n.data)
      lines.push('- ' + (n.title || n.type) + (meta ? '：' + meta : ''))
    })
    if (data.connections.length) {
      lines.push('连线：' + data.connections.map(function (c) {
        return (idToType[c.from] || '?') + ' → ' + (idToType[c.to] || '?')
      }).join(' · '))
    }
    return lines.join('\n')
  }

  window.ZenVideoAI = {
    snapshot: snapshot,
    snapshotMarkdown: snapshotMarkdown,
    workflowSpec: buildSpec,
    version: 1,
  }

  // --------------------------------------------------------------------
  // omm:zen-card-request — 仅响应共享助手确认的 parent source 与 origin
  // --------------------------------------------------------------------
  ;(function () {
    window.addEventListener('message', function (ev) {
      if (!ev.data || ev.data.type !== 'omm:zen-card-request') return
      if (!ZenUtil.isTrustedParentMessage(ev)) return
      var api = window.ZenVideoAI
      if (!api || !api.snapshotMarkdown) return
      var md = api.snapshotMarkdown()
      if (!md) return
      var card = {
        id: 'omm-video-workflow-' + Date.now().toString(36),
        kind: 'omm.video.workflow',
        content: md,
        source: 'omm-video',
        tags: ['视频工作流', 'AI工作区'],
      }
      try {
        window.parent.postMessage({ type: 'omm:zen-card-reply', token: ev.data.token, cards: [card] }, ev.origin)
      } catch (e) {}
    })
  })()

  // --------------------------------------------------------------------
  // 发送 AI 工作区（共享频道 documents → AI 插件；不可用时导出 workflow 文件）
  // --------------------------------------------------------------------
  function sendToAI() {
    var api = window.ZenVideoAI
    if (!api || !api.workflowSpec) { toast('AI 桥接未就绪'); return }
    var spec = api.workflowSpec()
    var title = '视频工作台 · ' + ((spec.nodes || []).length) + ' 节点'
    if (window.OMMShare && window.OMMShare.send) {
      return window.OMMShare.send({
        to: 'ai',
        channel: 'documents',
        format: 'omm.video.workflow',
        title: title,
        payload: { version: 1, title: title, canvas: api.snapshot(), workflow: spec },
      }).then(function (message) {
        if (!message) throw new Error('共享服务未确认投递')
        toast('工作流已发给 AI 工作区')
        if (window.OMMShare.openApp) window.OMMShare.openApp('ai')
      }).catch(function () {
        saveWorkflowFile()
      })
    } else {
      saveWorkflowFile()
    }
  }

  function apiGet(path) { return ZenJob.get(API, path) }
  function apiPost(path, body, raw) { return ZenJob.post(API, path, body, raw) }

  function uploadFile(file, nodeId) {
    var generation = ++uploadGeneration
    toast('正在上传 ' + file.name + ' …')
    apiPost('/api/upload?name=' + encodeURIComponent(file.name), file, true).then(function (res) {
      if (generation !== uploadGeneration) return
      var id = nodeId
      if (id && !canvas.getNode(id)) return
      if (!id) {
        var existing = canvas.getNodes().find(function (n) { return n.type === 'input' })
        id = existing ? existing.id : canvas.addNode('input', {}, { x: 140, y: 160 }).id
      }
      canvas.updateNode(id, { data: { fileId: res.fileId, filename: res.name } })
      toast('已导入 ' + res.name)
    }).catch(function (e) {
      if (generation === uploadGeneration) toast('上传失败：' + ZenJob.message(e, '未知错误'))
    })
  }

  function setRunning(running) {
    $('btn-run').disabled = running
    $('btn-stop').disabled = !running
    $('job-state').textContent = running ? '运行中' : '待命'
    if (!running) $('stat-progress').textContent = '进度：—'
  }

  function clearNodeStates() {
    canvas.getNodes().forEach(function (rec) {
      var el = canvas.getNodeElement(rec.id)
      if (!el) return
      delete el.dataset.state
      var badge = el.querySelector('[data-role="status"]')
      if (badge) { badge.textContent = ''; badge.className = 'zc-status' }
      var bar = el.querySelector('[data-role="progress"]')
      if (bar) {
        bar.classList.remove('active')
        if (bar.firstElementChild) bar.firstElementChild.style.width = '0%'
      }
      var result = el.querySelector('[data-role="result"]')
      if (result) result.textContent = ''
    })
  }

  function clearWorkflowState() {
    workflowRevision += 1
    clearNodeStates()
    $('result-body').innerHTML = '<div class="empty">工作流已变化，旧结果已清除。</div>'
    $('job-state').textContent = jobId ? '旧任务运行中' : '待命'
    if (!jobId) {
      $('stat-job').textContent = '任务：无'
      $('stat-progress').textContent = '进度：—'
    }
  }

  function run() {
    if (jobId || starting) { toast('任务正在运行'); return }
    var spec = buildSpec()
    if (!spec.nodes.length) { toast('画布是空的，请先添加节点'); return }
    if (!spec.nodes.some(function (n) { return n.type === 'input' && n.data.fileId }) &&
        !spec.nodes.some(function (n) { return n.type === 'probe' && n.data.fileId })) {
      toast('请先给“视频输入”节点选择文件'); return
    }
    var revision = workflowRevision
    starting = true
    $('btn-run').disabled = true
    apiPost('/api/run', spec).then(function (res) {
      starting = false
      jobId = res.jobId
      activeRevision = revision
      setRunning(true)
      $('stat-job').textContent = '任务：' + jobId
      ZenJob.poll(API, jobId, {
        onState: function (s) {
          if (jobId !== res.jobId || activeRevision !== workflowRevision) return
          Object.keys(s.nodes || {}).forEach(function (id) { applyNodeState(id, s.nodes[id]) })
          $('stat-progress').textContent = '进度：' + Math.round((s.progress || 0) * 100) + '%'
          $('job-state').textContent = '运行中'
          $('stat-job').textContent = '任务：' + jobId
        },
        onError: function () {
          if (jobId === res.jobId && activeRevision === workflowRevision) {
            $('job-state').textContent = '连接中断，正在重试'
          }
        },
        onFinish: function (s, error) {
          if (jobId !== res.jobId) return
          var stale = activeRevision !== workflowRevision
          jobId = null
          setRunning(false)
          $('stat-job').textContent = '任务：无'
          if (error) {
            $('job-state').textContent = '任务已回收'
            toast(ZenJob.message(error, '任务查询失败'))
            return
          }
          if (stale) {
            $('job-state').textContent = '工作流已变化'
            toast('工作流已变化，旧任务结果已忽略')
            return
          }
          renderResults(s)
          $('job-state').textContent = s.status === 'done' ? '完成' : s.status === 'cancelled' ? '已停止' : '失败'
          toast(s.status === 'done' ? '工作流执行完成' : '工作流结束：' + (s.error || s.status))
        },
      })
    }).catch(function (e) {
      starting = false
      $('btn-run').disabled = false
      toast('无法连接后端：' + ZenJob.message(e, '启动失败'))
    })
  }

  function stop() {
    return ZenJob.cancel(API, jobId, toast).catch(function (e) {
      toast('停止失败：' + ZenJob.message(e, '无法连接后端'))
    })
  }

  function applyNodeState(id, st) {
    var el = canvas.getNodeElement(id)
    if (!el) return
    el.dataset.state = st.status
    var badge = el.querySelector('[data-role="status"]')
    if (badge) {
      badge.textContent = st.status === 'running' ? Math.round((st.progress || 0) * 100) + '%' :
        st.status === 'done' ? '完成' : st.status === 'error' ? '失败' : st.status === 'cancelled' ? '已停止' : ''
      badge.className = 'zc-status' + (st.status ? ' is-' + st.status : '')
    }
    var bar = el.querySelector('[data-role="progress"]')
    if (bar) {
      bar.classList.toggle('active', st.status === 'running')
      bar.firstElementChild.style.width = Math.round((st.progress || 0) * 100) + '%'
    }
    var result = el.querySelector('[data-role="result"]')
    if (!result) return
    if (st.status === 'error') {
      result.innerHTML = '<span class="is-error">' + esc(st.error || '执行失败') + '</span>'
    } else if (st.status === 'done' || st.status === 'running') {
      var r = st.result || {}
      if (r.probe && r.probe.video) {
        result.textContent = fmtTime(r.probe.duration) + ' · ' + r.probe.video.width + '×' + r.probe.video.height + ' · ' + (r.probe.video.fps || '?') + 'fps'
      } else if (r.scenes) {
        result.textContent = '检测到 ' + r.scenes.length + ' 个场景切换：' + r.scenes.slice(0, 5).map(fmtTime).join(', ')
      } else if (r.silences) {
        result.textContent = r.silences.length + ' 段静音：' + r.silences.slice(0, 3).map(function (x) { return fmtTime(x.start) }).join(', ')
      } else if (r.black) {
        result.textContent = r.black.length + ' 段黑场'
      } else if (r.images && r.images.length) {
        result.innerHTML = '<div class="zv-thumbs">' + r.images.slice(0, 6).map(function (src) {
          return '<img src="' + esc(API + src) + '" alt="缩略图" />'
        }).join('') + '</div>'
      } else if (st.output) {
        result.innerHTML = '<a href="' + esc(API + st.output) + '" target="_blank" rel="noopener">打开产物 ↗</a>'
      }
    }
  }

  function renderResults(s) {
    var host = $('result-body')
    var html = ''
    var nodes = canvas.getNodes()
    var byId = {}
    nodes.forEach(function (n) { byId[n.id] = n })
    Object.keys(s.nodes || {}).forEach(function (id) {
      var st = s.nodes[id]
      if (st.status !== 'done' && st.status !== 'error') return
      var rec = byId[id]
      var label = rec ? (DEFS[rec.type] ? DEFS[rec.type].label : rec.type) : id
      html += '<div class="section-title result-section">' + esc(label) + '</div>'
      var r = st.result || {}
      if (r.probe) {
        html += '<div class="result-line">时长 ' + fmtTime(r.probe.duration) + '</div>'
        if (r.probe.video) html += '<div class="result-line">' + esc(r.probe.video.codec) + ' · ' + r.probe.video.width + '×' + r.probe.video.height + ' · ' + (r.probe.video.fps || '?') + ' fps</div>'
        if (r.probe.audio) html += '<div class="result-line">' + esc(r.probe.audio) + '</div>'
      }
      if (r.scenes) html += '<div class="result-line">场景切换 ' + r.scenes.length + ' 处：' + esc(r.scenes.slice(0, 12).map(fmtTime).join(' · ')) + '</div>'
      if (r.silences) html += '<div class="result-line">静音 ' + r.silences.length + ' 段：' + esc(r.silences.slice(0, 8).map(function (x) { return fmtTime(x.start) + '–' + fmtTime(x.end || 0) }).join(' · ')) + '</div>'
      if (r.black) html += '<div class="result-line">黑场 ' + r.black.length + ' 段</div>'
      if (r.images && r.images.length) {
        html += '<div class="mini-thumbs">' + r.images.map(function (src) {
          return '<img src="' + esc(API + src) + '" data-preview="' + esc(API + src) + '" alt="缩略图" />'
        }).join('') + '</div>'
      }
      if (st.output) {
        var isMedia = /\.(mp4|webm|mov|mkv|mp3|m4a|gif)$/i.test(st.output)
        html += '<div class="result-line"><a href="' + esc(API + st.output + '?download=1') + '" download>下载 ↧</a> ' +
          (isMedia ? '<a href="#" data-preview="' + esc(API + st.output) + '">预览 ↗</a>' : '') + '</div>'
      }
      if (st.error) html += '<div class="result-line is-error">' + esc(st.error) + '</div>'
      if (st.status === 'error' && st.log) html += '<div class="logbox">' + esc(st.log.slice(-700)) + '</div>'
    })
    host.innerHTML = html || '<div class="empty">没有产生可展示的结果。</div>'
    host.querySelectorAll('[data-preview]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault()
        openPreview(el.dataset.preview)
      })
    })
  }

  function openPreview(src) {
    var media = ''
    if (/\.(mp4|webm|mov|mkv)$/i.test(src)) {
      media = '<video src="' + esc(src) + '" controls autoplay></video>'
    } else if (/\.(mp3|m4a|wav)$/i.test(src)) {
      media = '<audio src="' + esc(src) + '" controls></audio>'
    } else {
      media = '<img src="' + esc(src) + '" alt="预览" />'
    }
    window.ZenUI.modal.open({
      title: '预览',
      html: '<div class="zv-preview">' + media + '</div>',
      foot: '<button class="menu-btn" id="preview-close">关闭</button>',
      onMount: function (body, foot) {
        foot.querySelector('#preview-close').addEventListener('click', function () {
          window.ZenUI.modal.close()
        })
      },
    })
  }

  // --------------------------------------------------------------------
  // 示例工作流（开箱即用）
  // --------------------------------------------------------------------
  var TEMPLATES = {
    '基础剪辑': [
      { type: 'input', x: 80, y: 140 },
      { type: 'trim', x: 400, y: 140 },
      { type: 'format', x: 720, y: 140 },
      { type: 'export', x: 1040, y: 140 },
    ],
    '媒体分析': [
      { type: 'input', x: 80, y: 260 },
      { type: 'probe', x: 400, y: 60 },
      { type: 'scene', x: 400, y: 220 },
      { type: 'silence', x: 400, y: 380 },
      { type: 'thumbnail', x: 720, y: 300 },
    ],
    '缩略图与 GIF': [
      { type: 'input', x: 80, y: 160 },
      { type: 'trim', x: 380, y: 160 },
      { type: 'thumbnail', x: 680, y: 60 },
      { type: 'format', x: 680, y: 320 },
      { type: 'export', x: 1000, y: 320 },
    ],
  }

  function applyTemplate(name) {
    var list = TEMPLATES[name]
    if (!list) return
    canvas.clear()
    var ids = []
    list.forEach(function (item) {
      var rec = canvas.addNode(item.type, {}, { x: item.x, y: item.y }, { change: false })
      ids.push(rec.id)
    })
    // 按模板顺序连接：输入 -> 各处理节点 -> 导出；分析模板从输入扇出
    if (name === '媒体分析') {
      for (var i = 1; i < ids.length; i++) canvas.addConnection(ids[0], ids[i])
    } else {
      for (var j = 1; j < ids.length; j++) canvas.addConnection(ids[j - 1], ids[j])
    }
    canvas.fitView()
    canvas._changed()
    toast('已载入“' + name + '”工作流')
  }

  // --------------------------------------------------------------------
  // 初始化
  // --------------------------------------------------------------------
  function init() {
    var nodeTypes = {}
    Object.keys(DEFS).forEach(function (key) {
      var def = DEFS[key]
      nodeTypes[key] = {
        label: def.label,
        category: def.category,
        glyph: def.glyph,
        ports: def.ports,
        w: def.w,
        h: def.h,
        defaults: def.defaults,
        render: function (data, host, api) { renderBody(def, data, host, api) },
        summary: def.summary,
      }
    })

    canvas = ZenCanvas.create({
      mount: $('canvas-host'),
      scope: 'video',
      notify: toast,
      nodeTypes: nodeTypes,
      storage: {
        save: function (data) {
          try { localStorage.setItem('zen.video.canvas.v1', JSON.stringify(data)) } catch (_) {}
        },
      },
      onSelectionChange: function (ids) {
        selectedId = ids.length === 1 ? ids[0] : null
        renderInspector()
      },
      onContextMenu: function (e, ctx) {
        var self = canvas
        var items = []
        if (ctx.node) {
          items.push({ label: '复制节点', hint: 'Ctrl+D', action: function () { self.select(ctx.node.id); self.duplicate() } })
          items.push({ label: '删除节点', hint: 'Del', danger: true, action: function () { self.removeNode(ctx.node.id) } })
          items.push({ separator: true })
        }
        items.push({ label: '粘贴到此处', action: function () { self.paste(self.screenToWorld(e.clientX, e.clientY)) } })
        items.push({ label: '全选', hint: 'Ctrl+A', action: function () { self.selectAll() } })
        items.push({ label: '自动排布', hint: 'L', action: function () { self.autoLayout($('strategy').value) } })
        items.push({ label: '适应视野', hint: 'F', action: function () { self.fitView() } })
        return items
      },
    })

    renderPalette()
    renderInspector()

    // 画布拖放添加节点
    var host = $('canvas-host')
    host.addEventListener('dragover', function (e) {
      if (e.dataTransfer.types.indexOf('text/zen-node') >= 0) e.preventDefault()
    })
    host.addEventListener('drop', function (e) {
      var type = e.dataTransfer.getData('text/zen-node')
      if (!type || !DEFS[type]) return
      e.preventDefault()
      var w = canvas.screenToWorld(e.clientX, e.clientY)
      canvas.addNode(type, {}, { x: w.x - 120, y: w.y - 40 })
    })

    // 载入上次画布，否则给一个可直接运行的示例
    var saved = null
    try { saved = JSON.parse(localStorage.getItem('zen.video.canvas.v1') || 'null') } catch (_) {}
    try {
      if (saved && saved.nodes && saved.nodes.length) canvas.fromJSON(ZenCanvas.normalizeSpec(saved, SPEC), { history: false })
      else applyTemplate('基础剪辑')
    } catch (err) {
      applyTemplate('基础剪辑')
      toast('已忽略无效的本地工作流')
    }

    // 工具栏
    $('btn-run').addEventListener('click', run)
    $('btn-stop').addEventListener('click', stop)
    $('btn-layout').addEventListener('click', function () { canvas.autoLayout($('strategy').value) })
    $('btn-fit').addEventListener('click', function () { canvas.fitView() })
    $('btn-clear').addEventListener('click', function () {
      window.ZenUI.dialog.confirm('清空画布？此操作可撤销（Ctrl+Z）。').then(function (ok) {
        if (!ok) return
        canvas.clear()
      })
    })
    $('btn-upload').addEventListener('click', function () { pendingFileNode = null; fileInput.value = ''; fileInput.click() })
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) uploadFile(fileInput.files[0], pendingFileNode)
    })
    $('btn-template').addEventListener('click', function () {
      var names = Object.keys(TEMPLATES)
      window.ZenUI.dialog.prompt('选择示例工作流：\n' + names.map(function (n, i) { return (i + 1) + '. ' + n }).join('\n'), '1').then(function (pick) {
        var idx = parseInt(pick, 10) - 1
        if (idx >= 0 && idx < names.length) applyTemplate(names[idx])
      })
    })
    $('btn-save').addEventListener('click', saveWorkflowFile)
    $('btn-ai').addEventListener('click', sendToAI)
    $('btn-open').addEventListener('click', function () {
      var inp = document.createElement('input')
      inp.type = 'file'
      inp.accept = '.json'
      inp.onchange = function () {
        var f = inp.files[0]
        if (!f) return
        var reader = new FileReader()
        reader.onload = function () {
          try { canvas.fromJSON(ZenCanvas.normalizeSpec(JSON.parse(reader.result), SPEC), { history: false }); toast('工作流已载入') }
          catch (err) { toast('文件解析失败：' + err.message) }
        }
        reader.readAsText(f)
      }
      inp.click()
    })
    $('btn-theme').addEventListener('click', function () {
      document.body.classList.toggle('theme-dark')
      localStorage.setItem('zen.theme', document.body.classList.contains('theme-dark') ? 'dark' : 'light')
    })
    if (localStorage.getItem('zen.theme') === 'dark') document.body.classList.add('theme-dark')

    $('btn-help').addEventListener('click', function () {
      window.ZenUI.dialog.alert(
        '1. 从左侧点选节点（或拖到画布）\n' +
        '2. 从节点右侧圆点拖到下一个节点左侧圆点，串成工作流\n' +
        '3. 选中节点，在右侧设置参数（都有默认值）\n' +
        '4. 给“视频输入”导入文件，点“运行”\n\n' +
        '分析节点（媒体信息/场景/静音/黑场/缩略图）不改视频内容，可并联在输入之后。\n' +
        '所有处理都基于内置 ffmpeg，无需额外安装。',
        { title: '使用说明' }
      )
    })

    // 后端与 ffmpeg 状态
    apiGet('/api/status').then(function (s) {
      var b = s.runtime && s.runtime.bundled
      $('runtime-badge').textContent = 'ffmpeg ' + (b ? '内置' : '系统') + ' ✓'
      $('stat-runtime').textContent = (b ? '内置 ffmpeg · ' : '系统 ffmpeg · ') + (s.runtime.version || '').slice(0, 42)
    }).catch(function () {
      $('runtime-badge').textContent = '后端未连接'
      $('stat-runtime').textContent = '请通过工作台启动视频产品'
    })

    canvas.bus.on('change', function () {
      $('stat-nodes').textContent = '节点 ' + canvas.state.nodes.length + ' · 连线 ' + canvas.state.connections.length
      clearWorkflowState()
    })
    $('stat-nodes').textContent = '节点 ' + canvas.state.nodes.length + ' · 连线 ' + canvas.state.connections.length
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
