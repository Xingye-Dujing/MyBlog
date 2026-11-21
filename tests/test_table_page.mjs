/* 表格自动化页面专项测试：结构、脚本语法、DOM 引用、画布与 AI 桥接线。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const ROOT = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const HTML = 'public/omm-table.html'
const JS = 'public/lib/zen-table.js'

test('页面存在且标题/资源正确', () => {
  assert.ok(existsSync(new URL(HTML, ROOT)), '入口页不存在')
  const html = read(HTML)
  assert.ok(html.includes('<title>表格自动化</title>'))
  for (const asset of [
    'omm-embed.js', 'omm-desktop.js', 'omm-share.js',
    'zen-style/zen.css', 'zen-style/products/table.css',
    'zen-canvas/layout-engine.js',
    'zen-canvas/zen-canvas.js', 'lib/zen-table.js',
  ]) {
    assert.ok(html.includes(asset), '缺少资源引用: ' + asset)
  }
  // 画布逻辑必须复用共享框架，页面不能有第二套拖拽/缩放实现
  assert.ok(!/function\s+initPanZoom|prototype\.zoomAt\s*=/.test(html))
})

test('产品脚本语法可解析', () => {
  assert.doesNotThrow(() => new Function(read(JS)), 'lib/zen-table.js 存在语法错误')
})

test('脚本引用的 DOM id 全部存在', () => {
  const html = read(HTML)
  const body = read(JS)
  const ids = new Set()
  for (const re of [/\$\('([^']+)'\)/g, /getElementById\('([^']+)'\)/g]) {
    let m
    while ((m = re.exec(body))) ids.add(m[1])
  }
  const declared = new Set()
  let dm
  const idRe = /\bid="([^"]+)"/g
  while ((dm = idRe.exec(html))) declared.add(dm[1])
  // 检查器的数据预览区由脚本动态注入，先用白名单排除。
  const dynamic = new Set(['inspector-data', 'preview-sheet'])
  const missing = [...ids].filter((id) => !declared.has(id) && !dynamic.has(id))
  assert.deepEqual(missing, [], '未定义的 DOM id: ' + missing.join(', '))
})

test('接入 ZenCanvas 且没有自行实现画布', () => {
  const js = read(JS)
  assert.ok(js.includes('ZenCanvas.create('))
  assert.ok(js.includes('ZenCanvasLayout') === false || js.includes('zen-canvas/layout-engine.js'))
  assert.ok(js.includes('canvas.autoLayout('))
  assert.ok(js.includes('canvas.toJSON('))
  assert.ok(js.includes('registerNodeType') === false || js.includes('nodeTypes'))
  assert.ok(!/function\s+renderConnections\s*\(/.test(js))
  assert.ok(!/function\s+screenToWorld\s*\(/.test(js))
})

test('工作流契约与后端一致', () => {
  const js = read(JS)
  assert.ok(js.includes("format: 'omm-table-workflow'"))
  assert.ok(js.includes('version: 1'))
  assert.ok(js.includes('/api/run'))
  assert.ok(js.includes('/api/job/'))
  assert.ok(js.includes('/api/upload'))
  assert.ok(js.includes("'file'") && js.includes("'write'") && js.includes("'save'"))
})

test('AI 桥与父窗口来源校验接线正确', () => {
  const js = read(JS)
  assert.ok(js.includes('window.ZenTableAI = {'))
  assert.ok(js.includes('snapshotMarkdown'))
  assert.ok(js.includes("ev.data.type !== 'omm:zen-card-request'"))
  assert.ok(js.includes('localOrigin(ev.origin)'))
  assert.ok(js.includes('window.parent.postMessage('))
  assert.ok(!/postMessage\([^,]+,\s*['"]\*['"]\)/.test(js), '禁止 wildcard postMessage')
  assert.ok(js.includes('OMMShare.send'))
})

test('节点类型覆盖规范中的 op', () => {
  const js = read(JS)
  const spec = read('public/json-specs/table.md')
  const required = ['file', 'mapCells', 'mapColumns', 'formula', 'filter', 'sort',
    'dedupe', 'join', 'aggregate', 'pivot', 'write', 'writeFormula',
    'exportTable', 'save', 'preview', 'note']
  for (const op of required) {
    assert.ok(new RegExp('\\b' + op + ': \\{').test(js), '节点定义缺失: ' + op)
    assert.ok(spec.includes('`' + op + '`'), '规范缺少 op: ' + op)
  }
})

test('后端不引入 GUI 代码', () => {
  const engine = read('public/server/table_engine.py')
  const serve = read('public/server/table-serve.py')
  for (const src of [engine, serve]) {
    assert.ok(!/import tkinter|from tkinter/.test(src), '后端不得依赖 Tkinter')
    assert.ok(!/messagebox|filedialog/.test(src), '后端不得使用 GUI 对话框')
  }
})
