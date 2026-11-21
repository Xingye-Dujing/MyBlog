/* Writer 深改专项测试（node:test）
 * 运行：node tests/test_writer_deep.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../public/omm-writer.html', import.meta.url), 'utf8')

function scripts(text) {
  const out = []
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(text))) out.push(m[1])
  return out
}

test('Writer 引入深改所需模块与样式', () => {
  assert.ok(src.includes('src="zen-card.js"'))
  assert.ok(src.includes('src="zen-chart.js"'))
  assert.ok(src.includes('href="zen-style/zen.css"'))
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
