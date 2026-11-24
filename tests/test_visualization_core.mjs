/* Shared ZENVIZ core regressions. Run: node --test tests/test_visualization_core.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { DataViz } from '../public/lib/data-viz.js'

const core = readFileSync(new URL('../third_party/zenviz-core/core/zenviz.js', import.meta.url), 'utf8')
const parseSource = readFileSync(new URL('../third_party/zenviz-core/core/zenviz-parse.js', import.meta.url), 'utf8')
const tail = readFileSync(new URL('../third_party/zenviz-core/profiles/omm/tail.js', import.meta.url), 'utf8')

function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} 未找到`)
  if (source.slice(start - 6, start) === 'async ') start -= 6
  const signatureOpen = source.indexOf('(', start)
  let signatureDepth = 0
  let signatureEnd = -1
  for (let i = signatureOpen; i < source.length; i += 1) {
    if (source[i] === '(') signatureDepth += 1
    else if (source[i] === ')' && --signatureDepth === 0) {
      signatureEnd = i
      break
    }
  }
  assert.notEqual(signatureEnd, -1, `${name} 签名不完整`)
  const open = source.indexOf('{', signatureEnd + 1)
  let depth = 0
  let quote = ''
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (lineComment) {
      if (ch === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false
        i += 1
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '/' && next === '/') {
      lineComment = true
      i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      blockComment = true
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`${name} 括号不平衡`)
}

function loadFunctions(source, names, scope = {}) {
  const declarations = names.map((name) => extractFunction(source, name)).join('\n')
  const args = Object.keys(scope)
  return new Function(...args, `${declarations}\nreturn { ${names.join(', ')} }`)(
    ...args.map((key) => scope[key]),
  )
}

function loadParser() {
  const sandbox = {}
  sandbox.globalThis = sandbox
  vm.runInNewContext(parseSource, sandbox)
  return sandbox.ZenvizParse
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[m])
}

function fakeSvgEl(tag, attrs = {}, text = '') {
  return {
    tag,
    attrs,
    text: String(text ?? ''),
    children: [],
    appendChild(child) {
      this.children.push(child)
      return child
    },
  }
}

function serializeSvg(node) {
  const attrs = Object.entries(node.attrs)
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join('')
  const body = escapeHtml(node.text) + node.children.map(serializeSvg).join('')
  return `<${node.tag}${attrs}>${body}</${node.tag}>`
}

test('CSV 字符状态机保留引号内多行、双写引号与首尾空白', () => {
  const { textData } = loadParser()
  const raw = 'name,note,value\r\nAlice,"  first\r\nsecond ""quoted""  ",1\rBob,"single\rline",2\n'
  assert.deepEqual(plain(textData(raw)), {
    headers: ['name', 'note', 'value'],
    rows: [
      ['Alice', '  first\r\nsecond "quoted"  ', '1'],
      ['Bob', 'single\rline', '2'],
    ],
  })
  assert.deepEqual(plain(textData(' a , b \n 1 , 2 \n\n')), {
    headers: ['a', 'b'],
    rows: [['1', '2']],
  })
  assert.deepEqual(plain(textData('\r\n  \r\nname,value\r\nA,1')), {
    headers: ['name', 'value'],
    rows: [['A', '1']],
  })
})

test('CSV 分隔符探测跳过引号内分隔符和换行', () => {
  const { textData, delimiterOf } = loadParser()
  assert.equal(delimiterOf('"a,b";"c\nd"\r\n1;2'), ';')
  assert.deepEqual(plain(textData('"a,b";"c,d"\n"x,y";10')), {
    headers: ['a,b', 'c,d'],
    rows: [['x,y', '10']],
  })
})

test('ECharts 饼图 tooltip 转义 name/value/percent', () => {
  const pieStart = core.indexOf("if (state.type === 'pie')", core.indexOf('function renderECharts'))
  const formatterStart = core.indexOf('formatter:', pieStart)
  const arrowStart = core.indexOf('(params) =>', formatterStart)
  const tickStart = core.indexOf('`', arrowStart)
  const tickEnd = core.indexOf('`', tickStart + 1)
  const formatter = new Function('escapeHtml', 'params', `return ${core.slice(tickStart, tickEnd + 1)}`)
  const html = formatter(escapeHtml, {
    name: '<img src=x onerror=alert(1)>',
    value: '1&2',
    percent: '50%',
  })
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(html.includes('1&amp;2'))
  assert.ok(!html.includes('<img'))
})

test('ApexCharts 把缺失值保留为 null，不转 0', () => {
  let options
  class ApexChartsStub {
    constructor(_mount, opts) { options = opts }
    render() {}
  }
  const mount = {
    clientWidth: 800,
    clientHeight: 600,
    style: { setProperty() {} },
    querySelector() { return null },
  }
  const state = {
    type: 'line', opacity: 0.9, lineWidth: 2, pointSize: 5,
    xTitle: 'X', yTitle: 'Y', rotateLabels: 0,
  }
  const chartProps = {
    line: {
      lineWidth: 2, lineType: 'solid', lineMode: 'single', pointSize: 5,
      smooth: false, showPoints: true, showGrid: true, yMin: '', yMax: '',
    },
  }
  const { renderApex } = loadFunctions(core, ['renderApex'], {
    window: { ApexCharts: ApexChartsStub },
    ApexCharts: ApexChartsStub,
    $: () => mount,
    state,
    chartProps,
    rowsToSeries: () => ({
      labels: ['A', 'B', 'C', 'D'],
      series: [{ name: 'S', data: [1, null, '', 3] }],
    }),
    palette: () => ['#155EEF'],
    chartInk: () => '#151515',
    chartPaper: () => '#ffffff',
    chartInkAlpha: (alpha) => `rgba(21,21,21,${alpha})`,
    chartPaperAlpha: (alpha) => `rgba(255,255,255,${alpha})`,
    numeric: (value) => value === null || value === '' ? null : Number(value),
    getChartFontFamily: () => 'serif',
    legendSelectionByType: {},
    reportError: (message, error) => { throw error || new Error(message) },
  })
  renderApex()
  assert.deepEqual(options.series[0].data, [1, null, null, 3])
})

test('关系图默认 0/1/2，失效映射自动推断', () => {
  const state = {
    type: 'network',
    data: { headers: ['来源', '去向', '权重'], rows: [['A', 'B', '2']] },
    xCol: 1,
    targetCol: 2,
    yCols: [3],
    y1Col: 99,
    y2Col: 99,
  }
  const { createDataSelectionState, normalizeDataSelection } = loadFunctions(
    core,
    ['createDataSelectionState', 'normalizeDataSelection'],
    {
      state,
      getChartDataRule: () => ({ x: 'category', target: true, maxY: 1 }),
      isUsableCategoryColumn: (index) => index >= 0 && index <= 2,
      firstUsableCategoryColumn: (exclude) => [0, 1].find((index) => index !== exclude) ?? null,
      isUsableNumericColumn: (index) => index === 2,
      firstUsableNumericColumns: () => [2],
    },
  )
  assert.deepEqual(createDataSelectionState('network'), {
    xCol: 0, yCols: [2], targetCol: 1, y1Col: 1, y2Col: 2,
  })
  normalizeDataSelection()
  assert.equal(state.xCol, 0)
  assert.equal(state.targetCol, 1)
  assert.deepEqual(state.yCols, [2])
})

test('右侧属性导入保留 dataSelections，且不重新加载列映射', async () => {
  const selections = { line: { xCol: 7, yCols: [8], targetCol: null, y1Col: 8, y2Col: 9 } }
  const stores = { echarts: { dataSelections: selections, typeStates: {}, chartProps: {} } }
  let selectionLoads = 0
  const saved = []
  const { importPropertySettings } = loadFunctions(core, ['importPropertySettings'], {
    PROPERTY_EXPORT_VERSION: 1,
    ENGINE_IDS: ['echarts'],
    enginePropertyStores: stores,
    createEnginePropertyStore: () => ({ dataSelections: { line: { xCol: 0 } }, typeStates: {}, chartProps: {} }),
    sanitizeTypeStates: () => ({ line: {} }),
    sanitizeChartProps: () => ({ line: {} }),
    saveEngineStore: (id) => saved.push(plain(stores[id].dataSelections)),
    loadEnginePropertyStore() {},
    loadDataSelectionStore() { selectionLoads += 1 },
    normalizeLayoutPrefs() {},
    renderInspector() {},
    applyChartMountLayout() {},
    resizeChart() {},
    renderChart() {},
    saveWorkspaceState() {},
    setStatus() {},
    reportError: (message, error) => { throw error || new Error(message) },
    state: { engine: 'echarts', type: 'line' },
  })
  const file = {
    name: 'props.json',
    text: async () => JSON.stringify({
      kind: 'zenviz-right-properties', version: 1, engines: { echarts: {} },
    }),
  }
  await importPropertySettings(file)
  assert.deepEqual(plain(stores.echarts.dataSelections), selections)
  assert.deepEqual(saved, [selections])
  assert.equal(selectionLoads, 0)
  assert.ok(!extractFunction(core, 'exportPropertySettings').includes('dataSelections'))
})

test('空 XLSX 返回空表，不退回示例数据', () => {
  const { aoaToData } = loadFunctions(core, ['aoaToData'], {
    sample: { headers: ['示例'], rows: [['不要替换']] },
  })
  assert.deepEqual(aoaToData([]), { headers: [], rows: [] })
  assert.deepEqual(aoaToData([[''], ['']]), { headers: [], rows: [] })
  assert.match(core, /XLSX 工作表为空 · 已载入空表/)
})

test('SVG overlay 保留标题/副标题/图例并遵循当前 chartProps', () => {
  const state = {
    type: 'line', showTitle: true, title: '<标题 & A>', subtitle: '<副标题>',
    titlePosition: 'top-left', titleOrientation: 'horizontal',
    legendPosition: 'bottom', legendOrientation: 'horizontal', showLegend: true,
    paddingLeft: 4, paddingRight: 4, paddingTop: 4, paddingBottom: 4,
  }
  const chartProps = { line: { showLegend: true } }
  const { svgOverlayBox, legendVisible, chartProp, buildSVGOverlay } = loadFunctions(
    core,
    ['svgOverlayBox', 'legendVisible', 'chartProp', 'buildSVGOverlay'],
    {
      state,
      chartProps,
      getChartDataRule: () => ({ legend: 'series' }),
      currentLegendNames: () => ['<A & B>', 'S2'],
      palette: () => ['#155EEF', '#009688'],
      chartInk: () => '#151515',
      chartPaper: () => '#ffffff',
      chartInkAlpha: (alpha) => `rgba(21,21,21,${alpha})`,
      chartPaperAlpha: (alpha) => `rgba(255,255,255,${alpha})`,
      legendSelectionByType: { line: { '<A & B>': false } },
      getChartFontFamily: () => 'serif',
      svgEl: fakeSvgEl,
    },
  )
  const svg = serializeSvg(buildSVGOverlay(1000, 620))
  assert.ok(svg.includes('data-zenviz-overlay="title"'))
  assert.ok(svg.includes('&lt;标题 &amp; A&gt;'))
  assert.ok(svg.includes('&lt;副标题&gt;'))
  assert.ok(svg.includes('data-zenviz-overlay="legend"'))
  assert.ok(svg.includes('&lt;A &amp; B&gt;'))
  assert.ok(svg.includes('opacity="0.34"'))
  assert.ok(!svg.includes(' rx='))
  chartProps.line.showLegend = false
  assert.ok(!serializeSvg(buildSVGOverlay(1000, 620)).includes('data-zenviz-overlay="legend"'))
  assert.match(extractFunction(core, 'buildStandaloneSVGString'), /appendChild\(buildSVGOverlay\(w, h\)\)/)
})

test('TeX 导出使用当前 chartProps 的图例、网格、线宽、平滑与范围', () => {
  const names = [
    'texEscapeText', 'texNum', 'texColorName', 'texPreamble', 'texFooter',
    'texQuantile', 'texHexToRgb', 'texRampColor', 'legendVisible', 'chartProp', 'buildTeX',
  ]
  const state = {
    type: 'line', data: { headers: ['X', 'A', 'B'], rows: [['a', 1, 2]] },
    title: '趋势', subtitle: '', showTitle: true, showLegend: true, showGrid: true,
    xTitle: 'X', yTitle: 'Y', width: 1000, height: 620,
  }
  const chartProps = {
    line: {
      showLegend: false, showGrid: false, smooth: true, showPoints: false,
      lineWidth: 3, lineType: 'dashed', pointSize: 7, yMin: '1', yMax: '9',
    },
  }
  const { buildTeX } = loadFunctions(core, names, {
    state,
    chartProps,
    chartNames: { line: '折线' },
    getChartDataRule: () => ({ legend: 'series' }),
    rowsToSeries: () => ({
      labels: ['A', 'B'],
      series: [{ name: 'S1', data: [1, 2] }, { name: 'S2', data: [2, 3] }],
    }),
    palette: () => ['#155EEF', '#009688'],
    numeric: (value) => value === null || value === '' ? null : Number(value),
    getPieSlices: () => [],
    getFlowRows: () => [],
    getPairSeries: () => ({}),
  })
  const tex = buildTeX()
  assert.ok(tex.includes('grid=none'))
  assert.ok(tex.includes('line width=3pt'))
  assert.ok(tex.includes('smooth'))
  assert.ok(tex.includes('dashed'))
  assert.ok(tex.includes('ymin=1'))
  assert.ok(tex.includes('ymax=9'))
  assert.ok(!tex.includes('mark=*'))
  assert.ok(!tex.includes('\\addlegendentry'))
})

test('Chart.js SVG 栅格兜底状态如实且不宣称无限矢量', async () => {
  const statuses = []
  const anchor = { click() {}, remove() {} }
  const { exportSVG } = loadFunctions(core, ['exportSVG'], {
    getRenderedSVGString: () => '',
    getExportCanvas: async () => ({
      canvas: { width: 1200, height: 800, toDataURL: () => 'data:image/png;base64,AA' },
      transparent: false,
    }),
    exportTransparent: () => false,
    exportPaperColor: () => '#ffffff',
    safeName: () => 'chart',
    state: { title: 'chart' },
    setStatus: (message) => statuses.push(message),
    reportError: (message, error) => { throw error || new Error(message) },
    document: { createElement: () => anchor },
    URL: { createObjectURL: () => 'blob:chart', revokeObjectURL() {} },
    Blob: class BlobStub {},
    setTimeout() {},
  })
  await exportSVG()
  assert.ok(statuses.at(-1).includes('1200 × 800'))
  assert.ok(statuses.at(-1).includes('Canvas 栅格图兜底（非矢量）'))
  assert.ok(!statuses.at(-1).includes('无限矢量'))
})

test('ECharts 重绘不再累积 resize 监听，Apex 版本与 vendor 一致', () => {
  const renderECharts = extractFunction(core, 'renderECharts')
  assert.ok(!renderECharts.includes("addEventListener('resize'"))
  assert.equal((core.match(/window\.addEventListener\('resize'/g) || []).length, 1)
  assert.match(core, /apexcharts:\s*\{[\s\S]*?version: '7\.4\.0'/)
  assert.doesNotMatch(core, /zenviz\.radius|changeRadius|applyRadius|radiusrow/)
})

test('送复盘经 OMMShare.publishRecord 写入 documents，桌面不写本地 origin', async () => {
  const calls = []
  const statuses = []
  const share = {
    publishRecord(record, options) {
      calls.push({ record, options })
      return Promise.resolve({ id: 'shared-1' })
    },
  }
  const localStorage = new Proxy({}, {
    get() { throw new Error('desktop must not write current origin') },
    set() { throw new Error('desktop must not write current origin') },
  })
  const { exportReview } = loadFunctions(tail, ['exportReview'], {
    window: { OMMShare: share },
    localStorage,
    state: {
      title: '新趋势', type: 'line',
      data: { headers: ['a', 'b'], rows: [[1, 2]] },
    },
    setStatus: (message) => statuses.push(message),
    reportError: (message, error) => { throw error || new Error(message) },
  })
  assert.equal(await exportReview(), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.channel, 'documents')
  assert.equal(calls[0].options.type, 'text/markdown')
  assert.equal(calls[0].options.format, 'omm.visualization.review')
  assert.equal(calls[0].record.rows, 1)
  assert.equal(calls[0].record.cols, 2)
  assert.ok(statuses.at(-1).includes('已送复盘'))
})

test('送复盘发布失败时提示且不伪造成功', async () => {
  const errors = []
  const statuses = []
  const { exportReview } = loadFunctions(tail, ['exportReview'], {
    window: {
      OMMShare: {
        publishRecord: () => Promise.reject(new Error('broker unavailable')),
      },
    },
    localStorage: new Proxy({}, {
      get() { throw new Error('must not fall back to origin storage') },
      set() { throw new Error('must not fall back to origin storage') },
    }),
    state: { title: '图', type: 'bar', data: { headers: [], rows: [] } },
    setStatus: (message) => statuses.push(message),
    reportError: (context, error) => errors.push({ context, error }),
  })
  assert.equal(await exportReview(), false)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].context, '送复盘失败')
  assert.match(errors[0].error.message, /broker unavailable/)
  assert.ok(!statuses.some((message) => message.startsWith('已送复盘')))
})

test('工作区持久化包含规范化后的数据表', () => {
  const stored = {}
  const state = {
    engine: 'echarts', type: 'line', category: '论文',
    data: { headers: ['类别', '值'], rows: [[1, 2], ['三月']] },
  }
  const { saveWorkspaceState } = loadFunctions(core, ['sanitizePersistedData', 'saveWorkspaceState'], {
    state,
    WORKSPACE_PERSIST_KEY: 'zenviz.workspace.v2', STORAGE_VERSION: 4,
    GLOBAL_PERSIST_KEYS: ['engine', 'type', 'category'],
    localStorage: { setItem: (key, value) => { stored[key] = value } },
    reportError: (message, error) => { throw error || new Error(message) },
  })
  saveWorkspaceState()
  const saved = JSON.parse(stored['zenviz.workspace.v2'])
  assert.deepEqual(saved.data, { headers: ['类别', '值'], rows: [['1', '2'], ['三月', '']] })
  assert.match(extractFunction(core, 'restorePersistedState'), /sanitizePersistedData\(workspace\.data\)/)
})

test('可视化桥接 CSV 由 DataViz.toCSV 生成，不信任传入 csv', () => {
  const { payloadCSV } = loadFunctions(tail, ['payloadCSV'], { window: { DataViz } })
  const csv = payloadCSV({
    csv: 'javascript:alert(1)',
    headers: ['名称', '备注'],
    rows: [['A,1', '第一行\n第二行']],
  })
  assert.ok(csv.includes('"A,1"'))
  assert.ok(csv.includes('"第一行\n第二行"'))
  assert.ok(!csv.includes('javascript:'))
})

test('可视化导出使用设计尺寸而非屏幕预览尺寸', () => {
  const canvasExport = extractFunction(core, 'getExportCanvas')
  assert.match(canvasExport, /Number\(state\.width\)/)
  assert.match(canvasExport, /Number\(state\.height\)/)
  assert.match(canvasExport, /exportScaleFactor\(designW, designH\)/)
  assert.doesNotMatch(canvasExport, /exportScaleFactor\(frame\.offsetWidth, frame\.offsetHeight\)/)
  assert.match(extractFunction(core, 'svgToCanvas'), /Number\(state\.width\)/)
  assert.match(extractFunction(core, 'getRenderedSVGString'), /Number\(state\.width\)/)
})

test('图表数据 palette 与 ramp 集中共享，界面色读取 ZEN 令牌', () => {
  assert.match(core, /const ZENVIZ_PALETTES = Object\.freeze/)
  assert.match(core, /const ZENVIZ_RAMPS = Object\.freeze/)
  assert.match(extractFunction(core, 'palettePreview'), /ZENVIZ_PALETTES\[id\]/)
  assert.match(extractFunction(core, 'chartInk'), /--zen-ink/)
  assert.match(extractFunction(core, 'chartPaperColor'), /--zen-paper/)
  assert.doesNotMatch(core, /'#151515'|'#ffffff'|'rgba\(21,21,21/)
  const css = readFileSync(new URL('../third_party/zenviz-core/core/zenviz.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /\.palette-preview \.p-(?:mono|culture|science|editorial)-/)
})
