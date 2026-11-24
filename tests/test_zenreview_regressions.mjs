/* ZenReview 回归测试：JSON 契约、本地日历日、Hub 信任/世代与跨产品导出。 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { ZenCard } from '../public/lib/zen-card.js'
import { ZenReview } from '../public/lib/zen-review.js'

const originalTZ = process.env.TZ
process.env.TZ = 'Asia/Shanghai'
after(() => {
  if (originalTZ === undefined) delete process.env.TZ
  else process.env.TZ = originalTZ
})

const html = readFileSync(new URL('../public/omm-zenreview.html', import.meta.url), 'utf8')
const utilSource = readFileSync(new URL('../public/zen/foundation/util.js', import.meta.url), 'utf8')
const moduleBody = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
const executable = moduleBody.split('\n').filter((line) => !/^\s*import\s/.test(line)).join('\n')

test('JSON 字段拒绝非法 JSON、普通对象和 null，规范 inputs wrapper 唯一映射两个数组', () => {
  for (const raw of ['{', '{}', 'null', '42', '"text"']) {
    const parsed = ZenReview.parseJSONArray(raw, 'timeline')
    assert.deepEqual(parsed.value, [])
    assert.ok(parsed.error, raw + ' 应显示字段级错误')
  }
  assert.deepEqual(ZenReview.parseJSONArray('', 'planner'), { value: [], error: '' })

  const wrapper = {
    timeline: [{ app: 'writer', ts: '2026-01-08T00:00:00+08:00' }],
    planner: [{ title: '写周报', done: true, day: '2026-01-08' }],
  }
  const timeline = ZenReview.parseJSONArray(JSON.stringify(wrapper), 'timeline')
  const planner = ZenReview.parseJSONArray(JSON.stringify(wrapper), 'planner')
  assert.equal(timeline.error, '')
  assert.equal(planner.error, '')
  assert.deepEqual(timeline.value, wrapper.timeline)
  assert.deepEqual(planner.value, wrapper.planner)
  assert.deepEqual(timeline.wrapper, wrapper)
  assert.deepEqual(planner.wrapper, wrapper)

  for (const raw of [
    { timeline: [] },
    { timeline: [], planner: {} },
    { timeline: {}, planner: [] },
  ]) {
    assert.ok(ZenReview.parseJSONArray(JSON.stringify(raw), 'timeline').error)
  }
})

test('日期统一使用本地日历日，UTC+8 午夜与默认区间不会少一天', () => {
  const midnight = '2026-01-08T00:00:00+08:00'
  const epoch = Date.parse(midnight)
  assert.equal(ZenReview.dateKey(midnight), '2026-01-08')
  assert.equal(ZenReview.dateKey(epoch), '2026-01-08')
  assert.equal(ZenReview.dateKey(String(epoch)), '2026-01-08')
  assert.equal(ZenReview.dateKey('2026-01-08'), '2026-01-08')
  assert.equal(ZenReview.dateKey('2026-02-30'), '')

  const range = ZenReview.defaultRange(epoch)
  assert.deepEqual(range, { from: '2026-01-02', to: '2026-01-08' })
  const summary = ZenReview.summarize({
    timeline: [{ app: 'writer', ts: midnight }],
    planner: [{ title: '复盘', done: true, day: '2026-01-08' }],
    cards: [{ createdAt: midnight, tags: ['跨产品'] }],
  }, range)
  assert.equal(summary.events, 1)
  assert.equal(summary.done, 1)
  assert.equal(summary.cards, 1)
  assert.equal(summary.activeDays, 1)
})

function createApp(options = {}) {
  const origin = options.origin || 'https://review.example.test'
  const search = options.search || ''
  const location = { origin, search }
  const posts = []
  const toasts = []
  const storageWrites = []
  const messageListeners = []
  const storageData = new Map(Object.entries(options.storage || {}))
  const localStorage = {
    getItem(key) { return storageData.has(key) ? storageData.get(key) : null },
    setItem(key, value) {
      storageWrites.push({ key, value })
      storageData.set(key, String(value))
    },
    removeItem(key) { storageData.delete(key) },
  }
  const elements = new Map()
  for (const match of html.matchAll(/<[a-z][^>]*>/gi)) {
    const tag = match[0]
    const id = (tag.match(/\bid="([^"]+)"/) || [])[1]
    if (!id) continue
    elements.set(id, {
      id,
      value: (tag.match(/\bvalue="([^"]*)"/) || [])[1] || '',
      textContent: '',
      hidden: /\bhidden\b/.test(tag),
      disabled: false,
      attributes: {},
      listeners: {},
      addEventListener(type, handler) {
        (this.listeners[type] ||= []).push(handler)
      },
      setAttribute(name, value) { this.attributes[name] = value },
      getAttribute(name) { return this.attributes[name] },
    })
  }
  const document = {
    body: { classList: { toggle() {}, contains() { return false } } },
    getElementById(id) { return elements.get(id) },
  }
  let clock = Date.parse('2026-01-08T00:00:00+08:00')
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args)
      else super(clock)
    }
    static now() { return clock }
  }
  let randomCounter = 0
  const math = Object.create(Math)
  math.random = () => {
    randomCounter += 1
    return (randomCounter % 100) / 100
  }
  let timerId = 0
  const timers = new Map()
  function setTimeout(callback, delay = 0) {
    const id = ++timerId
    timers.set(id, { callback, due: clock + Number(delay) })
    return id
  }
  function clearTimeout(id) { timers.delete(id) }
  function tick(ms) {
    clock += ms
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.due <= clock)
        .sort((a, b) => a[1].due - b[1].due)[0]
      if (!due) return
      timers.delete(due[0])
      due[1].callback()
    }
  }
  const parent = {
    postMessage(message, targetOrigin) { posts.push({ message, targetOrigin }) },
  }
  const window = {
    parent,
    location,
    localStorage,
    ZenUI: {
      toast(message, opts) { toasts.push({ message, tone: opts && opts.tone }) },
    },
    OMMShare: options.share || {},
    addEventListener(type, handler) {
      if (type === 'message') messageListeners.push(handler)
    },
  }
  if (options.topLevel) window.parent = window
  const cardApi = Object.assign({}, ZenCard, {
    create(input, opts) { return ZenCard.create(input, Object.assign({ now: clock }, opts)) },
  })
  const reviewApi = Object.assign({}, ZenReview, {
    defaultRange() { return { from: '2026-01-02', to: '2026-01-08' } },
  })
  const context = vm.createContext({
    window,
    location,
    document,
    localStorage,
    URL,
    URLSearchParams,
    Date: FakeDate,
    Math: math,
    Promise,
    console,
    setTimeout,
    clearTimeout,
    ZenCard: cardApi,
    ZenReview: reviewApi,
  })
  vm.runInContext(utilSource, context, { filename: 'zen/foundation/util.js' })
  context.ZenUtil = window.ZenUtil
  vm.runInContext(executable, context, { filename: 'omm-zenreview.html' })

  return {
    window,
    posts,
    toasts,
    storageWrites,
    storageData,
    el(id) { return elements.get(id) },
    click(id) {
      return Promise.all((elements.get(id).listeners.click || []).map((handler) => handler({ target: elements.get(id) })))
        .then((results) => results.length === 1 ? results[0] : results)
    },
    emit(data, eventOptions = {}) {
      const event = Object.assign({
        data,
        origin,
        source: parent,
      }, eventOptions)
      messageListeners.forEach((handler) => handler(event))
    },
    tick,
  }
}

test('字段级错误阻止生成且保留上一份报告，inputs wrapper 同时填充两个字段', async () => {
  const app = createApp()
  app.el('tl-json').value = JSON.stringify([{ app: 'writer', ts: '2026-01-08T00:00:00+08:00' }])
  app.el('pl-json').value = '[]'
  await app.click('gen-btn')
  const previous = app.el('report-out').textContent
  assert.ok(previous.includes('跨产品动态：**1**'))

  for (const raw of ['{', '{}', 'null']) {
    app.el('tl-json').value = raw
    await app.click('gen-btn')
    assert.equal(app.el('report-out').textContent, previous)
    assert.equal(app.el('tl-json-error').hidden, false)
    assert.ok(app.el('tl-json-error').textContent)
    assert.equal(app.el('tl-json').getAttribute('aria-invalid'), 'true')
  }
  app.el('tl-json').value = '[]'
  app.el('pl-json').value = 'null'
  await app.click('gen-btn')
  assert.equal(app.el('report-out').textContent, previous)
  assert.equal(app.el('pl-json-error').hidden, false)
  assert.ok(app.el('pl-json-error').textContent)

  const wrapperApp = createApp()
  wrapperApp.el('tl-json').value = JSON.stringify({
    timeline: [{ app: 'corpus', ts: '2026-01-08T00:00:00+08:00' }],
    planner: [{ title: '整理语料', done: true, day: '2026-01-08' }],
  })
  await wrapperApp.click('gen-btn')
  assert.equal(JSON.parse(wrapperApp.el('tl-json').value).length, 1)
  assert.equal(JSON.parse(wrapperApp.el('pl-json').value).length, 1)
  assert.ok(wrapperApp.el('report-out').textContent.includes('| corpus | 1 |'))
  assert.ok(wrapperApp.el('report-out').textContent.includes('- 整理语料'), wrapperApp.el('report-out').textContent)
})

test('嵌入页只信任精确 Hub 父窗口，独立页只信任同源父窗口', async () => {
  const hubOrigin = 'http://127.0.0.1:8320'
  const embedded = createApp({
    origin: 'http://127.0.0.1:8326',
    search: '?omm_embed=1&omm_hub_origin=' + encodeURIComponent(hubOrigin),
  })
  let settled = false
  const pending = embedded.click('pull-btn').then(() => { settled = true })
  const request = embedded.posts[0]
  assert.equal(request.targetOrigin, hubOrigin)
  assert.equal(request.message.type, 'omm:live-data-request')
  assert.equal(request.message.source, 'zenreview')
  assert.equal(request.message.expected, 1)

  embedded.emit({ type: 'omm:live-data-reply', token: request.message.token, data: { timeline: [{ app: 'forged' }] } }, {
    origin: 'http://127.0.0.1:9999',
  })
  embedded.emit({ type: 'omm:live-data-reply', token: request.message.token, data: { timeline: [{ app: 'sibling' }] } }, {
    origin: hubOrigin,
    source: {},
  })
  embedded.emit({ type: 'omm:live-data-reply', token: request.message.token, data: { timeline: [{ app: 'self' }] } }, {
    origin: embedded.window.location.origin,
    source: embedded.window,
  })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(embedded.el('tl-json').value, '')

  embedded.emit({ type: 'omm:live-data-reply', token: request.message.token, data: { timeline: [{ app: 'writer' }] } }, {
    origin: hubOrigin,
  })
  await pending
  assert.equal(JSON.parse(embedded.el('tl-json').value)[0].app, 'writer')

  const standalone = createApp({ origin: 'https://same.example.test' })
  const standalonePending = standalone.click('pull-btn')
  const standaloneRequest = standalone.posts[0]
  assert.equal(standaloneRequest.targetOrigin, 'https://same.example.test')
  standalone.emit({ type: 'omm:live-data-reply', token: standaloneRequest.message.token, data: { planner: [{ title: '伪造' }] } }, {
    origin: 'http://127.0.0.1:8320',
  })
  standalone.emit({ type: 'omm:live-data-reply', token: standaloneRequest.message.token, data: { planner: [{ title: '同源' }] } })
  await standalonePending
  assert.equal(JSON.parse(standalone.el('pl-json').value)[0].title, '同源')

  const topLevel = createApp({ topLevel: true })
  assert.equal(await topLevel.click('pull-btn'), null)
  assert.equal(topLevel.posts.length, 0)
})

test('Hub 慢回复按 token 世代隔离，不覆盖新拉取状态', async () => {
  const app = createApp()
  app.el('tl-json').value = '[{"app":"before"}]'
  app.el('pl-json').value = '[]'
  const first = app.click('pull-btn')
  const firstToken = app.posts[0].message.token
  app.tick(1)
  const second = app.click('pull-btn')
  const secondToken = app.posts[1].message.token
  assert.notEqual(firstToken, secondToken)
  assert.equal(await first, null)

  app.tick(2499)
  app.emit({ type: 'omm:live-data-reply', token: firstToken, data: { timeline: [{ app: 'stale' }] } })
  await Promise.resolve()
  assert.equal(JSON.parse(app.el('tl-json').value)[0].app, 'before')

  app.emit({ type: 'omm:live-data-reply', token: secondToken, data: { timeline: [{ app: 'fresh' }] } })
  await second
  assert.equal(JSON.parse(app.el('tl-json').value)[0].app, 'fresh')
})

test('拉取超时大于 Hub 2 秒兜底，迟到的正常回复仍可兑现', async () => {
  const app = createApp()
  let settled = false
  const pending = app.click('pull-btn').then(() => { settled = true })
  const token = app.posts[0].message.token
  app.tick(2001)
  await Promise.resolve()
  assert.equal(settled, false)
  app.emit({ type: 'omm:live-data-reply', token, data: { timeline: [{ app: 'writer' }] } })
  await pending
  assert.equal(JSON.parse(app.el('tl-json').value)[0].app, 'writer')

  const timeoutApp = createApp()
  const timeoutPending = timeoutApp.click('pull-btn')
  timeoutApp.tick(2999)
  assert.equal(timeoutApp.toasts.some((item) => item.message.includes('未响应')), false)
  timeoutApp.tick(1)
  assert.equal(await timeoutPending, null)
  assert.ok(timeoutApp.toasts.some((item) => item.message.includes('未响应')))
})

test('桌面报告使用 Hub 的跨产品 cards，而非只读当前 origin', async () => {
  const localCard = { id: 'local', content: '本地卡片', createdAt: '2026-01-08T00:00:00+08:00', tags: ['本地'] }
  const app = createApp({
    storage: { 'zen.cards.v1': JSON.stringify([localCard]) },
  })
  const pending = app.click('pull-btn')
  const token = app.posts[0].message.token
  app.emit({
    type: 'omm:live-data-reply',
    token,
    data: {
      timeline: [{ app: 'writer', ts: '2026-01-08T00:00:00+08:00' }],
      planner: [{ title: '完成跨产品复盘', done: true, day: '2026-01-08' }],
      cards: [{ content: '来自语料产品的卡片', source: 'corpus', tags: ['跨产品'] }],
    },
  })
  await pending
  await app.click('gen-btn')
  assert.equal(app.el('status-text').textContent, '1 条动态 · 2 张卡片 · 1 项完成')
  assert.ok(app.el('report-out').textContent.includes('#跨产品'))
  assert.ok(app.el('report-out').textContent.includes('- 完成跨产品复盘'))
  assert.equal(JSON.parse(app.storageData.get('zen.cards.v1')).length, 1)
})

test('导出通过 OMMShare.send 发送到 zencard，等待结果并处理失败', async () => {
  const calls = []
  const failed = createApp({
    share: {
      send(options) {
        calls.push(options)
        return Promise.reject(new Error('broker offline'))
      },
    },
  })
  failed.el('tl-json').value = '[]'
  await failed.click('gen-btn')
  await failed.click('tocards-btn')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].to, 'zencard')
  assert.equal(calls[0].format, 'zen-card')
  assert.equal(calls[0].payload.content, failed.el('report-out').textContent)
  assert.ok(failed.toasts.some((item) => item.message.includes('发送失败') && item.message.includes('broker offline')))
  assert.equal(failed.el('tocards-btn').disabled, false)
  assert.equal(failed.storageWrites.length, 0)

  let resolveSend
  const succeeding = createApp({
    share: {
      send() { return new Promise((resolve) => { resolveSend = resolve }) },
    },
  })
  succeeding.el('tl-json').value = '[]'
  await succeeding.click('gen-btn')
  const pending = succeeding.click('tocards-btn')
  assert.equal(succeeding.el('tocards-btn').disabled, true)
  assert.equal(succeeding.toasts.some((item) => item.message.includes('已发送到 ZenCard')), false)
  resolveSend({ id: 'shared-1' })
  await pending
  assert.equal(succeeding.el('tocards-btn').disabled, false)
  assert.ok(succeeding.toasts.some((item) => item.message.includes('已发送到 ZenCard')))
  assert.equal(succeeding.storageWrites.length, 0)
})

test('页面保留共享样式入口、直角与中性品牌，不增加内联样式', () => {
  assert.ok(html.includes('href="zen/zen.css"'))
  assert.ok(html.includes('href="zen/features/tool.css"'))
  assert.doesNotMatch(html, /<style\b/i)
  assert.doesNotMatch(html, /\bstyle\s*=/i)
  assert.doesNotMatch(html, /border-radius\s*:/i)
  assert.doesNotMatch(html, /postMessage\([^,]+,\s*['"]\*['"]\)/)
})
