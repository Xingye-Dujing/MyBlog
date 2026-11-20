/* 安全补漏回归测试（node:test）
 * 运行：node --test tests/test_security_fixes.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const source = readFileSync(new URL('src/composables/useMarkdown.js', ROOT), 'utf8')
const start = source.indexOf('const SAFE_STYLE_PROPS')
const end = source.indexOf('function sanitizeElement(')
assert.notEqual(start, -1)
assert.notEqual(end, -1)
const code = source.slice(start, end) + '\nreturn { safeStyle }'
const { safeStyle } = vm.runInNewContext(`(function () { ${code} })()`, { Set, String, Array })

test('内联样式白名单挡住覆盖整页的定位属性', () => {
  const cleaned = safeStyle(
    'position:fixed;inset:0;z-index:2147483647;background:#fff;pointer-events:auto;color:red'
  )
  assert.equal(cleaned, 'color:red')
})

test('常规排版样式仍然保留', () => {
  assert.equal(safeStyle('height:1.2em;color:#333'), 'height:1.2em;color:#333')
  assert.equal(safeStyle('background:url(javascript:alert(1));color:red'), 'color:red')
})
