/* zen-backup.js — 全产品统一备份：打包、校验、合并、差异（纯函数，无依赖）
 * 配合 Hub 的存档面板，把分散在各产品的 JSON 汇成一个可恢复的清单。
 */
function arr(v) {
  return Array.isArray(v) ? v : []
}
function str(v) {
  return v === null || v === undefined ? '' : String(v)
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
      if (p && p.checksum && p.checksum !== checksum(p.data)) {
        errors.push('products[' + i + '].checksum 不匹配')
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
    const mergedData = uniqueBy(
      arr(right.data).concat(arr(left.data)),
      o.idField || 'id'
    )
    return Object.assign({}, right, { data: mergedData })
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

export const ZenBackup = { collect, validate, byId, uniqueBy, merge, diff, checksum }
if (typeof globalThis !== 'undefined') globalThis.ZenBackup = ZenBackup
export default ZenBackup
