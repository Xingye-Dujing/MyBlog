/* AI 工作区恢复、流隔离与产物交互回归测试。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ai = readFileSync(new URL('../public/omm-ai.html', import.meta.url), 'utf8')

function extractFunction(text, name) {
  const asyncStart = text.indexOf('async function ' + name + '(')
  const start = asyncStart >= 0 ? asyncStart : text.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, name + ' 未找到')
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error('括号不平衡: ' + name)
}

function functions(names, sandbox) {
  const code = names.map((name) => extractFunction(ai, name)).join('\n')
  return vm.runInNewContext(`(function () { ${code}\nreturn { ${names.join(', ')} }; })()`, sandbox)
}

function rawElement() {
  return {
    children: [], dataset: {}, disabled: false, textContent: '', innerHTML: '', className: '',
    listeners: {},
    appendChild(child) { this.children.push(child) },
    querySelector() { return null },
    querySelectorAll() { return [] },
    addEventListener(type, fn) { this.listeners[type] = fn },
    remove() {}, focus() {}, click() {}
  }
}
function element() {
  const node = rawElement()
  node.ops = rawElement()
  node.querySelector = (selector) => selector === '.ops' ? node.ops : null
  return node
}

function baseSandbox(overrides = {}) {
  const chat = element()
  const S = {
    conv: '', generation: 1, busy: false, abort: null, key: 'temp-key', provider: 'deepseek',
    model: 'deepseek-chat', base: 'https://deepseek.test', skill: 'omm.zen.ai',
    artifacts: {}, questions: {}, applyResults: {}, liveToken: '', liveResolve: null
  }
  const controls = { btnSend: element(), btnStop: element(), chat }
  const stored = {}
  return {
    S, chat, controls,
    window: { OMMDesktop: {}, OMMShare: {}, ZenUI: {} },
    document: { createElement: element, getElementById: (id) => controls[id] || element() },
    $: (id) => controls[id] || element(),
    ZenUtil: {
      download: () => true, esc: String,
      getJSON: (key, fallback) => Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : fallback,
      setJSON: (key, value) => { stored[key] = value; return true },
      uid: (prefix) => (prefix || '') + 'test',
    },
    esc: String, encodeURIComponent,
    toast() {}, status() {}, meta() {}, switchTab() {}, refreshConversations() {},
    addMessage() { return element() }, toolEvent() {}, thinkEvent() {}, appendText() {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    Promise, Date, Math, String, Object, Array, Number, AbortController,
    setTimeout: () => 1, clearTimeout() {},
    ...overrides
  }
}

test('旧 Hub 的 radius payload 不能改写 AI 页面圆角令牌', () => {
  const calls = []
  const { setTheme } = functions(['setTheme'], {
    document: { documentElement: { dataset: {}, style: { setProperty: (...args) => calls.push(args) } } }
  })
  setTheme({ theme: 'dark', radius: 28, accent: '#fff' })
  assert.equal(calls.some(([name]) => name === '--radius' || name === '--zen-radius'), false)
  assert.doesNotMatch(ai, /payload\.radius/)
})

test('question answer 重新携带 provider/model/baseUrl 与本次内存 key', async () => {
  let request
  const sb = baseSandbox({
    fetch: async (_url, options) => {
      request = options
      return { ok: true, json: async () => ({ events: [] }) }
    }
  })
  sb.S.conv = 'conv_1'
  const { questionCard } = functions(['questionCard', 'isCurrentRun', 'consumeEvents'], sb)
  questionCard({ call_id: 'call_1', question: '继续？', options: ['是'] }, { id: 1, conv: 'conv_1' })
  const box = sb.chat.children[0]
  const button = box.children[0].children[0]
  await button.listeners.click()
  const body = JSON.parse(request.body)
  assert.equal(body.conversation_id, 'conv_1')
  assert.equal(body.provider, 'deepseek')
  assert.equal(body.model, 'deepseek-chat')
  assert.equal(body.baseUrl, 'https://deepseek.test')
  assert.equal(request.headers['X-Provider-Key'], 'temp-key')
})

test('历史会话渲染持久化 artifact，已应用产物没有重复应用入口', () => {
  const sb = baseSandbox()
  sb.S.conv = 'conv_history'
  const { renderConversation } = functions(
    ['renderConversation', 'artifactCard', 'questionCard', 'isCurrentRun'], sb
  )
  renderConversation({
    messages: [
      { role: 'assistant', blocks: [
        { type: 'text', text: '产物如下' },
        { type: 'tool_use', id: 'call_art', name: 'present_artifact', input: {
          kind: 'omm_markdown', title: '报告', summary: '摘要', payload: { filename: 'report.md', content: '# 报告' }
        } }
      ] },
      { role: 'tool', blocks: [{ type: 'tool_result', tool_use_id: 'call_art', content: { artifact_id: 'art_1' } }] }
    ]
  }, [
    { id: 'art_1', kind: 'omm_markdown', status: 'applied', payload: { filename: 'report.md', content: '# 报告' } },
    { id: 'art_2', kind: 'omm_markdown', status: 'proposed', payload: { filename: 'other.md', content: '# 其他' } }
  ])
  assert.equal(sb.S.artifacts['art_1'].status, 'applied')
  assert.equal(sb.S.artifacts['art_2'].status, 'proposed')
  const cards = sb.chat.children.filter((node) => node.className === 'artifact')
  assert.equal(cards.length, 2)
  const appliedButton = cards[0].ops.children[0]
  assert.equal(appliedButton.disabled, true)
  assert.equal(appliedButton.textContent, '已应用')
  assert.equal(appliedButton.listeners.click, undefined)
})

test('生成中新建会话会 abort 旧流，旧 artifact/question 事件被丢弃', async () => {
  let resolveLive
  let chatRequests = 0
  const sb = baseSandbox({
    requestLiveData: () => new Promise((resolve) => { resolveLive = resolve }),
    fetch: async () => { chatRequests++; return {} }
  })
  const { send, newChat, consumeEvents } = functions(
    ['send', 'newChat', 'consumeEvents', 'invalidateRun', 'cancelLiveData', 'isCurrentRun'], sb
  )
  const pending = send('旧问题')
  const oldController = sb.S.abort
  newChat()
  assert.equal(oldController.signal.aborted, true)
  resolveLive(null)
  await pending
  assert.equal(chatRequests, 0)
  assert.equal(sb.chat.children.length, 0)

  let artifactCalls = 0
  let questionCalls = 0
  sb.artifactCard = () => { artifactCalls++ }
  sb.questionCard = () => { questionCalls++ }
  consumeEvents([
    { type: 'artifact', artifact_id: 'old_art' },
    { type: 'question', call_id: 'old_question' }
  ], null, { id: 0, conv: 'old_conv' })
  assert.equal(artifactCalls, 0)
  assert.equal(questionCalls, 0)
})

test('切换会话在历史请求返回前即使旧请求失效', async () => {
  let resolveFetch
  const sb = baseSandbox({
    fetch: (url) => {
      const target = String(url)
      if (target.includes('/conversations/conv_old')) {
        return new Promise((resolve) => { resolveFetch = resolve })
      }
      return Promise.resolve({ json: async () => target.includes('/conversations/')
        ? { ok: true, conversation: { id: 'conv_new' }, messages: [] }
        : { artifacts: [] } })
    }
  })
  const { openConversation } = functions(['openConversation', 'invalidateRun', 'cancelLiveData'], sb)
  const oldOpening = openConversation('conv_old')
  const newOpening = openConversation('conv_new')
  await newOpening
  assert.equal(sb.S.conv, 'conv_new')
  resolveFetch({ json: async () => ({ ok: true, conversation: { id: 'conv_old' }, messages: [] }) })
  await oldOpening
  assert.equal(sb.S.conv, 'conv_new')
})

test('Web saveText 返回 false 时使用 ZenUtil.download，下载失败不假成功', async () => {
  const downloads = []
  const toasts = []
  const sb = baseSandbox({
    ZenUtil: {
      download: (...args) => { downloads.push(args); return true }, esc: String,
      getJSON: (_key, fallback) => fallback, setJSON: () => true,
    },
    toast: (message) => toasts.push(message)
  })
  sb.window.OMMDesktop.saveText = async () => false
  sb.S.conv = 'conv_save'
  sb.S.artifacts.art_save = { payload: { content: '# fallback' } }
  sb.S.applyResults.art_save = { action: 'save_text', filename: 'fallback.md', content: '# fallback', mime: 'text/markdown' }
  const { applyArtifact } = functions([
    'applyArtifact', 'saveArtifactText', 'markArtifactApplied', 'finalizeArtifact',
    'commitArtifact', 'pendingArtifactCommits', 'rememberArtifactCommit', 'isCurrentRun'
  ], sb)
  const button = element()
  await applyArtifact('art_save', button, element(), { id: 1, conv: 'conv_save' })
  assert.equal(downloads.length, 1)
  assert.equal(downloads[0][0], 'fallback.md')
  assert.equal(button.textContent, '已保存')
  assert.equal(toasts.some((text) => String(text).includes('已保存')), true)

  sb.ZenUtil.download = () => false
  sb.S.artifacts.art_fail = { payload: {} }
  sb.S.applyResults.art_fail = { action: 'save_text', filename: 'fail.md', content: 'x', mime: 'text/plain' }
  const failed = element()
  await applyArtifact('art_fail', failed, element(), { id: 1, conv: 'conv_save' })
  assert.equal(failed.disabled, false)
  assert.equal(toasts.some((text) => String(text).includes('已保存：fail.md')), false)
})

test('产物本地成功后提交失败会保留待同步状态并可重试', async () => {
  let fail = true
  const sb = baseSandbox({
    fetch: async () => ({ ok: !fail })
  })
  const { finalizeArtifact, flushArtifactCommits } = functions([
    'finalizeArtifact', 'markArtifactApplied', 'commitArtifact',
    'pendingArtifactCommits', 'rememberArtifactCommit', 'flushArtifactCommits'
  ], sb)
  const button = element()
  await finalizeArtifact('art_commit', button, '已保存', '已保存')
  assert.equal(button.disabled, true)
  assert.equal(JSON.stringify(sb.ZenUtil.getJSON('omm.ai.pending-commits.v1', [])), '["art_commit"]')
  fail = false
  await flushArtifactCommits()
  assert.equal(JSON.stringify(sb.ZenUtil.getJSON('omm.ai.pending-commits.v1', [])), '[]')
})

test('AI 注册共享接收器并把工作流加入下次对话上下文', async () => {
  let handler = null
  const sb = baseSandbox()
  sb.window.OMMShare = { onArtifact: (fn) => { handler = fn } }
  const { installSharedReceiver, receiveSharedArtifact, sharedArtifactContext } = functions([
    'installSharedReceiver', 'receiveSharedArtifact', 'sharedArtifactContext'
  ], sb)
  installSharedReceiver()
  assert.equal(typeof handler, 'function')
  await handler({ id: 'wf1', from: 'table', format: 'omm.table.workflow',
    title: '表格工作流', payload: { nodes: [{ id: 'n1' }] } })
  const context = sharedArtifactContext()
  assert.equal(context.length, 1)
  assert.equal(context[0].format, 'omm.table.workflow')
  assert.match(context[0].payload, /n1/)
  await assert.rejects(handler({ format: 'unsupported', payload: {} }), /不支持/)
})

test('AI 卡片包以 zen-card-pack 发送，等待共享结果并处理失败', async () => {
  let options
  let resolveSend
  const sb = baseSandbox()
  sb.window.OMMShare = {
    enabled: true,
    send: (value) => { options = value; return new Promise((resolve) => { resolveSend = resolve }) }
  }
  const { sendArtifactCards } = functions(['sendArtifactCards'], sb)
  let settled = false
  const sending = sendArtifactCards({ title: '卡片', cards: [{ content: '正文' }] }, 'writer')
    .then(() => { settled = true })
  assert.equal(options.format, 'zen-card-pack')
  assert.equal(options.to, 'writer')
  assert.equal(options.channel, undefined)
  assert.equal(settled, false)
  resolveSend({ id: 'message_1' })
  await sending
  assert.equal(settled, true)

  sb.window.OMMShare.send = async () => { throw new Error('频道拒绝') }
  await assert.rejects(sendArtifactCards({ cards: [] }, 'writer'), /频道拒绝/)
  sb.window.OMMShare.send = async () => false
  await assert.rejects(sendArtifactCards({ cards: [] }, 'writer'), /未接受/)
  assert.match(ai, /await window\.OMMShare\.send/)
})

test('卡片发送失败时保留重试，不显示已发送', async () => {
  const toasts = []
  const sb = baseSandbox({ toast: (message) => toasts.push(message) })
  sb.S.conv = 'conv_cards'
  sb.S.artifacts.art_cards = { payload: {} }
  sb.S.applyResults.art_cards = { action: 'publish_cards', title: '卡片', cards: [{ content: '正文' }] }
  sb.window.OMMShare = { enabled: true, send: async () => { throw new Error('频道拒绝') } }
  const { applyArtifact } = functions(
    ['applyArtifact', 'sendArtifactCards', 'markArtifactApplied', 'finalizeArtifact',
      'commitArtifact', 'pendingArtifactCommits', 'rememberArtifactCommit', 'isCurrentRun'], sb
  )
  const button = element()
  const ops = element()
  await applyArtifact('art_cards', button, ops, { id: 1, conv: 'conv_cards' })
  const send = ops.children[1]
  await send.listeners.click()
  assert.equal(send.disabled, false)
  assert.equal(send.textContent, '重试发送')
  assert.equal(button.textContent, '待发送')
  assert.equal(toasts.some((text) => String(text).includes('已发送到')), false)
  assert.equal(toasts.some((text) => String(text).includes('发送失败')), true)
})

test('live-data 只向带可信 Hub origin 的父窗口请求，不扩大独立页权限', async () => {
  const posted = []
  const parent = { postMessage: (...args) => posted.push(args) }
  const sb = baseSandbox({
    window: { parent },
    messageHubOrigin: '',
    S: { liveToken: '', liveResolve: null }
  })
  const { requestLiveData } = functions(['requestLiveData'], sb)
  assert.equal(await requestLiveData(), null)
  assert.equal(posted.length, 0)

  sb.messageHubOrigin = 'http://127.0.0.1:8300'
  const pending = requestLiveData()
  assert.equal(posted[0][0].type, 'omm:live-data-request')
  assert.equal(posted[0][1], 'http://127.0.0.1:8300')
  sb.S.liveResolve({ cards: [{ content: '可信数据' }] })
  assert.deepEqual(await pending, { cards: [{ content: '可信数据' }] })
  assert.match(ai, /event\.source !== window\.parent/)
  assert.match(ai, /isTrustedParentOrigin\(event\.origin\)/)
})
