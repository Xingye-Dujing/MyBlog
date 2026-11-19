/* zen-flow.js — 产品间自动化工作流规则引擎（纯函数，无依赖）
 * 规则：当一张卡片满足 when 条件时，产生 actions 描述的副作用（交给宿主执行）。
 * 引擎本身不碰 DOM / 网络 / 存储，便于测试。供 ZenFlow 产品使用。
 */
const ACTIONS = ['addTag', 'setKind', 'send', 'publish', 'notify', 'highlight']

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

function arr(v) {
  return Array.isArray(v) ? v : []
}

function createRule(input) {
  const r = input && typeof input === 'object' ? input : {}
  return {
    id: str(r.id) || 'rule-' + Date.now().toString(36),
    name: str(r.name) || '未命名规则',
    enabled: r.enabled !== false,
    priority: Number(r.priority) || 0,
    when: {
      source: str(r.when && r.when.source),
      kind: str(r.when && r.when.kind),
      tag: str(r.when && r.when.tag),
      text: str(r.when && r.when.text),
    },
    actions: arr(r.actions).filter(function (a) {
      return a && ACTIONS.indexOf(a.type) >= 0
    }),
  }
}

function validateRule(rule) {
  const errors = []
  if (!rule || typeof rule !== 'object') return { ok: false, errors: ['规则必须是对象'] }
  if (!str(rule.name)) errors.push('name 不能为空')
  if (!Array.isArray(rule.actions) || !rule.actions.length) errors.push('至少需要一条 action')
  rule.actions.forEach(function (a, i) {
    if (ACTIONS.indexOf(a.type) < 0) errors.push('actions[' + i + '].type 非法')
    if (a.type === 'send' && !str(a.to)) errors.push('actions[' + i + '].to 不能为空')
  })
  return { ok: errors.length === 0, errors: errors }
}

function match(rule, card) {
  if (!rule || rule.enabled === false || !card) return false
  const w = rule.when || {}
  if (w.source && str(card.source) !== w.source) return false
  if (w.kind && str(card.kind) !== w.kind) return false
  if (w.tag && arr(card.tags).indexOf(w.tag) < 0) return false
  if (w.text && str(card.content).indexOf(w.text) < 0) return false
  return true
}

function applyActions(rule, card, ctx) {
  const c = Object.assign({}, card, { tags: arr(card.tags).slice() })
  const effects = []
  const at = (ctx && ctx.now) || Date.now()
  arr(rule.actions).forEach(function (a) {
    switch (a.type) {
      case 'addTag': {
        const t = str(a.value || a.tag).trim()
        if (t && c.tags.indexOf(t) < 0) c.tags.push(t)
        break
      }
      case 'setKind':
        c.kind = str(a.value || a.kind) || c.kind
        break
      case 'highlight':
        c.color = str(a.value || a.color) || '#e3a400'
        break
      case 'send':
        effects.push({ type: 'send', to: str(a.to), card: Object.assign({}, c), at: at })
        break
      case 'publish':
        effects.push({ type: 'publish', channel: str(a.channel || 'auto'), card: Object.assign({}, c), at: at })
        break
      case 'notify':
        effects.push({ type: 'notify', message: str(a.message || rule.name + ' 已触发'), at: at })
        break
      default:
        break
    }
  })
  return { card: c, effects: effects }
}

/* Run all enabled rules in priority order. A card may trigger several rules. */
function run(rules, cards, ctx) {
  const list = arr(rules)
    .map(createRule)
    .filter(function (r) {
      return r.enabled !== false
    })
    .sort(function (a, b) {
      return a.priority - b.priority
    })
  const out = []
  const effects = []
  const fired = []
  arr(cards).forEach(function (raw) {
    let card = Object.assign({}, raw)
    list.forEach(function (r) {
      if (!match(r, card)) return
      const res = applyActions(r, card, ctx)
      card = res.card
      effects.push.apply(effects, res.effects)
      fired.push({ ruleId: r.id, cardId: str(card.id) })
    })
    out.push(card)
  })
  return { cards: out, effects: effects, fired: fired }
}

function serialize(rules) {
  return JSON.stringify({ format: 'zen-flow', v: 1, rules: arr(rules).map(createRule) })
}

function deserialize(text) {
  const obj = typeof text === 'string' ? JSON.parse(text) : text
  if (!obj || obj.format !== 'zen-flow' || !Array.isArray(obj.rules)) {
    throw new Error('非法 zen-flow 规则文件')
  }
  return obj.rules.map(createRule)
}

export const ZenFlow = {
  ACTIONS,
  createRule,
  validateRule,
  match,
  applyActions,
  run,
  serialize,
  deserialize,
}
if (typeof globalThis !== 'undefined') globalThis.ZenFlow = ZenFlow
export default ZenFlow
