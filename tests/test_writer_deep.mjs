/* Writer 深改专项测试（node:test）
 * 运行：node tests/test_writer_deep.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../public/omm-writer.html', import.meta.url), 'utf8')

function scripts(text) {
  const out = []
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(text))) out.push(m[1])
  return out
}

test('Writer 引入深改所需模块与样式', () => {
  assert.ok(src.includes('src="lib/zen-card.js"'))
  assert.ok(src.includes('src="lib/zen-chart.js"'))
  assert.ok(src.includes('href="zen/zen.css"'))
  assert.ok(src.includes('id="zw-zen-modal"'))
  assert.ok(src.includes('id="zw-zen-body"'))
  assert.ok(src.includes('id="zw-zen-close"'))
})

test('右键菜单含三个新动作', () => {
  for (const action of ['ctxZenCard', 'ctxZenChart', 'ctxTimeMachine']) {
    assert.ok(src.includes(`data-action="${action}"`), `缺少菜单项 ${action}`)
    assert.ok(src.includes(`case '${action}':`), `缺少分发分支 ${action}`)
  }
})

test('右键只有产品富菜单，画布动作由引擎统一承担', () => {
  for (const action of ['ctxSelectAll', 'ctxFitView', 'ctxAutoLayout']) {
    assert.ok(src.includes(`data-action="${action}"`), `缺少菜单项 ${action}`)
    assert.ok(src.includes(`case '${action}':`), `缺少分发分支 ${action}`)
  }
  assert.match(src, /contextMenu: false/)
  assert.match(src, /ZenWriterCanvas\.fitView\(opts\)/)
  assert.match(src, /ZenWriterCanvas\.focusNode\(node\.id\)/)
  assert.doesNotMatch(src, /ctxLeftPress|bandCentreY/)
  assert.doesNotMatch(src, /workspace\.addEventListener\('contextmenu'/)
  assert.doesNotMatch(src, /mousedown', \(e\) => \{\s*if \(e\.button === 2\)/)
})

test('ZenWriterDeep 提供三个入口且挂载全局', () => {
  assert.ok(src.includes('const ZenWriterDeep = {'))
  assert.ok(src.includes('openCardPicker(world)'))
  assert.ok(src.includes('openChart(world)'))
  assert.ok(src.includes('async openTimeMachine()'))
  assert.ok(src.includes('window.ZenWriterDeep = ZenWriterDeep'))
})

test('引用节点写入出处与批注，图表节点使用自包含 data URL', () => {
  assert.ok(src.includes("'<p><b>' + this.esc(c.content) + '</b></p>'"))
  assert.ok(src.includes("'<blockquote>' + this.esc(c.note) + '</blockquote>'"))
  assert.ok(src.includes('出处：'))
  assert.ok(src.includes("srcMode: 'embed'"))
  assert.ok(src.includes('window.ZenChart.toDataURL(spec)'))
})

test('时间机器走工作台快照接口并二次确认', () => {
  assert.ok(src.includes('dk.listSnapshots()'))
  assert.ok(src.includes('/__omm/fs/snapshot?app='))
  assert.ok(src.includes('await dk.restore(data.snapshot)'))
  assert.ok(src.includes('showConfirm('))
})

test('Writer 静态样式全部外置，9 个批量色块有中文可访问名称', () => {
  assert.doesNotMatch(src, /\sstyle="/, 'Writer 仍残留静态 style 属性')
  const swatches = Array.from(src.matchAll(/<button[^>]*class="ctx-batch-sw[^"]*"[^>]*>/g), (match) => match[0])
  assert.equal(swatches.length, 9)
  for (const swatch of swatches) {
    const label = /aria-label="([^"]+)"/.exec(swatch)
    assert.ok(label && /[\u4e00-\u9fff]/.test(label[1]), `批量色块缺少中文名称: ${swatch}`)
  }
  assert.match(src, /class="zw-export-image" width="100%"/)
  assert.doesNotMatch(src, /<img[^>]+style=/)
})

test('Writer 色阶由共享令牌驱动，涂鸦直径只写一个自定义属性', () => {
  const css = readFileSync(new URL('../public/zen/products/writer.css', import.meta.url), 'utf8')
  const declarations = css.split('\n').filter((line) => /^\s*(?:background|color|border|box-shadow|fill|stroke)\b/.test(line)).join('\n')
  assert.doesNotMatch(declarations, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  assert.match(css, /\[data-color='#00806a'\][\s\S]{0,120}var\(--zen-swatch-teal\)/)
  assert.match(css, /\[data-color='#333333'\][\s\S]{0,120}var\(--zen-swatch-graphite\)/)
  assert.match(src, /setProperty\('--zw-doodle-dot-size', d \+ 'px'\)/)
  assert.match(css, /width: var\(--zw-doodle-dot-size, 4px\)/)
  assert.match(css, /height: var\(--zw-doodle-dot-size, 4px\)/)
  assert.doesNotMatch(src, /<i style="width:/)
})

test('Writer 主脚本及新增逻辑语法可解析', () => {
  const all = scripts(src)
  assert.ok(all.length >= 3, '脚本数量异常')
  const main = all.reduce((a, b) => (a.length >= b.length ? a : b))
  assert.ok(main.includes('const ZenWriterDeep'), '取到的不是主脚本')
  assert.doesNotThrow(() => new Function(main), 'Writer 主脚本存在语法错误')
})

test('新增的深改代码没有通配符 postMessage', () => {
  assert.doesNotMatch(src, /ZenWriterDeep[\s\S]{0,4000}postMessage\([^,]+,\s*'\*'/)
})

test('Writer HTML 导出转义标题和图片属性，并最终委托共享清洗器', () => {
  const block = src.slice(src.indexOf("} else if (fmt === 'html')"), src.indexOf("} else if (fmt === 'json')"))
  assert.match(block, /escapeHtml\(getTitleText\(node\)\)/)
  assert.match(block, /escapeHtml\(img\.src\)/)
  assert.match(block, /escapeHtml\(node\.dataset\.fileName \|\| '插图'\)/)
  assert.match(block, /window\.ZenHTML\.sanitize\(body/)
  assert.doesNotMatch(block, /<h2>\$\{t\}<\/h2>/)
})

test('Writer 存档恢复消息使用精确父窗口 origin，不再回退通配符', () => {
  const block = src.slice(src.indexOf('async restoreFromArchive'), src.indexOf('async restoreFromArchive') + 4000)
  assert.match(block, /ZenUtil\.parentTargetOrigin\(\)/)
  assert.doesNotMatch(block, /return '\*'/)
  assert.doesNotMatch(src, /postMessage\([\s\S]{0,300}?,\s*'\*'/)
})

test('Writer 整库快照收集 link 资产，导入时重映射且缺资产明确失败', () => {
  const names = ['collectLinkedAssetIds', 'prepareLibraryAssetImport']
  let nextId = 0
  const context = vm.createContext({
    Set,
    AssetStore: { newId: () => 'asset-new-' + (++nextId) },
  })
  const functions = names.map((name) => {
    const marker = name === 'prepareLibraryAssetImport' ? `function ${name}(` : `function ${name}(`
    const start = src.indexOf(marker)
    assert.notEqual(start, -1, `${name} not found`)
    const open = src.indexOf('{', start)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
    }
    throw new Error(`unbalanced ${name}`)
  })
  vm.runInContext(functions.join('\n'), context)
  const api = vm.runInContext('({ collectLinkedAssetIds, prepareLibraryAssetImport })', context)
  assert.deepEqual(Array.from(api.collectLinkedAssetIds({
    a: { nodes: [{ srcMode: 'link', assetId: 'old' }, { srcMode: 'url', src: 'https://example.com' }] },
    b: { nodes: [{ srcMode: 'link', assetId: 'old' }] },
  })), ['old'])
  const plan = api.prepareLibraryAssetImport({
    assets: [{ id: 'old', dataUrl: 'data:image/png;base64,AA==' }],
  })
  const first = plan.remapNode({ srcMode: 'link', assetId: 'old' })
  const second = plan.remapNode({ srcMode: 'link', assetId: 'old' })
  assert.equal(first.assetId, second.assetId)
  assert.notEqual(first.assetId, 'old')
  assert.equal(plan.assets().length, 1)
  assert.throws(() => api.prepareLibraryAssetImport({ assets: [] }).remapNode({ srcMode: 'link', assetId: 'old' }), /资产缺失/)
  assert.match(src, /const assets = await AssetStore\.exportMany\(linkedIds\)/)
  assert.match(src, /await AssetStore\.putMany\(records/)
  assert.match(src, /missingAssetIds/)
  assert.match(src, /previousAssets\.filter\(Boolean\)/)
  assert.doesNotMatch(src, /for \(const srcId of Object\.keys\(obj\.docs\)[\s\S]{0,1600}?ZWStore\.writeDoc\(id/)
})
