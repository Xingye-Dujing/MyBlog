/* zen-backup.js — 全产品统一备份：打包、校验、合并、差异（纯函数，无依赖）
 * 配合 Hub 的存档面板，把分散在各产品的 JSON 汇成一个可恢复的清单。
 */
function arr(v) {
  return Array.isArray(v) ? v : []
}
function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

/* 备份会作为文件分享出去，不能直接携带 API Key / 令牌 / 数据库凭据。
 * 字段名按“词”判断，兼容 apiKey / api_key / accessToken / X-Supabase-Key。 */
const SECRET_WORDS = new Set([
  'apikey', 'token', 'secret', 'password', 'passwd', 'pwd',
  'credential', 'credentials', 'authorization', 'supabase',
])
const REDACTED = '***REDACTED***'

function wordsOf(key) {
  return str(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(function (w) { return w.toLowerCase() })
}

function isSecretKey(key) {
  const words = wordsOf(key)
  if (words.some(function (w) { return SECRET_WORDS.has(w) })) return true
  // apiKey 分词后是 api + key；紧凑串仍能命中 apikey 这类组合词。
  const compact = words.join('')
  return Array.from(SECRET_WORDS).some(function (w) { return compact.indexOf(w) >= 0 })
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    const out = {}
    Object.keys(value).forEach(function (k) {
      out[k] = isSecretKey(k) ? REDACTED : redactValue(value[k])
    })
    return out
  }
  return value
}

function containsSecret(value) {
  if (Array.isArray(value)) return value.some(containsSecret)
  if (value && typeof value === 'object') {
    return Object.keys(value).some(function (k) { return isSecretKey(k) || containsSecret(value[k]) })
  }
  return false
}

/* 导出前调用：整条密钥条目直接丢弃，普通条目里的敏感字段遮罩，并重算校验和。 */
function redactSecrets(manifest) {
  if (!manifest || !Array.isArray(manifest.products)) return manifest
  const products = manifest.products
    .filter(function (p) { return p && !isSecretKey(p.id) })
    .map(function (p) {
      const hadSecret = containsSecret(p.data)
      const data = redactValue(p.data)
      // 标记“内容被遮罩过”：分享导出可以带它，但绝不能再用它恢复本地数据，
      // 否则 REDACTED 会把真实的 apiKey/密码覆盖掉且不可撤销。
      return Object.assign({}, p, {
        data: data,
        checksum: checksum(data),
        redacted: hadSecret || p.redacted === true ? true : undefined,
      })
    })
  return Object.assign({}, manifest, { products: products })
}

/* 恢复时只允许写回 OMM-ZEN 自己的键（或当前已存在的键），防止伪造包借
 * p.id 覆盖任意 localStorage 项或写入 __proto__ 之类的特殊键。 */
const RESTORE_PREFIXES = ['zen.', 'zc-', 'zw', 'zp-', 'zr-', 'omm.', 'omm-', 'zenglish-']

function isRestorableKey(key) {
  const k = str(key)
  if (!k || k.length > 200 || isSecretKey(k)) return false
  return RESTORE_PREFIXES.some(function (prefix) { return k.indexOf(prefix) === 0 })
}

function restorableEntries(manifest, knownKeys, allowedKeys) {
  const known = Array.isArray(knownKeys) ? knownKeys : []
  const allowed = Array.isArray(allowedKeys) && allowedKeys.length ? allowedKeys : null
  return (manifest && Array.isArray(manifest.products) ? manifest.products : [])
    .filter(function (p) {
      if (!p || isSecretKey(p.id) || p.redacted === true) return false
      if (allowed) return allowed.indexOf(p.id) >= 0
      return isRestorableKey(p.id) || known.indexOf(p.id) >= 0
    })
    .map(function (p) {
      return { key: p.id, value: typeof p.data === 'string' ? p.data : JSON.stringify(p.data) }
    })
}

