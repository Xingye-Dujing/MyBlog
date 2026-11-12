/*
 * OMM-ZEN desktop bridge: save path, versioned files, snapshots and shared
 * resources.  The same file is loaded by every product page; on the public
 * website the /__omm/fs/status probe returns 404 and the script stays dormant.
 */
;(function () {
  'use strict'
  if (window.__ommDesktopLoaded) return
  window.__ommDesktopLoaded = true

  var API = '/__omm/fs'
  var APP_ID = (function () {
    var file = (location.pathname.split('/').pop() || '').toLowerCase()
    var m = file.match(/^omm-([a-z0-9_-]+)\.html$/)
    if (m) return m[1]
    if (/\/$/.test(location.pathname) && /mdforge/i.test(document.title)) return 'mdforge'
    return ''
  })()

  /* Products embedded in the hub shell must not draw their own floating
     archive button: the hub keeps one archive entry in its top bar. */
  var EMBEDDED = (function () {
    try {
      return new URLSearchParams(window.location.search).get('omm_embed') === '1'
    } catch (e) {
      return /[?&]omm_embed=1(?:&|$)/.test(window.location.search)
    }
  })()

  var state = {
    enabled: false,
    ready: false,
    savePath: '',
    mode: 'versioned',
    autoSnapshot: true,
    defaultPath: '',
    config: null,
    lastFingerprint: '',
    lastSnapshotAt: 0,
    restoring: false,
  }

  var blobUrls = new Map()
  var originalCreateObjectURL = URL.createObjectURL
  var originalRevokeObjectURL = URL.revokeObjectURL
  var originalAnchorClick = HTMLAnchorElement.prototype.click

  function qs(path, params) {
    var list = []
    var all = Object.assign({ app: APP_ID || undefined }, params || {})
    Object.keys(all).forEach(function (key) {
      if (all[key] === undefined || all[key] === null || all[key] === '') return
      list.push(encodeURIComponent(key) + '=' + encodeURIComponent(all[key]))
    })
    return API + path + (list.length ? '?' + list.join('&') : '')
  }

  function request(path, options, params) {
    options = options || {}
    options.cache = 'no-store'
    if (options.body && typeof options.body !== 'string') {
      options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {})
      options.body = JSON.stringify(options.body)
    }
    return fetch(qs(path, params), options).then(function (res) {
      var type = res.headers.get('Content-Type') || ''
      if (type.indexOf('application/json') >= 0) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error((data && (data.error || data.message)) || '请求失败')
          return data
        })
      }
      if (!res.ok) throw new Error('请求失败 (' + res.status + ')')
      return res.arrayBuffer().then(function (buf) {
        return { ok: true, data: buf, type: type }
      })
    })
  }

  function toast(text, kind) {
    if (!state.shadow) return
    var box = state.shadow.getElementById('omm-toast')
    if (!box) return
    box.textContent = text
    box.dataset.kind = kind || 'info'
    box.classList.add('show')
    clearTimeout(box._timer)
    box._timer = setTimeout(function () {
      box.classList.remove('show')
    }, kind === 'error' ? 6000 : 3800)
  }

  function fmtSize(bytes) {
    if (!bytes) return '0 B'
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }

  function fmtTime(value) {
    if (!value) return ''
    var d = new Date(value)
    if (isNaN(d.getTime())) return String(value)
    return d.toLocaleString()
  }

  // ------------------------------------------------------------- state capture

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onload = function () {
        var text = String(reader.result || '')
        resolve(text.slice(text.indexOf(',') + 1))
      }
      reader.onerror = function () {
        reject(reader.error || new Error('读取文件失败'))
      }
      reader.readAsDataURL(blob)
    })
  }

  function base64ToBlob(data, mime) {
    var binary = atob(data || '')
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type: mime || 'application/octet-stream' })
  }

  function base64ToBytes(data) {
    var binary = atob(data || '')
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }

  async function encodeValue(value) {
    if (value === null || value === undefined) return value
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value
    }
    if (value instanceof Blob) {
      return {
        __omm_type: 'blob',
        mime: value.type || 'application/octet-stream',
        name: value.name || '',
        data: await blobToBase64(value),
      }
    }
    if (value instanceof ArrayBuffer) {
      return { __omm_type: 'bytes', data: await blobToBase64(new Blob([value])) }
    }
    if (ArrayBuffer.isView(value)) {
      return {
        __omm_type: 'bytes',
        data: await blobToBase64(new Blob([value.buffer.slice(0)])),
      }
    }
    if (value instanceof Date) {
      return { __omm_type: 'date', value: value.toISOString() }
    }
    if (Array.isArray(value)) {
      var list = []
      for (var i = 0; i < value.length; i++) list.push(await encodeValue(value[i]))
      return list
    }
    if (typeof value === 'object') {
      var out = {}
      var keys = Object.keys(value)
      for (var k = 0; k < keys.length; k++) out[keys[k]] = await encodeValue(value[keys[k]])
      return out
    }
    return String(value)
  }

  function decodeValue(value) {
    if (value === null || value === undefined) return value
    if (Array.isArray(value)) return value.map(decodeValue)
    if (typeof value !== 'object') return value
    if (value.__omm_type === 'blob') {
      var blob = base64ToBlob(value.data, value.mime)
      if (value.name) {
        try {
          return new File([blob], value.name, { type: value.mime || blob.type })
        } catch (e) {
          return blob
        }
      }
      return blob
    }
    if (value.__omm_type === 'bytes') return base64ToBytes(value.data)
    if (value.__omm_type === 'date') return new Date(value.value)
    var out = {}
    Object.keys(value).forEach(function (key) {
      out[key] = decodeValue(value[key])
    })
    return out
  }

  function openDatabase(name, version, upgrade) {
    return new Promise(function (resolve, reject) {
      var req = version ? indexedDB.open(name, version) : indexedDB.open(name)
      req.onupgradeneeded = function (event) {
        if (typeof upgrade === 'function') {
          try {
            upgrade(req.result, event)
          } catch (e) {
            // ignore schema errors; records below may still restore
          }
        }
      }
      req.onsuccess = function () {
        resolve(req.result)
      }
      req.onerror = function () {
        reject(req.error || new Error('打开数据库失败: ' + name))
      }
      req.onblocked = function () {
        reject(new Error('数据库被占用: ' + name))
      }
    })
  }

  function createSchema(db, info) {
    ;(info.stores || []).forEach(function (storeInfo) {
      if (!db.objectStoreNames.contains(storeInfo.name)) {
        var store = db.createObjectStore(storeInfo.name, {
          keyPath: storeInfo.keyPath === null ? undefined : storeInfo.keyPath,
          autoIncrement: !!storeInfo.autoIncrement,
        })
        ;(storeInfo.indexes || []).forEach(function (idx) {
          try {
            store.createIndex(idx.name, idx.keyPath, {
              unique: !!idx.unique,
              multiEntry: !!idx.multiEntry,
            })
          } catch (e) {}
        })
      }
    })
  }

  async function captureDatabase(name) {
    var db = await openDatabase(name)
    var stores = []
    var names = Array.prototype.slice.call(db.objectStoreNames)
    if (!names.length) {
      db.close()
      return { name: name, version: db.version, stores: [] }
    }
    var tx = db.transaction(names, 'readonly')
    for (var i = 0; i < names.length; i++) {
      var storeName = names[i]
      var store = tx.objectStore(storeName)
      var info = {
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: !!store.autoIncrement,
        indexes: [],
        records: [],
      }
      var idxNames = Array.prototype.slice.call(store.indexNames)
      idxNames.forEach(function (idxName) {
        var idx = store.index(idxName)
        info.indexes.push({
          name: idx.name,
          keyPath: idx.keyPath,
          unique: !!idx.unique,
          multiEntry: !!idx.multiEntry,
        })
      })
      var keys = await new Promise(function (resolve, reject) {
        var r = store.getAllKeys()
        r.onsuccess = function () { resolve(r.result || []) }
        r.onerror = function () { reject(r.error) }
      })
      var values = await new Promise(function (resolve, reject) {
        var r = store.getAll()
        r.onsuccess = function () { resolve(r.result || []) }
        r.onerror = function () { reject(r.error) }
      })
      for (var n = 0; n < values.length; n++) {
        info.records.push({
          key: await encodeValue(keys[n]),
          value: await encodeValue(values[n]),
        })
      }
      stores.push(info)
    }
    db.close()
    return { name: name, version: db.version, stores: stores }
  }

  async function captureState(label) {
    var snapshot = {
      version: 1,
      app: APP_ID,
      label: label || '手动快照',
      taken_at: new Date().toISOString(),
      url: location.href,
      localStorage: {},
      sessionStorage: {},
      indexedDB: [],
    }
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i)
        snapshot.localStorage[key] = localStorage.getItem(key)
      }
    } catch (e) {}
    try {
      for (var s = 0; s < sessionStorage.length; s++) {
        var skey = sessionStorage.key(s)
        snapshot.sessionStorage[skey] = sessionStorage.getItem(skey)
      }
    } catch (e) {}

    if (!window.indexedDB || typeof indexedDB.databases !== 'function') return snapshot
    var databases = []
    try {
      databases = await indexedDB.databases()
    } catch (e) {
      databases = []
    }
    for (var d = 0; d < databases.length; d++) {
      var info = databases[d]
      if (!info || !info.name) continue
      try {
        snapshot.indexedDB.push(await captureDatabase(info.name))
      } catch (e) {
        // A database can be busy; keep the rest of the snapshot.
      }
    }
    return snapshot
  }

  async function restoreDatabase(info) {
    if (!info || !info.name) return
    var db = null
    try {
      db = await openDatabase(info.name)
    } catch (e) {
      db = await openDatabase(info.name, info.version || 1, function (up) {
        createSchema(up, info)
      })
    }
    var missing = (info.stores || []).filter(function (storeInfo) {
      return !db.objectStoreNames.contains(storeInfo.name)
    })
    if (missing.length) {
      var nextVersion = (db.version || 1) + 1
      db.close()
      db = await openDatabase(info.name, nextVersion, function (up) {
        createSchema(up, info)
      })
    }
    for (var i = 0; i < (info.stores || []).length; i++) {
      var storeInfo = info.stores[i]
      if (!db.objectStoreNames.contains(storeInfo.name)) continue
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(storeInfo.name, 'readwrite')
        var store = tx.objectStore(storeInfo.name)
        var r = store.clear()
        r.onerror = function () { reject(r.error) }
        r.onsuccess = function () {
          var records = storeInfo.records || []
          for (var n = 0; n < records.length; n++) {
            var record = records[n]
            var value = decodeValue(record.value)
            if (storeInfo.keyPath === null || storeInfo.keyPath === undefined) {
              store.put(value, decodeValue(record.key))
            } else {
              store.put(value)
            }
          }
        }
        tx.oncomplete = function () { resolve() }
        tx.onerror = function () { reject(tx.error) }
        tx.onabort = function () { reject(tx.error || new Error('恢复事务中止')) }
      })
    }
    db.close()
  }

  async function applyState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('快照内容无效')
    state.restoring = true
    var ls = snapshot.localStorage || {}
    try {
      Object.keys(localStorage).forEach(function (key) {
        localStorage.removeItem(key)
      })
      Object.keys(ls).forEach(function (key) {
        localStorage.setItem(key, String(ls[key]))
      })
    } catch (e) {
      throw new Error('写入本地数据失败: ' + (e && e.message ? e.message : e))
    }
    var ss = snapshot.sessionStorage || {}
    try {
      Object.keys(sessionStorage).forEach(function (key) {
        sessionStorage.removeItem(key)
      })
      Object.keys(ss).forEach(function (key) {
        sessionStorage.setItem(key, String(ss[key]))
      })
    } catch (e) {}

    var dbs = snapshot.indexedDB || []
    for (var i = 0; i < dbs.length; i++) {
      await restoreDatabase(dbs[i])
    }
    state.restoring = false
    location.reload()
  }

  function fingerprint(text) {
    var head = text.slice(0, 2048)
    var tail = text.slice(-2048)
    var hash = 2166136261
    var sample = head + tail
    for (var i = 0; i < sample.length; i++) {
      hash ^= sample.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return text.length + ':' + (hash >>> 0)
  }

  // ------------------------------------------------------------------ saving

  function fallbackDownload(blob, filename) {
    try {
      var url = originalCreateObjectURL.call(URL, blob)
      var a = document.createElement('a')
      a.href = url
      a.download = filename || 'omm-export.bin'
      originalAnchorClick.call(a)
      setTimeout(function () { originalRevokeObjectURL.call(URL, url) }, 30000)
    } catch (e) {}
  }

  function saveBlob(filename, blob, options) {
    options = options || {}
    if (!state.enabled) return Promise.resolve(false)
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onload = function () { resolve(String(reader.result || '').split(',')[1] || '') }
      reader.onerror = function () { reject(reader.error || new Error('读取文件失败')) }
      reader.readAsDataURL(blob)
    }).then(async function (data) {
      var payload = {
        app: APP_ID,
        name: filename || 'omm-export.bin',
        mime: blob.type || '',
        data: data,
        mode: options.mode || state.mode,
        label: options.label || ('保存 ' + (filename || '')),
      }
      if (options.snapshot !== false && state.autoSnapshot) {
        try {
          var snapshot = await captureState(payload.label)
          var fp = fingerprint(JSON.stringify(snapshot))
          if (fp !== state.lastFingerprint || Date.now() - state.lastSnapshotAt > 60000) {
            payload.state = snapshot
            state.lastFingerprint = fp
            state.lastSnapshotAt = Date.now()
          }
        } catch (e) {}
      }
      return request('/save', { method: 'POST', body: payload }).then(function (result) {
        var extra = result.mode === 'versioned' ? '（历史版本）' : ''
        toast('已保存 ' + result.filename + extra + '\n' + result.path)
        refreshArchive()
        return result
      })
    }).catch(function (err) {
      toast('保存失败：' + (err && err.message ? err.message : err), 'error')
      fallbackDownload(blob, filename)
      throw err
    })
  }

  function saveText(filename, text, mime, options) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' })
    return saveBlob(filename, blob, options)
  }

  function createSnapshot(label) {
    if (!state.enabled) return Promise.reject(new Error('当前不是桌面版'))
    toast('正在生成历史快照…')
    return captureState(label || '手动快照').then(function (snapshot) {
      return request('/snapshot', { method: 'POST', body: { app: APP_ID, state: snapshot, label: label || '手动快照' } })
    }).then(function (result) {
      toast('快照已创建：' + result.name)
      state.lastSnapshotAt = Date.now()
      refreshArchive()
      return result
    }).catch(function (err) {
      toast('快照失败：' + (err && err.message ? err.message : err), 'error')
      throw err
    })
  }

  function installHooks() {
    URL.createObjectURL = function (obj) {
      var url = originalCreateObjectURL.call(URL, obj)
      try {
        if (obj instanceof Blob) blobUrls.set(url, obj)
      } catch (e) {}
      return url
    }
    URL.revokeObjectURL = function (url) {
      setTimeout(function () { blobUrls.delete(url) }, 120000)
      return originalRevokeObjectURL.call(URL, url)
    }
    HTMLAnchorElement.prototype.click = function () {
      var href = this.href || ''
      var name = this.getAttribute('download')
      if (state.enabled && name && (blobUrls.has(href) || /^data:/i.test(href))) {
        var blob = blobUrls.get(href)
        if (!blob && /^data:/i.test(href)) {
          try {
            var parts = href.split(',')
            var meta = parts[0]
            var mime = (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream'
            blob = base64ToBlob(parts[1] || '', mime)
          } catch (e) {
            blob = null
          }
        }
        if (blob) {
          saveBlob(name, blob).catch(function () {})
          return
        }
      }
      return originalAnchorClick.apply(this, arguments)
    }

    // Server-generated downloads (MdForge / LaTeX) are ordinary links.  Fetch
    // them into a Blob so they follow the same save-path rules.
    document.addEventListener('click', function (event) {
      if (!state.enabled) return
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return
      var href = anchor.href || ''
      if (!/\/api\/download\//i.test(href) && !/\/pdf\?/i.test(href)) return
      event.preventDefault()
      event.stopPropagation()
      fetch(href, { cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('下载失败 (' + res.status + ')')
        var disposition = res.headers.get('Content-Disposition') || ''
        var name = ''
        var utf = disposition.match(/filename\*=UTF-8''([^;]+)/i)
        if (utf) {
          try { name = decodeURIComponent(utf[1]) } catch (e) {}
        }
        if (!name) {
          var plain = disposition.match(/filename="?([^";]+)"?/i)
          if (plain) name = plain[1]
        }
        if (!name) {
          var last = (href.split('?')[0].split('/').pop() || 'download').toLowerCase()
          name = /\/pdf$/.test(href.split('?')[0]) || /\/pdf\?/i.test(href) ? 'main.pdf' : last || 'download.bin'
        }
        return res.blob().then(function (blob) { return saveBlob(name, blob) })
      }).catch(function (err) {
        toast('保存失败：' + (err && err.message ? err.message : err), 'error')
        window.open(href, '_blank', 'noopener')
      })
    }, true)
  }

  // ------------------------------------------------------------ shared files

  function loadResource(resource) {
    if (!resource || !resource.path) return Promise.resolve(false)
    toast('正在载入 ' + resource.name + '…')
    return fetch(qs('/file', { app: APP_ID, path: resource.path }), { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('读取共享文件失败')
      return res.arrayBuffer()
    }).then(function (buf) {
      var name = resource.name || resource.file || 'shared-file'
      var mime = resource.mime || 'application/octet-stream'
      var file
      try {
        file = new File([buf], name, { type: mime })
      } catch (e) {
        file = new Blob([buf], { type: mime })
        file.name = name
      }
      var ext = ('.' + (name.split('.').pop() || '')).toLowerCase()
      var inputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"]'))
      var best = null
      var bestScore = -1
      inputs.forEach(function (input) {
        var accept = (input.getAttribute('accept') || '').toLowerCase()
        var score = 0
        if (accept.indexOf(ext) >= 0) score += 4
        if (accept.indexOf('*') >= 0 || accept.indexOf('application/octet-stream') >= 0) score += 1
        if (input.offsetParent !== null) score += 2
        if (input.id && /file|import|input/i.test(input.id)) score += 1
        if (score > bestScore) {
          bestScore = score
          best = input
        }
      })
      if (best && bestScore > 0) {
        try {
          var dt = new DataTransfer()
          dt.items.add(file)
          best.files = dt.files
          best.dispatchEvent(new Event('change', { bubbles: true }))
          toast('已载入 ' + name + ' 到当前应用')
          return { ok: true, input: best.id || 'file-input' }
        } catch (e) {}
      }
      if (['.md', '.markdown', '.txt', '.tex'].indexOf(ext) >= 0) {
        var decoder = new TextDecoder('utf-8')
        var text = decoder.decode(buf)
        var editor = document.getElementById('editor') || document.querySelector('#tex, textarea.tex')
        if (editor && 'value' in editor) {
          editor.value = text
          editor.dispatchEvent(new Event('input', { bubbles: true }))
          editor.dispatchEvent(new Event('change', { bubbles: true }))
          toast('已载入 ' + name + ' 到编辑器')
          return { ok: true, editor: true }
        }
      }
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(resource.path)
      } catch (e) {}
      toast('当前应用没有自动载入入口，路径已复制：' + resource.path, 'error')
      return { ok: false, path: resource.path }
    }).catch(function (err) {
      toast('载入失败：' + (err && err.message ? err.message : err), 'error')
      throw err
    })
  }

  // --------------------------------------------------------------------- UI

  function panelCss() {
    /* --omm-radius is inherited from the host page, so the hub's rounded-corner
       setting controls the archive panel and every border inside it. */
    return [
      /* --radius is inherited from the host document, so the hub's rounded
         corner setting also covers the archive panel and all of its borders. */
      ':host{all:initial;--omm-radius:var(--radius,0px)}',
      '*{box-sizing:border-box}',
      '.omm-btn{position:fixed;left:16px;bottom:84px;z-index:2147482100;pointer-events:auto;',
      '  display:flex;align-items:center;gap:4px;border:1px solid #26231f;background:rgba(255,255,255,.96);',
      '  color:#26231f;font:600 11px/1 "Literata","Songti SC","SimSun",serif;letter-spacing:.04em;',
      '  padding:5px 7px;cursor:pointer;box-shadow:0 3px 10px rgba(38,35,31,.10);',
      '  border-radius:var(--omm-radius,0px)}',
      '.omm-btn:hover{background:#f2eee7;border-color:#26231f;color:#26231f}',
      '.omm-panel{position:fixed;left:16px;bottom:132px;z-index:2147482101;pointer-events:auto;',
      '  width:min(580px,calc(100vw - 32px));max-height:min(72vh,720px);display:none;flex-direction:column;',
      '  background:rgba(255,255,255,.985);color:#26231f;border:1px solid #26231f;',
      '  border-radius:var(--omm-radius,0px);',
      '  box-shadow:0 22px 60px rgba(38,35,31,.24);font:12px/1.55 "Literata","Songti SC","SimSun",serif}',
      '.omm-panel.open{display:flex}',
      ':host([data-shell="hub"]) .omm-btn{display:none}',
      ':host([data-embedded="1"]) .omm-btn{display:none}',
      ':host([data-shell="hub"]) .omm-panel{left:auto;right:16px;bottom:auto;top:calc(var(--topbar,46px) + 8px);',
      '  width:min(460px,calc(100vw - 32px));max-height:min(76vh,720px)}',
      '.omm-head{display:flex;align-items:center;justify-content:space-between;padding:11px 13px;border-bottom:1px solid #d9d3c8}',
      '.omm-head b{font-size:14px;letter-spacing:.04em}',
      '.omm-x{border:0;background:transparent;font-size:17px;cursor:pointer;color:#26231f;padding:0 4px;border-radius:var(--omm-radius,0px)}',
      '.omm-tabs{display:flex;gap:2px;padding:7px 11px 0;border-bottom:1px solid #d9d3c8}',
      '.omm-tabs button{border:0;background:transparent;font:inherit;padding:5px 9px;cursor:pointer;color:#6d6559;border-bottom:2px solid transparent;border-radius:var(--omm-radius,0px) var(--omm-radius,0px) 0 0}',
      '.omm-tabs button[aria-selected="true"]{color:#26231f;border-color:#26231f;font-weight:700}',
      '.omm-body{padding:11px 13px 13px;overflow:auto;min-height:180px}',
      '.omm-pane{display:none}.omm-pane.active{display:block}',
      '.omm-label{display:block;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:#6d6559;margin:9px 0 4px}',
      '.omm-input{width:100%;padding:7px 8px;border:1px solid #b9b1a3;background:#fff;font:inherit;color:#26231f;border-radius:var(--omm-radius,0px)}',
      '.omm-input:focus{outline:1px solid #26231f;border-color:#26231f}',
      '.omm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:7px 0}',
      '.omm-row label{display:flex;align-items:center;gap:6px;cursor:pointer}',
      '.omm-row input[type="checkbox"],.omm-row input[type="radio"]{',
      '  -webkit-appearance:none;appearance:none;width:13px;height:13px;margin:0;flex:0 0 auto;',
      '  border:1px solid #26231f;background:#fff;position:relative;display:inline-block;',
      '  vertical-align:-2px;cursor:pointer;accent-color:#26231f;border-radius:var(--omm-radius,0px)}',
      '.omm-row input[type="radio"]{border-radius:50%}',
      '.omm-row input[type="checkbox"]:checked,.omm-row input[type="radio"]:checked{background:#f2eee7}',
      '.omm-row input[type="checkbox"]:checked::after{content:"";position:absolute;left:3px;top:0;',
      '  width:4px;height:8px;border:solid #26231f;border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}',
      '.omm-row input[type="radio"]:checked::after{content:"";position:absolute;left:3px;top:3px;',
      '  width:5px;height:5px;border-radius:50%;background:#26231f}',
      '.omm-row input[type="checkbox"]:focus-visible,.omm-row input[type="radio"]:focus-visible{',
      '  outline:1px solid #26231f;outline-offset:2px}',
      '.omm-primary,.omm-secondary{border:1px solid #26231f;font:inherit;font-size:11.5px;padding:5px 11px;cursor:pointer;background:#fff;color:#26231f;border-radius:var(--omm-radius,0px)}',
      '.omm-primary{background:#f2eee7}.omm-primary:hover,.omm-secondary:hover{background:#e8dfd1}',
      '.omm-primary:disabled,.omm-secondary:disabled{opacity:.45;cursor:default}',
      '.omm-note{color:#6d6559;font-size:11.5px;margin-top:6px;word-break:break-all}',
      '.omm-list{border:1px solid #d9d3c8;margin-top:8px;max-height:320px;overflow:auto;border-radius:var(--omm-radius,0px)}',
      '.omm-item{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;padding:8px 9px;border-bottom:1px solid #ece7de}',
      '.omm-item:last-child{border-bottom:0}',
      '.omm-item-main{min-width:0;flex:1}',
      '.omm-item b{display:block;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.omm-meta{color:#817767;font-size:11px;word-break:break-all}',
      '.omm-actions{display:flex;gap:4px;flex-shrink:0}',
      '.omm-actions button{border:1px solid #bcb3a4;background:#fff;color:#26231f;font:inherit;font-size:11px;padding:3px 7px;cursor:pointer;border-radius:var(--omm-radius,0px)}',
      '.omm-actions button:hover{background:#f2eee7;color:#26231f;border-color:#26231f}',
      '.omm-actions button:disabled{opacity:.38;cursor:default;background:#fff;color:#26231f}',
      '.omm-actions button.danger:hover{background:#f7e4e1;border-color:#8f2f27;color:#8f2f27}',
      '.omm-empty{padding:24px 8px;text-align:center;color:#8a8172;font-size:12px}',
      '.omm-badge{display:inline-block;border:1px solid #c9c1b3;padding:0 5px;margin-right:5px;font-size:10px;color:#6d6559;border-radius:var(--omm-radius,0px)}',
      '.omm-toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,16px);z-index:2147482200;pointer-events:none;',
      '  max-width:min(680px,calc(100vw - 40px));padding:8px 13px;background:#fffdf8;color:#26231f;border:1px solid #26231f;',
      '  border-radius:var(--omm-radius,0px);',
      '  font:12px/1.5 "Literata","Songti SC","SimSun",serif;white-space:pre-wrap;opacity:0;transition:.18s}',
      '.omm-toast.show{opacity:1;transform:translate(-50%,0)}',
      '.omm-toast[data-kind="error"]{background:#fdf0ee;border-color:#8f2f27;color:#8f2f27}',
    ].join('')
  }

  function panelHtml() {
    return [
      '<button class="omm-btn" id="omm-open" type="button" title="保存路径、快照与共享文件">▣ 存档</button>',
      '<section class="omm-panel" id="omm-panel" role="dialog" aria-label="OMM-ZEN 存档">',
      '  <div class="omm-head"><b>存档</b><button class="omm-x" id="omm-close" type="button" aria-label="关闭">×</button></div>',
      '  <div class="omm-tabs" role="tablist">',
      '    <button type="button" role="tab" data-pane="save" aria-selected="true">保存设置</button>',
      '    <button type="button" role="tab" data-pane="archive" aria-selected="false">存档记录</button>',
      '  </div>',
      '  <div class="omm-body">',
      '    <div class="omm-pane active" data-pane="save">',
      '      <label class="omm-label" for="omm-path">保存 / 快照目录</label>',
      '      <input class="omm-input" id="omm-path" spellcheck="false" autocomplete="off" />',
      '      <div class="omm-note" id="omm-path-note"></div>',
      '      <div class="omm-row"><label><input type="radio" name="omm-mode" value="versioned" /> 每次保存加时间后缀（保留所有版本）</label></div>',
      '      <div class="omm-row"><label><input type="radio" name="omm-mode" value="overwrite" /> 覆盖同名文件</label></div>',
      '      <div class="omm-row"><label><input type="checkbox" id="omm-auto" /> 保存时自动记录历史快照</label></div>',
      '      <div class="omm-row"><label><input type="checkbox" id="omm-all" /> 以上路径与保存方式应用到所有产品</label></div>',
      '      <div class="omm-row"><button class="omm-primary" id="omm-save-config" type="button">保存设置</button>',
      '        <button class="omm-secondary" id="omm-open-folder" type="button">打开文件夹</button></div>',
      '      <div class="omm-note">文件与快照都会写进上面的目录。</div>',
      '    </div>',
      '    <div class="omm-pane" data-pane="archive">',
      '      <div class="omm-row"><button class="omm-primary" id="omm-snap-now" type="button">立即创建快照</button>',
      '        <label><input type="checkbox" id="omm-all-snaps" checked /> 显示所有产品</label>',
      '        <button class="omm-secondary" id="omm-refresh-archive" type="button">刷新</button></div>',
      '      <div class="omm-list" id="omm-archive-list"><div class="omm-empty">读取中…</div></div>',
      '    </div>',
      '  </div>',
      '</section>',
      '<div class="omm-toast" id="omm-toast" role="status"></div>',
    ].join('')
  }

  function el(id) {
    return state.shadow ? state.shadow.getElementById(id) : null
  }

  function setPane(name) {
    if (!state.shadow) return
    state.shadow.querySelectorAll('.omm-tabs button').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.pane === name ? 'true' : 'false')
    })
    state.shadow.querySelectorAll('.omm-pane').forEach(function (pane) {
      pane.classList.toggle('active', pane.dataset.pane === name)
    })
    if (name === 'archive') refreshArchive()
  }

  function openPanel() {
    var panel = el('omm-panel')
    if (!panel) return
    panel.classList.add('open')
    var pathInput = el('omm-path')
    if (pathInput) pathInput.value = state.savePath || state.defaultPath || ''
    var note = el('omm-path-note')
    if (note) note.textContent = state.savePath ? '当前路径：' + state.savePath : ''
    var mode = state.shadow.querySelector('input[name="omm-mode"][value="' + state.mode + '"]')
    if (mode) mode.checked = true
    var auto = el('omm-auto')
    if (auto) auto.checked = !!state.autoSnapshot
    setPane('save')
    refreshArchive()
  }

  function closePanel() {
    var panel = el('omm-panel')
    if (panel) panel.classList.remove('open')
  }

  /* One list for everything that was archived: saved documents ("file") and
     captured application states ("snapshot").  The old build showed the same
     records in two panels with two nearly identical renderers. */
  function refreshArchive() {
    if (!state.enabled || !state.shadow) return
    var list = el('omm-archive-list')
    if (!list) return
    var all = el('omm-all-snaps') && el('omm-all-snaps').checked
    /* The hub manages every product, so it always lists them all. */
    if (state.shell === 'hub') all = true
    request('/archive', {}, { app: APP_ID, all: all ? '1' : '0' }).then(function (data) {
      var entries = (data && data.entries) || []
      list.textContent = ''
      if (!entries.length) {
        var empty = document.createElement('div')
        empty.className = 'omm-empty'
        empty.textContent = '还没有存档。保存文件或点“立即创建快照”即可。'
        list.appendChild(empty)
        return
      }
      entries.forEach(function (item) {
        list.appendChild(item.kind === 'snapshot' ? snapshotRow(item, all) : fileRow(item, all))
      })
    }).catch(function (err) {
      list.innerHTML = ''
      var empty = document.createElement('div')
      empty.className = 'omm-empty'
      empty.textContent = '读取存档失败：' + (err && err.message ? err.message : err)
      list.appendChild(empty)
    })
  }

  function badgeFor(app) {
    var badge = document.createElement('span')
    badge.className = 'omm-badge'
    badge.textContent = app || ''
    return badge
  }

  function fileRow(item, all) {
    var row = document.createElement('div')
    row.className = 'omm-item'
    var main = document.createElement('div')
    main.className = 'omm-item-main'
    var title = document.createElement('b')
    title.textContent = item.name || item.file || 'shared'
    var meta = document.createElement('div')
    meta.className = 'omm-meta'
    meta.appendChild(badgeFor(item.app_name || item.app || ''))
    meta.appendChild(document.createTextNode(fmtTime(item.updated) + ' · ' + fmtSize(item.size) + (item.exists === false ? ' · 文件已丢失' : '')))
    main.appendChild(title)
    main.appendChild(meta)
    var actions = document.createElement('div')
    actions.className = 'omm-actions'
    /* A shared document can be loaded into the product that saved it too.
       From the hub there is no editor, so ask the owning product to take it. */
    var load = document.createElement('button')
    load.type = 'button'
    load.textContent = state.shell === 'hub' ? '在应用中打开' : '载入'
    load.disabled = item.exists === false
    load.onclick = function () {
      if (state.shell === 'hub') {
        window.dispatchEvent(
          new CustomEvent('omm:load-file', {
            detail: { app: item.app, path: item.path, name: item.name, mime: item.mime },
          })
        )
        closePanel()
        return
      }
      loadResource(item)
    }
    var copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = '路径'
    copy.onclick = function () {
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(item.path)
      } catch (e) {}
      toast('已复制路径：' + item.path)
    }
    actions.appendChild(load)
    actions.appendChild(copy)
    row.appendChild(main)
    row.appendChild(actions)
    return row
  }

  function snapshotRow(item, all) {
    var row = document.createElement('div')
    row.className = 'omm-item'
    var main = document.createElement('div')
    main.className = 'omm-item-main'
    var title = document.createElement('b')
    title.textContent = item.label || item.name
    var meta = document.createElement('div')
    meta.className = 'omm-meta'
    if (all) meta.appendChild(badgeFor(item.app_name || item.app || ''))
    meta.appendChild(document.createTextNode(item.time + ' · ' + fmtSize(item.size)))
    main.appendChild(title)
    main.appendChild(meta)
    var actions = document.createElement('div')
    actions.className = 'omm-actions'

    var restore = document.createElement('button')
    restore.type = 'button'
    restore.textContent = '恢复'
    if (item.app && APP_ID && item.app !== APP_ID) {
      restore.disabled = true
      restore.title = '请在该产品中恢复这条快照'
    }
    restore.onclick = function () {
      if (restore.disabled) return
      if (!confirm('恢复快照会覆盖当前应用数据，确定继续？\n' + item.time + ' · ' + (item.label || item.name))) return
      toast('正在恢复快照…')
      request('/snapshot', {}, { app: APP_ID, path: item.path }).then(function (data) {
        return applyState(data.snapshot)
      }).catch(function (err) {
        toast('恢复失败：' + (err && err.message ? err.message : err), 'error')
      })
    }

    /* Snapshots used to have a fixed, timestamp derived name; rename them. */
    var rename = document.createElement('button')
    rename.type = 'button'
    rename.textContent = '改名'
    rename.onclick = function () {
      var next = window.prompt('新的快照名称：', item.label || '')
      if (next === null) return
      next = String(next).trim()
      if (!next) return
      request('/snapshot/rename', { method: 'POST', body: { app: APP_ID, path: item.path, label: next } })
        .then(function () {
          toast('已改名为：' + next)
          refreshArchive()
        })
        .catch(function (err) {
          toast('改名失败：' + (err && err.message ? err.message : err), 'error')
        })
    }

    var del = document.createElement('button')
    del.type = 'button'
    del.className = 'danger'
    del.textContent = '删除'
    del.onclick = function () {
      if (!confirm('删除这个快照文件？\n' + (item.label || item.name))) return
      request('/snapshot/delete', { method: 'POST', body: { app: APP_ID, path: item.path } }).then(function () {
        toast('快照已删除')
        refreshArchive()
      }).catch(function (err) {
        toast('删除失败：' + (err && err.message ? err.message : err), 'error')
      })
    }
    actions.appendChild(restore)
    actions.appendChild(rename)
    actions.appendChild(del)
    row.appendChild(main)
    row.appendChild(actions)
    return row
  }

  function saveSettings() {
    var path = el('omm-path') ? el('omm-path').value.trim() : ''
    var modeInput = state.shadow.querySelector('input[name="omm-mode"]:checked')
    var mode = modeInput ? modeInput.value : state.mode
    var auto = el('omm-auto') ? el('omm-auto').checked : state.autoSnapshot
    var scope = el('omm-all') && el('omm-all').checked ? 'all' : 'app'
    var button = el('omm-save-config')
    if (button) button.disabled = true
    request('/config', {
      method: 'POST',
      body: { app: APP_ID, path: path, mode: mode, auto_snapshot: auto, scope: scope },
    }).then(function (data) {
      state.savePath = data.save_path || path
      state.mode = data.mode || mode
      state.autoSnapshot = !!data.auto_snapshot
      state.config = data.config || state.config
      if (el('omm-path')) el('omm-path').value = state.savePath
      if (el('omm-path-note')) el('omm-path-note').textContent = '当前路径：' + state.savePath
      toast('保存设置已更新：' + state.savePath)
      refreshArchive()
    }).catch(function (err) {
      toast('保存设置失败：' + (err && err.message ? err.message : err), 'error')
    }).finally(function () {
      if (button) button.disabled = false
    })
  }

  function mountUI() {
    if (document.getElementById('omm-desktop-host')) return
    var host = document.createElement('div')
    host.id = 'omm-desktop-host'
    host.style.cssText = 'position:fixed;inset:0;z-index:2147482000;pointer-events:none'
    /* Inside the hub shell the archive is opened from the top bar instead of
       the floating button, so the panel lives next to the toolbar. */
    if (document.body && document.body.dataset.ommShell === 'hub') {
      host.setAttribute('data-shell', 'hub')
      state.shell = 'hub'
    }
    if (EMBEDDED) {
      host.setAttribute('data-embedded', '1')
      state.embedded = true
    }
    var shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<style>' + panelCss() + '</style>' + panelHtml()
    state.shadow = shadow
    document.documentElement.appendChild(host)

    el('omm-open').addEventListener('click', openPanel)
    el('omm-close').addEventListener('click', closePanel)
    shadow.querySelectorAll('.omm-tabs button').forEach(function (button) {
      button.addEventListener('click', function () { setPane(button.dataset.pane) })
    })
    el('omm-save-config').addEventListener('click', saveSettings)
    el('omm-open-folder').addEventListener('click', function () {
      request('/open', { method: 'POST', body: { app: APP_ID } }).then(function (data) {
        toast('已打开：' + data.path)
      }).catch(function (err) {
        toast('打开失败：' + (err && err.message ? err.message : err), 'error')
      })
    })
    el('omm-snap-now').addEventListener('click', function () {
      createSnapshot('手动快照').catch(function () {})
    })
    el('omm-refresh-archive').addEventListener('click', refreshArchive)
    el('omm-all-snaps').addEventListener('change', refreshArchive)
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closePanel()
    })
    /* Clicking anywhere else closes the archive panel. */
    document.addEventListener('pointerdown', function (event) {
      var panel = el('omm-panel')
      if (!panel || !panel.classList.contains('open')) return
      var path = event.composedPath ? event.composedPath() : [event.target]
      if (path.indexOf(panel) >= 0) return
      if (path.indexOf(el('omm-open')) >= 0) return
      closePanel()
    }, true)
    if (host.getAttribute('data-shell') === 'hub') {
      window.addEventListener('omm:archive', function (event) {
        var action = event && event.detail ? event.detail.action : ''
        var panel = el('omm-panel')
        if (action === 'toggle') {
          if (panel && panel.classList.contains('open')) closePanel()
          else openPanel()
        } else if (action === 'close') {
          closePanel()
        }
      })
    }
  }

  // ------------------------------------------------------------------- boot

  function applyConfig(data) {
    state.enabled = true
    state.ready = true
    state.config = data.config || state.config
    state.savePath = data.save_path || ''
    state.mode = data.mode || state.mode
    state.autoSnapshot = data.auto_snapshot !== false
    state.defaultPath = data.default_path || ((data.config && data.config.save && data.config.save.path) || '')
  }

  function boot() {
    request('/status', {}, { app: APP_ID || undefined }).then(function (data) {
      if (!data || !data.desktop) return
      applyConfig(data)
      installHooks()
      mountUI()
      request('/config', {}, { app: APP_ID }).then(function (cfg) {
        applyConfig(cfg)
        window.dispatchEvent(new CustomEvent('omm-desktop-ready', { detail: { app: APP_ID } }))
      }).catch(function () {})
    }).catch(function () {
      // Public website: no desktop API. Stay completely silent.
    })
  }

  window.OMMDesktop = {
    app: APP_ID,
    get enabled() { return state.enabled },
    saveBlob: saveBlob,
    saveText: saveText,
    snapshot: createSnapshot,
    captureState: captureState,
    restore: applyState,
    loadResource: loadResource,
    openPanel: openPanel,
    openFolder: function () { return request('/open', { method: 'POST', body: { app: APP_ID } }) },
    config: function () { return request('/config', {}, { app: APP_ID }) },
    shared: function () { return request('/shared') },
    setConfig: function (patch) {
      return request('/config', { method: 'POST', body: Object.assign({ app: APP_ID }, patch || {}) })
        .then(function (data) { applyConfig(data); return data })
    },
    listSnapshots: function (all) {
      return request('/snapshots', {}, { app: APP_ID, all: all ? '1' : '0' })
    },
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0) })
  } else {
    setTimeout(boot, 0)
  }
})()
