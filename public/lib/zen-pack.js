/* zen-pack.js — ZenPack 工作区包：在 ZenBackup 之上的薄包装
 * 打包/校验/差异/合并/恢复全部委托给 zen-backup.js，不重复实现。
 * 这里只增加“整个工作区”的显式键注册表、可移植文件读写与 Hub 协议入口。
 */
import { ZenBackup } from './zen-backup.js'

/* 唯一键目录真源。keys 是精确键，prefixes 是产品源码明确使用的动态命名空间。
 * 不扫描任意 localStorage 键，也不按前缀猜测未注册产品。 */
const WORKSPACE_PRODUCTS = Object.freeze([
  {
    id: 'hub', name: '静书房工作台',
    keys: [
      'omm.hub.appearance.v1', 'omm.hub.pins.v1', 'omm.hub.recent.v1',
      'omm.hub.usage.v1', 'omm.hub.workspace.v1', 'omm.hub.workspaces.v1',
      'omm.bridge.ping.v1', 'zen.theme',
    ],
    prefixes: ['omm.hub.screen-layout.v1.'],
  },
  { id: 'ai', name: 'AI 工作区', keys: [], prefixes: [], optional: true },
  {
    id: 'annotate', name: '文本标注',
    keys: ['zencode.project.v1', 'zencode.settings.v1', 'zencode-sync-meta-v1'],
    prefixes: [],
  },
  {
    id: 'corpus', name: '英语语料库',
    keys: ['omm-corpus-v1', 'omm-corpus-sync-meta-v1', 'omm-corpus-v1-prepull-backup'],
    prefixes: [],
  },
  {
    id: 'data', name: '数据工作台',
    keys: [
      'zendata.v1.doc', 'zendata.v1.settings', 'zendata.v1.seed',
      'zendata.v1.rev', 'zendata-sync-meta-v1',
    ],
    prefixes: [],
  },
  {
    id: 'english', name: '六级备考',
    keys: ['zenglish_v1', 'zenglish-sync-meta-v2', 'zenglish_v1-prepull-backup'],
    prefixes: [],
  },
  {
    id: 'latex', name: 'LaTeX 编译工作台',
    keys: [
      'zentex.api', 'zentex.auto', 'zentex.autoDelay', 'zentex.autoLoad', 'zentex.bg',
      'zentex.document', 'zentex.editor', 'zentex.engine', 'zentex.flip',
      'zentex.menuPinned', 'zentex.passes', 'zentex.pngDpi', 'zentex.split',
      'zentex.templates', 'zentex.tpl',
    ],
    prefixes: [],
  },
  {
    id: 'mdforge', name: 'Markdown 铸造台',
    keys: ['mdforge.settings.v2', 'mdforge.draft.v1', 'mdforge.tuning.v1'],
    prefixes: [],
  },
  {
    id: 'message', name: '消息同步',
    keys: [
      'zmsg-ui-v1', 'zmsg-ui-v1-lang', 'zmsg-message-cache-v1',
      'zmsg-message-cache-v1-favorites', 'zmsg-device-v1-id', 'zmsg-device-v1-name',
    ],
    prefixes: [],
  },
  {
    id: 'planner', name: '日程安排',
    keys: ['zp-events-v1', 'zp-settings-v1', 'zp-data-v2', 'zp-count-v1', 'zp-sync-meta-v2'],
    prefixes: [],
  },
  { id: 'redact', name: '文档脱敏工具', keys: ['zr-settings'], prefixes: [] },
  { id: 'search', name: '智能搜索', keys: ['omm-search-v1'], prefixes: [] },
  {
    id: 'visualization', name: '可视化图表',
    keys: [
      'zenviz.workspace.v2', 'zenviz.preferences.v1', 'zenviz.layout-margin-mode',
      'zenviz.export-quality', 'zenviz.bg', 'zenviz.menuPinned',
      'zenviz.engine.v4.echarts', 'zenviz.engine.v4.chartjs',
      'zenviz.engine.v4.apexcharts', 'zenviz.engine.v4.zen',
      'zen.viz.review.v1', 'zen.viz.pending',
    ],
    prefixes: ['zenviz.engine.v4.', 'zenviz.engine.v3.', 'zenviz.engine.v2.'],
  },
  {
    id: 'writer', name: '所思所想',
    keys: [
      'zc-docs', 'zc-settings', 'zc-autosave', 'zc-connections',
      'zwLayoutStrategy', 'zwDocListMode', 'zw-sync-meta-v1',
    ],
    prefixes: ['zc-doc:'],
  },
  {
    id: 'zencard', name: '间隔复习',
    keys: ['zen.cards.v1', 'zen.srs.v1', 'zen.inbox.v1'],
    prefixes: [],
  },
  {
    id: 'zenflow', name: '自动化编排',
    keys: ['zen.flow.rules.v1', 'zen.flow.strategy.v1'],
    prefixes: [],
  },
  { id: 'zenclip', name: '网页剪藏', keys: ['zen.clip.v1'], prefixes: [] },
  { id: 'zenreview', name: '复盘报告', keys: [], prefixes: [], optional: true },
  { id: 'zenbackup', name: '统一备份', keys: [], prefixes: [], optional: true },
  { id: 'video', name: '视频工作台', keys: ['zen.video.canvas.v1'], prefixes: [] },
  {
    id: 'table', name: '表格自动化',
    keys: ['zen.table.canvas.v1', 'zenmark.table.ui.v1'],
    prefixes: [],
  },
  {
    id: 'lambda', name: 'Lambda 演算计算器',
    keys: ['lambda.ui.v2', 'lambda.hint.narrow'],
    prefixes: [],
  },
].map(function (product) {
  return Object.freeze(Object.assign({}, product, {
    keys: Object.freeze((product.keys || []).slice()),
    prefixes: Object.freeze((product.prefixes || []).slice()),
  }))
}))

