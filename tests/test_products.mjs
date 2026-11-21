/* 产品集成测试：验证新增单文件产品结构完整、模块脚本可解析、
 * 脚本中引用的 DOM id 全部存在，且没有开发期残留表达式。
 * 运行：node tests/test_products.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const ROOT = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')

const PRODUCTS = [
  {
    file: 'public/omm-zencard.html',
    title: '间隔复习',
    modules: ['lib/zen-card.js', 'lib/zen-srs.js'],
    ids: ['review-area', 'card-list', 'add-card', 'import-btn', 'export-btn', 'tabs', 'graph-canvas', 'graph-detail'],
  },
  {
    file: 'public/omm-zenflow.html',
    title: '自动化编排',
    modules: ['lib/zen-card.js', 'lib/zen-flow.js'],
    ids: ['rule-list', 'save-rule', 'add-action', 'run-btn', 'effect-list', 'editor-title'],
  },
  {
    file: 'public/omm-zenclip.html',
    title: '网页剪藏',
    modules: ['lib/zen-card.js'],
    ids: ['clip-text', 'make-card', 'preview-card', 'clip-list', 'download-btn'],
  },
  {
    file: 'public/omm-zenreview.html',
    title: '复盘报告',
    modules: ['lib/zen-card.js', 'lib/zen-review.js'],
    ids: ['gen-btn', 'report-out', 'range-from', 'range-to', 'copy-btn', 'tocards-btn'],
  },
  {
    file: 'public/omm-zenbackup.html',
    title: '统一备份',
    modules: ['lib/zen-backup.js'],
    ids: ['scan-btn', 'manifest-list', 'pack-btn', 'import-file', 'diff-out', 'restore-btn'],
  },
]

function moduleBody(html) {
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/)
  assert.ok(m, '找不到 <script type="module">')
  return m[1]
}

for (const p of PRODUCTS) {
  test(`${p.file}：文件与标题`, () => {
    assert.ok(existsSync(new URL(p.file, ROOT)), '文件不存在')
    const html = read(p.file)
    assert.ok(html.includes(`<title>${p.title}</title>`), 'title 不匹配')
    assert.ok(html.includes('zen-style/zen.css'), '未引入共用样式')
    assert.ok(html.includes('omm-embed.js'), '未引入 hub 桥接')
    assert.ok(html.includes('omm-share.js'), '未引入共享总线')
  })

  test(`${p.file}：模块脚本语法可解析`, () => {
    const body = moduleBody(read(p.file))
    const stripped = body.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')
    assert.doesNotThrow(() => new Function(stripped), '模块脚本存在语法错误')
  })

  test(`${p.file}：引用了正确的逻辑模块`, () => {
    const body = moduleBody(read(p.file))
    p.modules.forEach((m) => {
      assert.ok(body.includes(`from './${m}'`), `缺少模块 ${m}`)
      assert.ok(existsSync(new URL(`public/${m}`, ROOT)), `模块文件 ${m} 不存在`)
    })
  })

  test(`${p.file}：脚本引用的 DOM id 全部存在`, () => {
    const html = read(p.file)
    const body = moduleBody(html)
    const ids = new Set()
    for (const re of [/\$\('([^']+)'\)/g, /getElementById\('([^']+)'\)/g]) {
      let m
      while ((m = re.exec(body))) ids.add(m[1])
    }
    const declared = new Set()
    let dm
    const idRe = /\bid="([^"]+)"/g
    while ((dm = idRe.exec(html))) declared.add(dm[1])
    const missing = [...ids].filter((id) => !declared.has(id))
    assert.deepEqual(missing, [], '未定义的 DOM id: ' + missing.join(', '))
  })

  test(`${p.file}：包含关键交互元素且无开发残留`, () => {
    const html = read(p.file)
    p.ids.forEach((id) => assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`))
    assert.doesNotMatch(html, /ZenCard\s*===\s*null|Zen(Card|Flow|SRS|Backup|Review)\s*&&/)
  })
}

test('既有 12 个产品仍全部引入共享桥接脚本（回归护栏）', () => {
  const names = ['annotate', 'corpus', 'data', 'english', 'latex', 'mdforge', 'message', 'planner', 'redact', 'search', 'visualization', 'writer']
  names.forEach((n) => {
    const html = read(`public/omm-${n}.html`)
    assert.ok(html.includes('omm-share.js'), `omm-${n}.html 缺少 omm-share.js`)
    assert.ok(html.includes('lib/zen-link.js'), `omm-${n}.html 缺少 zen-link 桥接`)
    assert.ok(/<title>/.test(html), `omm-${n}.html 缺少 title`)
  })
})

test('zen-link 仅信任同源与 loopback origin', () => {
  const src = read('public/lib/zen-link.js')
  const start = src.indexOf('function isTrusted(')
  assert.notEqual(start, -1)
  const open = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break }
  }
  const fn = new Function('location', 'URL', `return (${src.slice(start, end)})`)(
    { origin: 'https://example.com' }, URL
  )
  assert.equal(fn('https://example.com'), true)
  assert.equal(fn('http://127.0.0.1:8321'), true)
  assert.equal(fn('https://evil.example'), false)
  assert.equal(fn('null'), false)
})

test('核心模块均挂载全局并导出命名符号', () => {
  const mods = {
    'public/lib/zen-card.js': 'ZenCard',
    'public/lib/zen-srs.js': 'ZenSRS',
    'public/lib/zen-flow.js': 'ZenFlow',
    'public/lib/zen-review.js': 'ZenReview',
    'public/lib/zen-backup.js': 'ZenBackup',
  }
  for (const [file, name] of Object.entries(mods)) {
    const src = read(file)
    assert.ok(src.includes(`export const ${name}`), `${file} 未导出 ${name}`)
    assert.ok(src.includes(`globalThis.${name} = ${name}`), `${file} 未挂载全局`)
  }
})
