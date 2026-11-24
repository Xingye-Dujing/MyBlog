/* 设计系统契约：文档齐备、样式入口统一、组件词汇可复用、开发者技能已接线。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'

const ROOT = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const exists = (p) => existsSync(new URL(p, ROOT))
const products = [
  'ai', 'annotate', 'corpus', 'data', 'english', 'hub', 'latex', 'mdforge', 'message',
  'planner', 'redact', 'search', 'visualization', 'writer', 'video', 'table',
  'zencard', 'zenflow', 'zenclip', 'zenreview', 'zenbackup',
]

test('设计系统文档齐备且可索引', () => {
  const docs = ['README.md', 'design-tokens.md', 'components.md',
    'shared-modules.md', 'product-guide.md', 'skills.md']
  for (const name of docs) {
    const path = `public/docs/${name}`
    assert.ok(exists(path), `缺少文档 ${path}`)
    assert.ok(read(path).length > 200, `${path} 内容过短`)
  }
  const index = read('public/docs/README.md')
  for (const name of docs.slice(1)) {
    assert.ok(index.includes(name), `索引缺少 ${name}`)
  }
})

test('每个产品只通过统一入口与自身产品样式接入', () => {
  for (const id of products) {
    const html = read(`public/omm-${id}.html`)
    assert.ok(html.includes('zen/zen.css'), `${id} 未引入统一入口`)
    const cssPath = `public/zen/products/${id}.css`
    if (exists(cssPath)) {
      assert.ok(html.includes(`zen/products/${id}.css`), `${id} 未引入产品样式`)
      assert.ok(read(cssPath).trimStart().startsWith('@layer zen.product'), `${id} 样式未声明产品层`)
    } else {
      assert.ok(!html.includes('zen/products/'), `${id} 引用了不存在的样式`)
    }
  }
})

test('每个产品都有统一风格的产品图标', () => {
  const source = read('public/omm-icons.js')
  const ids = new Set(
    [...source.matchAll(/^ {4}([a-z][a-z0-9]*):\s*$/gm)].map((m) => m[1]),
  )
  // hub 用品牌 icon.ico；lambda 的入口是 index.html，不在上面的 omm-* 列表里。
  for (const id of [...products.filter((id) => id !== 'hub'), 'lambda']) {
    assert.ok(ids.has(id), `${id} 缺少 SVG 产品图标`)
  }
  assert.equal(
    (source.match(/<svg class="app-icon"/g) || []).length,
    ids.size,
    '每个产品图标都应使用统一的 app-icon 类',
  )
})

test('所有产品统一接入 OMM-ZEN UI 核心组件（可选件按需加载）', () => {
  const required = [
    'zen/components/layer.js',
    'zen/components/toast.js',
    'zen/components/dialog.js',
    'zen/components/select.js',
    'zen/components/menu.js',
    'zen/components/shortcuts.js',
    'zen/components/index.js',
  ]
  const all = [...products, 'hub']
  for (const id of all) {
    const html = read(`public/omm-${id}.html`)
    for (const asset of required) {
      assert.ok(html.includes(asset), `${id} 未接入核心组件 ${asset}`)
    }
    assert.ok(html.indexOf('zen/components/index.js') < html.indexOf('omm-desktop.js'),
      `${id} 的 zen/ui 必须在桥接脚本之前加载`)
    // 可选组件不得被不需要的产品引用
    if (!['planner', 'zenreview', 'english'].includes(id)) {
      assert.ok(!html.includes('zen/components/picker.js'), `${id} 不必要地加载了 picker`)
    }
  }
})

test('样式入口只加载核心层，能力包按需引用', () => {
  const entry = read('public/zen/zen.css')
  const imports = [...entry.matchAll(/@import\s+url\("([^"]+)"\)/g)].map((m) => m[1])
  for (const feature of ['grid', 'doc', 'learning', 'cloud', 'tool']) {
    assert.ok(!imports.some((p) => p.includes(`features/${feature}.css`)),
      `${feature} 不应由核心入口全量加载`)
  }
  assert.ok(exists('public/zen/canvas/canvas.css'), '缺少统一画布样式包')
  assert.ok(!imports.some((p) => p.includes('canvas/canvas.css')), '画布样式不应进入核心入口')
})

test('ZEN 界面圆角只允许共享令牌或语义圆形', () => {
  const files = readdirSync(new URL('public/zen/', ROOT), { recursive: true })
    .filter((name) => String(name).endsWith('.css'))
    .map((name) => `public/zen/${String(name).replaceAll('\\\\', '/')}`)
  files.push('public/lib/zen-link.js', 'public/omm-mdforge.html', 'public/index.html')
  for (const name of readdirSync(new URL('public/', ROOT))) {
    const file = String(name).replaceAll('\\\\', '/')
    if (/^omm-[^/]+\.html$/.test(file)) files.push(`public/${file}`)
  }
  if (exists('third_party/zenviz-core/core/zenviz.css')) {
    files.push('third_party/zenviz-core/core/zenviz.css')
  }
  const embed = read('public/omm-embed.js')
  assert.ok(embed.includes("'--zen-radius': '0px'"), '嵌入桥必须固定 ZEN 直角令牌')
  assert.ok(!/data\.radius/.test(embed), '嵌入桥不得接受父窗口圆角覆盖')
  const fixed = /border-radius\s*:\s*(?:[1-9]\d*(?:\.\d+)?px|99px|999px)/i
  const derived = /border-radius\s*:\s*calc\(var\(--(?:zen-)?radius\)\s*[+*-]\s*[0-9.]+\s*px\)/i
  const tokenOverride = /--(?:zen-)?radius\s*:\s*[1-9]\d*(?:\.\d+)?px/i
  for (const file of new Set(files)) {
    const text = read(file)
    assert.ok(!fixed.test(text), `${file} 写死了非零界面圆角`)
    assert.ok(!derived.test(text), `${file} 从圆角令牌派生出非零圆角`)
    assert.ok(!tokenOverride.test(text), `${file} 覆盖了 ZEN 圆角令牌`)
  }
})

test('Lambda 与 MdForge 不写死第二套产品色板', () => {
  const lambda = read('public/zen/products/lambda.css')
  assert.ok(lambda.includes('--bg:var(--zen-paper)'), 'Lambda 底色必须复用 ZEN 令牌')
  assert.doesNotMatch(lambda, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'Lambda 不得写死产品色值')
  assert.doesNotMatch(lambda, /^\s*'\s*\+/m, 'Lambda CSS 不得残留 JavaScript 片段')
  const mdforge = read('public/zen/products/mdforge.css')
  assert.doesNotMatch(mdforge, /--(?:bg|paper|text|border|hover|active|accent)[\w-]*\s*:\s*(?:#|rgba?\()/i,
    'MdForge 不得写死第二套 ZEN 色彩令牌')
})

test('候选区不再使用浏览器原生 select 弹窗', () => {
  const files = [
    ...products.filter((id) => id !== 'hub').map((id) => `public/omm-${id}.html`),
    'public/lib/zen-video.js',
    'public/lib/zen-table.js',
    'public/lib/zen-link.js',
  ]
  for (const file of files) {
    const text = read(file)
    for (const m of text.matchAll(/<select\b[^>]*>/g)) {
      assert.ok(/data-zen-select/.test(m[0]),
        `${file} 存在未接入 OMM-ZEN UI 的 select: ${m[0].slice(0, 120)}`)
      assert.ok(!/data-omm-select/.test(m[0]),
        `${file} 仍使用已废弃的 data-omm-select: ${m[0].slice(0, 120)}`)
    }
  }
})

test('产品不再使用浏览器原生弹窗', () => {
  const files = [
    ...products.filter((id) => id !== 'hub').map((id) => `public/omm-${id}.html`),
    'public/omm-hub.html', 'public/index.html',
    'public/lib/zen-table.js', 'public/lib/zen-video.js',
    'public/omm-desktop.js', 'public/omm-share.js', 'public/omm-hub.js',
  ]
  const native = /(?<![.\w])(?:window\.)?(?:confirm|prompt|alert)\s*\(\s*['"`]/
  for (const file of files) {
    const text = read(file)
    assert.ok(!native.test(text), `${file} 仍在使用浏览器原生弹窗`)
  }
})

test('产品页不内联样式，视觉资产全部来自 zen/', () => {
  const files = [
    ...products.map((id) => `public/omm-${id}.html`),
    'public/index.html',
  ]
  for (const file of files) {
    const text = read(file)
    assert.ok(!/^[ \t]*<style\b/im.test(text), `${file} 存在内联 <style>`)
  }
})

test('组件词汇集中在共享层', () => {
  const primitives = read('public/zen/foundation/primitives.css')
  for (const cls of ['panel', 'menu-btn', 'dropdown', 'dd-item', 'seg', 'hint']) {
    assert.ok(primitives.includes('.' + cls), `共享层缺少组件 ${cls}`)
  }
  // 模态壳已统一到共享组件（不再有产品私有的 .modal-box）。
  const components = read('public/zen/components/components.css')
  assert.ok(components.includes('.zenui-modal'), '共享层缺少模态壳 .zenui-modal')
  for (const file of ['grid', 'doc', 'learning', 'cloud', 'tool']) {
    assert.ok(exists(`public/zen/features/${file}.css`), `缺少能力样式 ${file}`)
  }
})

test('开发者技能已接入设计系统文档', () => {
  const skills = read('public/agent_workspace/omm_skills.py')
  assert.ok(skills.includes("id='omm.zen.dev'"))
  assert.ok(skills.includes('docs/product-guide.md'))
  assert.ok(skills.includes('docs/design-tokens.md'))
})