const WORKSPACE_KEYS = Object.freeze(WORKSPACE_PRODUCTS.reduce(function (keys, product) {
  product.keys.forEach(function (key) {
    if (keys.indexOf(key) < 0) keys.push(key)
  })
  return keys
}, []))
const WORKSPACE_KEY_PREFIXES = Object.freeze(WORKSPACE_PRODUCTS.reduce(function (prefixes, product) {
  product.prefixes.forEach(function (prefix) {
    if (prefixes.indexOf(prefix) < 0) prefixes.push(prefix)
  })
  return prefixes
}, []))
const KEY_PRODUCT = new Map(WORKSPACE_KEYS.map(function (key) {
  const product = WORKSPACE_PRODUCTS.find(function (item) { return item.keys.indexOf(key) >= 0 })
  return [key, product]
}))
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

function appId(value) {
  return str(value).replace(/^omm-/, '')
}

function isWorkspaceKey(key) {
  if (typeof key !== 'string' || !key || key.length > 200 || UNSAFE_KEYS.has(key)) return false
  if (ZenBackup.isSecretKey(key)) return false
  if (KEY_PRODUCT.has(key)) return true
  return WORKSPACE_KEY_PREFIXES.some(function (prefix) {
    if (key.indexOf(prefix) !== 0) return false
    const suffix = key.slice(prefix.length)
    return !!suffix && /^[A-Za-z0-9_-]+$/.test(suffix) && !UNSAFE_KEYS.has(suffix)
  })
}

function productForKey(key) {
  if (KEY_PRODUCT.has(key)) return KEY_PRODUCT.get(key)
  return WORKSPACE_PRODUCTS.find(function (product) {
    return product.prefixes.some(function (prefix) {
      return key.indexOf(prefix) === 0 && isWorkspaceKey(key)
    })
  }) || null
}

function errorText(error) {
  if (!error) return '未知错误'
  return str(error.message || error)
}

/* 从存储里收集键 -> 产品条目。raw 始终是 localStorage 的原始字符串，
 * data 仅作预览/合并视图；恢复 raw 条目时绝不重新序列化。 */
function scanWorkspaceDetailed(storage, keys) {
  const entries = []
  const failures = []
  if (!storage || typeof storage.getItem !== 'function') {
    return { entries: entries, failures: [{ key: '(storage)', app: '', error: 'localStorage 不可用' }] }
  }
  const custom = Array.isArray(keys) && keys.length > 0
  const list = custom ? keys.slice() : WORKSPACE_KEYS.slice()
  if (!custom) {
    try {
      if (typeof storage.key === 'function' && storage.length !== undefined) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i)
          if (isWorkspaceKey(key) && list.indexOf(key) < 0) list.push(key)
        }
      }
    } catch (error) {
      failures.push({ key: '(storage)', app: '', error: '无法枚举动态工作区键：' + errorText(error) })
    }
  }
  const seen = new Set()
  list.forEach(function (key) {
    if (typeof key !== 'string' || !key || seen.has(key)) return
    seen.add(key)
    const product = productForKey(key)
    let raw
    try { raw = storage.getItem(key) } catch (error) {
      failures.push({ key: key, app: product ? product.id : '', error: errorText(error) })
      return
    }
    if (raw === null || raw === undefined) return
    let data = raw
    try { data = JSON.parse(raw) } catch (e) { /* 保留普通字符串 */ }
    const entry = {
      id: key,
      name: product ? product.name + ' / ' + key : key,
      data: data,
      raw: raw,
      encoding: 'raw',
    }
    if (product) entry.app = product.id
    entries.push(entry)
  })
  return { entries: entries, failures: failures }
}

