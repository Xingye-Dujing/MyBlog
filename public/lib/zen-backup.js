/* zen-backup.js — 全产品统一备份：打包、校验、合并、差异（纯函数，无依赖）
 * 配合 Hub 的存档面板，把分散在各产品的 JSON 汇成一个可恢复的清单。
 */
function arr(v) {
  return Array.isArray(v) ? v : []
}

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key)
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cloneJSON(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/* 备份会作为文件分享出去，不能直接携带 API Key / 令牌 / 数据库凭据。
 * 字段名按“词”判断，兼容 apiKey / api_key / accessToken / X-Supabase-Key。 */
const SECRET_WORDS = new Set([
  'apikey', 'token', 'secret', 'password', 'passwd', 'pwd',
  'credential', 'credentials', 'authorization', 'supabase',
])
const REDACTED = '***REDACTED***'
const UNSAFE_PATH_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

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

function pathSegment(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? '.' + key : '[' + JSON.stringify(key) + ']'
}

function redactValue(value, path, maskedPaths, storageMap) {
  if (Array.isArray(value)) {
    return value.map(function (item, index) {
      return redactValue(item, path + '[' + index + ']', maskedPaths, false)
    })
  }
  if (value && typeof value === 'object') {
    const out = {}
    Object.keys(value).forEach(function (k) {
      const childPath = path + pathSegment(k)
      let safe
      if (isSecretKey(k)) {
        safe = REDACTED
        maskedPaths.push(childPath)
      } else if (storageMap && typeof value[k] === 'string') {
        // Hub 产品快照的 localStorage/sessionStorage 值是原始 JSON 字符串；
        // 只有发现敏感字段时才反序列化并重写，普通 raw 字符串保持字节不变。
        const before = maskedPaths.length
        try {
          const parsed = JSON.parse(value[k])
          safe = redactValue(parsed, childPath, maskedPaths, false)
          if (maskedPaths.length === before) safe = value[k]
          else safe = JSON.stringify(safe)
        } catch (e) { safe = value[k] }
      } else {
        safe = redactValue(value[k], childPath, maskedPaths, k === 'localStorage' || k === 'sessionStorage')
      }
      // defineProperty 保留名为 __proto__ 的普通 JSON 字段，绝不修改对象原型。
      Object.defineProperty(out, k, {
        value: safe, enumerable: true, configurable: true, writable: true,
      })
    })
    return out
  }
  return value
}

function parseMaskedPath(path) {
  if (typeof path !== 'string' || path.charAt(0) !== '$') throw new Error('非法遮蔽路径')
  const parts = []
  let i = 1
  while (i < path.length) {
    if (path.charAt(i) === '.') {
      i++
      const start = i
      while (i < path.length && /[A-Za-z0-9_$]/.test(path.charAt(i))) i++
      if (i === start) throw new Error('非法遮蔽路径')
      parts.push(path.slice(start, i))
      continue
    }
    if (path.charAt(i) !== '[') throw new Error('非法遮蔽路径')
    i++
    if (path.charAt(i) === '"') {
      const start = i
      i++
      while (i < path.length) {
        if (path.charAt(i) === '\\') { i += 2; continue }
        if (path.charAt(i) === '"') break
        i++
      }
      if (i >= path.length) throw new Error('非法遮蔽路径')
      let key
      try { key = JSON.parse(path.slice(start, i + 1)) } catch (e) { throw new Error('非法遮蔽路径') }
      if (typeof key !== 'string') throw new Error('非法遮蔽路径')
      parts.push(key)
      i++
    } else {
      const start = i
      while (i < path.length && /[0-9]/.test(path.charAt(i))) i++
      if (i === start) throw new Error('非法遮蔽路径')
      parts.push(Number(path.slice(start, i)))
    }
    if (path.charAt(i) !== ']') throw new Error('非法遮蔽路径')
    i++
  }
  if (parts.some(function (part) { return typeof part === 'string' && UNSAFE_PATH_KEYS.has(part) })) {
    throw new Error('非法遮蔽路径')
  }
  return parts
}

function pathContainer(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch (e) { return value }
}

function valueAtPath(value, parts) {
  let current = value
  for (let i = 0; i < parts.length; i++) {
    current = pathContainer(current)
    const key = parts[i]
    if (!current || typeof current !== 'object' || !hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

const SKIP_VALUE = Symbol('skip-redacted-value')

function mergeMaskedPath(incoming, current, parts) {
  if (!parts.length) {
    return current === undefined || current === REDACTED ? SKIP_VALUE : cloneJSON(current)
  }
  const source = pathContainer(incoming)
  if (!source || typeof source !== 'object') return incoming
  const key = parts[0]
  if (!hasOwn(source, key)) return incoming
  const currentObject = pathContainer(current)
  const currentChild = currentObject && typeof currentObject === 'object' && hasOwn(currentObject, key)
    ? currentObject[key]
    : undefined
  const merged = mergeMaskedPath(source[key], currentChild, parts.slice(1))
  if (merged === SKIP_VALUE) delete source[key]
  else {
    Object.defineProperty(source, key, {
      value: merged, enumerable: true, configurable: true, writable: true,
    })
  }
  return typeof incoming === 'string' ? JSON.stringify(source) : source
}

function mergeMaskedValue(incoming, current, maskedPaths) {
  let out = cloneJSON(incoming)
  maskedPaths.forEach(function (path) {
    out = mergeMaskedPath(out, current, parseMaskedPath(path))
  })
  return out
}

function currentValue(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') return undefined
  const raw = storage.getItem(key)
  if (raw === null || raw === undefined) return undefined
  try { return JSON.parse(raw) } catch (e) { return raw }
}

/* 导出前调用：整条密钥条目直接丢弃，普通条目里的敏感字段遮罩，并重算校验和。
 * 遮蔽路径随包导出；恢复时只处理这些路径，history 等普通字段完整保留。 */
function redactSecrets(manifest) {
  if (!manifest || !Array.isArray(manifest.products)) return manifest
  const products = []
  manifest.products.forEach(function (p) {
    if (!p || isSecretKey(p.id)) return
    const out = Object.assign({}, p)
    const maskedPaths = []
    if (p.encoding === 'raw') {
      let parsed = p.data
      try { parsed = JSON.parse(p.raw) } catch (e) { /* 普通字符串按原值处理 */ }
      const safe = redactValue(parsed, '$', maskedPaths)
      if (maskedPaths.length) {
        out.data = safe
        out.raw = JSON.stringify(safe)
      }
    } else {
      out.data = redactValue(p.data, '$', maskedPaths)
    }
    const paths = maskedPaths.length ? maskedPaths : arr(p.maskedPaths)
    if (paths.length || p.redacted === true) {
      out.redacted = true
      out.maskedPaths = paths
    } else {
      delete out.redacted
      delete out.maskedPaths
    }
    out.checksum = checksum(entryPayload(out))
    products.push(out)
  })
  return Object.assign({}, manifest, { products: products })
}

/* 通用备份的兼容入口。实际工作区恢复必须同时传入明确 allowedKeys；
 * 那时 knownKeys 不参与判断，redacted 条目按 maskedPaths 合并而非整条丢弃。 */
const RESTORE_PREFIXES = ['zen.', 'zc-', 'zw', 'zp-', 'zr-', 'omm.', 'omm-', 'zenglish-']

function isRestorableKey(key) {
  const k = str(key)
  if (!k || k.length > 200 || isSecretKey(k)) return false
  if (UNSAFE_PATH_KEYS.has(k)) return false
  return RESTORE_PREFIXES.some(function (prefix) { return k.indexOf(prefix) === 0 })
}

function restoreEntryData(entry, current) {
  const maskedPaths = arr(entry && entry.maskedPaths)
  if (entry && entry.redacted === true && !maskedPaths.length) return { skip: true, value: undefined }
  const incoming = maskedPaths.length ? mergeMaskedValue(entry.data, current, maskedPaths) : cloneJSON(entry.data)
  return incoming === SKIP_VALUE
    ? { skip: true, value: undefined }
    : { skip: false, value: incoming }
}

function restoreEntryValue(entry, current) {
  const maskedPaths = arr(entry && entry.maskedPaths)
  if (entry && entry.redacted === true && !maskedPaths.length) return { skip: true, value: undefined }
  if (entry && entry.encoding === 'raw') {
    if (!maskedPaths.length) return { skip: false, value: entry.raw }
    let incoming
    try { incoming = JSON.parse(entry.raw) } catch (e) { return { skip: true, value: undefined } }
    const merged = mergeMaskedValue(incoming, current, maskedPaths)
    return merged === SKIP_VALUE
      ? { skip: true, value: undefined }
      : { skip: false, value: JSON.stringify(merged) }
  }
  const incoming = maskedPaths.length ? mergeMaskedValue(entry.data, current, maskedPaths) : entry.data
  if (incoming === SKIP_VALUE) return { skip: true, value: undefined }
  const value = entry.encoding === 'json'
    ? JSON.stringify(incoming)
    : typeof incoming === 'string' ? incoming : JSON.stringify(incoming)
  return { skip: false, value: value }
}

function restorableEntries(manifest, knownKeys, allowedKeys, storage) {
  const known = arr(knownKeys)
  const explicit = arr(allowedKeys)
  const allowed = explicit.length ? new Set(explicit) : null
  const entries = []
  arr(manifest && manifest.products).forEach(function (p) {
    if (!p || isSecretKey(p.id)) return false
    if (allowed ? !allowed.has(p.id) : known.indexOf(p.id) < 0 && !isRestorableKey(p.id)) return false
    const maskedPaths = arr(p.maskedPaths)
    if (p.redacted === true && !allowed) return false
    const restored = restoreEntryValue(p, currentValue(storage, p.id))
    if (restored.skip) return false
    const entry = { key: p.id, value: restored.value }
    if (maskedPaths.length) entry.maskedPaths = maskedPaths.slice()
    entries.push(entry)
  })
  return entries
}

function checksum(value) {
  const text = JSON.stringify(value)
  if (text === undefined) throw new TypeError('备份数据必须是可序列化的 JSON 值')
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

function entryPayload(entry) {
  return entry && entry.encoding === 'raw' ? entry.raw : entry && entry.data
}

function entryChecksum(entry) {
  return checksum(entryPayload(entry))
}

function collect(products, meta) {
  const entries = arr(products)
    .filter(function (p) { return p && str(p.id) })
    .map(function (p) {
      const entry = {
        id: str(p.id),
        name: str(p.name || p.id),
        version: str(p.version || '1'),
        savedAt: str(p.savedAt || new Date().toISOString()),
        data: p.data,
      }
      if (hasOwn(p, 'raw')) {
        entry.raw = p.raw
        entry.encoding = 'raw'
      } else if (hasOwn(p, 'encoding')) {
        entry.encoding = p.encoding
      }
      if (hasOwn(p, 'app')) entry.app = str(p.app)
      if (hasOwn(p, 'product')) entry.product = str(p.product)
      if (hasOwn(p, 'redacted')) entry.redacted = p.redacted
      if (hasOwn(p, 'maskedPaths')) entry.maskedPaths = arr(p.maskedPaths)
      entry.checksum = checksum(entryPayload(entry))
      return entry
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
  if (!isObject(manifest)) return { ok: false, errors: ['备份必须是对象'] }
  if (manifest.format !== 'zen-backup') errors.push('format 必须是 zen-backup')
  if (manifest.v !== 1) errors.push('v 必须是数字 1')
  if (!Array.isArray(manifest.products)) errors.push('products 必须是数组')
  else {
    const ids = new Set()
    manifest.products.forEach(function (p, i) {
      const at = 'products[' + i + ']'
      if (!isObject(p)) { errors.push(at + ' 必须是对象'); return }
      if (typeof p.id !== 'string' || !p.id) errors.push(at + '.id 不能为空')
      else if (ids.has(p.id)) errors.push(at + '.id 重复：' + p.id)
      else ids.add(p.id)
      if (!hasOwn(p, 'data')) errors.push(at + '.data 缺失')
      if (typeof p.checksum !== 'string' || !/^[0-9a-z]{1,7}$/.test(p.checksum)) {
        errors.push(at + '.checksum 缺失或格式非法')
      }
      if (hasOwn(p, 'encoding') && p.encoding !== 'raw' && p.encoding !== 'json') {
        errors.push(at + '.encoding 必须是 raw 或 json')
      }
      if (p.encoding === 'raw') {
        if (typeof p.raw !== 'string') errors.push(at + '.raw 必须是字符串')
        if (hasOwn(p, 'data') && typeof p.raw === 'string') {
          let parsed
          try { parsed = JSON.parse(p.raw) } catch (e) { parsed = p.raw }
          try {
            if (checksum(parsed) !== checksum(p.data)) errors.push(at + '.data 与 raw 不一致')
          } catch (e) { errors.push(at + '.data 必须是可序列化的 JSON 值') }
        }
      } else if (hasOwn(p, 'raw')) {
        errors.push(at + '.raw 必须配合 encoding: raw')
      }
      if (hasOwn(p, 'redacted') && typeof p.redacted !== 'boolean') {
        errors.push(at + '.redacted 必须是布尔值')
      }
      if (hasOwn(p, 'maskedPaths')) {
        if (!Array.isArray(p.maskedPaths)) errors.push(at + '.maskedPaths 必须是数组')
        else {
          const seen = new Set()
          p.maskedPaths.forEach(function (path, pathIndex) {
            try {
              parseMaskedPath(path)
              if (seen.has(path)) errors.push(at + '.maskedPaths[' + pathIndex + '] 重复')
              seen.add(path)
              if (valueAtPath(p.data, parseMaskedPath(path)) !== REDACTED) {
                errors.push(at + '.maskedPaths[' + pathIndex + '] 未指向遮蔽值')
              }
            } catch (e) { errors.push(at + '.maskedPaths[' + pathIndex + '] 非法') }
          })
        }
      }
      if (p.redacted === true && (!Array.isArray(p.maskedPaths) || !p.maskedPaths.length)) {
        errors.push(at + '.redacted 必须附带 maskedPaths')
      }
      try {
        if (typeof p.checksum === 'string' && p.checksum !== entryChecksum(p)) {
          errors.push(at + '.checksum 不匹配')
        }
      } catch (e) { errors.push(at + '.checksum 无法计算') }
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

function refreshEntry(entry) {
  const out = Object.assign({}, entry)
  out.checksum = entryChecksum(out)
  return out
}

/* Merge incoming into current. Strategy: 'incoming' (覆盖), 'current' (保留),
 * 'append' (按 id 去重追加，默认). */
function merge(current, incoming, opts) {
  const o = opts || {}
  const strategy = o.strategy || 'append'
  const a = byId(current)
  const b = byId(incoming)
  const ids = Object.keys(b).concat(Object.keys(a).filter(function (id) { return !b[id] }))
  const products = ids.map(function (id) {
    const left = a[id]
    const right = b[id]
    if (!right) return refreshEntry(left)
    if (!left || strategy === 'incoming') return refreshEntry(right)
    if (strategy === 'current') return refreshEntry(left)
    // 脱敏数组的字段路径与旧下标绑定，不能与另一份数据直接拼接。
    if (right.redacted === true || left.redacted === true) return refreshEntry(right)
    if (Array.isArray(right.data) && Array.isArray(left.data)) {
      const mergedData = uniqueBy(arr(right.data).concat(arr(left.data)), o.idField || 'id')
      const out = Object.assign({}, right, { data: mergedData })
      delete out.raw
      delete out.encoding
      out.checksum = checksum(mergedData)
      return out
    }
    // 只有两侧都是数组才做去重合并；对象/主题/设置必须完整取其一。
    return refreshEntry(left)
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
    else if (entryChecksum(a[id]) !== entryChecksum(b[id])) changed.push(id)
  })
  Object.keys(a).forEach(function (id) {
    if (!b[id]) removed.push(id)
  })
  return { added: added, removed: removed, changed: changed }
}

export const ZenBackup = {
  collect, validate, byId, uniqueBy, merge, diff, checksum,
  isSecretKey, redactSecrets, isRestorableKey, restorableEntries, restoreEntryData, restoreEntryValue,
  REDACTED,
}
if (typeof globalThis !== 'undefined') globalThis.ZenBackup = ZenBackup
export default ZenBackup
