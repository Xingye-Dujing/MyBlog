/* zen-card.js 单元测试（node:test）
 * 运行：node tests/test_zencard.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ZenCard } from '../public/zen-card.js'

const FIXED = { now: Date.UTC(2026, 0, 2, 3, 4, 5), rand: 0.5 }

test('create：归一化字段并给出合法默认值', () => {
  const c = ZenCard.create({ content: '  你好  ', tags: ['a', 'a', ' b '], kind: 'quote', source: 'annotate' }, FIXED)
  assert.equal(c.format, 'zen-card')
  assert.equal(c.v, 1)
  assert.ok(c.id.startsWith('zc-'))
  assert.equal(c.kind, 'quote')
  assert.equal(c.source, 'annotate')
  assert.equal(c.content, '  你好  ')
  assert.deepEqual(c.tags, ['a', 'b'])
  assert.equal(c.createdAt, '2026-01-02T03:04:05.000Z')
  assert.equal(c.updatedAt, '2026-01-02T03:04:05.000Z')
})

test('create：非法 kind/source 回退到默认值', () => {
  const c = ZenCard.create({ content: 'x', kind: '???', source: '???' }, FIXED)
  assert.equal(c.kind, 'note')
  assert.equal(c.source, 'manual')
})

test('create：接受 text / en / zh / note 等别名', () => {
  const c = ZenCard.create({ text: 'hello', en: 'ignored', zh: '你好', notes: '批注' }, FIXED)
  assert.equal(c.content, 'hello')
  assert.equal(c.translation, '你好')
  assert.equal(c.note, '批注')
})

test('validate：合法卡片通过', () => {
  const r = ZenCard.validate(ZenCard.create({ content: 'ok' }, FIXED))
  assert.deepEqual(r, { ok: true, errors: [] })
})

test('validate：拒绝空内容 / 错格式 / 错版本 / 非法枚举', () => {
  assert.equal(ZenCard.validate(ZenCard.create({ content: '' }, FIXED)).ok, false)
  const bad = ZenCard.create({ content: 'x' }, FIXED)
  bad.format = 'wrong'
  bad.v = 2
  bad.kind = 'nope'
  bad.tags = 'not-array'
  const r = ZenCard.validate(bad)
  assert.equal(r.ok, false)
  assert.ok(r.errors.length >= 4)
})

test('validate：links 结构校验', () => {
  const c = ZenCard.create({ content: 'x' }, FIXED)
  c.links = [{ rel: 'related', id: 'zc-a' }, { rel: 'x' }]
  assert.equal(ZenCard.validate(c).ok, false)
  c.links = [{ rel: 'related', id: 'zc-a' }]
  assert.equal(ZenCard.validate(c).ok, true)
})

test('parse / serialize 往返一致', () => {
  const c = ZenCard.create({ content: 'A "quote" & <tag>', tags: ['x'], kind: 'fact' }, FIXED)
  const text = ZenCard.serialize(c, true)
  const back = ZenCard.parse(text)
  assert.deepEqual(back, c)
})

test('serialize 对非法卡片抛错', () => {
  assert.throws(() => ZenCard.serialize({ format: 'bad' }))
})

test('pack 往返保留多张卡片', () => {
  const cards = [
    ZenCard.create({ content: 'one' }, FIXED),
    ZenCard.create({ content: 'two', kind: 'todo' }, FIXED),
  ]
  const text = ZenCard.serializePack(cards, { name: '包' }, true)
  const pack = ZenCard.parsePack(text)
  assert.equal(pack.name, '包')
  assert.equal(pack.cards.length, 2)
  assert.deepEqual(pack.cards[0], cards[0])
})

test('fingerprint 对同内容稳定、对不同内容不同', () => {
  const a = ZenCard.create({ content: 'same', translation: '同' }, FIXED)
  const b = ZenCard.create({ content: 'same', translation: '同' }, { ...FIXED, rand: 0.9 })
  assert.notEqual(a.id, b.id)
  assert.equal(ZenCard.fingerprint(a), ZenCard.fingerprint(b))
  const c = ZenCard.create({ content: 'diff' }, FIXED)
  assert.notEqual(ZenCard.fingerprint(a), ZenCard.fingerprint(c))
})

test('merge：按 id 与指纹去重', () => {
  const a = ZenCard.create({ content: 'dup', createdAt: '2026-01-01T00:00:00.000Z' }, FIXED)
  const b = ZenCard.create({ content: 'dup', createdAt: '2026-01-03T00:00:00.000Z' }, { ...FIXED, rand: 0.9 })
  const c = ZenCard.create({ content: 'other', createdAt: '2026-01-02T00:00:00.000Z' }, { ...FIXED, rand: 0.2 })
  const out = ZenCard.merge([a, b, c])
  assert.equal(out.length, 2)
  assert.equal(out[0].content, 'dup')
  assert.equal(out[1].content, 'other')
})

test('Corpus 转换：entry <-> card', () => {
  const entry = {
    id: 'ex-1',
    en: 'Deliberate practice works.',
    zh: '刻意练习有效。',
    categoryId: 'study',
    type: 'sentence',
    tags: ['备考'],
    source: '书',
    notes: '例句',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const card = ZenCard.fromCorpusEntry(entry, [{ id: 'study', name: '学习' }])
  assert.equal(card.source, 'corpus')
  assert.equal(card.kind, 'sentence')
  assert.equal(card.content, entry.en)
  assert.ok(card.tags.includes('学习'))
  const back = ZenCard.toCorpusEntry(card, 'study')
  assert.equal(back.en, entry.en)
  assert.equal(back.type, 'sentence')
})

test('Annotate 转换：mark + doc -> card，card -> mark', () => {
  const doc = { id: 'd1', title: '文章', text: '这是一段示例文本用于测试。' }
  const mark = { id: 'm1', start: 0, end: 5, quote: '这是一段示', note: '重点', color: '#e0913b' }
  const card = ZenCard.fromAnnotateMark(mark, doc)
  assert.equal(card.source, 'annotate')
  assert.equal(card.kind, 'quote')
  assert.equal(card.content, '这是一段示')
  assert.equal(card.ref, '文章')
  const back = ZenCard.toAnnotateMark(card, 'd1')
  assert.equal(back.quote, card.content)
  assert.equal(back.sty, 'note')
})

test('English 桥接转换：三种 item 都能转成卡片并还原', () => {
  const word = ZenCard.fromEnglishBridge({ t: 'word', w: 'abandon', m: '放弃', note: 'n', src: 'cet6' })
  assert.equal(word.kind, 'word')
  assert.equal(word.content, 'abandon')
  assert.deepEqual(ZenCard.toEnglishBridge(word), { t: 'word', w: 'abandon', m: '放弃', note: 'n', tags: word.tags, src: 'cet6' })
  const sent = ZenCard.fromEnglishBridge({ t: 'sentence', en: 'Hello', zh: '你好' })
  assert.equal(sent.kind, 'sentence')
  assert.deepEqual(ZenCard.toEnglishBridge(sent), { t: 'sentence', en: 'Hello', zh: '你好' })
  const doc = ZenCard.fromEnglishBridge({ t: 'doc', title: '标题', text: '正文' })
  assert.equal(doc.kind, 'note')
  assert.equal(doc.ref, '标题')
})

test('Writer 转换：卡片变为合法 .zc 节点与画布', () => {
  const cards = [ZenCard.create({ content: 'A & B', note: '批注', tags: ['t'], ref: '出处' }, FIXED)]
  const node = ZenCard.toWriterNode(cards[0], 1)
  assert.equal(node.type, 'text')
  assert.equal(node.id, 'node-1')
  assert.ok(node.content.includes('A &amp; B'))
  assert.ok(node.content.includes('<blockquote>批注</blockquote>'))
  assert.notEqual(node.x, 0)
  const canvas = ZenCard.toWriterCanvas(cards, '知识卡片')
  assert.equal(canvas.format, 'zenwriter-canvas')
  assert.equal(canvas.v, 2)
  assert.equal(canvas.nodes.length, 1)
})

test('Data 转换：行 <-> 卡片，tags 用 | 连接', () => {
  const card = ZenCard.create({ content: 'x', tags: ['a', 'b'] }, FIXED)
  const row = ZenCard.toDataRow(card)
  assert.equal(row.tags, 'a|b')
  const back = ZenCard.fromDataRow(row)
  assert.deepEqual(back.tags, ['a', 'b'])
})

test('Search / Web / Markdown 辅助转换', () => {
  const s = ZenCard.fromSearchResult({ answer: '答案', url: 'https://x', tags: ['AI'] })
  assert.equal(s.source, 'search')
  assert.equal(s.kind, 'fact')
  assert.equal(s.ref, 'https://x')
  const w = ZenCard.fromWebSelection({ text: '<b>选中</b>' }, { url: 'https://y', note: '剪藏' })
  assert.equal(w.content, '选中')
  assert.equal(w.source, 'clip')
  const md = ZenCard.toMarkdown(ZenCard.create({ content: '行1\n行2', note: 'n', tags: ['t'] }, FIXED))
  assert.ok(md.startsWith('> 行1\n> 行2'))
  assert.ok(md.includes('#t'))
})

test('escapeHtml / stripHtml', () => {
  assert.equal(ZenCard.escapeHtml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;')
  assert.equal(ZenCard.stripHtml('<p>hello</p>'), 'hello')
})
