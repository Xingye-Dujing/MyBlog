/* Regression tests for the hub <-> product postMessage hardening.
 *
 * Run from the repository root:  node tests/test_message_security.mjs
 *
 * The functions under test are extracted from the actual shipped source files
 * and executed in a small VM sandbox, so the tests exercise the real code.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const ROOT = new URL('../', import.meta.url)
function src(name) {
  return readFileSync(new URL(name, ROOT), 'utf8')
}

function extractFunction(text, name) {
  const marker = `function ${name}(`
  const startIdx = text.indexOf(marker)
  assert.notEqual(startIdx, -1, `${name} not found in source`)
  const open = text.indexOf('{', startIdx)
  assert.notEqual(open, -1, `${name} has no body`)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(startIdx, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

function loadFunctions(text, names, extraGlobals = {}) {
  const code = names.map((n) => extractFunction(text, n)).join('\n') +
    `\nreturn { ${names.join(', ')} }`
  const sandbox = { URL, ...extraGlobals }
  const context = vm.createContext(sandbox)
  return vm.runInContext(`(function () { ${code} })()`, context)
}

let passed = 0
function check(label, fn) {
  fn()
  passed++
  console.log(`  ok - ${label}`)
}

/* ------------------------------------------------------------------ hub */
console.log('omm-hub.js version + frame origin helpers')
const hub = src('public/omm-hub.js')
const hubWindow = {
  window: {
    location: {
      href: 'http://127.0.0.1:8300/omm-hub.html',
      origin: 'http://127.0.0.1:8300',
    },
  },
}
const hubFns = loadFunctions(
  hub,
  ['versionKey', 'isNewerVersion', 'isLoopbackOrigin', 'frameTargetOrigin'],
  { ...hubWindow, LOOPBACK_HOSTS: ['127.0.0.1', 'localhost', '[::1]', '::1'] },
)

check('1.2.0 > 1.2 (matches Python tuple comparison)', () => {
  assert.equal(hubFns.isNewerVersion('1.2.0', '1.2'), true)
})
check('1.2 is not newer than 1.2.0', () => {
  assert.equal(hubFns.isNewerVersion('1.2', '1.2.0'), false)
})
check('1.0.17 > 1.0.16', () => {
  assert.equal(hubFns.isNewerVersion('1.0.17', '1.0.16'), true)
})
check('1.0.16 is not newer than 1.0.17', () => {
  assert.equal(hubFns.isNewerVersion('1.0.16', '1.0.17'), false)
})
check('equal versions are not newer', () => {
  assert.equal(hubFns.isNewerVersion('1.0.17', '1.0.17'), false)
})
check('frameTargetOrigin uses the iframe URL origin, not the hub origin', () => {
  const frame = {
    dataset: { url: 'http://127.0.0.1:8341/omm-writer.html?omm_embed=1' },
    src: 'about:blank',
  }
  assert.equal(hubFns.frameTargetOrigin(frame), 'http://127.0.0.1:8341')
})
check('frameTargetOrigin falls back to hub origin when URL is missing', () => {
  assert.equal(hubFns.frameTargetOrigin({ dataset: {}, src: 'about:blank' }),
    'http://127.0.0.1:8300')
})
check('frameTargetOrigin rejects non-loopback product URL', () => {
  assert.equal(hubFns.frameTargetOrigin({ dataset: { url: 'https://evil.example/x' } }),
    'http://127.0.0.1:8300')
})
check('isLoopbackOrigin accepts loopback http(s) only', () => {
  assert.equal(hubFns.isLoopbackOrigin('http://127.0.0.1:8300'), true)
  assert.equal(hubFns.isLoopbackOrigin('http://localhost:8341'), true)
  assert.equal(hubFns.isLoopbackOrigin('https://evil.example'), false)
  assert.equal(hubFns.isLoopbackOrigin('null'), false)
  assert.equal(hubFns.isLoopbackOrigin('file:///C:/x'), false)
})

/* ------------------------------------------------------------ static guards */
console.log('source-level protocol guards')
const bridgeFiles = [
  'public/omm-hub.js',
  'public/omm-desktop.js',
  'public/omm-embed.js',
  'public/omm-share.js',
]
for (const file of bridgeFiles) {
  const text = src(file)
  check(`${file}: no wildcard postMessage target remains`, () => {
    // Match '*' used directly as the second (targetOrigin) argument.
    assert.equal(/postMessage\([\s\S]{0,600}?,\s*'\*'\s*\)/.test(text), false,
      `${file} still contains postMessage(..., '*')`)
  })
  check(`${file}: inbound messages validate origin`, () => {
    assert.match(text, /event\.origin/)
  })
}
const htmlBridges = ['public/omm-writer.html']
for (const file of htmlBridges) {
  const text = src(file)
  check(`${file}: no wildcard postMessage target remains`, () => {
    assert.equal(/postMessage\([\s\S]{0,600}?,\s*'\*'\s*\)/.test(text), false,
      `${file} still contains postMessage(..., '*')`)
  })
}
check('hub forwards its own origin into embedded product URLs', () => {
  assert.match(hub, /omm_hub_origin=' \+/)
})
check('product bridges read the forwarded hub origin', () => {
  for (const file of bridgeFiles.slice(1)) {
    assert.match(src(file), /omm_hub_origin/)
  }
})

console.log(`\n${passed} JS checks passed`)
