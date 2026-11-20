/* zen-review.js — 复盘数据聚合与报告生成（纯函数，无依赖）
 * 汇总 Hub 时间线 / Planner 完成项 / 知识卡片，产出统计与 Markdown 报告。
 */
function arr(v) {
  return Array.isArray(v) ? v : []
}
function str(v) {
  return v === null || v === undefined ? '' : String(v)
}
function dateKey(v) {
  // Hub 时间线的 ts 常是 Date.now() 数字（epoch 毫秒）。原实现先 str() 再
  // new Date()，把 "1767225600000" 当日期字符串解析成 Invalid Date，导致
  // 所有数字时间戳的事件被区间过滤静默丢弃。
  if (typeof v === 'number' && isFinite(v)) {
    const nd = new Date(v)
    return isNaN(nd.getTime()) ? '' : nd.toISOString().slice(0, 10)
  }
  const s = str(v)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  if (/^\d+$/.test(s)) {
    const nd = new Date(Number(s))
    return isNaN(nd.getTime()) ? '' : nd.toISOString().slice(0, 10)
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

function inRange(key, range) {
  if (!key) return false
  if (!range || (!range.from && !range.to)) return true
  // 区间边界同样可能是 Date.now() 数字（Hub 时间线就是这种形状）。直接
  // str(range.from).slice(0,10) 会得到 "1767225600" 之类的片段，与 ISO 日期键
  // 比较时整个区间的数据会被静默丢弃；统一走 dateKey 归一化。
  const from = range.from ? dateKey(range.from) : ''
  const to = range.to ? dateKey(range.to) : ''
  if (from && key < from) return false
  if (to && key > to) return false
  return true
}

function summarize(data, range) {
  const timeline = arr(data && data.timeline).filter(function (e) {
    return inRange(dateKey(e && (e.ts || e.time || e.date || e.at)), range)
  })
  const cards = arr(data && data.cards).filter(function (c) {
    return inRange(dateKey(c && c.createdAt), range)
  })
  const done = arr(data && data.planner).filter(function (e) {
    if (!e || (e.done !== true && e.done !== 'done')) return false
    const key = dateKey(e.day || e.date || e.ts || e.time || e.at)
    // 有日期的完成项按区间过滤；历史数据没有日期时沿用原行为（纳入统计）。
    return !key || inRange(key, range)
  })
  const byApp = Object.create(null)
  timeline.forEach(function (e) {
    const app = str(e && (e.app || e.source || e.product)) || '未知'
    byApp[app] = (byApp[app] || 0) + 1
  })
  const tagCount = Object.create(null)
  cards.forEach(function (c) {
    arr(c && c.tags).forEach(function (t) {
      tagCount[t] = (tagCount[t] || 0) + 1
    })
  })
  const topTags = Object.keys(tagCount)
    .map(function (t) {
      return { tag: t, count: tagCount[t] }
    })
    .sort(function (a, b) {
      return b.count - a.count
    })
    .slice(0, 8)
  const days = Object.create(null)
  timeline.forEach(function (e) {
    const k = dateKey(e && (e.ts || e.time || e.date || e.at))
    if (k) days[k] = (days[k] || 0) + 1
  })
  const activeDays = Object.keys(days).length
  return {
    events: timeline.length,
    cards: cards.length,
    done: done.length,
    byApp: byApp,
    topTags: topTags,
    activeDays: activeDays,
    timeline: timeline,
    doneList: done,
  }
}

function buildReport(data, opts) {
  const o = opts || {}
  const s = summarize(data, o.range)
  const lines = []
  lines.push('# ' + (o.title || '复盘报告'))
  if (o.range && (o.range.from || o.range.to)) {
    lines.push('', '周期：' + (o.range.from || '…') + ' 至 ' + (o.range.to || '…'))
  }
  lines.push('')
  lines.push('- 活跃天数：**' + s.activeDays + '**')
  lines.push('- 跨产品动态：**' + s.events + '** 条')
  lines.push('- 新增知识卡片：**' + s.cards + '** 张')
  lines.push('- 完成待办：**' + s.done + '** 项')
  const apps = Object.keys(s.byApp).sort(function (a, b) {
    return s.byApp[b] - s.byApp[a]
  })
  if (apps.length) {
    lines.push('', '## 产品活跃度', '')
    lines.push('| 产品 | 动态数 |')
    lines.push('| --- | --- |')
    apps.forEach(function (a) {
      lines.push('| ' + a + ' | ' + s.byApp[a] + ' |')
    })
  }
  if (s.topTags.length) {
    lines.push('', '## 高频标签', '')
    lines.push(s.topTags.map(function (t) { return '#' + t.tag + '(' + t.count + ')' }).join('  '))
  }
  if (s.doneList.length) {
    lines.push('', '## 已完成', '')
    s.doneList.slice(0, 30).forEach(function (e) {
      lines.push('- ' + str(e.title || e.text || e.content || '（无标题）'))
    })
  }
  if (o.notes) {
    lines.push('', '## 手写小结', '', str(o.notes))
  }
  return lines.join('\n') + '\n'
}

export const ZenReview = { summarize, buildReport, inRange, dateKey }
if (typeof globalThis !== 'undefined') globalThis.ZenReview = ZenReview
export default ZenReview
