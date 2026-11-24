/* Cmd+K 检索增强专项测试（node:test）
 * 纯函数从 omm-hub.js 抽出执行：模糊评分、频率加权排序、即时命令。
 * 运行：node tests/test_cmdk_upgrade.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const hub = readFileSync(new URL('public/omm-hub.js', ROOT), 'utf8')

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

const NAMES = ['cmdkPad', 'cmdkFormatNumber', 'cmdkFuzzyScore', 'cmdkRank', 'cmdkOrderItems', 'cmdkInstantItems']
const api = vm.runInNewContext(
  `(function () { ${NAMES.map((n) => extractFunction(hub, n)).join('\n')}
     return { cmdkPad, cmdkFormatNumber, cmdkFuzzyScore, cmdkRank, cmdkOrderItems, cmdkInstantItems }
   })()`,
  { Number, Math, Date, isFinite, parseInt, Function, String }
)
// vm 返回的数组属于另一个 realm，用 Array.from 归一化后再做结构比较。
const { cmdkFuzzyScore, cmdkRank, cmdkOrderItems, cmdkInstantItems, cmdkPad } = api
const asArray = (value) => Array.from(value)

test('模糊评分：完全匹配最强，子序列命中可用，不匹配为 -1', () => {
  assert.ok(cmdkFuzzyScore('Writer', 'writer') > cmdkFuzzyScore('Writer', 'wt'), '完整命中应强于间隔子序列')
  assert.ok(cmdkFuzzyScore('Writerxx', 'writer') > cmdkFuzzyScore('xxWriter', 'writer'), '词首命中应更强')
  assert.ok(cmdkFuzzyScore('Writer', 'wr') > 0)
  assert.ok(cmdkFuzzyScore('所思所想 writer', '所想') > 0)
  assert.ok(cmdkFuzzyScore('自动化编排', '自编') > 0, '中文子序列应命中')
  assert.equal(cmdkFuzzyScore('writer', 'zzz'), -1)
  assert.equal(cmdkFuzzyScore('writer', ''), 0)
})

test('排序：过滤不匹配项，前缀结果优先', () => {
  const items = [
    { label: '查看 Writer', group: '应用' },
    { label: 'Writer 所思所想', group: '应用' },
    { label: '数据工作台', group: '应用' },
  ]
  const ranked = cmdkRank(items, 'writer', {})
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].label, 'Writer 所思所想', '词首命中应排最前')
})

test('排序：使用频率加权可提升常用项', () => {
  const items = [
    { label: '自动化编排', appId: 'zenflow' },
    { label: '自动化规则说明', appId: 'docs' },
  ]
  const usage = { zenflow: { opens: 20, seconds: 600 }, docs: { opens: 0, seconds: 0 } }
  const ranked = cmdkRank(items, '自动化', usage)
  assert.equal(ranked[0].appId, 'zenflow')
})

test('排序：同分时保持原顺序，空查询不改动顺序', () => {
  const items = [{ label: 'A' }, { label: 'B' }, { label: 'C' }]
  assert.deepEqual(asArray(cmdkRank(items, '', {})), items)
  const same = [{ label: 'x1' }, { label: 'x2' }]
  assert.deepEqual(asArray(cmdkRank(same, 'x', {})).map((i) => i.label), ['x1', 'x2'])
  assert.equal(cmdkPad(7), '07')
})

test('即时命令：算术表达式只接受安全字符', () => {
  assert.equal(cmdkInstantItems('= 1+2*3')[0].label, '= 7')
  assert.equal(cmdkInstantItems('= (2+3)*4')[0].label, '= 20')
  assert.equal(cmdkInstantItems('= 10/4')[0].label, '= 2.5')
  assert.equal(asArray(cmdkInstantItems('= alert(1)')).length, 0)
  assert.equal(asArray(cmdkInstantItems('= 1;2')).length, 0)
})

test('即时命令：日期与进制换算', () => {
  const date = cmdkInstantItems('@date')[0]
  assert.match(date.label, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(date.hint, /Unix 时间戳 \d+/)
  assert.equal(cmdkInstantItems('hex 255')[0].label, '0xff')
  assert.equal(cmdkInstantItems('bin 10')[0].label, '0b1010')
  assert.equal(cmdkInstantItems('oct 8')[0].label, '0o10')
  assert.equal(asArray(cmdkInstantItems('')).length, 0)
})

test('即时命令不参与自身查询过滤，分组顺序与键盘索引一致', () => {
  const instant = cmdkInstantItems('@date')
  const candidates = instant.concat([
    { group: '动作', label: '动作' },
    { group: '应用', label: '应用' },
  ])
  const ordered = cmdkOrderItems(candidates, ['即时命令', '应用', '动作'])
  assert.deepEqual(Array.from(ordered, (item) => item.label), [instant[0].label, '应用', '动作'])
})

test('面板本体仍复用 renderCmdk，仅在过滤阶段接入新函数', () => {
  const render = hub.slice(hub.indexOf('function renderCmdk()'), hub.indexOf('function runCmdk('))
  assert.ok(render.includes('cmdkRank(cmdkItems, query, usageStats)'))
  assert.ok(render.includes('cmdkOrderItems(instant.concat(ranked), CMDK_GROUPS)'))
  assert.ok(render.includes('data-cmdk="\' + entry.index + \'"'))
  assert.ok(!render.includes('cmdkRank(cmdkItems.concat(cmdkInstantItems(query))'))
  assert.ok(!render.includes('cmdk-items-v2'), '不应重建面板元素')
  const build = hub.slice(hub.indexOf('function buildCmdkItems()'), hub.indexOf('function loadCmdkShares()'))
  for (const appId of ['app.id', 'appId', "'writer'", "'search'"]) {
    assert.ok(build.includes('appId: ' + appId) || build.includes(appId), '缺少加权来源: ' + appId)
  }
  assert.ok(hub.includes("var USAGE_KEY = 'omm.hub.usage.v1'"))
})
