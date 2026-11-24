/* Lambda SSE protocol: a closed stream without the done frame is not success. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const start = html.indexOf('  async function streamEval(')
const end = html.indexOf('  async function evalLine(', start)
assert.ok(start >= 0 && end > start)

function loadStreamEval(frames) {
  const encoder = new TextEncoder()
  const chunks = frames.map((frame) => encoder.encode('data: ' + JSON.stringify(frame) + '\n\n'))
  let index = 0
  const response = {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () => index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true },
      }),
    },
  }
  const context = {
    state: { session: 's1', lang: 'both' },
    fetch: async () => response,
    TextDecoder,
    showRunning: () => {},
    isStreamFailure: (obj) => !!obj && (obj.kind === 'timeout' || obj.kind === 'expired' ||
      (obj.kind === 'error' && obj.ok === false)),
    dual: (zh, en) => en,
    console,
  }
  vm.runInNewContext(html.slice(start, end) + '\nglobalThis.streamEval = streamEval', context)
  return context.streamEval
}

test('Lambda SSE 收到 done 才返回成功', async () => {
  const streamEval = loadStreamEval([
    { kind: 'start', session: 's1' },
    { kind: 'result', text: 'one' },
    { kind: 'done', ok: true, session: 's1' },
  ])
  const result = await streamEval('ONE')
  assert.equal(result.status, 200)
  assert.equal(result.data.ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(result.data.outputs)), [{ kind: 'result', text: 'one' }])
})

test('Lambda SSE 缺少 done 时按结果未知处理并要求重建', async () => {
  const streamEval = loadStreamEval([
    { kind: 'start', session: 's1' },
    { kind: 'result', text: 'partial' },
  ])
  const result = await streamEval('ONE')
  assert.equal(result.status, 500)
  assert.equal(result.data.ok, false)
  assert.equal(result.data.restart, true)
  assert.equal(result.data.code, 'incomplete_stream')
})
