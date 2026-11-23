/* 共用加密工具：编解码往返、密钥派生与产品侧复用检查。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import '../public/lib/zen-crypto.js'
const C = globalThis.ZenCrypto

const ROOT = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')

test('字节与 Base64 往返一致', () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255])
  const encoded = C.bytesToBase64(bytes)
  assert.equal(typeof encoded, 'string')
  const decoded = C.base64ToBytes(encoded)
  assert.ok(decoded instanceof ArrayBuffer)
  assert.deepEqual([...new Uint8Array(decoded)], [...bytes])
})

test('deriveKey 派生的密钥可完成 AES-GCM 加解密', async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await C.deriveKey('passphrase', salt)
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode('共享样式之外的共享逻辑'))
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted)
  assert.equal(new TextDecoder().decode(plain), '共享样式之外的共享逻辑')
})

test('seal/unseal 默认信封往返且格式稳定', async () => {
  const data = { hello: 'world', n: 1 }
  const box = await C.seal(data, 'pw')
  const parsed = JSON.parse(box)
  assert.equal(parsed.v, 1)
  assert.equal(parsed.alg, 'AES-GCM')
  assert.equal(parsed.kdf, 'PBKDF2-SHA256')
  assert.equal(parsed.iter, 310000)
  assert.ok(parsed.salt && parsed.iv && parsed.cipher)
  assert.deepEqual(await C.unseal(box, 'pw'), data)
  await assert.rejects(() => C.unseal(box, 'wrong'))
})

test('seal/unseal 支持版本、规整、校验与本地化文案', async () => {
  const opts = {
    version: 2,
    accept: [1, 2],
    normalize: (x) => ({ ...x, ok: true }),
    validate: (x) => x.ok === true,
    msgUnsupported: '错误格式',
    msgInvalid: '数据无效',
  }
  const box = await C.seal({ a: 1 }, 'pw', opts)
  assert.equal(JSON.parse(box).v, 2)
  assert.deepEqual(await C.unseal(box, 'pw', opts), { a: 1, ok: true })
  await assert.rejects(
    async () => C.unseal(JSON.stringify({ v: 9, alg: 'AES-GCM' }), 'pw', opts), /错误格式/)
  const invalid = await C.seal({ a: 1 }, 'pw', { version: 2 })
  await assert.rejects(
    async () => C.unseal(invalid, 'pw', { version: 2, validate: () => false, msgInvalid: '数据无效' }),
    /数据无效/)
  await assert.rejects(
    async () => C.unseal(JSON.stringify({ v: 9, alg: 'AES-GCM' }), 'pw',
      { ...opts, msgUnsupported: () => 'thunk' }), /thunk/)
})

test('内层编解码可经回调替换（消息正文格式）', async () => {
  const codec = {
    encode: (body) => (typeof body === 'string' ? body : JSON.stringify({ __zmsg: 1, ...body })),
    decode: (text) => {
      try {
        const data = JSON.parse(text)
        if (data && data.__zmsg === 1) return data
      } catch (_) {}
      return text
    },
  }
  assert.deepEqual(
    await C.unseal(await C.seal({ body: 'hi' }, 'pw', codec), 'pw', codec),
    { __zmsg: 1, body: 'hi' })
  assert.equal(
    await C.unseal(await C.seal('plain text', 'pw', codec), 'pw', codec), 'plain text')
})

test('七个云同步产品复用共享 AES-GCM 信封，不再内联实现', () => {
  for (const name of ['annotate', 'corpus', 'data', 'english', 'planner', 'writer', 'message']) {
    const html = read(`public/omm-${name}.html`)
    assert.ok(html.includes('<script src="lib/zen-crypto.js"></script>'), `${name} 未引入共享模块`)
    assert.ok(html.includes('ZenCrypto.seal('), `${name} 未委托共享封装`)
    assert.ok(html.includes('ZenCrypto.unseal('), `${name} 未委托共享解封`)
    assert.ok(!/crypto\.subtle\.(encrypt|decrypt)/.test(html), `${name} 仍有内联加解密`)
    assert.ok(!/\bfunction (b64|ub64|keyFor)\s*\(/.test(html), `${name} 仍有内联原语`)
    assert.ok(!/\bvar (b64|ub64|keyFor) = ZenCrypto\./.test(html), `${name} 仍有原语别名`)
  }
})
