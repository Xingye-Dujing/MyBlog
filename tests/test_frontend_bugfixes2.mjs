/* 第二轮前端缺陷回归：共享消息表、链接监听、日程/表格数据容错（node:test）
 * 运行：node --test tests/test_frontend_bugfixes2.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8')

test('共享已读表在裁剪后仍无原型链（constructor 消息不会丢失）', () => {
  const src = read('public/omm-share.js')
  assert.match(src, /seen: Object\.create\(null\)/)
  assert.doesNotMatch(src, /state\.seen = \{\}/)
  assert.match(src, /state\.seen = Object\.create\(null\)[\r\n]+\s*ack\.forEach/)
})

test('patchLinks 只安装一次，避免重复打开插件', () => {
  const src = read('public/omm-share.js')
  assert.match(src, /function patchLinks\(\) \{[\r\n]+\s*if \(state\.linksPatched\) return/)
  assert.match(src, /linksPatched: false/)
})

test('日程加载不会因为一条 null 事件/规则而清空全部数据', () => {
  const src = read('public/omm-planner.html', 'utf8')
  assert.match(src, /const x = e && typeof e === 'object' \? e : \{\}/)
  assert.match(src, /const x = r && typeof r === 'object' \? r : \{\}/)
  assert.match(src, /src\[ds\]\.filter\(Boolean\)\.map\(normEvent\)/)
  assert.match(src, /rb\[k\]\.filter\(Boolean\)\.map\(normRule\)/)
  assert.match(src, /ev\[ds\]\.filter\(Boolean\)\.map\(normEvent\)/)
})

test('多列 UPDATE 用原始行计算右值，SET a=b,b=a 不再得到 (2,2)', () => {
  const src = read('public/omm-data.html')
  assert.match(src, /var original = r\.slice\(\)/)
  assert.match(src, /r\[t\.col\] = evOp\(t\.val, original, ut\)/)
  assert.doesNotMatch(src, /r\[ci\] = evOp\(s2\.val, r, ut\)/)
})

test('JSON 导入跳过 null 行而不是整体失败', () => {
  const src = read('public/omm-data.html')
  assert.match(src, /arr = arr\.filter\(function \(r\) \{ return r !== null && typeof r === 'object' \}\)/)
})