function scanWorkspace(storage, keys) {
  return scanWorkspaceDetailed(storage, keys).entries
}

function normalizeResults(results) {
  const failures = []
  function add(row, fallbackApp) {
    if (!row) return
    if (typeof row === 'string') {
      failures.push({ app: fallbackApp || '', error: row })
      return
    }
    if (row.ok === false || row.success === false || row.error) {
      failures.push({
        app: appId(row.app || row.product || row.sourceApp || fallbackApp),
        key: str(row.key || row.id || ''),
        error: errorText(row.error || '产品未确认成功'),
      })
    }
  }
  if (Array.isArray(results)) results.forEach(function (row) { add(row, '') })
  else if (results && typeof results === 'object') {
    Object.keys(results).forEach(function (key) { add(results[key], key) })
  }
  return failures
}

function workspaceCoverage(manifest, results, mode, scanFailures) {
  const found = new Set()
  ;(manifest && Array.isArray(manifest.products) ? manifest.products : []).forEach(function (entry) {
    const product = WORKSPACE_PRODUCTS.find(function (item) {
      return item.id === appId(entry.app || entry.product || entry.sourceApp || entry.id)
    }) || productForKey(entry.id)
    if (product) found.add(product.id)
  })
  const failures = normalizeResults(results).concat(scanFailures || [])
  const failed = new Set(failures.map(function (failure) { return appId(failure.app) }).filter(Boolean))
  const missingProducts = WORKSPACE_PRODUCTS
    .filter(function (product) {
      return !product.optional && (product.keys.length || product.prefixes.length) &&
        !found.has(product.id) && !failed.has(product.id)
    })
    .map(function (product) { return product.id })
  const failedProducts = WORKSPACE_PRODUCTS
    .filter(function (product) { return failed.has(product.id) })
    .map(function (product) { return product.id })
  return {
    mode: mode || 'local',
    missingProducts: missingProducts,
    failedProducts: failedProducts,
    failures: failures,
  }
}

function collectWorkspace(storage, meta, options) {
  const opts = options || {}
  const scan = scanWorkspaceDetailed(storage)
  const manifest = ZenBackup.collect(scan.entries, Object.assign({
    name: opts.mode === 'hub' ? 'OMM-ZEN 全产品备份' : 'OMM-ZEN 同源工作区备份',
  }, meta || {}))
  manifest.coverage = workspaceCoverage(manifest, opts.results, opts.mode || 'local', scan.failures)
  return manifest
}

function makePack(storage, meta) {
  // 工作区包会被搬去另一台机器，导出前先脱敏：整条凭据键丢弃、字段遮罩、重算校验和。
  return ZenBackup.redactSecrets(collectWorkspace(storage, meta || { name: 'OMM-ZEN 工作区包' }))
}

function readPack(text) {
  const manifest = typeof text === 'string' ? JSON.parse(text) : text
  const check = ZenBackup.validate(manifest)
  if (!check.ok) throw new Error(check.errors[0])
  return manifest
}

/* 差异与合并都直接委托，避免两套语义。 */
function planPack(current, incoming) {
  return { diff: ZenBackup.diff(current, incoming), merged: ZenBackup.merge(current, incoming) }
}

/* 恢复到 localStorage 时只接受显式注册键；不读取 knownKeys，也不接受调用方扩张白名单。 */
function restoreEntries(manifest, storage) {
  readPack(manifest)
  return ZenBackup.restorableEntries(manifest, null, WORKSPACE_KEYS, storage)
}

function snapshot(entries, storage) {
  if (!storage || typeof storage.getItem !== 'function') throw new Error('localStorage 不可用')
  return entries.map(function (entry) {
    if (!isWorkspaceKey(entry.key)) throw new Error('快照包含未注册键：' + entry.key)
    return { key: entry.key, value: storage.getItem(entry.key) }
  })
}

function rollback(saved, storage) {
  const failures = []
  let written = 0
  saved.forEach(function (entry) {
    try {
      if (entry.value === null || entry.value === undefined) {
        if (typeof storage.removeItem !== 'function') throw new Error('storage.removeItem 不可用')
        storage.removeItem(entry.key)
      } else {
        storage.setItem(entry.key, entry.value)
      }
      written++
    } catch (error) { failures.push({ key: entry.key, error: errorText(error) }) }
  })
  return { written: written, failures: failures }
}

function applyPack(manifest, storage) {
  // 校验必须先于任何读取/写入；损坏包不能改变当前存储。
  const entries = restoreEntries(manifest, storage)
  const failures = []
  let written = 0
  entries.forEach(function (entry) {
    try {
      storage.setItem(entry.key, entry.value)
      if (storage.getItem(entry.key) !== entry.value) throw new Error('写入后读回值不一致')
      written++
    } catch (error) {
      failures.push({ key: entry.key, error: errorText(error) })
    }
  })
  // 全部成功保留既有数量返回；部分失败必须显式暴露失败列表，调用方不得按总条目数报成功。
  return failures.length ? { written: written, failures: failures } : written
}

