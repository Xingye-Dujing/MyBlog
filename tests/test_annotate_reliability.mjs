/* 回归测试：文本标注页“编码者信度”的表格行号对齐。
 *
 * 运行：node --test tests/test_annotate_reliability.mjs
 *
 * 直接从发货源码 omm-paper.js 抽取纯函数在 VM 中执行，确保测到的是真实代码。
 * 表格编码的 UI 与导出的编码表都用 1 基行号，而 cellCodes.row 是 0 基下标；
 * 第二编码者按提示填写行号后必须能换算回 0 基，否则 κ 恒为 0、所有项目
 * 都被当成“只有一方编码”。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const source = readFileSync(new URL('public/omm-paper.js', ROOT), 'utf8')

function extractFunction(text, name) {
  const marker = `function ${name}(`
  const start = text.indexOf(marker)
  assert.notEqual(start, -1, `${name} not found`)
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const codes = [
  { id: 'c1', no: '01', name: '议题属性', level: 'open' },
  { id: 'c2', no: '02', name: '情感动员', level: 'open' },
]
const H = {
  P: {
    docs: [{ id: 'd1', kind: 'table', title: '访谈表' }],
    codes,
    anns: [],
    cellCodes: [
      { table: 'd1', row: 0, col: '文本', code: 'c1', round: 1 },
      { table: 'd1', row: 1, col: '文本', code: 'c2', round: 1 },
    ],
  },
  sortedCodes: () => codes,
  nowStr: () => '2026-01-01 00:00',
  annById: () => null,
  codeById: (id) => codes.find((c) => c.id === id),
  docById: (id) => H.P.docs.find((d) => d.id === id),
}

const names = [
  'currentTableDoc',
  'normKey',
  'parseSecond',
  'matchCode',
  'primaryMap',
  'kappaOf',
  'compute',
  'keyLabel',
]
const sandbox = { console, H, window: { ZenTable: { ui: { docId: 'd1' } } } }
const ctx = vm.createContext(sandbox)
vm.runInContext(names.map((n) => extractFunction(source, n)).join('\n'), ctx)
const api = vm.runInContext(`({ ${names.join(', ')} })`, ctx)
// 跨 realm 的对象用 JSON 往返规整成普通对象再断言。
const plain = (v) => JSON.parse(JSON.stringify(v))

test('表格行号按 1 基输入换算回 0 基键', () => {
  assert.equal(api.normKey('1', 'table'), '0')
  assert.equal(api.normKey('2', 'table'), '1')
  assert.equal(api.normKey('第 2 行', 'table'), '1')
  assert.equal(api.normKey('0', 'table'), '0') // 防御性：不产生 -1
  // 文本片段 ID 原样保留
  assert.equal(api.normKey('a-123', 'text'), 'a-123')
})

test('两次编码一致时得到 κ = 1，没有 missing', () => {
  const r = plain(api.compute('table', 1, '文本', '1,01\n2,02'))
  assert.equal(r.stat.N, 2)
  assert.equal(r.stat.po, 1)
  assert.equal(r.stat.kappa, 1)
  assert.equal(r.missing, 0)
  assert.equal(r.unmatched, 0)
  assert.deepEqual(r.disagreements, [])
})

test('一处分歧时 κ 与 Po 正确下降并列出分歧项', () => {
  const r = plain(api.compute('table', 1, '文本', '1,01\n2,01'))
  assert.equal(r.stat.N, 2)
  assert.equal(r.stat.po, 0.5)
  assert.equal(r.missing, 0)
  assert.equal(r.disagreements.length, 1)
})
