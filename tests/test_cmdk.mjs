/* Cmd+K 全局命令面板扩展专项测试（node:test）
 * 面板本体不重写：在既有 buildCmdkItems 上增加卡片 / 笔记 / 搜索历史三类来源。
 * 运行：node tests/test_cmdk.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const hub = read('public/omm-hub.js')

test('命令面板读取产品既有的 localStorage 键', () => {
  const readCards = hub.slice(hub.indexOf('function readLiveCards()'), hub.indexOf('function collectLiveLocalData('))
  for (const key of ['zen.cards.v1', 'zen.inbox.v1', 'zen.clip.v1']) {
    assert.ok(readCards.includes("'" + key + "'"), '缺少来源: ' + key)
  }
  const build = hub.slice(hub.indexOf('function buildCmdkItems()'), hub.indexOf('function loadCmdkShares()'))
  assert.ok(build.includes('readLiveCards().concat(productCards)'), '命令面板未合并隐藏采集结果')
  for (const key of ['zc-docs', 'omm-search-v1']) {
    assert.ok(build.includes("'" + key + "'"), '缺少来源: ' + key)
  }
})

test('新增三组复用既有动作函数，未引入新协议', () => {
  const seg = hub.slice(hub.indexOf('function buildCmdkItems()'), hub.indexOf('function loadCmdkShares()'))
  assert.ok(seg.includes("group: '知识卡片'"))
  assert.ok(seg.includes("group: '笔记'"))
  assert.ok(seg.includes("group: '搜索历史'"))
  assert.ok(seg.includes('openKnowledgeGraph()'))
  assert.ok(seg.includes('showKgDetail(c)'))
  assert.ok(seg.includes("activateApp('writer')"))
  assert.ok(seg.includes("activateApp('search')"))
})

test('渲染分组顺序包含新增三组', () => {
  const seg = hub.slice(hub.indexOf('var CMDK_GROUPS = ['), hub.indexOf('var gsearchOpen'))
  for (const g of ['知识卡片', '笔记', '搜索历史']) assert.ok(seg.includes("'" + g + "'"), g)
})

test('卡片读取委托 ZenUtil.getJSON，不再保留 cmdkRead 私有实现', () => {
  assert.ok(hub.includes('var cmdkCards = dedupeLiveCards(readLiveCards().concat(productCards))'))
  assert.ok(hub.includes("var cmdkDocs = ZenUtil.getJSON('zc-docs', null)"))
  assert.ok(!/function\s+cmdkRead\s*\(/.test(hub))
})

test('Ctrl+K 绑定与命令项仍在', () => {
  assert.ok(hub.includes("{ id: 'command-palette', label: '命令面板', def: 'Ctrl+K' }"))
  assert.ok(hub.includes('function openCommandPalette('))
})
