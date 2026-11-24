/* Shared bridge trust, inbox acknowledgement and overlay ownership regressions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')

function extract(text, name) {
  const start = text.indexOf('async function ' + name + '(') >= 0
    ? text.indexOf('async function ' + name + '(')
    : text.indexOf('function ' + name + '(')
  assert.ok(start >= 0, name)
  const open = text.indexOf('{', start)
  let depth = 0, quote = '', line = false, block = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i], next = text[i + 1]
    if (line) { if (ch === '\n') line = false; continue }
    if (block) { if (ch === '*' && next === '/') { block = false; i++ } continue }
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '/' && next === '/') { line = true; i++; continue }
    if (ch === '/' && next === '*') { block = true; i++; continue }
    if (ch === '{') depth++
    if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error(name + ' unbalanced')
}

test('三个桥接脚本统一使用 ZenUtil 的精确父窗口信任校验', () => {
  for (const path of ['public/omm-embed.js', 'public/omm-desktop.js', 'public/omm-share.js']) {
    const source = read(path)
    assert.ok(source.includes('ZenUtil.isTrustedParentMessage(event)'), path)
    assert.doesNotMatch(source, /function isTrustedParentOrigin|function isLoopbackOrigin/, path)
  }
})

test('共享文件没有载入入口时不通知、不 ACK', async () => {
  const source = read('public/omm-share.js')
  const notifications = []
  const fn = vm.runInNewContext('(' + extract(source, 'deliverMessage') + ')', {
    state: { handlers: [() => {}], toast: () => {} },
    fetchFile: async () => new ArrayBuffer(8),
    apiGet: async () => { throw new Error('not a record') },
    emit: async () => {},
    notifyReceived: () => notifications.push(true),
    window: { OMMDesktop: { loadBlob: async () => ({ ok: false }) } },
    Promise, Object, Array, String,
  })
  const result = await fn({ artifact: { id: 'a1', kind: 'file', title: 'x' } })
  assert.equal(result, false)
  assert.equal(notifications.length, 0)
})

test('共享文件载入成功后才通知并 ACK', async () => {
  const source = read('public/omm-share.js')
  const notifications = []
  const fn = vm.runInNewContext('(' + extract(source, 'deliverMessage') + ')', {
    state: { handlers: [() => {}], toast: () => {} },
    fetchFile: async () => new ArrayBuffer(8),
    apiGet: async () => { throw new Error('not a record') },
    emit: async () => {},
    notifyReceived: () => notifications.push(true),
    window: { OMMDesktop: { loadBlob: async () => ({ ok: true }) } },
    Promise, Object, Array, String,
  })
  const result = await fn({ artifact: { id: 'a1', kind: 'file', title: 'x' } })
  assert.equal(result, true)
  assert.equal(notifications.length, 1)
})

test('存档与共享视觉只在共享 CSS 中实现，桥接不再注入 shadow 样式', () => {
  const desktop = read('public/omm-desktop.js')
  const share = read('public/omm-share.js')
  const entry = read('public/zen/zen.css')
  const css = read('public/zen/components/archive.css')
  assert.ok(entry.includes('components/archive.css'))
  assert.ok(css.includes('.omm-panel') && css.includes('.osh-list'))
  assert.doesNotMatch(desktop, /attachShadow|PANEL_CSS|PANEL_VARS|omm-toast/)
  assert.doesNotMatch(share, /injectCss|createElement\(['"]style/)
})

test('ZenCSV 可在导出边界防公式注入而不改变默认无损往返', () => {
  const context = { window: {} }
  vm.runInNewContext(read('public/lib/zen-csv.js'), context)
  const rows = [['=HYPERLINK("x")', '+cmd', '-cmd', '-1', '@sum', 'plain']]
  const safe = context.window.ZenCSV.stringify(rows, ',', { formulaSafe: true })
  assert.match(safe, /'=HYPERLINK/)
  assert.match(safe, /'\+cmd/)
  assert.match(safe, /,-1,/)
  assert.match(safe, /'@sum/)
  const normal = context.window.ZenCSV.stringify(rows, ',')
  assert.ok(normal.includes('=HYPERLINK'))
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.ZenCSV.parse(normal, ','))), rows)
})

test('日期选择器关闭前保存回调，不在 ctx 清空后解引用', () => {
  const picker = read('public/zen/components/picker.js')
  assert.ok(picker.includes('var callback = ctx.cb'))
  assert.doesNotMatch(picker, /close\(\);\s*ctx\.cb/)
  assert.ok(picker.includes("layer.trapTab") || picker.includes('onKeyDown'))
})
