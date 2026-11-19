/* ZenReview 从工作台拉取数据的契约测试（node:test）。
 * 复用 omm:live-data-request/reply 协议，不弹 prompt、不用通配符 origin。
 * 运行：node tests/test_review_pull.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../public/omm-zenreview.html', import.meta.url), 'utf8')

test('ZenReview 有从工作台拉取按钮', () => {
  assert.ok(html.includes('id="pull-btn"'))
  assert.ok(html.includes("$('pull-btn').addEventListener('click', pullFromHub)"))
})

test('拉取复用 live-data 协议且用明确 origin', () => {
  assert.ok(html.includes("type: 'omm:live-data-request', token: token"))
  assert.ok(html.includes('window.parent.postMessage('))
  assert.ok(html.includes('hubOrigin'))
  assert.doesNotMatch(html, /postMessage\([^,]+,\s*'\*'/)
})

test('reply 只在 token 匹配且来源可信时才兑现', () => {
  assert.ok(html.includes("d.type === 'omm:live-data-reply' && d.token === pullToken"))
  assert.ok(html.includes('event.source !== window.parent'))
  assert.ok(html.includes('trustedParent(event.origin)'))
})

test('hubOrigin 只接受 loopback，否则回退同源', () => {
  const origin = vm.runInNewContext(
    html.slice(html.indexOf('const hubOrigin = (function ()'), html.indexOf('function trustedParent(')) + '\nhubOrigin',
    {
      URLSearchParams: class { get() { return null } },
      location: { search: '', origin: 'https://xingye-blog.xyz' },
      URL,
    }
  )
  assert.equal(origin, 'https://xingye-blog.xyz')
})
