/* AI 工作区读取用户真实产品数据的客户端契约测试（node:test）。
 * 验证 AI 页向 Hub 请求实时快照、超时降级，并把数据放进 chat 的 context。
 * 运行：node tests/test_ai_live_context.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const ai = readFileSync(new URL('public/omm-ai.html', ROOT), 'utf8')

function extractFunction(text, name) {
  const start = text.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, name + ' 未找到')
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error('括号不平衡: ' + name)
}

test('send 把实时快照放进 chat 请求的 context.omm_live', () => {
  assert.ok(ai.includes('var live = await requestLiveData();'))
  assert.ok(ai.includes('context: live ? { omm_live: live } : {}'))
})

test('requestLiveData 用带 token 的明确 origin 请求', () => {
  assert.ok(ai.includes("type: 'omm:live-data-request', token: S.liveToken"))
  assert.ok(ai.includes('window.parent.postMessage('))
  assert.ok(ai.includes('messageHubOrigin'))
  assert.doesNotMatch(ai, /postMessage\([^,]+,\s*'\*'/)
})

test('reply 只在 token 匹配时才兑现', () => {
  assert.ok(ai.includes("data.type === 'omm:live-data-reply' && data.token === S.liveToken"))
})

test('独立运行（无父窗口）时 requestLiveData 立即返回 null', async () => {
  const fn = vm.runInNewContext(
    extractFunction(ai, 'requestLiveData') + '\nrequestLiveData',
    {
      window: { parent: null },
      Promise,
      S: { liveToken: '', liveResolve: null },
      messageHubOrigin: '',
    }
  )
  // window.parent === window is the real standalone check; simulate with parent=window below.
  const standalone = vm.runInNewContext(
    extractFunction(ai, 'requestLiveData') + '\nrequestLiveData',
    (() => {
      const win = {}
      win.parent = win
      return { window: win, Promise, S: { liveToken: '', liveResolve: null }, messageHubOrigin: '' }
    })()
  )
  assert.equal(await standalone(), null)
  assert.equal(await fn(), null)
})
