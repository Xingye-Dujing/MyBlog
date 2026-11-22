/* 共享资产底线：产品不得自带视觉基座、Toast、原生弹窗或私有浮层。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const exists = (p) => existsSync(new URL(p, ROOT))

const PRODUCTS = [
  'ai', 'annotate', 'corpus', 'data', 'english', 'hub', 'latex', 'mdforge', 'message',
  'planner', 'redact', 'search', 'visualization', 'writer', 'video', 'table',
  'zencard', 'zenflow', 'zenclip', 'zenreview', 'zenbackup',
]
const PAGES = [...PRODUCTS.map((id) => `public/omm-${id}.html`), 'public/index.html']
const CORE = [
  'zen/components/layer.js', 'zen/components/toast.js', 'zen/components/dialog.js',
  'zen/components/select.js', 'zen/components/menu.js', 'zen/components/shortcuts.js',
  'zen/components/index.js',
]

test('每个产品都引用共享核心资产（含 Lambda 入口页）', () => {
  for (const page of PAGES) {
    const text = read(page)
    assert.ok(text.includes('zen/zen.css'), `${page} 未引入 zen.css`)
    for (const asset of CORE) {
      assert.ok(text.includes(asset), `${page} 未接入 ${asset}`)
    }
  }
})

test('产品不再自带 Toast 节点与 DOM 实现', () => {
  for (const page of PAGES) {
    const text = read(page)
    assert.ok(!/<div[^>]*\bid="(?:toast|notification)"/i.test(text),
      `${page} 仍自带 Toast/通知节点`)
    const domToast = /function\s+(?:toast|notify)\s*\([^)]*\)\s*\{(?:(?!ZenUI\.toast)[\s\S]){0,400}?\b(?:getElementById|\$|classList\.add)\b/.test(text)
    assert.ok(!domToast, `${page} 仍有操作 DOM 的私有 Toast 实现`)
  }
  for (const lib of ['public/lib/zen-table.js', 'public/lib/zen-video.js', 'public/lib/zen-link.js']) {
    assert.ok(!/zen-link-toast|getElementById\(['"]toast['"]\)/.test(read(lib)),
      `${lib} 仍自带 Toast 节点`)
  }
})

test('产品不使用原生弹窗与原生对话框元素', () => {
  for (const page of PAGES) {
    const text = read(page)
    assert.ok(!/(?<![.\w])(?:window\.)?(?:alert|confirm|prompt)\s*\(\s*['"`]/.test(text),
      `${page} 仍有原生弹窗`)
    assert.ok(!/<\s*dialog\b/i.test(text), `${page} 仍有 <dialog> 元素`)
    const nativeModals = [...text.matchAll(/\.showModal\s*\(/g)]
      .filter((m) => text.lastIndexOf('UIMgr', m.index) !== m.index - 5)
    assert.equal(nativeModals.length, 0, `${page} 仍调用原生 showModal`)
  }
})

test('zen/ 目录职责单一且名称互不重叠', () => {
  const dir = fileURLToPath(new URL('../public/zen/', import.meta.url))
  const folders = new Set(readdirSync(dir).filter((name) =>
    statSync(join(dir, name)).isDirectory()))
  for (const name of ['foundation', 'components', 'canvas', 'features', 'products']) {
    assert.ok(folders.has(name), `缺少职责目录 ${name}`)
  }
  for (const retired of ['styles', 'ui', 'base']) {
    assert.ok(!folders.has(retired), `已废弃目录 ${retired} 不应存在`)
  }
  assert.ok(exists('public/zen/zen.css'), '缺少统一样式入口')
})
