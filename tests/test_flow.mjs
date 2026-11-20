/* zen-flow.js 单元测试 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ZenFlow } from '../public/zen-flow.js'
import { ZenCard } from '../public/zen-card.js'

const baseCard = { id: 'zc-1', kind: 'quote', source: 'annotate', content: '精读句子', tags: ['精读'] }

test('createRule 归一化并过滤非法 action', () => {
  const r = ZenFlow.createRule({
    name: '规则',
    when: { source: 'search' },
    actions: [{ type: 'addTag', value: 'AI' }, { type: 'bogus' }],
  })
  assert.equal(r.enabled, true)
  assert.equal(r.actions.length, 1)
  assert.equal(r.when.source, 'search')
})

test('内置规则模板全部有效且枚举合法', () => {
  const tpls = ZenFlow.templates()
  assert.ok(tpls.length >= 3)
  for (const t of tpls) {
    assert.equal(ZenFlow.validateRule(t).ok, true, t.name + ' 校验失败')
    if (t.when.source) assert.ok(ZenCard.SOURCES.includes(t.when.source), t.name + ' 来源非法')
    if (t.when.kind) assert.ok(ZenCard.KINDS.includes(t.when.kind), t.name + ' 类型非法')
    for (const a of t.actions) {
      if (a.type === 'setKind') assert.ok(ZenCard.KINDS.includes(a.value), t.name + ' setKind 非法')
    }
  }
  assert.equal(new Set(tpls.map((t) => t.id)).size, tpls.length, '模板 id 必须唯一')
})

test('validateRule 校验名字与 action', () => {
  assert.equal(ZenFlow.validateRule(ZenFlow.createRule({ name: '', actions: [] })).ok, false)
  const r = ZenFlow.createRule({ name: 'x', actions: [{ type: 'send' }] })
  assert.equal(ZenFlow.validateRule(r).ok, false)
  const r2 = ZenFlow.createRule({ name: 'x', actions: [{ type: 'send', to: 'corpus' }] })
  assert.equal(ZenFlow.validateRule(r2).ok, true)
})

test('match 支持 source/kind/tag/text 条件', () => {
  const rule = ZenFlow.createRule({ when: { source: 'annotate', kind: 'quote', tag: '精读', text: '精读' } })
  assert.equal(ZenFlow.match(rule, baseCard), true)
  assert.equal(ZenFlow.match(rule, { ...baseCard, source: 'search' }), false)
  assert.equal(ZenFlow.match(rule, { ...baseCard, tags: [] }), false)
  assert.equal(ZenFlow.match(rule, { ...baseCard, content: '无' }), false)
  rule.enabled = false
  assert.equal(ZenFlow.match(rule, baseCard), false)
})

test('applyActions：addTag/setKind/highlight 修改卡片', () => {
  const rule = ZenFlow.createRule({
    actions: [{ type: 'addTag', value: 'AI' }, { type: 'setKind', value: 'fact' }, { type: 'highlight', value: '#f00' }],
  })
  const res = ZenFlow.applyActions(rule, baseCard, { now: 1 })
  assert.deepEqual(res.card.tags, ['精读', 'AI'])
  assert.equal(res.card.kind, 'fact')
  assert.equal(res.card.color, '#f00')
  assert.equal(res.effects.length, 0)
})

test('applyActions：send/publish/notify 产生副作用描述且不改原卡片', () => {
  const rule = ZenFlow.createRule({
    actions: [{ type: 'send', to: 'writer' }, { type: 'publish', channel: 'documents' }, { type: 'notify', message: 'hi' }],
  })
  const res = ZenFlow.applyActions(rule, baseCard, { now: 5 })
  assert.equal(res.effects.length, 3)
  assert.deepEqual(res.effects.map((e) => e.type), ['send', 'publish', 'notify'])
  assert.equal(res.effects[0].to, 'writer')
  assert.equal(res.card.tags.length, 1)
})

test('run：按优先级触发多条规则并汇总', () => {
  const rules = [
    ZenFlow.createRule({ id: 'r2', priority: 2, when: { tag: '精读' }, actions: [{ type: 'addTag', value: '完成后' }] }),
    ZenFlow.createRule({ id: 'r1', priority: 1, when: { source: 'annotate' }, actions: [{ type: 'send', to: 'corpus' }] }),
  ]
  const out = ZenFlow.run(rules, [baseCard], { now: 9 })
  assert.deepEqual(out.cards[0].tags, ['精读', '完成后'])
  assert.equal(out.effects.length, 1)
  assert.equal(out.fired.length, 2)
})

test('serialize / deserialize 往返', () => {
  const rules = [ZenFlow.createRule({ name: 'x', actions: [{ type: 'notify' }] })]
  const back = ZenFlow.deserialize(ZenFlow.serialize(rules))
  assert.equal(back[0].name, 'x')
  assert.throws(() => ZenFlow.deserialize('{"format":"bad"}'))
})

test('validateRule 遇到缺失/非数组 actions 时返回校验失败而不是抛异常', () => {
  for (const actions of [undefined, null, {}]) {
    const res = ZenFlow.validateRule({ name: 'x', actions })
    assert.equal(res.ok, false)
    assert.ok(res.errors.some((e) => e.indexOf('action') >= 0))
  }
})
