/* Markdown 安全集成回归：博客必须复用共享清洗器，不能重新长出私有副本。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')

test('Markdown 渲染委托共享 ZenHTML 清洗器', () => {
  const source = read('src/composables/useMarkdown.js')
  assert.match(source, /window\.ZenHTML\.sanitize\(/)
  assert.doesNotMatch(source, /function\s+(?:sanitizeHtml|safeStyle|sanitizeElement)\s*\(/)
})

test('博客入口在应用模块之前加载共享清洗器', () => {
  const html = read('index.html')
  const sanitizer = html.indexOf('lib/zen-html.js')
  const app = html.indexOf('/src/main.js')
  assert.ok(sanitizer >= 0)
  assert.ok(app > sanitizer)
})
