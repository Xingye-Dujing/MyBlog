/* zen-srs.js — SM-2 间隔重复核心（纯函数，无依赖）
 * 供 ZenCard 复习产品使用；同时挂到 globalThis.ZenSRS。
 */
const DAY = 86400000
const RELEARN = 10 * 60 * 1000
const MIN_EASE = 1.3

function num(v, fallback) {
  const n = Number(v)
  return isFinite(n) ? n : fallback
}

function createState(cardId, now) {
  return {
    id: String(cardId),
    reps: 0,
    ease: 2.5,
    interval: 0,
    due: num(now, Date.now()),
    lapses: 0,
    last: null,
  }
}

function fromCards(cards, now) {
  const seen = Object.create(null)
  return (Array.isArray(cards) ? cards : []).reduce(function (out, c) {
    const id = String((c && c.id) || '')
    if (!id || seen[id]) return out
    seen[id] = 1
    out.push(createState(id, now))
    return out
  }, [])
}

/* quality: 0..5，或 'again'|'hard'|'good'|'easy' */
function toQuality(grade) {
  if (typeof grade === 'number') return Math.max(0, Math.min(5, Math.round(grade)))
  return { again: 0, hard: 3, good: 4, easy: 5 }[String(grade)] === undefined
    ? 4
    : { again: 0, hard: 3, good: 4, easy: 5 }[String(grade)]
}

function grade(state, input, now) {
  const s = state || createState('', now)
  const q = toQuality(input)
  const t = num(now, Date.now())
  const next = {
    id: s.id,
    reps: num(s.reps, 0),
    ease: num(s.ease, 2.5),
    interval: num(s.interval, 0),
    due: num(s.due, t),
    lapses: num(s.lapses, 0),
    last: t,
  }
  if (q < 3) {
    next.reps = 0
    next.interval = 0
    next.lapses += 1
    next.due = t + RELEARN
    next.ease = Math.max(MIN_EASE, next.ease - 0.2)
    return next
  }
  next.reps += 1
  if (next.reps === 1) next.interval = 1
  else if (next.reps === 2) next.interval = 6
  else next.interval = Math.max(1, Math.round(next.interval * next.ease))
  next.ease = Math.max(MIN_EASE, next.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
  next.due = t + next.interval * DAY
  return next
}

function update(states, id, input, now) {
  return (Array.isArray(states) ? states : []).map(function (s) {
    return s && s.id === id ? grade(s, input, now) : s
  })
}

function dueQueue(states, now, limit) {
  const t = num(now, Date.now())
  const list = (Array.isArray(states) ? states : [])
    .filter(function (s) {
      return s && num(s.due, 0) <= t
    })
    .sort(function (a, b) {
      return num(a.due, 0) - num(b.due, 0)
    })
  return typeof limit === 'number' && limit >= 0 ? list.slice(0, limit) : list
}

function stats(states, now) {
  const t = num(now, Date.now())
  const list = Array.isArray(states) ? states : []
  let learned = 0
  let lapses = 0
  let due = 0
  let easeSum = 0
  list.forEach(function (s) {
    if (num(s.reps, 0) >= 2) learned += 1
    lapses += num(s.lapses, 0)
    if (num(s.due, 0) <= t) due += 1
    easeSum += num(s.ease, 0)
  })
  return {
    total: list.length,
    learned: learned,
    learning: list.length - learned,
    lapses: lapses,
    due: due,
    avgEase: list.length ? Math.round((easeSum / list.length) * 100) / 100 : 0,
  }
}

function serialize(states) {
  return JSON.stringify({ format: 'zen-srs', v: 1, states: Array.isArray(states) ? states : [] })
}

function deserialize(text) {
  const obj = typeof text === 'string' ? JSON.parse(text) : text
  if (!obj || obj.format !== 'zen-srs' || !Array.isArray(obj.states)) {
    throw new Error('非法 zen-srs 状态文件')
  }
  return obj.states
}

export const ZenSRS = {
  DAY,
  createState,
  fromCards,
  toQuality,
  grade,
  update,
  dueQueue,
  stats,
  serialize,
  deserialize,
}
if (typeof globalThis !== 'undefined') globalThis.ZenSRS = ZenSRS
export default ZenSRS
