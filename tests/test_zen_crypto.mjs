/* 共用加密工具：编解码往返、密钥派生与产品侧复用检查。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import '../public/zen-crypto.js'
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

test('六个云同步产品复用共享实现，不再内联定义', () => {
  for (const name of ['annotate', 'corpus', 'data', 'english', 'planner', 'writer']) {
    const html = read(`public/omm-${name}.html`)
    assert.ok(html.includes('<script src="zen-crypto.js"></script>'), `${name} 未引入共享模块`)
    for (const fn of ['function b64(', 'function ub64(', 'function keyFor(']) {
      assert.ok(!html.includes(fn), `${name} 仍有内联 ${fn}`)
    }
    assert.ok(html.includes('ZenCrypto.deriveKey'), `${name} 未使用共享派生函数`)
  }
})
