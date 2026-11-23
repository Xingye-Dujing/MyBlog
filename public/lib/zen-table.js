/* zen-table.js — 表格自动化工作台的产品层。
 *
 * 本文件只做三件事：
 *   1. 用 ZenCanvas.registerNodeType 声明业务节点（字段 + 默认值 + 正文）；
 *   2. 把画布图编译成 omm-table-workflow JSON，调用后端并轮询任务；
 *   3. 渲染节点库 / 检查器 / 数据预览 / 结果面板。
 * 画布的拖拽、连线、缩放、框选、撤销与自动布局全部来自 zen/canvas/。
 */
(function () {
  'use strict'

  var API = ''
  var canvas = null
  var jobId = null
  var pollTimer = null
  var selectedId = null
  var bookMeta = null
  var lastResult = null
  var fileInput = document.getElementById('file-input')
  var pendingFileNode = null
  var activeTab = 'params'
  var rangeTarget = null
  var dragging = null

  function $(id) { return document.getElementById(id) }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function toast(msg) { return window.ZenUI.toast(msg) }
  function f(key, label, type, extra) {
    return Object.assign({ key: key, label: label, type: type || 'text' }, extra || {})
  }
  function colLetter(n) {
    var s = ''
    n = Math.max(1, Number(n) || 1)
    while (n > 0) { n--; s = String.fromCharCode(65 + n % 26) + s; n = Math.floor(n / 26) }
    return s
  }
  function colNumber(s) {
    var n = 0
    String(s || '').toUpperCase().replace(/[^A-Z]/g, '').split('').forEach(function (c) {
      n = n * 26 + (c.charCodeAt(0) - 64)
    })
    return n || 1
  }
  function shortText(v, max) {
    var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
    return s.length > (max || 22) ? s.slice(0, max || 22) + '…' : s
  }

  // ----------------------------------------------------------------------
  // 预设
  // ----------------------------------------------------------------------
  var FEE_LOOKUP = [
    { min: '', max: '18:55', result: 0 },
    { min: '18:56', max: '19:24', result: 1 },
    { min: '19:25', max: '19:54', result: 1.5 },
    { min: '19:55', max: '20:24', result: 2 },
    { min: '20:25', max: '20:54', result: 2.5 },
    { min: '20:55', max: '', result: 3 },
  ]
  var OPS = [
    ['copy', '原样复制'], ['lastTimeLookup', '取最后时间→查表分档'],
    ['lookup', '查表映射'], ['number', '转成数字'], ['multiply', '乘以另一列 / 常数'],
    ['text', '文本处理'], ['condition', '条件判断'], ['formula', '安全表达式'],
    ['lastTime', '只提取最后时间'],
  ]

  // ----------------------------------------------------------------------
  // 节点定义
  // ----------------------------------------------------------------------
  var DEFS = {
    file: {
      label: 'Excel 文件与区域', category: '输入', glyph: '入', ports: ['right'], kind: 'k-in', w: 252, h: 138,
      defaults: {
        fileId: '', filename: '', sheetMode: 'one', sheet: '', selected: [],
        rangeMode: 'auto', startCell: 'A1', endCell: '', headerRow: 0, overrides: [],
      },
      fields: [
        f('file', 'Excel 文件', 'file', { hint: '支持 .xlsx / .xlsm；上传后自动识别工作表和真实数据范围。' }),
        f('sheetMode', '工作表范围', 'select', {
          options: [['one', '单个工作表'], ['all', '全部工作表'], ['selected', '勾选工作表']],
        }),
        f('sheet', '工作表', 'sheets', { when: { sheetMode: 'one' } }),
        f('selected', '勾选工作表', 'sheetsMulti', { when: { sheetMode: 'selected' } }),
        f('rangeMode', '区域模式', 'select', {
          options: [['auto', '自动识别（推荐）'], ['manual', '手动指定区域']],
        }),
        f('startCell', '起始单元格', 'text', { hint: '例如 C6；自动模式下从此处读到真实末尾。' }),
        f('endCell', '结束单元格', 'text', { when: { rangeMode: 'manual' }, hint: '例如 AG90' }),
        f('headerRow', '表头所在行', 'number', { min: 0, max: 100, hint: '0 = 没有表头' }),
        f('overrides', '按工作表覆盖', 'table', {
          hint: '可选：为个别工作表单独指定起点、终点与表头行。',
          columns: [
            { key: 'sheet', label: '工作表' }, { key: 'startCell', label: '起点' },
            { key: 'endCell', label: '终点' }, { key: 'headerRow', label: '表头行' },
          ],
        }),
      ],
      summary: function (d) { return d.filename || '未选择 Excel 文件' },
      meta: function (d) { return (d.sheetMode === 'all' ? '全部工作表' : d.sheet || '未选工作表') + ' · ' + (d.rangeMode === 'auto' ? '自动区域' : (d.startCell + ':' + d.endCell)) },
    },
    mapCells: {
      label: '逐格计算', category: '计算', glyph: '格', ports: ['left', 'right'], kind: 'k-calc', w: 256, h: 152,
      defaults: {
        columns: 'C:AG', step: 1, op: 'copy', lookupKind: 'time', lookup: [], defaultResult: 0,
        factor: { mode: 'column', column: 'C', value: 1 }, zeroOnInvalid: true,
        textOp: 'trim', textN: 1, textStart: 0, textOld: '', textNew: '', pattern: '', group: 0,
        prefix: '', suffix: '', condition: { logic: 'and', rules: [], then: 1, else: 0 },
        expression: '', target: 'same', targetOffset: 0, sourceSkipEmpty: true,
      },
      fields: [
        f('columns', '列范围', 'text', { hint: '例如 C:AG；会逐行逐列对每一格执行同一规则。' }),
        f('step', '列步长', 'number', { min: 1, max: 100 }),
        f('op', '计算方式', 'select', { options: OPS }),
        f('lookupKind', '查表类型', 'select', {
          options: [['time', '时间区间'], ['numeric', '数值区间'], ['exact', '精确匹配']],
          when: { op: ['lastTimeLookup', 'lookup'] },
        }),
        f('lookup', '分档 / 映射表', 'lookup', { when: { op: ['lastTimeLookup', 'lookup'] } }),
        f('defaultResult', '未命中时的值', 'number', { when: { op: ['lastTimeLookup', 'lookup'] } }),
        f('factor', '乘数来源', 'factor', { when: { op: 'multiply' } }),
        f('zeroOnInvalid', '空值/非法值按 0 处理', 'checkbox', { when: { op: ['multiply', 'number'] } }),
        f('textOp', '文本操作', 'select', {
          options: [['trim', '去首尾空格'], ['upper', '转大写'], ['lower', '转小写'],
            ['left', '取左边 N 字'], ['right', '取右边 N 字'], ['mid', '中间截取'],
            ['replace', '替换'], ['regex', '正则提取']], when: { op: 'text' },
        }),
        f('textN', '截取长度 N', 'number', { when: { op: 'text', textOp: ['left', 'right', 'mid'] } }),
        f('textStart', '起始位置', 'number', { when: { op: 'text', textOp: 'mid' } }),
        f('textOld', '被替换文本', 'text', { when: { op: 'text', textOp: 'replace' } }),
        f('textNew', '替换为', 'text', { when: { op: 'text', textOp: 'replace' } }),
        f('pattern', '正则表达式', 'text', { when: { op: 'text', textOp: 'regex' } }),
        f('condition', '条件', 'condition', { when: { op: 'condition' } }),
        f('expression', '表达式', 'expr', { when: { op: 'formula' } }),
        f('target', '结果写到', 'select', {
          options: [['same', '原列'], ['offset', '偏移列'], ['new', '新列（改名）']],
        }),
        f('targetOffset', '偏移列数', 'number', { when: { target: 'offset' } }),
        f('sourceSkipEmpty', '跳过空白源单元格', 'checkbox'),
      ],
      summary: function (d) {
        var op = (OPS.filter(function (x) { return x[0] === d.op })[0] || [d.op, d.op])[1]
        return d.columns + ' · ' + op
      },
      meta: function (d) { return '逐格映射 · 步长 ' + (d.step || 1) },
    },
    mapColumns: {
      label: '逐列批量计算', category: '计算', glyph: '列', ports: ['left', 'right'], kind: 'k-calc', w: 256, h: 156,
      defaults: {
        targetColumns: 'E:CG', step: 2, sourceMode: 'left', sourceOffset: -1,
        sourceColumn: '', sourceHeader: '', op: 'multiply', lookupKind: 'numeric', lookup: [],
        defaultResult: 0, factor: { mode: 'column', column: 'C', value: 1 }, zeroOnInvalid: true,
        textOp: 'trim', textN: 1, textStart: 0, textOld: '', textNew: '', pattern: '', group: 0,
        prefix: '', suffix: '', condition: { logic: 'and', rules: [], then: 1, else: 0 },
        expression: '', sourceSkipEmpty: false,
      },
      fields: [
        f('targetColumns', '目标列范围', 'text', { hint: '例如 E:CG；每隔一列时可把步长设为 2。' }),
        f('step', '列步长', 'number', { min: 1, max: 100 }),
        f('sourceMode', '源列取自', 'select', {
          options: [['left', '目标列左移 N 列'], ['same', '同一列'], ['fixed', '指定列'], ['header', '按表头名称']],
        }),
        f('sourceOffset', '左移列数', 'number', { when: { sourceMode: 'left' } }),
        f('sourceColumn', '指定源列', 'text', { when: { sourceMode: 'fixed' } }),
        f('sourceHeader', '表头名称', 'text', { when: { sourceMode: 'header' } }),
        f('op', '计算方式', 'select', { options: OPS }),
        f('lookupKind', '查表类型', 'select', {
          options: [['numeric', '数值区间'], ['time', '时间区间'], ['exact', '精确匹配']],
          when: { op: ['lastTimeLookup', 'lookup'] },
        }),
        f('lookup', '映射表', 'lookup', { when: { op: ['lastTimeLookup', 'lookup'] } }),
        f('defaultResult', '未命中时的值', 'number', { when: { op: ['lastTimeLookup', 'lookup'] } }),
        f('factor', '乘数来源', 'factor', { when: { op: 'multiply' } }),
        f('zeroOnInvalid', '空值/非法值按 0 处理', 'checkbox', { when: { op: ['multiply', 'number'] } }),
        f('textOp', '文本操作', 'select', {
          options: [['trim', '去空格'], ['upper', '大写'], ['lower', '小写'], ['left', '左截取'],
            ['right', '右截取'], ['mid', '中间截取'], ['replace', '替换'], ['regex', '正则提取']],
          when: { op: 'text' },
        }),
        f('textN', '截取长度 N', 'number', { when: { op: 'text', textOp: ['left', 'right', 'mid'] } }),
        f('textStart', '起始位置', 'number', { when: { op: 'text', textOp: 'mid' } }),
        f('textOld', '被替换文本', 'text', { when: { op: 'text', textOp: 'replace' } }),
        f('textNew', '替换为', 'text', { when: { op: 'text', textOp: 'replace' } }),
        f('pattern', '正则表达式', 'text', { when: { op: 'text', textOp: 'regex' } }),
        f('condition', '条件', 'condition', { when: { op: 'condition' } }),
        f('expression', '表达式', 'expr', { when: { op: 'formula' } }),
        f('sourceSkipEmpty', '跳过空白源单元格', 'checkbox'),
      ],
      summary: function (d) { return d.targetColumns + ' · 源' + (d.sourceMode === 'left' ? (d.sourceOffset || -1) : d.sourceMode) },
      meta: function (d) { return '逐列计算 · 步长 ' + (d.step || 1) + ' · ' + (d.op || '') },
    },
    formula: {
      label: '计算列', category: '计算', glyph: '式', ports: ['left', 'right'], kind: 'k-calc', w: 250, h: 126,
      defaults: { outputColumn: 'AL', expression: '[D] * [C]' },
      fields: [
        f('outputColumn', '输出列名', 'text', { hint: '写回到这个列，例如 AL' }),
        f('expression', '表达式', 'expr', {
          hint: '用 [列字母] 引用本行单元格，例如 [D]*[C] 或 IF([E]>0,[E],0)',
        }),
      ],
      summary: function (d) { return (d.outputColumn || '?') + ' = ' + shortText(d.expression, 20) },
      meta: function () { return '安全表达式 · 支持 IF / ROUND / REGEX 等' },
    },
    filter: {
      label: '筛选行', category: '整理', glyph: '筛', ports: ['left', 'right'], kind: 'k-shape', w: 250, h: 126,
      defaults: { logic: 'and', rules: [], keep: true },
      fields: [
        f('logic', '条件关系', 'select', { options: [['and', '同时满足'], ['or', '满足任一']] }),
        f('rules', '筛选条件', 'rules'),
        f('keep', '保留满足条件的行', 'checkbox'),
      ],
      summary: function (d) { return (d.rules || []).length + ' 个条件 · ' + (d.logic === 'or' ? '任一' : '全部') },
      meta: function () { return '按行筛选，不改变列' },
    },
    sort: {
      label: '排序', category: '整理', glyph: '序', ports: ['left', 'right'], kind: 'k-shape', w: 242, h: 120,
      defaults: { keys: [{ column: 'A', dir: 'asc' }] },
      fields: [f('keys', '排序键', 'sortkeys')],
      summary: function (d) { return (d.keys || []).map(function (k) { return k.column + (k.dir === 'desc' ? '↓' : '↑') }).join(' · ') },
      meta: function () { return '多列稳定排序' },
    },
    dedupe: {
      label: '去重', category: '整理', glyph: '重', ports: ['left', 'right'], kind: 'k-shape', w: 232, h: 110,
      defaults: { columns: 'A', keep: 'first' },
      fields: [
        f('columns', '按哪些列判断', 'text'),
        f('keep', '保留', 'select', { options: [['first', '第一条'], ['last', '最后一条']] }),
      ],
      summary: function (d) { return '按 ' + (d.columns || '?') + ' 去重' },
      meta: function () { return '保留首条或末条' },
    },
    join: {
      label: '两表连接', category: '整理', glyph: '连', ports: ['left', 'top', 'right'], kind: 'k-shape', w: 254, h: 132,
      defaults: { leftKey: 'A', rightKey: 'A', mode: 'left', prefix: 'R_' },
      fields: [
        f('leftKey', '主表连接列', 'text'),
        f('rightKey', '副表连接列', 'text'),
        f('mode', '连接方式', 'select', { options: [['left', '左连接（保留主表全部）'], ['inner', '内连接（只保留匹配）']] }),
        f('prefix', '副表列前缀', 'text'),
      ],
      summary: function (d) { return d.leftKey + ' = ' + d.rightKey },
      meta: function () { return '主表接左侧 · 副表接上方端口' },
    },
    aggregate: {
      label: '分组汇总', category: '汇总', glyph: '汇', ports: ['left', 'right'], kind: 'k-summary', w: 254, h: 134,
      defaults: {
        mode: 'columns', valueColumns: 'E:CG', step: 2, agg: 'sum', groupBy: 'A',
        nameKey: '姓名', sheetKey: '__sheet', totalKey: '合计', nameColumnOffset: -1,
      },
      fields: [
        f('mode', '汇总方式', 'select', {
          options: [['columns', '按列汇总（姓名在表头行）'], ['rows', '按行分组汇总']],
        }),
        f('valueColumns', '值列范围', 'text'),
        f('step', '列步长', 'number', { min: 1 }),
        f('agg', '聚合函数', 'select', {
          options: [['sum', '求和'], ['avg', '平均'], ['count', '计数'], ['min', '最小'], ['max', '最大']],
        }),
        f('nameKey', '名称字段名', 'text', { when: { mode: 'columns' } }),
        f('sheetKey', '工作表字段名', 'text', { when: { mode: 'columns' } }),
        f('totalKey', '结果字段名', 'text', { when: { mode: 'columns' } }),
        f('nameColumnOffset', '名称列偏移', 'number', {
          when: { mode: 'columns' }, hint: '-1 表示用结果列左边一列的表头作为名称',
        }),
        f('groupBy', '分组列', 'text', { when: { mode: 'rows' } }),
      ],
      summary: function (d) { return d.valueColumns + ' · ' + (d.agg === 'sum' ? '求和' : d.agg) },
      meta: function (d) { return d.mode === 'columns' ? '按列汇总（适合工资汇总）' : '按行分组' },
    },
    pivot: {
      label: '交叉汇总', category: '汇总', glyph: '叉', ports: ['left', 'right'], kind: 'k-summary', w: 250, h: 132,
      defaults: {
        rowKeys: ['姓名'], colKey: '__sheet', valueKey: '合计', agg: 'sum',
        rowTotals: true, colTotals: true, totalLabel: '合计',
      },
      fields: [
        f('rowKeys', '行字段（逗号分隔）', 'text'),
        f('colKey', '列字段', 'text'),
        f('valueKey', '值字段', 'text'),
        f('rowTotals', '生成行合计', 'checkbox'),
        f('colTotals', '生成合计行', 'checkbox'),
        f('totalLabel', '合计标签', 'text'),
      ],
      summary: function (d) { return (d.rowKeys || []).join(',') + ' × ' + d.colKey },
      meta: function () { return '行转列 · 可带行列合计' },
    },
    write: {
      label: '写回单元格', category: '输出', glyph: '写', ports: ['left', 'right'], kind: 'k-out', w: 256, h: 148,
      defaults: {
        columns: 'C:AG', rowMode: 'same', offset: 0, conflict: 'skip', style: 'asc',
        skipEmpty: true, skipZero: false,
      },
      fields: [
        f('columns', '写入列范围', 'text'),
        f('rowMode', '目标行', 'rowMode'),
        f('offset', '行偏移量', 'number', { when: { rowMode: 'offset' } }),
        f('conflict', '已有值处理', 'select', {
          options: [['skip', '跳过非空（安全）'], ['overwrite', '覆盖已有值'], ['error', '遇到非空则中止']],
        }),
        f('style', '写入样式', 'select', {
          options: [['asc', '统一边框/居中（原 ASC 风格）'], ['inherit', '沿用源单元格样式'], ['keep', '只写值']],
        }),
        f('skipEmpty', '跳过空结果', 'checkbox'),
        f('skipZero', '跳过 0', 'checkbox'),
      ],
      summary: function (d) {
        var modes = { same: '原行', next: '下一行', insertBelow: '下方插入空行', offset: '偏移行' }
        return d.columns + ' → ' + (modes[d.rowMode] || d.rowMode)
      },
      meta: function (d) { return '冲突：' + (d.conflict === 'skip' ? '跳过' : d.conflict) + ' · 样式：' + d.style },
    },
    writeFormula: {
      label: '写公式', category: '输出', glyph: '∑', ports: ['left', 'right'], kind: 'k-out', w: 252, h: 140,
      defaults: {
        kind: 'rowSum', columns: 'C:AG', targetColumn: 'AH', rowMode: 'same', offset: 0,
        sumRow: 'auto', conflict: 'skip', style: 'asc',
      },
      fields: [
        f('kind', '公式类型', 'select', { options: [['rowSum', '行内合计（横向 SUM）'], ['colSum', '列合计（纵向 SUM）']] }),
        f('columns', '求和列范围', 'text'),
        f('targetColumn', '结果列', 'text', { when: { kind: 'rowSum' } }),
        f('rowMode', '结果行', 'rowMode', { when: { kind: 'rowSum' } }),
        f('offset', '行偏移量', 'number', { when: { kind: 'rowSum', rowMode: 'offset' } }),
        f('sumRow', '求和行', 'text', {
          when: { kind: 'colSum' }, hint: 'auto = 每个工作表数据末行的下一行',
        }),
        f('conflict', '已有值处理', 'select', {
          options: [['skip', '跳过非空'], ['overwrite', '覆盖'], ['error', '中止']],
        }),
        f('style', '写入样式', 'select', {
          options: [['asc', '统一边框/居中'], ['inherit', '沿用样式'], ['keep', '只写值']],
        }),
      ],
      summary: function (d) {
        return d.kind === 'colSum' ? (d.columns + ' 列合计') : (d.columns + ' → ' + d.targetColumn)
      },
      meta: function () { return '写入 =SUM(...) 公式' },
    },
    exportTable: {
      label: '导出汇总表', category: '输出', glyph: '表', ports: ['left', 'right'], kind: 'k-out', w: 250, h: 130,
      defaults: {
        filename: '汇总表.xlsx', sheetName: '汇总', title: '', header: true, totals: true, style: 'asc',
      },
      fields: [
        f('filename', '文件名', 'text'),
        f('sheetName', '工作表名', 'text'),
        f('title', '标题', 'text', { hint: '留空则不写标题行' }),
        f('header', '写表头', 'checkbox'),
        f('totals', '合计行加粗', 'checkbox'),
      ],
      summary: function (d) { return d.filename || '汇总表.xlsx' },
      meta: function (d) { return d.title ? ('标题：' + d.title) : '独立 xlsx 文件' },
    },
    save: {
      label: '保存工作簿', category: '输出', glyph: '存', ports: ['left'], kind: 'k-out', w: 238, h: 112,
      defaults: { filename: '结果文件.xlsx' },
      fields: [f('filename', '结果文件名', 'text', { hint: '产物在工作台右侧可下载。' })],
      summary: function (d) { return d.filename || '结果文件.xlsx' },
      meta: function () { return '终点节点 · 统一执行写计划' },
    },
    preview: {
      label: '节点预览', category: '辅助', glyph: '看', ports: ['left', 'right'], kind: '', w: 230, h: 104,
      defaults: { rows: 20 },
      fields: [f('rows', '预览行数', 'number', { min: 1, max: 200 })],
      summary: function (d) { return '显示前 ' + (d.rows || 20) + ' 行' },
      meta: function () { return '不写文件，仅查看数据' },
    },
    note: {
      label: '注释', category: '辅助', glyph: '注', ports: [], kind: '', w: 230, h: 106,
      defaults: { text: '说明这一步做什么' },
      fields: [f('text', '文字', 'text')],
      summary: function (d) { return shortText(d.text, 24) },
      meta: function () { return '仅画布说明' },
    },
  }

  var FIELD_OPTIONS = {
    rowMode: [['same', '原行写入'], ['next', '下一行（不插行）'], ['insertBelow', '每行下方插入空行'], ['offset', '偏移 N 行']],
  }

  // ----------------------------------------------------------------------
  // 节点正文
  // ----------------------------------------------------------------------
  function renderBody(def, data, host) {
    host.innerHTML =
      '<div class="zt-kind ' + (def.kind || '') + '"><i></i>' + esc(def.category) + ' · ' + esc(def.label) + '</div>' +
      '<div class="zt-summary" data-role="summary"></div>' +
      '<div class="zt-meta" data-role="meta"></div>' +
      '<div class="zt-progress" data-role="progress"><i></i></div>' +
      '<div class="zt-result" data-role="result"></div>'
    host.querySelector('[data-role="summary"]').textContent = def.summary ? def.summary(data) : ''
    host.querySelector('[data-role="meta"]').textContent = def.meta ? def.meta(data) : ''
  }

  // ----------------------------------------------------------------------
  // 检查器
  // ----------------------------------------------------------------------
  function visibleField(fd, data) {
    if (!fd.when) return true
    var keys = Object.keys(fd.when)
    for (var i = 0; i < keys.length; i++) {
      var allow = fd.when[keys[i]]
      var actual = String(data[keys[i]] == null ? '' : data[keys[i]])
      if (Array.isArray(allow)) {
        if (allow.map(String).indexOf(actual) < 0) return false
      } else if (String(allow) !== actual) return false
    }
    return true
  }

  function optionsOf(fd) {
    if (FIELD_OPTIONS[fd.key]) return FIELD_OPTIONS[fd.key]
    return fd.options || []
  }

  function optionLabel(opt) {
    return Array.isArray(opt) ? opt[1] : String(opt)
  }
  function optionValue(opt) {
    return Array.isArray(opt) ? String(opt[0]) : String(opt)
  }

  function renderInspector() {
    var body = $('inspector-body')
    var id = selectedId
    var rec = id && canvas ? canvas.getNode(id) : null
    if (!rec) {
      $('inspect-kind').textContent = '未选中'
      body.innerHTML = '<div class="empty">选中节点后在这里设置参数。<br />所有参数都有默认值。</div>'
      return
    }
    var def = DEFS[rec.type]
    $('inspect-kind').textContent = def ? def.label : rec.type
    var tabs = '<div class="tabs-row">' +
      '<button data-tab="params" class="' + (activeTab === 'params' ? 'active' : '') + '">参数</button>' +
      '<button data-tab="data" class="' + (activeTab === 'data' ? 'active' : '') + '">数据预览</button></div>'
    if (activeTab === 'data') {
      body.innerHTML = tabs + '<div id="inspector-data"></div>'
      renderInspectorData(rec)
      bindTabs()
      return
    }
    var html = tabs + '<h3 class="title">' + esc(def ? def.label : rec.type) + '</h3>' +
      '<div class="node-id">' + esc(rec.id) + ' · ' + esc(def ? def.category : '') + '</div>'
    var fields = (def && def.fields) || []
    if (!fields.length) html += '<div class="hintline">这个节点无需额外设置。</div>'
    fields.forEach(function (fd) {
      if (!visibleField(fd, rec.data)) return
      html += renderField(fd, rec)
    })
    html += '<div class="section-title">操作</div>' +
      '<div class="field-row"><button class="menu-btn" data-act="duplicate">复制节点</button>' +
      '<button class="menu-btn danger" data-act="remove">删除节点</button>' +
      '<button class="menu-btn" data-act="preview">试算到此</button></div>'
    body.innerHTML = html
    bindFields(rec)
    bindTabs()
  }

  function bindTabs() {
    $('inspector-body').querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () { activeTab = btn.dataset.tab; renderInspector() })
    })
  }

  function renderField(fd, rec) {
    var value = rec.data[fd.key]
    var html = '<label class="field"><span>' + esc(fd.label) + '</span>'
    if (fd.type === 'select') {
      html += '<select data-zen-select data-key="' + esc(fd.key) + '">'
      optionsOf(fd).forEach(function (opt) {
        html += '<option value="' + esc(optionValue(opt)) + '"' +
          (String(value === undefined ? '' : value) === optionValue(opt) ? ' selected' : '') + '>' +
          esc(optionLabel(opt)) + '</option>'
      })
      html += '</select>'
    } else if (fd.type === 'checkbox') {
      html += '<label class="switch-row"><input type="checkbox" data-key="' + esc(fd.key) + '"' +
        (value ? ' checked' : '') + ' /> 启用</label>'
    } else if (fd.type === 'file') {
      html += '<div class="field-row"><button class="menu-btn" data-file-key="' + esc(fd.key) + '">' +
        (rec.data.filename ? '更换：' + esc(shortText(rec.data.filename, 16)) : '选择 Excel 文件…') + '</button></div>' +
        '<div class="hintline">' + esc(value || '尚未选择文件') + '</div>'
    } else if (fd.type === 'sheets') {
      var sheets = bookMeta ? bookMeta.sheets.map(function (s) { return s.name }) : []
      html += '<select data-zen-select data-key="' + esc(fd.key) + '"><option value="">（请先导入 Excel）</option>' +
        sheets.map(function (s) {
          return '<option value="' + esc(s) + '"' + (value === s ? ' selected' : '') + '>' + esc(s) + '</option>'
        }).join('') + '</select>'
    } else if (fd.type === 'sheetsMulti') {
      var all = bookMeta ? bookMeta.sheets.map(function (s) { return s.name }) : []
      html += '<div class="field-row">' + (all.length ? all.map(function (s) {
        var on = Array.isArray(value) && value.indexOf(s) >= 0
        return '<label class="switch-row"><input type="checkbox" data-multi="' + esc(fd.key) +
          '" value="' + esc(s) + '"' + (on ? ' checked' : '') + ' /> ' + esc(s) + '</label>'
      }).join('') : '<span class="hintline">请先导入 Excel</span>') + '</div>'
    } else if (fd.type === 'factor') {
      var fv = value || {}
      html += '<div class="field-row"><select data-zen-select data-factor="mode">' +
        ['column:乘某一列', 'header:按表头名称', 'constant:固定数值'].map(function (o) {
          var p = o.split(':')
          return '<option value="' + p[0] + '"' + (fv.mode === p[0] ? ' selected' : '') + '>' + p[1] + '</option>'
        }).join('') + '</select>' +
        '<input type="text" data-factor="column" placeholder="列名" value="' + esc(fv.column || '') + '" />' +
        '<input type="number" data-factor="value" placeholder="数值" value="' + esc(fv.value == null ? 1 : fv.value) + '" /></div>'
    } else if (fd.type === 'lookup') {
      html += renderTableEditor(fd.key, ['min', 'max', 'result'], ['下限', '上限', '结果'], value || []) +
        '<div class="field-row"><button class="menu-btn" data-lookup-preset="' + esc(fd.key) + '">载入加班补贴标准</button></div>'
    } else if (fd.type === 'condition') {
      var cond = value || { logic: 'and', rules: [], then: 1, else: 0 }
      html += '<select data-zen-select data-cond="logic"><option value="and"' + (cond.logic === 'and' ? ' selected' : '') +
        '>同时满足</option><option value="or"' + (cond.logic === 'or' ? ' selected' : '') + '>满足任一</option></select>' +
        renderTableEditor('cond-rules', ['column', 'op', 'value'], ['列', '比较', '值'], cond.rules || [], true) +
        '<div class="field-row"><input type="text" data-cond="then" placeholder="成立时" value="' + esc(cond.then) + '" />' +
        '<input type="text" data-cond="else" placeholder="否则" value="' + esc(cond.else) + '" /></div>'
    } else if (fd.type === 'rules') {
      html += renderTableEditor(fd.key, ['column', 'op', 'value'], ['列', '比较', '值'], value || [], true) +
        '<div class="hintline">比较符：&gt; &gt;= &lt; &lt;= == != contains empty notEmpty</div>'
    } else if (fd.type === 'sortkeys') {
      html += renderTableEditor(fd.key, ['column', 'dir'], ['列', '方向 asc/desc'], value || [])
    } else if (fd.type === 'table') {
      html += renderTableEditor(fd.key, fd.columns.map(function (c) { return c.key }),
        fd.columns.map(function (c) { return c.label }), value || [])
    } else if (fd.type === 'expr') {
      html += '<textarea data-key="' + esc(fd.key) + '" rows="3">' + esc(value || '') + '</textarea>' +
        '<div class="field-row">' +
        ['IF([C]>0,1,0)', 'ROUND([D]*[C],2)', 'LASTTIME([C])', 'CONTAINS([A],"张")'].map(function (t) {
          return '<button class="menu-btn" data-expr-insert="' + esc(t) + '">' + esc(shortText(t, 12)) + '</button>'
        }).join('') +
        '<button class="menu-btn" data-expr-check="' + esc(fd.key) + '">校验</button></div>'
    } else {
      var inputType = fd.type === 'number' ? 'number' : 'text'
      html += '<input type="' + inputType + '" data-key="' + esc(fd.key) + '"' +
        (fd.min != null ? ' min="' + fd.min + '"' : '') +
        (fd.max != null ? ' max="' + fd.max + '"' : '') +
        ' value="' + esc(value == null ? '' : value) + '" />'
    }
    if (fd.hint) html += '<div class="hintline">' + esc(fd.hint) + '</div>'
    return html + '</label>'
  }

  function renderTableEditor(key, keys, labels, rows, compact) {
    var html = '<table class="editor-table"><thead><tr>' +
      labels.map(function (l) { return '<th>' + esc(l) + '</th>' }).join('') + '<th></th></tr></thead><tbody>'
    ;(rows || []).forEach(function (row, i) {
      html += '<tr>'
      keys.forEach(function (k) {
        html += '<td><input data-tcell="' + esc(key) + '" data-row="' + i + '" data-col="' + esc(k) +
          '" value="' + esc(row[k] == null ? '' : row[k]) + '" /></td>'
      })
      html += '<td class="row-del" data-tdel="' + esc(key) + '" data-row="' + i + '">×</td></tr>'
    })
    html += '</tbody></table><button class="menu-btn" data-tadd="' + esc(key) + '">+ 添加一行</button>'
    return html
  }

  function bindFields(rec) {
    var body = $('inspector-body')
    function patch(p) { canvas.updateNode(rec.id, { data: p }) }

    body.querySelectorAll('[data-key]').forEach(function (input) {
      if (input.dataset.multi !== undefined) return
      var handler = function () {
        var key = input.dataset.key
        var val
        if (input.type === 'checkbox') val = input.checked
        else if (input.type === 'number') val = Number(input.value)
        else val = input.value
        var p = {}; p[key] = val; patch(p)
        if (key === 'sheetMode' || key === 'rangeMode' || key === 'op' ||
            key === 'kind' || key === 'mode' || key === 'target') renderInspector()
      }
      input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'change', handler)
    })
    body.querySelectorAll('[data-multi]').forEach(function (input) {
      input.addEventListener('change', function () {
        var key = input.dataset.multi
        var values = Array.prototype.slice.call(body.querySelectorAll('[data-multi="' + key + '"]:checked'))
          .map(function (el) { return el.value })
        var p = {}; p[key] = values; patch(p)
      })
    })
    body.querySelectorAll('[data-factor]').forEach(function (input) {
      input.addEventListener('change', function () {
        var fv = Object.assign({}, rec.data.factor || {})
        fv[input.dataset.factor] = input.dataset.factor === 'value' ? Number(input.value) : input.value
        patch({ factor: fv })
      })
    })
    body.querySelectorAll('[data-cond]').forEach(function (input) {
      input.addEventListener('change', function () {
        var cond = Object.assign({}, rec.data.condition || { logic: 'and', rules: [], then: 1, else: 0 })
        cond[input.dataset.cond] = input.value
        patch({ condition: cond })
      })
    })
    body.querySelectorAll('[data-tcell]').forEach(function (input) {
      input.addEventListener('change', function () {
        var key = input.dataset.tcell
        var i = Number(input.dataset.row)
        var col = input.dataset.col
        if (key === 'cond-rules') {
          var cond = Object.assign({}, rec.data.condition || { logic: 'and', rules: [], then: 1, else: 0 })
          cond.rules = (cond.rules || []).slice()
          cond.rules[i] = cond.rules[i] || {}
          cond.rules[i][col] = input.value
          patch({ condition: cond })
        } else {
          var rows = (rec.data[key] || []).slice()
          rows[i] = rows[i] || {}
          rows[i][col] = input.value
          var p = {}; p[key] = rows; patch(p)
        }
      })
    })
    body.querySelectorAll('[data-tdel]').forEach(function (cell) {
      cell.addEventListener('click', function () {
        var key = cell.dataset.tdel
        var i = Number(cell.dataset.row)
        if (key === 'cond-rules') {
          var cond = Object.assign({}, rec.data.condition || { logic: 'and', rules: [], then: 1, else: 0 })
          cond.rules = (cond.rules || []).slice()
          cond.rules.splice(i, 1)
          patch({ condition: cond })
        } else {
          var rows = (rec.data[key] || []).slice()
          rows.splice(i, 1)
          var p = {}; p[key] = rows; patch(p)
        }
        renderInspector()
      })
    })
    body.querySelectorAll('[data-tadd]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.dataset.tadd
        if (key === 'cond-rules') {
          var cond = Object.assign({}, rec.data.condition || { logic: 'and', rules: [], then: 1, else: 0 })
          cond.rules = (cond.rules || []).concat([{ column: '', op: '>=', value: '' }])
          patch({ condition: cond })
        } else {
          var rows = (rec.data[key] || []).slice()
          var def = DEFS[rec.type]
          var fd = (def.fields || []).filter(function (x) { return x.key === key })[0]
          var blank = {}
          ;((fd && fd.columns) || []).forEach(function (c) { blank[c.key] = '' })
          rows.push(blank)
          var p = {}; p[key] = rows; patch(p)
        }
        renderInspector()
      })
    })
    body.querySelectorAll('[data-lookup-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.dataset.lookupPreset
        var p = {}; p[key] = FEE_LOOKUP.map(function (x) { return Object.assign({}, x) })
        p.defaultResult = 3
        patch(p)
        renderInspector()
        toast('已载入加班补贴标准')
      })
    })
    body.querySelectorAll('[data-expr-insert]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var area = body.querySelector('textarea[data-key="expression"]')
        if (!area) return
        area.value = (area.value ? area.value + ' ' : '') + btn.dataset.exprInsert
        var p = {}; p[area.dataset.key] = area.value; patch(p)
      })
    })
    body.querySelectorAll('[data-expr-check]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        apiPost('/api/expr/check', { expression: rec.data.expression || '' }).then(function (res) {
          toast(res.ok ? '表达式合法' : ('表达式错误：' + (res.error || '')))
        })
      })
    })
    var fileBtn = body.querySelector('[data-file-key]')
    if (fileBtn) {
      fileBtn.addEventListener('click', function () {
        pendingFileNode = rec.id
        fileInput.value = ''
        fileInput.click()
      })
    }
    body.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.act === 'remove') canvas.removeNode(rec.id)
        else if (btn.dataset.act === 'duplicate') { canvas.select(rec.id); canvas.duplicate() }
        else if (btn.dataset.act === 'preview') previewNode(rec.id)
      })
    })
    // 选区字段：点击后在预览网格中拖选
    body.querySelectorAll('input[data-key="startCell"], input[data-key="endCell"]').forEach(function (input) {
      input.addEventListener('focus', function () {
        rangeTarget = { nodeId: rec.id, key: input.dataset.key }
      })
    })
  }

  // ----------------------------------------------------------------------
  // 数据预览
  // ----------------------------------------------------------------------
  function renderInspectorData(rec) {
    var host = $('inspector-data')
    var result = lastResult && lastResult.nodes && lastResult.nodes[rec.id]
    var sample = result && result.result && (result.result.columns ? result.result : null)
    if (sample && sample.columns && sample.rows) {
      host.innerHTML = '<div class="section-title">节点输出 · ' + esc(rec.id) + '</div>' +
        gridHTML(sample.columns, sample.rows, null) +
        '<div class="hintline">共 ' + sample.rowCount + ' 行 · ' + sample.colCount + ' 列' +
        (sample.sheets && sample.sheets.length ? ' · 工作表：' + esc(sample.sheets.join('、')) : '') + '</div>'
      bindGrid(host, null)
      return
    }
    if (!bookMeta) {
      host.innerHTML = '<div class="empty">请先导入 Excel 文件，或运行一次工作流。</div>'
      return
    }
    var sheets = bookMeta.sheets || []
    var name = (rec.type === 'file' && rec.data.sheet && sheets.some(function (s) { return s.name === rec.data.sheet }))
      ? rec.data.sheet : (sheets[0] && sheets[0].name)
    var sheet = sheets.filter(function (s) { return s.name === name })[0]
    if (!sheet) {
      host.innerHTML = '<div class="empty">没有可预览的工作表。</div>'
      return
    }
    host.innerHTML = '<div class="field"><span>预览工作表</span><select id="preview-sheet" data-zen-select>' +
      sheets.map(function (s) {
        return '<option value="' + esc(s.name) + '"' + (s.name === name ? ' selected' : '') + '>' +
          esc(s.name) + '</option>'
      }).join('') + '</select></div>' +
      '<div class="hintline">真实范围：' + sheet.maxRow + ' 行 × ' + sheet.maxCol + ' 列 · 仅显示前 30 行 / 30 列</div>' +
      gridHTML(sheet.columns, sheet.rows, sheet) +
      '<div class="hintline">聚焦“起始/结束单元格”输入框后，可在上方网格拖选区域。</div>'
    $('preview-sheet').addEventListener('change', function (e) { showSheetPreview(e.target.value) })
    bindGrid(host, sheet)
  }

  function showSheetPreview(name) {
    var sheet = (bookMeta.sheets || []).filter(function (s) { return s.name === name })[0]
    if (!sheet) return
    var host = $('inspector-data')
    host.innerHTML = gridHTML(sheet.columns, sheet.rows, sheet) +
      '<div class="hintline">' + esc(name) + ' · ' + sheet.maxRow + ' 行 × ' + sheet.maxCol + ' 列</div>'
    bindGrid(host, sheet)
  }

  function gridHTML(columns, rows, sheet) {
    if (!rows || !rows.length) return '<div class="zt-empty">暂无数据</div>'
    var html = '<div class="zt-preview"><table><thead><tr><th class="col-head">#</th>'
    columns.forEach(function (c, i) {
      html += '<th>' + esc(typeof c === 'string' ? (sheet ? colLetter(i + 1) : c) : c) + '</th>'
    })
    html += '</tr></thead><tbody>'
    rows.forEach(function (row, r) {
      html += '<tr><td class="row-head">' + (r + 1) + '</td>'
      columns.forEach(function (_c, c) {
        html += '<td data-cell="' + (r + 1) + ':' + (c + 1) + '">' + esc(row[c] == null ? '' : row[c]) + '</td>'
      })
      html += '</tr>'
    })
    return html + '</tbody></table></div>'
  }

  function bindGrid(host, sheet) {
    host.querySelectorAll('[data-cell]').forEach(function (td) {
      td.addEventListener('mousedown', function (e) {
        if (!rangeTarget || !sheet) return
        e.preventDefault()
        var parts = td.dataset.cell.split(':')
        dragging = { r1: Number(parts[0]), c1: Number(parts[1]) }
        paintSelection(host, dragging, dragging)
      })
      td.addEventListener('mouseenter', function () {
        if (!dragging) return
        var parts = td.dataset.cell.split(':')
        dragging.r2 = Number(parts[0])
        dragging.c2 = Number(parts[1])
        paintSelection(host, dragging, dragging)
      })
    })
    document.addEventListener('mouseup', function once() {
      document.removeEventListener('mouseup', once)
      if (!dragging || !rangeTarget) { dragging = null; return }
      var d = dragging
      dragging = null
      var a = colLetter(d.c1) + d.r1
      var b = colLetter(d.c2 || d.c1) + (d.r2 || d.r1)
      var rec = canvas.getNode(rangeTarget.nodeId)
      if (!rec) return
      var patch = {}
      if (Object.prototype.hasOwnProperty.call(rec.data, 'startCell')) patch.startCell = a
      if (Object.prototype.hasOwnProperty.call(rec.data, 'endCell')) patch.endCell = b
      if (!Object.keys(patch).length) patch[rangeTarget.key] = a
      canvas.updateNode(rangeTarget.nodeId, { data: patch })
      rangeTarget = null
      toast('已填入区域 ' + a + ':' + b)
      renderInspector()
    })
  }

  function paintSelection(host, sel, other) {
    host.querySelectorAll('[data-cell]').forEach(function (td) {
      td.classList.remove('selected')
    })
    if (!sel) return
    var r1 = Math.min(sel.r1, sel.r2 || sel.r1), r2 = Math.max(sel.r1, sel.r2 || sel.r1)
    var c1 = Math.min(sel.c1, sel.c2 || sel.c1), c2 = Math.max(sel.c1, sel.c2 || sel.c1)
    host.querySelectorAll('[data-cell]').forEach(function (td) {
      var p = td.dataset.cell.split(':')
      var r = Number(p[0]), c = Number(p[1])
      if (r >= r1 && r <= r2 && c >= c1 && c <= c2) td.classList.add('selected')
    })
  }

  // ----------------------------------------------------------------------
  // 节点库
  // ----------------------------------------------------------------------
  function renderPalette() {
    var host = $('palette-body')
    var groups = canvas.typesByCategory()
    var order = ['输入', '计算', '整理', '汇总', '输出', '辅助', '其它']
    var html = ''
    order.concat(Object.keys(groups).filter(function (g) { return order.indexOf(g) < 0 })).forEach(function (cat) {
      var items = groups[cat]
      if (!items || !items.length) return
      html += '<div class="group-title">' + esc(cat) + '</div>'
      items.forEach(function (def) {
        html += '<button class="palette-item" draggable="true" data-type="' + esc(def.key) +
          '" title="点击添加，或拖到画布指定位置">' +
          '<span class="pi-glyph">' + esc(def.glyph) + '</span><span>' + esc(def.label) +
          '<span class="pi-desc">' + esc(def.ports.indexOf('left') >= 0 ? '入 / 出' : '仅输出') + '</span></span></button>'
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
    var rect = $('canvas-host').getBoundingClientRect()
    var w = canvas.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
    var n = canvas.state.nodes.length
    var rec = canvas.addNode(type, {}, { x: w.x - 120 + (n % 3) * 28, y: w.y - 60 + (n % 3) * 24 })
    canvas.select(rec.id)
    toast('已添加“' + DEFS[type].label + '”')
  }

  // ----------------------------------------------------------------------
  // 工作流契约
  // ----------------------------------------------------------------------
  function buildSpec() {
    var data = canvas.toJSON()
    return {
      format: 'omm-table-workflow',
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

  function toCanvasJSON(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
    if (obj.format !== 'omm-table-workflow' && obj.app) return obj
    var nodes = (Array.isArray(obj.nodes) ? obj.nodes : []).map(function (n) {
      var def = DEFS[n.type]
      return {
        id: n.id, type: n.type,
        x: n.x != null ? n.x : 100, y: n.y != null ? n.y : 100,
        w: n.w != null ? n.w : (def ? def.w : 250),
        h: n.h != null ? n.h : (def ? def.h : 120),
        title: n.title || (def ? def.label : n.type),
        locked: !!n.locked, minimized: !!n.minimized,
        data: n.data || {},
      }
    })
    var connections = (Array.isArray(obj.connections) ? obj.connections : []).map(function (c) {
      return { id: c.id, from: c.from, to: c.to, fromPort: c.fromPort || 'right', toPort: c.toPort || 'left' }
    })
    return { version: 1, app: 'table', nodes: nodes, connections: connections, view: { scale: 1, panX: 0, panY: 0 }, meta: {} }
  }

  function saveWorkflowFile() {
    ZenUtil.saveJSON('table-workflow.json', buildSpec())
    toast('已导出工作流 table-workflow.json')
  }

  // ----------------------------------------------------------------------
  // AI 桥
  // ----------------------------------------------------------------------
  function summaryOf(type, data) {
    var def = DEFS[type]
    return def && def.summary ? def.summary(data || {}) : ''
  }

  function snapshot() {
    if (!canvas) return { version: 1, app: 'table', nodeCount: 0, connectionCount: 0, nodes: [], connections: [], output: [] }
    var data = canvas.toJSON()
    return {
      version: 1, app: 'table',
      nodeCount: data.nodes.length, connectionCount: data.connections.length,
      nodes: data.nodes.map(function (n) {
        return { id: n.id, type: n.type, title: n.title || n.type, summary: summaryOf(n.type, n.data), data: n.data }
      }),
      connections: data.connections.map(function (c) {
        return { from: c.from, to: c.to, fromPort: c.fromPort, toPort: c.toPort }
      }),
      output: data.nodes.filter(function (n) { return n.type === 'save' || n.type === 'exportTable' })
        .map(function (n) { return n.data }),
    }
  }

  function snapshotMarkdown() {
    if (!canvas) return ''
    var data = canvas.toJSON()
    var ids = {}
    data.nodes.forEach(function (n) { ids[n.id] = n.type })
    var lines = ['表格自动化画布 · ' + data.nodes.length + ' 个节点 · ' + data.connections.length + ' 条连线']
    data.nodes.forEach(function (n) {
      var def = DEFS[n.type]
      lines.push('- ' + (n.title || n.type) + '：' + (def && def.summary ? def.summary(n.data) : n.type))
    })
    if (data.connections.length) {
      lines.push('连线：' + data.connections.map(function (c) {
        return (ids[c.from] || '?') + ' → ' + (ids[c.to] || '?')
      }).join(' · '))
    }
    return lines.join('\n')
  }

  window.ZenTableAI = {
    snapshot: snapshot,
    snapshotMarkdown: snapshotMarkdown,
    workflowSpec: buildSpec,
    version: 1,
  }

  ;(function () {
    window.addEventListener('message', function (ev) {
      if (!ev.data || ev.data.type !== 'omm:zen-card-request') return
      if (window.parent === window) return
      if (!ZenUtil.isLocalOrigin(ev.origin)) return
      var api = window.ZenTableAI
      if (!api || !api.snapshotMarkdown) return
      var md = api.snapshotMarkdown()
      if (!md) return
      var card = {
        id: 'omm-table-workflow-' + Date.now().toString(36),
        kind: 'omm.table.workflow',
        content: md,
        source: 'omm-table',
        tags: ['表格自动化', 'AI工作区'],
      }
      try {
        window.parent.postMessage({ type: 'omm:zen-card-reply', token: ev.data.token, cards: [card] }, ev.origin)
      } catch (e) {}
    })
  })()

  function sendToAI() {
    var api = window.ZenTableAI
    if (!api || !api.workflowSpec) { toast('AI 桥接未就绪'); return }
    var spec = api.workflowSpec()
    var title = '表格自动化 · ' + ((spec.nodes || []).length) + ' 节点'
    if (window.OMMShare && window.OMMShare.send) {
      window.OMMShare.send({
        to: 'ai', channel: 'documents', format: 'omm.table.workflow', title: title,
        payload: { version: 1, title: title, canvas: api.snapshot(), workflow: spec },
      }).then(function () {
        toast('工作流已发给 AI 工作区')
        if (window.OMMShare.openApp) window.OMMShare.openApp('ai')
      }, function () { saveWorkflowFile() })
    } else {
      saveWorkflowFile()
    }
  }

  // ----------------------------------------------------------------------
  // 后端交互
  // ----------------------------------------------------------------------
  function apiGet(path) {
    return fetch(API + path).then(function (r) { return r.json() })
  }
  function apiPost(path, body, raw) {
    return fetch(API + path, {
      method: 'POST',
      headers: raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' },
      body: raw ? body : JSON.stringify(body || {}),
    }).then(function (r) { return r.json() })
  }

  function uploadFile(file, nodeId) {
    toast('正在上传 ' + file.name + ' …')
    apiPost('/api/upload?name=' + encodeURIComponent(file.name), file, true).then(function (res) {
      if (!res.ok) { toast('上传失败：' + (res.error || '未知错误')); return }
      var id = nodeId
      if (!id) {
        var existing = canvas.getNodes().find(function (n) { return n.type === 'file' })
        id = existing ? existing.id : canvas.addNode('file', {}, { x: 140, y: 160 }).id
      }
      canvas.updateNode(id, { data: { fileId: res.fileId, filename: res.name, sheet: '' } })
      loadBookMeta(res.fileId)
      toast('已导入 ' + res.name)
    }).catch(function (e) { toast('上传失败：' + e.message) })
  }

  function loadBookMeta(fileId) {
    apiGet('/api/book?file=' + encodeURIComponent(fileId)).then(function (res) {
      if (!res.ok) { toast('读取工作簿失败：' + (res.error || '')); return }
      bookMeta = res
      // 自动选择第一张工作表
      var rec = canvas.getNodes().filter(function (n) { return n.type === 'file' })[0]
      if (rec && bookMeta.sheets.length) {
        var valid = bookMeta.sheets.some(function (s) { return s.name === rec.data.sheet })
        if (!valid || (rec.data.sheetMode === 'selected' && !(rec.data.selected || []).length)) {
          canvas.updateNode(rec.id, { data: { sheet: bookMeta.sheets[0].name, selected: [bookMeta.sheets[0].name] } })
        }
      }
      renderInspector()
      $('stat-runtime').textContent = 'openpyxl · ' + bookMeta.sheets.length + ' 个工作表'
    }).catch(function () {})
  }

  function run(dryRun, previewNode) {
    if (jobId) { toast('任务正在运行'); return }
    var spec = buildSpec()
    if (!spec.nodes.length) { toast('画布是空的，请先添加节点'); return }
    if (!spec.nodes.some(function (n) { return n.type === 'file' && n.data.fileId })) {
      toast('请先给 Excel 文件节点导入文件'); return
    }
    apiPost('/api/run', { spec: spec, dryRun: !!dryRun, previewNode: previewNode || '' }).then(function (res) {
      if (!res.ok) { toast('启动失败：' + (res.error || '')); return }
      jobId = res.jobId
      lastResult = null
      $('btn-run').disabled = true
      $('btn-dry').disabled = true
      $('btn-stop').disabled = false
      $('result-state').textContent = dryRun ? '试运行中' : '运行中'
      $('stat-job').textContent = '任务：' + jobId + (dryRun ? '（试运行）' : '')
      poll()
    }).catch(function (e) { toast('无法连接后端：' + e.message) })
  }

  function previewNode(id) { run(true, id) }

  function stop() {
    if (!jobId) return
    apiPost('/api/cancel/' + jobId, {}).then(function () { toast('已请求停止') })
  }

  function poll() {
    clearTimeout(pollTimer)
    if (!jobId) return
    apiGet('/api/job/' + jobId).then(function (s) {
      if (!s.ok) return
      Object.keys(s.nodes || {}).forEach(function (id) { applyNodeState(id, s.nodes[id]) })
      $('stat-progress').textContent = '进度：' + Math.round((s.progress || 0) * 100) + '%'
      $('result-state').textContent = s.status === 'done' ? '完成' : s.status === 'error' ? '失败' : '运行中'
      $('stat-job').textContent = '任务：' + jobId
      if (s.status === 'running') {
        pollTimer = setTimeout(poll, 600)
      } else {
        lastResult = s
        renderResults(s)
        jobId = null
        $('btn-run').disabled = false
        $('btn-dry').disabled = false
        $('btn-stop').disabled = true
        toast(s.status === 'done' ? (s.dryRun ? '试运行完成' : '工作流执行完成') : '工作流失败')
        if (activeTab === 'data') renderInspector()
      }
    }).catch(function () { pollTimer = setTimeout(poll, 1500) })
  }

  function applyNodeState(id, st) {
    var el = canvas.getNodeElement(id)
    if (!el) return
    el.dataset.state = st.status
    var badge = el.querySelector('[data-role="status"]')
    if (badge) {
      badge.textContent = st.status === 'running' ? Math.round((st.progress || 0) * 100) + '%' :
        st.status === 'done' ? '完成' : st.status === 'error' ? '失败' : ''
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
      result.innerHTML = '<span style="color:#c0392b">' + esc((st.error && st.error.message) || '执行失败') + '</span>'
    } else if (st.status === 'done') {
      var r = st.result || {}
      if (r.rowCount != null) {
        result.textContent = r.rowCount + ' 行 × ' + r.colCount + ' 列'
      } else if (r.written != null) {
        result.textContent = '写入 ' + r.written + ' 个单元格' + (r.filename ? ' · ' + r.filename : '')
      } else if (r.filename) {
        result.textContent = r.filename
      }
    }
  }

  function renderResults(s) {
    var host = $('result-body')
    var html = ''
    if (s.error) {
      html += '<div class="result-line" style="color:#c0392b">' + esc(s.error.message || s.error) + '</div>'
      if (s.error.hint) html += '<div class="hintline">' + esc(s.error.hint) + '</div>'
    }
    if (s.dryRun) html += '<div class="hintline">试运行：未写出任何文件</div>'
    if (s.conflicts && s.conflicts.length) {
      html += '<div class="section-title">冲突 / 计划（前 200 条）</div>'
      s.conflicts.slice(0, 200).forEach(function (c) {
        html += '<div class="conflict-row">' + esc(c.sheet) + '!' + esc(c.column) + c.row +
          ' · 原：' + esc(shortText(c.old, 18)) + ' → 新：' + esc(shortText(c.new, 18)) +
          ' · ' + esc(c.action) + '</div>'
      })
    }
    if (s.outputs && s.outputs.length) {
      html += '<div class="section-title">产物</div>'
      s.outputs.forEach(function (o) {
        html += '<div class="result-line"><a href="' + esc(API + o.url) + '" download>' +
          esc(o.name) + ' ↧</a> <span class="faint">' + esc(o.kind) + '</span></div>'
      })
    }
    if (s.warnings && s.warnings.length) {
      html += '<div class="section-title">提示</div>'
      s.warnings.slice(0, 30).forEach(function (w) {
        html += '<div class="result-line">' + esc(w.message || w) + '</div>'
      })
    }
    var nodes = canvas.getNodes()
    var byId = {}
    nodes.forEach(function (n) { byId[n.id] = n })
    html += '<div class="section-title">节点结果</div>'
    Object.keys(s.nodes || {}).forEach(function (id) {
      var st = s.nodes[id]
      if (st.status !== 'done') return
      var rec = byId[id]
      var def = rec && DEFS[rec.type]
      var r = st.result || {}
      var line = ''
      if (r.rowCount != null) line = r.rowCount + ' 行 × ' + r.colCount + ' 列'
      else if (r.written != null) line = '写入 ' + r.written
      else if (r.filename) line = r.filename
      else if (r.rows != null) line = r.rows + ' 行'
      html += '<div class="result-line">' + esc(def ? def.label : id) + ' · ' + esc(line || '完成') + '</div>'
    })
    host.innerHTML = html || '<div class="empty">没有可展示的结果。</div>'
  }

  // ----------------------------------------------------------------------
  // 示例工作流
  // ----------------------------------------------------------------------
  var TEMPLATES = {
    '加班补贴：时间分档 + 插入行': [
      ['file', 80, 140, { sheet: '打卡时间', rangeMode: 'manual', startCell: 'C6', endCell: 'AG90', headerRow: 0 }],
      ['mapCells', 400, 140, { columns: 'C:AG', op: 'lastTimeLookup', lookupKind: 'time', lookup: FEE_LOOKUP, defaultResult: 3, sourceSkipEmpty: true }],
      ['write', 720, 140, { columns: 'C:AG', rowMode: 'insertBelow', conflict: 'skip', style: 'asc', skipEmpty: true, skipZero: true }],
      ['writeFormula', 1040, 140, { kind: 'rowSum', columns: 'C:AG', targetColumn: 'AH', rowMode: 'insertBelow', style: 'asc' }],
      ['save', 1360, 140, { filename: '结果文件.xlsx' }],
    ],
    '工资计算：乘系数 + 列合计 + 汇总': [
      ['file', 80, 180, { sheetMode: 'all', rangeMode: 'auto', startCell: 'A1', headerRow: 1 }],
      ['mapColumns', 400, 180, { targetColumns: 'E:CG', step: 2, sourceMode: 'left', sourceOffset: -1, op: 'multiply', factor: { mode: 'column', column: 'C', value: 1 }, zeroOnInvalid: true }],
      ['write', 720, 180, { columns: 'E:CG', step: 2, rowMode: 'same', conflict: 'skip', style: 'asc' }],
      ['writeFormula', 1040, 180, { kind: 'colSum', columns: 'E:CG', step: 2, sumRow: 'auto', style: 'asc' }],
      ['aggregate', 1360, 180, { mode: 'columns', valueColumns: 'E:CG', step: 2, agg: 'sum', nameKey: '姓名', sheetKey: '__sheet', totalKey: '合计', nameColumnOffset: -1 }],
      ['pivot', 1680, 180, { rowKeys: ['姓名'], colKey: '__sheet', valueKey: '合计', rowTotals: true, colTotals: true, totalLabel: '合计' }],
      ['exportTable', 2000, 180, { filename: '工资汇总表.xlsx', sheetName: '工资汇总', title: '工资表', header: true, totals: true }],
      ['save', 2320, 180, { filename: '工资计算结果.xlsx' }],
    ],
    '条件筛选并导出汇总': [
      ['file', 100, 160, { rangeMode: 'auto', startCell: 'A1', headerRow: 1 }],
      ['filter', 440, 160, { logic: 'and', rules: [{ column: 'A', op: 'notEmpty', value: '' }] }],
      ['aggregate', 780, 160, { mode: 'rows', valueColumns: 'C:C', agg: 'sum', groupBy: 'A' }],
      ['exportTable', 1120, 160, { filename: '筛选汇总.xlsx', sheetName: '汇总', header: true }],
    ],
  }

  function applyTemplate(name) {
    var list = TEMPLATES[name]
    if (!list) return
    canvas.clear()
    var ids = []
    list.forEach(function (item) {
      var rec = canvas.addNode(item[0], item[3] || {}, { x: item[1], y: item[2] }, { change: false })
      ids.push(rec.id)
    })
    for (var i = 1; i < ids.length; i++) canvas.addConnection(ids[i - 1], ids[i])
    canvas.fitView()
    canvas._changed()
    lastResult = null
    toast('已载入“' + name + '”工作流')
  }

  function showHelp() {
    var html =
      '<b>三步开始</b><ol>' +
      '<li>点“导入 Excel”，画布里会出现文件节点，工作表与区域自动识别。</li>' +
      '<li>点“示例工作流”选“加班补贴”或“工资计算”，按你的表格改几处参数。</li>' +
      '<li>先“试运行”看冲突，再点“运行”，右侧下载结果。</li></ol>' +
      '<b>怎么连线</b><p>从节点右侧圆点拖到下一个节点左侧圆点。连接节点还有上方端口，接副表。</p>' +
      '<b>行模式</b><p>“原行”写到源行；“下一行”写到相邻行但不插行；“下方插入空行”会在每行后插一行再写，适合加班补贴。</p>' +
      '<b>冲突</b><p>默认跳过非空单元格；试运行会列出所有冲突。要覆盖请在写回节点里改策略。</p>' +
      '<b>逻辑</b><p>逐格计算适合“多列同一规则”；逐列计算适合“每列各取左邻列”。筛选、排序、去重、分组汇总、交叉汇总可以自由组合。</p>' +
      '<b>AI</b><p>点“发送 AI 工作区”让 AI 看懂当前流程；AI 也能生成 omm-table-workflow JSON，用“打开”导入。</p>'
    window.ZenUI.modal.open({
      title: '表格自动化 · 用法',
      html: '<div id="preview-content" class="zt-help">' + html + '</div>',
      foot: '<button class="menu-btn" id="preview-close">关闭</button>',
      onMount: function (body, foot) {
        foot.querySelector('#preview-close').addEventListener('click', function () {
          window.ZenUI.modal.close()
        })
      },
    })
  }

  // ----------------------------------------------------------------------
  // 初始化
  // ----------------------------------------------------------------------
  function init() {
    var nodeTypes = {}
    Object.keys(DEFS).forEach(function (key) {
      var def = DEFS[key]
      nodeTypes[key] = {
        label: def.label, category: def.category, glyph: def.glyph, ports: def.ports,
        w: def.w, h: def.h, defaults: def.defaults,
        render: function (data, host) { renderBody(def, data, host) },
        summary: def.summary,
      }
    })

    canvas = ZenCanvas.create({
      mount: $('canvas-host'), scope: 'table', notify: toast, nodeTypes: nodeTypes,
      storage: {
        save: function (data) {
          try { localStorage.setItem('zen.table.canvas.v1', JSON.stringify(data)) } catch (_) {}
        },
      },
      onSelectionChange: function (ids) {
        selectedId = ids.length === 1 ? ids[0] : null
        activeTab = 'params'
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

    var saved = null
    try { saved = JSON.parse(localStorage.getItem('zen.table.canvas.v1') || 'null') } catch (_) {}
    if (saved && saved.nodes && saved.nodes.length) canvas.fromJSON(toCanvasJSON(saved), { history: false })
    else applyTemplate('加班补贴：时间分档 + 插入行')

    $('btn-dry').addEventListener('click', function () { run(true) })
    $('btn-run').addEventListener('click', function () { run(false) })
    $('btn-stop').addEventListener('click', stop)
    $('btn-layout').addEventListener('click', function () { canvas.autoLayout($('strategy').value) })
    $('btn-fit').addEventListener('click', function () { canvas.fitView() })
    $('btn-clear').addEventListener('click', function () {
      window.ZenUI.dialog.confirm('清空画布？此操作可撤销（Ctrl+Z）。').then(function (ok) {
        if (!ok) return
        canvas.clear()
        renderResults({ nodes: {}, outputs: [] })
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
      inp.type = 'file'; inp.accept = '.json'
      inp.onchange = function () {
        var file = inp.files[0]
        if (!file) return
        var reader = new FileReader()
        reader.onload = function () {
          try {
            var obj = JSON.parse(reader.result)
            var spec = obj.format === 'omm-table-workflow' ? obj : obj.workflow || obj
            canvas.fromJSON(toCanvasJSON(spec), { history: false })
            toast('工作流已载入')
          } catch (err) { toast('文件解析失败：' + err.message) }
        }
        reader.readAsText(file)
      }
      inp.click()
    })
    $('btn-theme').addEventListener('click', function () {
      document.body.classList.toggle('theme-dark')
      localStorage.setItem('zen.theme', document.body.classList.contains('theme-dark') ? 'dark' : 'light')
    })
    if (localStorage.getItem('zen.theme') === 'dark') document.body.classList.add('theme-dark')
    $('btn-help').addEventListener('click', showHelp)

    apiGet('/api/status').then(function (s) {
      if (!s.ok) return
      $('runtime-badge').textContent = 'openpyxl ' + (s.openpyxl || '') + ' ✓'
      $('stat-runtime').textContent = 'openpyxl ' + (s.openpyxl || '') + ' · 后端就绪'
    }).catch(function () {
      $('runtime-badge').textContent = '后端未连接'
      $('stat-runtime').textContent = '请通过静书房启动表格自动化'
    })

    canvas.bus.on('change', function () {
      $('stat-nodes').textContent = '节点 ' + canvas.state.nodes.length + ' · 连线 ' + canvas.state.connections.length
    })
    $('stat-nodes').textContent = '节点 ' + canvas.state.nodes.length + ' · 连线 ' + canvas.state.connections.length
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
