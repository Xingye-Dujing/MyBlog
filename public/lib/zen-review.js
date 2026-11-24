/* zen-review.js — 复盘数据聚合与报告生成（纯函数，无依赖）
 * 汇总 Hub 时间线 / Planner 完成项 / 知识卡片，产出统计与 Markdown 报告。
 */
function arr(v) {
  return Array.isArray(v) ? v : []
}
function str(v) {
  return v === null || v === undefined ? '' : String(v)
}
function localDateKey(date) {
  if (!date || isNaN(date.getTime())) return ''
  return String(date.getFullYear()).padStart(4, '0') + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0')
}

function dateKey(v) {
  if (typeof v === 'number' && isFinite(v)) return localDateKey(new Date(v))
  const s = str(v).trim()
  if (!s) return ''
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (dateOnly) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    const date = new Date(0)
    date.setHours(0, 0, 0, 0)
    date.setFullYear(year, month - 1, day)
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
      ? s
      : ''
  }
  const date = new Date(/^\d+$/.test(s) ? Number(s) : s)
  return localDateKey(date)
}

function defaultRange(now) {
  const end = new Date(now === undefined ? Date.now() : now)
  const start = new Date(end.getTime())
  start.setDate(start.getDate() - 6)
  return { from: dateKey(start), to: dateKey(end) }
}

function parseJSONArray(text, field) {
  const name = str(field).trim()
  if (name !== 'timeline' && name !== 'planner') {
    return { value: [], error: '未知 JSON 字段：' + name }
  }
  const raw = str(text).trim()
  if (!raw) return { value: [], error: '' }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { value: [], error: name + ' JSON 解析失败：' + (error.message || String(error)) }
  }
  if (Array.isArray(parsed)) return { value: parsed, error: '' }
  if (parsed && typeof parsed === 'object') {
    const hasTimeline = Object.prototype.hasOwnProperty.call(parsed, 'timeline')
    const hasPlanner = Object.prototype.hasOwnProperty.call(parsed, 'planner')
    if (hasTimeline || hasPlanner) {
      if (!hasTimeline || !Array.isArray(parsed.timeline)) {
        return { value: [], error: '规范 wrapper 的 timeline 必须是数组' }
      }
      if (!hasPlanner || !Array.isArray(parsed.planner)) {
        return { value: [], error: '规范 wrapper 的 planner 必须是数组' }
      }
      return { value: parsed[name], error: '', wrapper: parsed }
    }
  }
  return { value: [], error: name + ' 必须是数组或规范 wrapper { timeline: [...], planner: [...] }' }
}

function inRange(key, range) {
  const normalized = dateKey(key)
  if (!normalized) return false
  if (!range || (!range.from && !range.to)) return true
  const from = range.from ? dateKey(range.from) : ''
  const to = range.to ? dateKey(range.to) : ''
  if (from && normalized < from) return false
  if (to && normalized > to) return false
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
    const from = o.range.from ? dateKey(o.range.from) : ''
    const to = o.range.to ? dateKey(o.range.to) : ''
    lines.push('', '周期：' + (from || '…') + ' 至 ' + (to || '…'))
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

export const ZenReview = { summarize, buildReport, inRange, dateKey, defaultRange, parseJSONArray }
if (typeof globalThis !== 'undefined') globalThis.ZenReview = ZenReview
export default ZenReview