function hubMode(win) {
  const w = win || (typeof window !== 'undefined' ? window : null)
  if (!w || !w.parent || w.parent === w) return false
  try {
    const params = new URLSearchParams(w.location.search || '')
    return params.get('omm_embed') === '1' || !!params.get('omm_hub_origin') || !!w.OMMDesktop
  } catch (e) { return false }
}

function hubTargetOrigin(win) {
  const w = win || (typeof window !== 'undefined' ? window : null)
  if (!w || !w.parent || w.parent === w) throw new Error('当前页面不在 Hub 嵌入窗格中')
  let raw = ''
  try { raw = new URLSearchParams(w.location.search || '').get('omm_hub_origin') || '' } catch (e) { /* noop */ }
  if (!raw) throw new Error('缺少 Hub origin，拒绝把当前 origin 当作全产品存储')
  let target
  try { target = new URL(raw) } catch (e) { throw new Error('Hub origin 非法') }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Hub origin 必须是 HTTP(S)')
  return target.origin
}

/* Hub 专用协议。请求与回复都校验 token；回复还必须来自精确父窗口与精确 origin。 */
function requestHub(action, manifest, options) {
  const opts = options || {}
  const win = opts.window || (typeof window !== 'undefined' ? window : null)
  if (action !== 'collect' && action !== 'restore') return Promise.reject(new Error('非法 Hub 备份动作'))
  if (!win || typeof win.parent.postMessage !== 'function') return Promise.reject(new Error('Hub 父窗口不可用'))
  let targetOrigin
  try { targetOrigin = hubTargetOrigin(win) } catch (error) { return Promise.reject(error) }
  if (action === 'restore') {
    try { readPack(manifest) } catch (error) { return Promise.reject(error) }
  }
  return new Promise(function (resolve, reject) {
    const token = 'zenbackup-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    let done = false
    let timer = null
    function cleanup() {
      if (typeof win.removeEventListener === 'function') win.removeEventListener('message', onMessage)
      if (timer !== null && typeof win.clearTimeout === 'function') win.clearTimeout(timer)
    }
    function fail(error) {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }
    function onMessage(event) {
      if (done || event.source !== win.parent || event.origin !== targetOrigin) return
      const reply = event.data
      if (!reply || reply.type !== 'omm:workspace-backup-reply' || reply.token !== token) return
      done = true
      cleanup()
      if (action === 'collect') {
        try {
          const collected = readPack(reply.manifest)
          resolve({
            ok: reply.ok === true,
            error: errorText(reply.error),
            manifest: collected,
            results: reply.results,
            coverage: workspaceCoverage(collected, reply.results, 'hub', collected.coverage && collected.coverage.failures),
          })
        } catch (error) {
          const failures = normalizeResults(reply.results)
          reject(new Error(errorText(reply.error || error.message) +
            (failures.length ? '；' + failures.map(function (item) {
              return (item.app || item.key || '未知产品') + '：' + item.error
            }).join('；') : '')))
        }
      } else {
        // 部分恢复失败也必须把 results 交给页面展示和回滚，不能吞成通用错误。
        resolve(reply)
      }
    }
    if (typeof win.addEventListener !== 'function') {
      reject(new Error('当前环境不支持 Hub 消息监听'))
      return
    }
    win.addEventListener('message', onMessage)
    const message = { type: 'omm:workspace-backup-request', token: token, action: action }
    if (action === 'restore') message.manifest = manifest
    const setTimer = typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : setTimeout
    const clearTimer = typeof win.clearTimeout === 'function' ? win.clearTimeout.bind(win) : clearTimeout
    // Hub owns an 180s job budget; wait slightly longer so its real progress or
    // failure reply arrives before the caller removes the listener.
    timer = setTimer(function () { fail(new Error('Hub 备份请求超时')) }, Number(opts.timeout) || 190000)
    try {
      win.parent.postMessage(message, targetOrigin)
    } catch (error) { fail(error) }
  })
}

export const ZenPack = {
  WORKSPACE_PRODUCTS,
  WORKSPACE_KEYS,
  WORKSPACE_KEY_PREFIXES,
  isWorkspaceKey,
  productForKey,
  scanWorkspace,
  collectWorkspace,
  makePack,
  readPack,
  planPack,
  restoreEntries,
  snapshot,
  rollback,
  applyPack,
  workspaceCoverage,
  normalizeResults,
  hubMode,
  hubTargetOrigin,
  requestHub,
}
if (typeof globalThis !== 'undefined') globalThis.ZenPack = ZenPack
export default ZenPack
