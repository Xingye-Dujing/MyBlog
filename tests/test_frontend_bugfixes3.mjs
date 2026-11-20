/* 第三轮前端回归：样式转义绕过、侧栏 NaN、可视化统计与粘贴解析（node:test）
 * 运行：node --test tests/test_frontend_bugfixes3.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8')

test('侧栏宽度解析拒绝 NaN', () => {
  const src = read('src/views/HomeView.vue')
  assert.match(src, /Number\.isFinite\(width\)/)
  assert.doesNotMatch(src, /Math\.max\(minSidebarWidth, Math\.min\(maxSidebarWidth, Number\(savedWidth\)\)\)/)
})

function loadParse() {
  const sandbox = {}
  sandbox.globalThis = sandbox
  vm.runInNewContext(read('third_party/zenviz-core/core/zenviz-parse.js'), sandbox)
  return sandbox.ZenvizParse
}

test('引号内的分隔符不参与分隔符探测', () => {
  const { textData } = loadParse()
  const result = textData('"a,b";"c,d"\n"x,y";10')
  assert.equal(JSON.parse(JSON.stringify(result.headers)).length, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(result.headers)), ['a,b', 'c,d'])
  assert.deepEqual(JSON.parse(JSON.stringify(result.rows[0])), ['x,y', '10'])
})

test('逗号分隔的引号字段不再整列错位', () => {
  const { textData } = loadParse()
  const result = textData('name,place\nAlice,"Beijing, China"')
  assert.deepEqual(JSON.parse(JSON.stringify(result.headers)), ['name', 'place'])
  assert.deepEqual(JSON.parse(JSON.stringify(result.rows[0])), ['Alice', 'Beijing, China'])
})

test('送复盘统计从 {headers, rows} 读取真实行列数', () => {
  const src = read('third_party/zenviz-core/profiles/omm/tail.js')
  assert.match(src, /Array\.isArray\(data\.rows\) \? data\.rows : \[\]/)
  assert.match(src, /Array\.isArray\(data\.headers\) \? data\.headers\.length : 0/)
  const shipped = read('public/omm-visualization.html')
  assert.match(shipped, /Array\.isArray\(data\.rows\) \? data\.rows : \[\]/)
})
