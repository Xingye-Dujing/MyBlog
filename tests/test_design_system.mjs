/* 设计系统契约：文档齐备、样式入口统一、组件词汇可复用、开发者技能已接线。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

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
    assert.ok(html.includes('zen-style/zen.css'), `${id} 未引入统一入口`)
    const cssPath = `public/zen-style/products/${id}.css`
    if (exists(cssPath)) {
      assert.ok(html.includes(`zen-style/products/${id}.css`), `${id} 未引入产品样式`)
      assert.ok(read(cssPath).trimStart().startsWith('@layer zen.product'), `${id} 样式未声明产品层`)
    } else {
      assert.ok(!html.includes('zen-style/products/'), `${id} 引用了不存在的样式`)
    }
  }
})

test('组件词汇集中在共享层', () => {
  const primitives = read('public/zen-style/primitives.css')
  for (const cls of ['panel', 'modal-box', 'menu-btn', 'dropdown', 'dd-item', 'seg', 'hint']) {
    assert.ok(primitives.includes('.' + cls), `共享层缺少组件 ${cls}`)
  }
  for (const file of ['grid', 'doc', 'canvas', 'canvas-framework', 'learning', 'cloud', 'tool']) {
    assert.ok(exists(`public/zen-style/features/${file}.css`), `缺少能力样式 ${file}`)
  }
})

test('开发者技能已接入设计系统文档', () => {
  const skills = read('public/agent_workspace/omm_skills.py')
  assert.ok(skills.includes("id='omm.zen.dev'"))
  assert.ok(skills.includes('docs/product-guide.md'))
  assert.ok(skills.includes('docs/design-tokens.md'))
})
