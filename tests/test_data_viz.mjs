/* data-viz.js 单元测试 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DataViz } from '../public/data-viz.js'

const table = {
  name: '销量',
  cols: [{ name: '月份' }, { name: '销量' }, { name: '利润' }],
  rows: [['一月', 12, 5], ['二月', '二,月', 7]],
}

test('toCSV 正确转义逗号、引号与换行', () => {
  const csv = DataViz.toCSV(table)
  assert.ok(csv.includes('月份,销量,利润'))
  assert.ok(csv.includes('"二,月"'))
  assert.equal(DataViz.csvCell('a"b'), '"a""b"')
  assert.ok(csv.includes('\r\n'))
})

test('guessRoles 识别分类列与数值列', () => {
  const roles = DataViz.guessRoles(['月份', '销量', '利润'], [['一月', 12, 5], ['二月', 19, 7]])
  assert.equal(roles.category, 0)
  assert.deepEqual(roles.values, [1, 2])
})

test('guessRoles 在全数值表里有兜底系列', () => {
  const roles = DataViz.guessRoles(['A', 'B'], [[1, 2], [3, 4]])
  assert.deepEqual(roles.values, [1])
})

test('toPayload 包含 headers/rows/csv/roles', () => {
  const p = DataViz.toPayload(table)
  assert.equal(p.format, 'zenviz-data')
  assert.equal(p.v, 1)
  assert.deepEqual(p.headers, ['月份', '销量', '利润'])
  assert.equal(p.roles.category, 0)
  assert.ok(p.csv.includes('销量'))
})

test('parsePayload 校验格式并往返', () => {
  const p = DataViz.toPayload(table)
  assert.deepEqual(DataViz.parsePayload(JSON.stringify(p)), p)
  assert.throws(() => DataViz.parsePayload('{"format":"bad"}'))
  assert.throws(() => DataViz.parsePayload('{"format":"zenviz-data","v":1}'))
})

test('isNumeric 区分数字与文本', () => {
  assert.equal(DataViz.isNumeric('12'), true)
  assert.equal(DataViz.isNumeric('一月'), false)
  assert.equal(DataViz.isNumeric(null), false)
})
