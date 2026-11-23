/* 智能搜索知识库深改专项测试（node:test） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../public/omm-search.html', import.meta.url), 'utf8')

function extractFunction(text, name) {
  const start = text.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} not found`)
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

test('搜索页引入通用卡片与知识库模块', () => {
  assert.ok(src.includes('src="lib/zen-card.js"'))
  assert.ok(src.includes('src="lib/search-library.js"'))
})

test('知识库入口与面板齐全', () => {
  assert.ok(src.includes('id="m-kb"'))
  assert.ok(src.includes('data-open="dd-kb"'))
  assert.ok(src.includes('id="dd-kb"'))
  for (const id of ['kb-filter', 'kb-pinned', 'kb-count', 'kb-stats', 'kb-list', 'kb-export', 'kb-import']) {
    assert.ok(src.includes(`id="${id}"`), `缺少 #${id}`)
  }
})

test('知识库渲染、检索与发送逻辑存在', () => {
  assert.ok(src.includes('function renderKB()'))
  assert.ok(src.includes('window.SearchLibrary.filter(S.history, kbFilter'))
  assert.ok(src.includes('window.SearchLibrary.stats(S.history)'))
  assert.ok(src.includes('function kbSend(entry, target)'))
  assert.ok(src.includes('data-pin='))
  assert.ok(src.includes('data-send='))
})

test('新搜索与清空历史都会刷新知识库', () => {
  const push = src.slice(src.indexOf('function pushHistory('), src.indexOf('function renderHistory()'))
  assert.ok(push.includes('renderKB()'))
  assert.ok(src.includes("renderHistory(); renderSuggestions(); renderKB(); toast('已清空历史')"))
})

test('导出卡片包与导入回历史都接入', () => {
  assert.ok(src.includes("window.SearchLibrary.pack(S.history, '搜索知识库')"))
  assert.ok(/window\.SearchLibrary\.unpack\(String\((?:text|reader\.result)\)\)/.test(src))
})

test('主脚本语法可解析', () => {
  const re = /<script>([\s\S]*?)<\/script>/g
  let m
  let main = ''
  while ((m = re.exec(src))) if (m[1].length > main.length) main = m[1]
  assert.ok(main.includes('function renderKB()'))
  assert.doesNotThrow(() => new Function(main))
})

test('新增知识库代码没有通配符 postMessage', () => {
  assert.doesNotMatch(src, /function kbSend[\s\S]{0,1200}postMessage\([^,]+,\s*'\*'/)

/* ------------------------------------------- 搜索 -> 卡片 -> 复习 联动 */

test('知识库每项都有存为卡片按钮与事件入口', () => {
  assert.ok(src.includes('data-tocard='))
  assert.ok(src.includes("e.target.closest('[data-tocard]')"))
  assert.ok(src.includes('function kbToCard(entry)'))
})

test('kbToCard 把历史条目经 toCard 写入卡片库', () => {
  const calls = []
  const entry = { query: '什么是 SM-2', answer: '一种间隔重复算法', sources: [{ url: 'https://x.example' }] }
  const fn = vm.runInNewContext(
    extractFunction(src, 'kbToCard') + '\nkbToCard',
    {
      window: {
        SearchLibrary: { toCard: (e) => { calls.push(['toCard', e]); return { content: e.answer } } },
        ZenLink: { publish: (c, t) => calls.push(['publish', c, t]) },
      },
      toast: (m) => calls.push(['toast', m]),
    }
  )
  fn(entry)
  assert.deepEqual(calls.map((c) => c[0]), ['toCard', 'publish', 'toast'])
  assert.deepEqual(calls[1][2], '') // 空目标 = 存本地卡片库，不弹 prompt
})

test('卡片模块未加载时 kbToCard 只提示不抛错', () => {
  const fn = vm.runInNewContext(extractFunction(src, 'kbToCard') + '\nkbToCard', {
    window: { SearchLibrary: null, ZenLink: null }, toast() {},
  })
  assert.doesNotThrow(() => fn({ query: 'x' }))
})
})
