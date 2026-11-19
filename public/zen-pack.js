/* zen-pack.js — ZenPack 工作区包：在 ZenBackup 之上的薄包装
 * 打包/校验/差异/合并/恢复全部委托给 zen-backup.js，不重复实现。
 * 这里只增加“整个工作区”的键目录与可移植文件的读写入口。
 */
import { ZenBackup } from './zen-backup.js'

/* 构成一次完整搬家的数据：卡片/剪藏/规则/笔记/设置/工作台状态。 */
const WORKSPACE_KEYS = [
  'zen.cards.v1', 'zen.inbox.v1', 'zen.clip.v1',
  'zen.flow.rules.v1', 'zen.flow.strategy.v1', 'zen.theme',
  'zc-docs', 'zc-settings', 'zc-autosave', 'zwLayoutStrategy', 'zwDocListMode',
  'omm-search-v1', 'zp-settings-v1', 'zr-settings', 'zenglish-supabase-config-v1',
  'omm.hub.appearance.v1', 'omm.hub.pins.v1', 'omm.hub.workspaces.v1',
  'omm.hub.recent.v1', 'omm.hub.usage.v1', 'omm.bridge.ping.v1',
]

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

/* 从存储里收集键 -> 产品条目，交给 ZenBackup.collect 统一打包。 */
function scanWorkspace(storage, keys) {
  const list = Array.isArray(keys) && keys.length ? keys : WORKSPACE_KEYS
  const out = []
  list.forEach(function (key) {
    let raw
    try { raw = storage.getItem(key) } catch (e) { return }
    if (raw === null || raw === undefined) return
    let data = raw
    try { data = JSON.parse(raw) } catch (e) { /* 保留原始字符串 */ }
    out.push({ id: key, name: key, data: data })
  })
  return out
}

function makePack(storage, meta) {
  return ZenBackup.collect(scanWorkspace(storage), meta || { name: 'OMM-ZEN 工作区包' })
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

/* 恢复到 localStorage 时使用的键值对；字符串原样写回，对象序列化。 */
function restoreEntries(manifest) {
  return (manifest && Array.isArray(manifest.products) ? manifest.products : []).map(function (p) {
    return {
      key: p.id,
      value: typeof p.data === 'string' ? p.data : JSON.stringify(p.data),
    }
  })
}

function applyPack(manifest, storage) {
  const entries = restoreEntries(manifest)
  entries.forEach(function (e) {
    try { storage.setItem(e.key, e.value) } catch (err) { /* 配额或只读键，跳过 */ }
  })
  return entries.length
}

export const ZenPack = {
  WORKSPACE_KEYS,
  scanWorkspace,
  makePack,
  readPack,
  planPack,
  restoreEntries,
  applyPack,
}
if (typeof globalThis !== 'undefined') globalThis.ZenPack = ZenPack
export default ZenPack
