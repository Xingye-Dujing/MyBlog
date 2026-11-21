/* lib/zen-chart.js 单元测试 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ZenChart } from '../public/lib/zen-chart.js'

test('parseCSV 解析表头与数值', () => {
  const d = ZenChart.parseCSV('月份,销量\n1月,10\n2月,20')
  assert.deepEqual(d.labels, ['1月', '2月'])
  assert.equal(d.series.length, 1)
  assert.deepEqual(d.series[0].values, [10, 20])
})

test('parseCSV 支持多系列与自定义分隔符', () => {
  const d = ZenChart.parseCSV('月份;A;B\n一月;1;2\n二月;3;4', ';')
  assert.equal(d.series.length, 2)
  assert.deepEqual(d.series[1].values, [2, 4])
})

test('normalize 接受数组 / labels+series / csv', () => {
  assert.deepEqual(ZenChart.normalize([{ label: 'a', value: 1 }]).labels, ['a'])
  const d = ZenChart.normalize({ labels: ['x'], series: [{ name: 's', values: [3] }] })
  assert.equal(d.series[0].values[0], 3)
  assert.equal(ZenChart.normalize({ csv: 'a,b\n1,2' }).labels[0], '1')
})

test('renderSVG 生成自包含 SVG 且转义标题', () => {
  const svg = ZenChart.renderSVG({ kind: 'bar', title: '<A & B>', labels: ['x', 'y'], series: [{ name: 's', values: [1, 2] }] })
  assert.ok(svg.startsWith('<svg'))
  assert.ok(svg.includes('&lt;A &amp; B&gt;'))
  assert.ok(svg.includes('<rect'))
  assert.ok(svg.includes('s: 1'))
  assert.ok(svg.endsWith('</svg>'))
})

test('line 渲染折线与点', () => {
  const svg = ZenChart.renderSVG({ kind: 'line', labels: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] })
  assert.ok(svg.includes('<polyline'))
  assert.ok(svg.includes('<circle'))
})

test('toDataURL 生成可用于 image 节点的 data URL', () => {
  const url = ZenChart.toDataURL({ labels: ['a'], series: [{ name: 's', values: [1] }] })
  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'))
  assert.ok(decodeURIComponent(url.split(',')[1]).includes('<svg'))
})

test('空数据也能生成合法 SVG', () => {
  const svg = ZenChart.renderSVG({})
  assert.ok(svg.includes('<svg'))
  assert.ok(svg.endsWith('</svg>'))
})

test('normalize 容忍非数组的 labels', () => {
  const d = ZenChart.normalize({ labels: 'abc', series: [{ name: 's', values: [1] }] })
  assert.deepEqual(d.labels, [])
  assert.ok(ZenChart.renderSVG({ labels: 'abc', series: [{ name: 's', values: [1] }] }).includes('<svg'))
})