function checksum(value) {
  const text = JSON.stringify(value)
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

function collect(products, meta) {
  const entries = arr(products)
    .filter(function (p) {
      return p && str(p.id)
    })
    .map(function (p) {
      return {
        id: str(p.id),
        name: str(p.name || p.id),
        version: str(p.version || '1'),
        savedAt: str(p.savedAt || new Date().toISOString()),
        checksum: checksum(p.data),
        data: p.data,
      }
    })
  return {
    format: 'zen-backup',
    v: 1,
    createdAt: str(meta && meta.createdAt) || new Date().toISOString(),
    name: str(meta && meta.name) || 'OMM-ZEN 全量备份',
    products: entries,
  }
}

function validate(manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['备份必须是对象'] }
  if (manifest.format !== 'zen-backup') errors.push('format 必须是 zen-backup')
  if (manifest.v !== 1) errors.push('v 必须是数字 1')
  if (!Array.isArray(manifest.products)) errors.push('products 必须是数组')
  else {
    manifest.products.forEach(function (p, i) {
      if (!p || !str(p.id)) errors.push('products[' + i + '].id 不能为空')
      // 缺失 checksum 与 checksum 不匹配都不能放过，否则伪造/损坏的包能借
      // readPack() 的 validate() 这道唯一完整性闸门写入任意工作区键。
      if (p && (!str(p.checksum) || p.checksum !== checksum(p.data))) {
        errors.push('products[' + i + '].checksum 缺失或不匹配')
      }
    })
  }
  return { ok: errors.length === 0, errors: errors }
}

function byId(manifest) {
  const map = Object.create(null)
  arr(manifest && manifest.products).forEach(function (p) {
    if (p && str(p.id)) map[p.id] = p
  })
  return map
}

function uniqueBy(data, idField) {
  const key = idField || 'id'
  const seen = Object.create(null)
  return arr(data).filter(function (row) {
    if (!row || typeof row !== 'object') return true
    const id = str(row[key])
    if (!id) return true
    if (seen[id]) return false
    seen[id] = 1
    return true
  })
}

/* Merge incoming into current. Strategy: 'incoming' (覆盖), 'current' (保留),
 * 'append' (按 id 去重追加，默认). */
function merge(current, incoming, opts) {
  const o = opts || {}
  const strategy = o.strategy || 'append'
  const a = byId(current)
  const b = byId(incoming)
  const ids = Object.keys(b).concat(Object.keys(a).filter(function (id) {
    return !b[id]
  }))
  const products = ids.map(function (id) {
    const left = a[id]
    const right = b[id]
    if (!right) return left
    if (!left || strategy === 'incoming') return right
    if (strategy === 'current') return left
    // 只有两侧都是数组才做去重合并；任一侧是对象（主题/设置）时必须取其一，
    // 否则 arr(对象) 会变成 []，把对象数据整份丢掉。
    const mergedData =
      Array.isArray(right.data) && Array.isArray(left.data)
        ? uniqueBy(arr(right.data).concat(arr(left.data)), o.idField || 'id')
        : strategy === 'incoming' ? right.data : left.data
    // right.checksum 是针对旧 right.data 算的，合并后必须重算，否则生成的清单
    // 连自己的 validate() 都过不了（"checksum 不匹配"）。
    return Object.assign({}, right, { data: mergedData, checksum: checksum(mergedData) })
  })
  return {
    format: 'zen-backup',
    v: 1,
    createdAt: new Date().toISOString(),
    name: str(o.name) || '合并备份',
    products: products,
  }
}

function diff(current, incoming) {
  const a = byId(current)
  const b = byId(incoming)
  const added = []
  const removed = []
  const changed = []
  Object.keys(b).forEach(function (id) {
    if (!a[id]) added.push(id)
    else if (checksum(a[id].data) !== checksum(b[id].data)) changed.push(id)
  })
  Object.keys(a).forEach(function (id) {
    if (!b[id]) removed.push(id)
  })
  return { added: added, removed: removed, changed: changed }
}

export const ZenBackup = {
  collect, validate, byId, uniqueBy, merge, diff, checksum,
  isSecretKey, redactSecrets, isRestorableKey, restorableEntries,
}
if (typeof globalThis !== 'undefined') globalThis.ZenBackup = ZenBackup
export default ZenBackup
