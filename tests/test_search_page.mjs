/* 智能搜索知识库深改专项测试（node:test） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../public/omm-search.html', import.meta.url), 'utf8')

test('搜索页引入通用卡片与知识库模块', () => {
  assert.ok(src.includes('src="zen-card.js"'))
  assert.ok(src.includes('src="search-library.js"'))
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
  assert.ok(src.includes('window.SearchLibrary.unpack(String(reader.result))'))
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
})
