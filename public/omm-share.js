/*
 * OMM-ZEN share bridge
 * ====================
 * Products already know how to hand notes and documents to each other, but
 * those buttons were written for pages served from one folder.  In the desktop
 * shell every product has its own loopback origin, so the old transport
 * (localStorage inbox + BroadcastChannel + "open omm-*.html") cannot cross the
 * origin boundary.
 *
 * This module provides the missing transport without changing the web build:
 *
 *   OMMShare.publishFile()   put a saved document into the shared space
 *   OMMShare.send()          deliver an artifact or a small JSON payload
 *   OMMShare.onArtifact()    receive payloads in a product
 *   OMMShare.mountPanel()    render the "共享空间" view in the archive panel
 *
 * The broker lives on disk (see desktop/omm_share.py), so it also works when a
 * product is opened on its own rather than from the hub.  Messages are fetched
 * from an inbox on boot, on visibility change and when the hub sends a nudge.
 */
;(function () {
  'use strict'
  if (window.__ommShareLoaded) return
  window.__ommShareLoaded = true

  var API = '/__omm/share'
  var APP = (function () {
    var file = (location.pathname.split('/').pop() || '').toLowerCase()
    var match = file.match(/^omm-([a-z0-9_-]+)\.html$/)
    if (match) return match[1]
    if (/\/$/.test(location.pathname) && /mdforge/i.test(document.title)) return 'mdforge'
    return ''
  })()

  var state = {
    enabled: false,
    app: APP,
    space: null,
    handlers: [],
    polling: false,
    pollTimer: 0,
    root: null,
    isHub: false,
    toast: function () {},
    channel: '',
    view: 'items',
    loading: false,
    error: '',
    seen: {},
    selected: {},
    previews: {},
  }

  /* ------------------------------------------------------------------ utils */

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function fmtTime(value) {
    if (!value) return ''
    var date = new Date(value)
    if (isNaN(date.getTime())) return String(value)
    return date.toLocaleString()
  }

  function fmtSize(bytes) {
    var size = Number(bytes) || 0
    if (!size) return '0 B'
    if (size < 1024) return size + ' B'
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
    return (size / 1024 / 1024).toFixed(1) + ' MB'
  }

  function appId(value) {
    return String(value || '').replace(/^omm-/, '').trim()
  }

  function channelById(id) {
    var channels = (state.space && state.space.channels) || []
    for (var i = 0; i < channels.length; i++) {
      if (channels[i].id === id) return channels[i]
    }
    return null
  }

  function channelName(id) {
    var channel = channelById(id)
    return channel ? channel.name : id
  }

  function appName(id) {
    var channels = (state.space && state.space.channels) || []
    for (var i = 0; i < channels.length; i++) {
      var apps = channels[i].apps || []
      for (var j = 0; j < apps.length; j++) {
        if (apps[j].app === id) return apps[j].name
      }
    }
    return id
  }

  function consumers(channel) {
    return (channel && channel.apps ? channel.apps : []).filter(function (item) {
      return item.consume
    })
  }

  /* -------------------------------------------------------------------- api */

  function query(params) {
    var parts = ['app=' + encodeURIComponent(APP)]
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key]
      if (value === undefined || value === null || value === '') return
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value))
    })
    return parts.join('&')
  }

  function apiGet(path, params) {
    return fetch(API + path + '?' + query(params), { cache: 'no-store' }).then(readJson)
  }

  function apiPost(path, body) {
    return fetch(API + path + '?' + query(), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ app: APP }, body || {})),
    }).then(readJson)
  }

  function readJson(res) {
    var type = res.headers.get('Content-Type') || ''
    if (type.indexOf('application/json') < 0) {
      return res.text().then(function (text) {
        throw new Error(text || '共享服务不可用')
      })
    }
    return res.json().then(function (data) {
      if (!res.ok || (data && data.ok === false)) {
        throw new Error((data && data.error) || '共享服务出错')
      }
      return data
    })
  }

  function fetchFile(itemId) {
    return fetch(API + '/file?' + query({ id: itemId }), { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('共享文件不可用')
      return res.arrayBuffer()
    })
  }

  /* ---------------------------------------------------------------- transport */

  function loadSpace() {
    return apiGet('/space').then(function (data) {
      state.space = data
      state.enabled = true
      state.error = ''
      return data
    })
  }

  function refresh() {
    if (!state.root) return Promise.resolve(null)
    state.loading = true
    state.error = ''
    render()
    return loadSpace().then(function (data) {
      state.loading = false
      render()
      return data
    }).catch(function (err) {
      state.loading = false
      state.error = err && err.message ? err.message : String(err)
      render()
      return null
    })
  }

  function publishFile(file) {
    var payload = {
      channel: (file && file.channel) || 'auto',
      source_path: (file && file.path) || '',
      name: (file && file.name) || 'shared.bin',
      title: (file && (file.title || file.name)) || '共享文件',
      type: (file && file.type) || '',
      replace_key: (file && file.replaceKey) || '',
      tags: (file && file.tags) || [],
    }
    return apiPost('/publish', payload).then(function (data) {
      state.toast('已放入共享空间「' + channelName(data.item.channel) + '」')
      if (state.root) refresh()
      return data.item
    })
  }

  function publishRecord(record, options) {
    var opts = options || {}
    var payload = {
      channel: opts.channel || 'auto',
      type: opts.type || 'application/json',
      format: opts.format || '',
      title: opts.title || '共享记录',
      record: record,
      tags: opts.tags || [],
      replace_key: opts.replaceKey || '',
    }
    return apiPost('/publish', payload).then(function (data) {
      state.toast('已放入共享空间「' + channelName(data.item.channel) + '」')
      if (state.root) refresh()
      return data.item
    })
  }

  function send(options) {
    var opts = options || {}
    var body = {
      to: appId(opts.to),
      channel: opts.channel || '',
      format: opts.format || '',
      title: opts.title || '',
      artifact_id: opts.artifactId || '',
      payload: opts.payload,
    }
    return apiPost('/send', body).then(function (data) {
      return data.message
    })
  }

  /* The OMM Bridge packages (english / corpus / annotate) go through here. */
  function sendBridge(to, payload, meta) {
    var target = appId(to)
    var title = (meta && (meta.title || meta.name)) || '英语笔记'
    send({
      to: target,
      channel: 'notes.english',
      format: 'omm.bridge',
      title: title,
      payload: payload,
    }).then(function () {
      openApp(target)
      state.toast('已发送到「' + appName(target) + '」')
    }).catch(function (err) {
      state.toast('发送失败：' + (err && err.message ? err.message : err), 'error')
    })
    return true
  }

  function openApp(target) {
    var id = appId(target)
    if (!id) return
    if (state.isHub) {
      window.dispatchEvent(new CustomEvent('omm:open-app', { detail: { app: id } }))
      return
    }
    if (window.parent && window.parent !== window) {
      try {
        window.parent.postMessage({ type: 'omm:share-open', app: id }, '*')
      } catch (e) {
        /* ignore */
      }
    }
  }

  function openArtifact(item, target) {
    var name = target.name || appName(target.app)
    return send({
      to: target.app,
      channel: item.channel,
      artifactId: item.id,
      format: item.format,
      title: item.title,
    }).then(function () {
      var canOpen = state.isHub || (window.parent && window.parent !== window)
      state.toast(canOpen ? '已发送到「' + name + '」' : '已放入「' + name + '」的收件箱，打开它即可接收')
      openApp(target.app)
    }).catch(function (err) {
      state.toast('发送失败：' + (err && err.message ? err.message : err), 'error')
    })
  }

  function removeItem(item) {
    var message = '从共享空间移除「' + item.title + '」？\n不会删除本地的存档文件。'
    var confirmed = window.OMMUI && window.OMMUI.confirm
      ? window.OMMUI.confirm(message, { title: '移除共享项目', ok: '移除', danger: true })
      : Promise.resolve(window.confirm(message))
    confirmed.then(function (ok) {
      if (!ok) return
      apiPost('/delete', { id: item.id }).then(function () {
        state.toast('已从共享空间移除')
        refresh()
      }).catch(function (err) {
        state.toast('移除失败：' + (err && err.message ? err.message : err), 'error')
      })
    })
  }

  function setPolicy(channel, app, capability, value) {
    var body = { channel: channel, app: app }
    body[capability] = value
    apiPost('/policy', body).then(function () {
      state.toast('连接规则已更新')
      return loadSpace()
    }).then(function () {
      render()
    }).catch(function (err) {
      state.toast('更新失败：' + (err && err.message ? err.message : err), 'error')
      refresh()
    })
  }

  /* ----------------------------------------------------------------- inbox */

  function notifyReceived(message, item) {
    if (!window.parent || window.parent === window) return;
    try {
      window.parent.postMessage(
        {
          type: 'omm:shared-received',
          app: APP,
          title: (item && item.title) || message.title || '',
          kind: (item && item.kind) || 'record',
        },
        '*'
      );
    } catch (e) {
      /* ignore */
    }
  }

  function emit(artifact) {
    state.handlers.slice().forEach(function (handler) {
      try {
        handler(artifact)
      } catch (e) {
        if (window.console) console.error(e)
      }
    })
    window.dispatchEvent(new CustomEvent('omm:artifact', { detail: artifact }))
  }

  async function deliverMessage(message) {
    if (!message) return false
    if (message.artifact) {
      var item = message.artifact
      if (item.kind === 'file') {
        try {
          var buffer = await fetchFile(item.id)
          if (window.OMMDesktop && window.OMMDesktop.loadBlob) {
            window.OMMDesktop.loadBlob(item.title || 'shared', item.type, buffer)
            notifyReceived(message, item)
          } else {
            state.toast('收到共享文件，但当前应用无法自动载入', 'error')
          }
          return true
        } catch (err) {
          state.toast('共享文件读取失败：' + (err && err.message ? err.message : err), 'error')
          return true
        }
      }
      if (!state.handlers.length) return false
      try {
        var data = await apiGet('/item', { id: item.id })
        var record = data.item || {}
        record.from = message.from
        record.message_id = message.id
        record.created_at = record.created_at || message.created_at
        emit(record)
        notifyReceived(message, record)
      } catch (e) {
        emit({
          id: message.id,
          from: message.from,
          format: message.format || item.format,
          title: item.title,
          payload: null,
          created_at: message.created_at,
        })
      }
      return true
    }
    if (message.format === 'omm.bridge' && !state.handlers.length) return false
    var simple = {
      id: message.id,
      from: message.from,
      from_name: message.from_name,
      format: message.format,
      title: message.title,
      payload: message.payload,
      created_at: message.created_at,
      channel: message.channel,
    }
    emit(simple)
    notifyReceived(message, simple)
    return true
  }

  async function pollInbox() {
    if (!state.enabled || state.polling) return
    state.polling = true
    var messages = []
    try {
      var data = await apiGet('/inbox')
      messages = data.messages || []
    } catch (e) {
      state.polling = false
      return
    }
    var ack = []
    for (var i = 0; i < messages.length; i++) {
      var message = messages[i]
      if (!message || !message.id) continue
      if (state.seen[message.id]) {
        ack.push(message.id)
        continue
      }
      var handled = false
      try {
        handled = await deliverMessage(message)
      } catch (e) {
        handled = false
      }
      if (handled) {
        state.seen[message.id] = true
        ack.push(message.id)
      }
    }
    if (ack.length) {
      apiPost('/ack', { ids: ack }).catch(function () {})
      var keys = Object.keys(state.seen)
      if (keys.length > 300) {
        state.seen = {}
        ack.forEach(function (id) { state.seen[id] = true })
      }
    }
    state.polling = false
  }

  /* ---------------------------------------------------------- legacy bridge */

  /* The three English pages ship an inline OMMBridge implementation.  Keep
     their API and package format, but replace the transport with the broker.
     They call `watch()` while the document is still parsing, so the object is
     trapped as soon as the page assigns it (see installBridgeTrap). */
  function patchBridge(value) {
    var bridge = value || window.OMMBridge
    if (!bridge || bridge.__ommSharePatched) return
    bridge.__ommSharePatched = true
    var originalWatch = bridge.watch
    var originalOpen = bridge.openApp
    var originalDeliver = bridge.deliver

    bridge.watch = function (apply) {
      onArtifact(function (artifact) {
        if (artifact.format !== 'omm.bridge') return
        try {
          apply({
            id: artifact.message_id || artifact.id,
            from: artifact.from,
            ts: artifact.created_at,
            env: artifact.payload,
          })
        } catch (e) {
          if (window.console) console.error(e)
        }
      })
      if (typeof originalWatch === 'function') {
        try {
          originalWatch(apply)
        } catch (e) {
          /* ignore */
        }
      }
    }

    bridge.deliver = function (target, items, meta) {
      /* On the public website the desktop broker does not exist: keep the
         original localStorage + BroadcastChannel transport untouched. */
      if (!state.enabled) {
        if (typeof originalDeliver === 'function') {
          return originalDeliver.apply(bridge, arguments)
        }
        return false
      }
      var payload = typeof bridge.env === 'function' ? bridge.env(items, meta) : { items: items }
      return sendBridge(target, payload, meta)
    }

    bridge.openApp = function (file) {
      var match = String(file || '').match(/omm-([a-z0-9_-]+)\.html/i)
      if (match && state.enabled) {
        openApp(match[1])
        return
      }
      if (typeof originalOpen === 'function') originalOpen(file)
    }
  }

  /* Links to another product page would 404 on a per-plugin server.  Route
     them to the hub when the desktop shell is present. */
  function patchLinks() {
    document.addEventListener('click', function (event) {
      if (!state.enabled) return
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null
      if (!anchor) return
      var href = anchor.getAttribute('href') || ''
      var match = href.match(/^omm-([a-z0-9_-]+)\.html(?:[?#].*)?$/i)
      if (!match) return
      event.preventDefault()
      event.stopPropagation()
      openApp(match[1])
    }, true)
  }

  var bridgeValue = null

  /* Install an accessor before the page's inline bridge is parsed.  A plain
     DOMContentLoaded hook would be too late: these pages register their
     receiver while the parser is still running. */
  function installBridgeTrap() {
    if (window.OMMBridge) {
      bridgeValue = window.OMMBridge
      patchBridge(bridgeValue)
      return
    }
    try {
      Object.defineProperty(window, 'OMMBridge', {
        configurable: true,
        get: function () { return bridgeValue },
        set: function (value) {
          bridgeValue = value
          patchBridge(value)
        },
      })
    } catch (e) {
      /* fall back to the DOMContentLoaded hook */
    }
  }

  function onArtifact(handler) {
    if (typeof handler !== 'function') return function () {}
    state.handlers.push(handler)
    if (state.handlers.length === 1 && state.enabled) {
      /* The page just registered its receiver; pick up anything that arrived
         before the UI was ready (or before this script booted). */
      setTimeout(pollInbox, 0)
    }
    return function () {
      var index = state.handlers.indexOf(handler)
      if (index >= 0) state.handlers.splice(index, 1)
    }
  }

  /* -------------------------------------------------------------------- UI */

  var CSS = [
    '.osh{display:flex;flex-direction:column;gap:6px;font-size:11.5px}',
    '.osh-item input[data-pick]{margin-right:6px;vertical-align:-2px;accent-color:var(--omm-ink,#26231f)}',
    '.osh-preview{margin-top:5px;padding:5px 7px;border:1px dashed var(--omm-line-soft,#d9d3c8);background:var(--omm-soft,#faf7f1);font:10.5px/1.5 var(--omm-mono,monospace);white-space:pre-wrap;word-break:break-all;max-height:150px;overflow:auto;color:var(--omm-ink,#26231f)}',
    '.osh-batch{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 7px;border:1px solid var(--omm-ink,#26231f);background:var(--omm-soft,#faf7f1);font-size:10.5px;margin-bottom:5px}',
    '.osh-batch button{border:1px solid var(--omm-line-soft,#d9d3c8);background:var(--omm-paper,#ffffff);padding:2px 7px;font-size:10.5px;cursor:pointer;color:var(--omm-ink,#26231f)}',
    '.osh-batch button:hover{border-color:var(--omm-ink,#26231f)}',
    '.osh-batch button.danger{color:#8f2f27}',
    '.osh-lead{color:var(--omm-dim, #6d6559);font-size:11px;line-height:1.55;margin:0 0 2px;padding:5px 8px;background:var(--omm-soft, #faf7f1);border-left:2px solid var(--omm-line-soft, #d9d3c8)}',
    '.osh-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.osh-summary{margin-left:auto;color:var(--omm-dim, #6d6559);font-size:10.5px}',
    '.osh-chips{display:flex;gap:4px;flex-wrap:wrap;margin:2px 0}',
    '.osh-chip{border:1px solid var(--omm-line-soft, #c9c1b3);background:var(--omm-paper, #ffffff);color:var(--omm-dim, #6d6559);font:inherit;font-size:10.5px;',
    '  padding:2px 8px;cursor:pointer;border-radius:var(--omm-radius,0px)}',
    '.osh-chip:hover{border-color:var(--omm-ink, #26231f);color:var(--omm-ink, #26231f)}',
    '.osh-chip[aria-pressed="true"]{background:var(--omm-ink, #26231f);border-color:var(--omm-ink, #26231f);color:var(--omm-paper, #ffffff)}',
    '.osh-list{border:1px solid var(--omm-line-soft, #d9d3c8);border-radius:var(--omm-radius,0px)}',
    '.osh-empty{padding:20px 10px;text-align:center;color:var(--omm-dim, #6d6559);font-size:11.5px;line-height:1.7;white-space:pre-line}',
    '.osh-foot{margin-top:5px;color:var(--omm-dim, #6d6559);font-size:10.5px}',
    '.osh-rules{display:flex;flex-direction:column;gap:2px}',
    '.osh-rule{border:1px solid var(--omm-line-soft, #d9d3c8);padding:7px 8px;margin-bottom:6px;border-radius:var(--omm-radius,0px)}',
    '.osh-rule-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}',
    '.osh-rule-head b{font-size:11.5px}',
    '.osh-rule-head span{color:var(--omm-dim, #6d6559);font-size:10.5px}',
    '.osh-member{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:2px 0;font-size:11px}',
    '.osh-member b{font-weight:600;min-width:88px}',
    '.osh-member label{display:flex;align-items:center;gap:4px;color:var(--omm-dim, #6d6559);cursor:pointer}',
    '.osh-member input[type="checkbox"]{-webkit-appearance:none;appearance:none;width:13px;height:13px;',
    '  margin:0;border:1px solid var(--omm-ink, #26231f);background:var(--omm-paper, #ffffff);position:relative;cursor:pointer;',
    '  border-radius:var(--omm-radius,0px)}',
    '.osh-member input[type="checkbox"]:checked{background:var(--omm-soft, #f2eee7)}',
    '.osh-member input[type="checkbox"]:checked::after{content:"";position:absolute;left:3px;top:0;',
    '  width:4px;height:8px;border:solid var(--omm-ink, #26231f);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}',
    '.osh-note{color:var(--omm-dim, #6d6559);font-size:10.5px;line-height:1.55;margin:0 0 6px}',
    '.osh-target{white-space:nowrap}',
  ].join('')

  function injectCss(root) {
    var scope = root.getRootNode ? root.getRootNode() : document
    if (!scope || !scope.querySelector) return
    if (scope.querySelector('#omm-share-css')) return
    var style = document.createElement('style')
    style.id = 'omm-share-css'
    style.textContent = CSS
    if (scope === document) document.head.appendChild(style)
    else scope.appendChild(style)
  }

  function mountPanel(root, options) {
    var opts = options || {}
    if (!root) return null
    if (state.root === root) {
      state.isHub = !!opts.isHub
      state.toast = opts.toast || state.toast
      refresh()
      return root
    }
    state.root = root
    state.isHub = !!opts.isHub
    state.toast = opts.toast || function () {}
    injectCss(root)

    root.innerHTML =
      '<div class="osh">' +
      '  <div class="osh-lead">跨产品中转站：这里只放你主动分享出来的副本。发送给其它产品不会移动或删除「存档历史」，删除共享也不会删除本地文件。</div>' +
      '  <div class="osh-bar">' +
      '    <button type="button" class="omm-secondary" data-act="refresh">刷新</button>' +
      '    <button type="button" class="omm-secondary" data-act="rules">连接规则</button>' +
      '    <span class="osh-summary"></span>' +
      '  </div>' +
      '  <div class="osh-items">' +
      '    <div class="osh-chips"></div>' +
      '    <div class="osh-list"></div>' +
      '    <div class="osh-foot"></div>' +
      '  </div>' +
      '  <div class="osh-rules" hidden></div>' +
      '</div>'

    root.addEventListener('click', function (event) {
      var target = event.target
      if (!target || !target.closest) return
      var action = target.closest('[data-act]')
      if (action) {
        if (action.dataset.act === 'refresh') refresh()
        else if (action.dataset.act === 'rules') {
          state.view = state.view === 'rules' ? 'items' : 'rules'
          render()
        }
        return
      }
      var chip = target.closest('.osh-chip[data-channel]')
      if (chip) {
        state.channel = chip.dataset.channel || ''
        render()
        return
      }
      var open = target.closest('[data-open]')
      if (open) {
        var item = findItem(open.dataset.id)
        var channel = channelById(open.dataset.ch || (item && item.channel))
        if (!item || !channel) return
        var targetApp = (channel.apps || []).filter(function (entry) {
          return entry.app === open.dataset.open && entry.consume
        })[0]
        if (targetApp) openArtifact(item, targetApp)
        return
      }
      var remove = target.closest('[data-del]')
      if (remove) {
        var found = findItem(remove.dataset.del)
        if (found) removeItem(found)
      }
    })

    root.addEventListener('change', function (event) {
      var input = event.target
      if (!input || !input.matches) return
      if (input.matches('input[data-cap]')) {
        setPolicy(input.dataset.ruleChannel, input.dataset.app, input.dataset.cap, input.checked)
        return
      }
      if (input.matches('input[data-pick]')) {
        if (input.checked) state.selected[input.dataset.pick] = true
        else delete state.selected[input.dataset.pick]
        render()
      }
    })

    refresh()
    return root
  }

  function findItem(id) {
    var items = (state.space && state.space.items) || []
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i]
    }
    return null
  }

  function render() {
    if (!state.root) return
    var root = state.root
    var summary = root.querySelector('.osh-summary')
    var chips = root.querySelector('.osh-chips')
    var list = root.querySelector('.osh-list')
    var foot = root.querySelector('.osh-foot')
    var rules = root.querySelector('.osh-rules')
    var itemsView = root.querySelector('.osh-items')
    var rulesBtn = root.querySelector('[data-act="rules"]')
    if (!summary || !list) return

    var space = state.space
    var all = (space && space.items) || []
    var channels = ((space && space.channels) || []).filter(function (channel) {
      return channel.visible
    })
    if (state.view === 'rules') {
      rules.hidden = false
      itemsView.hidden = true
      rulesBtn.textContent = '返回共享项目'
      renderRules(rules, space)
      summary.textContent = '谁可以和谁共享'
      return
    }
    rules.hidden = true
    itemsView.hidden = false
    rulesBtn.textContent = '连接规则'

    if (state.loading) {
      summary.textContent = '读取中…'
    } else if (state.error) {
      summary.textContent = '读取失败'
    } else {
      summary.textContent = '共 ' + all.length + ' 个项目 · ' + channels.length + ' 个频道'
    }

    clear(chips)
    chips.appendChild(chip('', '全部', all.length, state.channel === ''))
    channels.forEach(function (channel) {
      var count = all.filter(function (item) { return item.channel === channel.id }).length
      chips.appendChild(chip(channel.id, channel.name, count, state.channel === channel.id))
    })

    clear(list)
    renderBatchBar(list)
    var visible = all.filter(function (item) {
      return !state.channel || item.channel === state.channel
    })
    if (state.error) {
      list.appendChild(el('div', 'osh-empty', '共享空间读取失败：' + state.error))
    } else if (!visible.length) {
      list.appendChild(
        el(
          'div',
          'osh-empty',
          '还没有共享项目。\n保存文件时勾选“自动放入共享空间”，或在存档里点“共享”。'
        )
      )
    } else {
      visible.forEach(function (item) {
        list.appendChild(renderItem(item))
      })
    }
    if (foot) {
      foot.textContent = state.loading
        ? '读取中…'
        : visible.length === all.length
          ? '共 ' + all.length + ' 个项目'
          : '显示 ' + visible.length + ' / ' + all.length + ' 个项目'
    }
  }

  function chip(id, label, count, active) {
    var button = el('button', 'osh-chip', label + (count ? ' · ' + count : ''))
    button.type = 'button'
    button.dataset.channel = id
    button.setAttribute('aria-pressed', active ? 'true' : 'false')
    return button
  }

  var TEXT_EXTS = ['.md', '.markdown', '.txt', '.csv', '.tsv', '.tex', '.json', '.log', '.yml', '.yaml', '.xml', '.html', '.css', '.js']

  function isPreviewable(item) {
    if (item.kind !== 'file') return true /* records show their payload */
    var mime = String(item.type || '').toLowerCase()
    if (/^(text\/|application\/json)/.test(mime)) return true
    var name = String(item.title || item.name || '')
    return TEXT_EXTS.some(function (ext) { return name.toLowerCase().endsWith(ext) })
  }

  function previewText(item) {
    if (state.previews[item.id]) return Promise.resolve(state.previews[item.id])
    var fetchPromise
    if (item.kind === 'file') {
      fetchPromise = fetch('/__omm/share/file?id=' + encodeURIComponent(item.id), { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.arrayBuffer() : null })
        .then(function (buffer) {
          if (!buffer) return '(无法读取文件)'
          var text = new TextDecoder('utf-8').decode(buffer.slice(0, 4096))
          var lines = text.split(/\r?\n/).slice(0, 10).join('\n')
          return text.length > 4096 ? lines + '\n…' : lines
        })
    } else {
      fetchPromise = apiGet('/item', { id: item.id }).then(function (data) {
        var record = data && data.item
        try {
          return JSON.stringify(record && record.payload != null ? record.payload : record, null, 1).slice(0, 600)
        } catch (e) {
          return '(无法解析记录)'
        }
      })
    }
    return fetchPromise.then(function (text) {
      state.previews[item.id] = text || '(空)'
      return state.previews[item.id]
    })
  }

  function selectedIds() {
    return Object.keys(state.selected).filter(function (id) { return state.selected[id] })
  }

  function batchTargets() {
    var seen = {}
    var targets = []
    var channels = (state.space && state.space.channels) || []
    channels.forEach(function (channel) {
      ;(channel.apps || []).forEach(function (member) {
        if (!member.consume || seen[member.app]) return
        seen[member.app] = true
        targets.push(member)
      })
    })
    return targets
  }

  function sendBatch(targetApp, targetName) {
    var ids = selectedIds()
    if (!ids.length) return
    var ok = 0
    var failed = 0
    var chain = Promise.resolve()
    ids.forEach(function (id) {
      var item = findItem(id)
      if (!item) return
      chain = chain.then(function () {
        return send({
          to: targetApp,
          channel: item.channel,
          artifactId: item.id,
          format: item.format,
          title: item.title,
        }).then(function () { ok += 1 }, function () { failed += 1 })
      })
    })
    chain.then(function () {
      state.toast(
        failed
          ? '已发送 ' + ok + ' 个，失败 ' + failed + ' 个'
          : '已把 ' + ok + ' 个项目发送到「' + targetName + '」'
      )
      state.selected = {}
      refresh()
    })
  }

  function renderItem(item) {
    var channel = channelById(item.channel)
    var row = el('div', 'omm-item osh-item')
    var main = el('div', 'omm-item-main')
    var head = el('div', 'omm-item-head')

    var pick = el('input')
    pick.type = 'checkbox'
    pick.checked = !!state.selected[item.id]
    pick.title = '选择后可批量发送'
    pick.dataset.pick = item.id
    head.appendChild(pick)
    head.appendChild(el('b', '', item.title || '共享项目'))
    var meta = el('div', 'omm-meta')
    var kind = el('span', 'omm-kind', channel ? channel.name : item.channel)
    kind.title = item.type || ''
    meta.appendChild(kind)
    var source = el('span', 'omm-badge', item.source_name || item.source_app || '')
    source.title = '来源：' + (item.source_name || item.source_app || '未知')
    meta.appendChild(source)
    meta.appendChild(document.createTextNode(' · ' + fmtTime(item.created_at) + ' · ' + fmtSize(item.size)))
    main.appendChild(head)
    main.appendChild(meta)

    var actions = el('div', 'omm-actions')
    var targets = consumers(channel)
    targets.slice(0, 3).forEach(function (target) {
      var button = el('button', 'osh-target', '在 ' + target.name + ' 中打开')
      button.type = 'button'
      button.dataset.open = target.app
      button.dataset.ch = item.channel
      button.dataset.id = item.id
      button.title = '发送到「' + target.name + '」并切换到它'
      actions.appendChild(button)
    })
    if (!targets.length) {
      actions.appendChild(el('span', 'osh-note', '暂无接收方'))
    }
    if (isPreviewable(item)) {
      var previewBtn = el('button', '', '预览')
      previewBtn.type = 'button'
      previewBtn.title = '展开内容预览（不发送）'
      previewBtn.onclick = function () {
        var existing = row.querySelector('.osh-preview')
        if (existing) {
          existing.remove()
          return
        }
        var box = el('div', 'osh-preview', '读取中…')
        main.appendChild(box)
        previewText(item).then(function (text) {
          box.textContent = text
        }).catch(function (err) {
          box.textContent = '预览失败：' + (err && err.message ? err.message : err)
        })
      }
      actions.appendChild(previewBtn)
    }
    if (state.isHub || item.source_app === APP) {
      var del = el('button', 'danger', '删除')
      del.type = 'button'
      del.dataset.del = item.id
      del.title = '从共享空间移除（不会删除本地存档）'
      actions.appendChild(del)
    }
    /* Drag the card onto a product pane in the hub to send it there. */
    row.draggable = true
    row.addEventListener('dragstart', function (event) {
      try {
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData(
          'application/x-omm-item',
          JSON.stringify({ id: item.id, channel: item.channel, title: item.title || '', format: item.format || '' })
        )
      } catch (e) { /* ignore */ }
    })
    row.appendChild(main)
    row.appendChild(actions)
    return row
  }

  function renderBatchBar(container) {
    var ids = selectedIds()
    if (!ids.length) return
    var bar = el('div', 'osh-batch')
    bar.appendChild(el('span', '', '已选 ' + ids.length + ' 项：'))
    batchTargets().forEach(function (target) {
      var button = el('button', '', '发送到 ' + target.name)
      button.type = 'button'
      button.onclick = function () { sendBatch(target.app, target.name) }
      bar.appendChild(button)
    })
    var clearBtn = el('button', 'danger', '取消选择')
    clearBtn.type = 'button'
    clearBtn.onclick = function () {
      state.selected = {}
      render()
    }
    bar.appendChild(clearBtn)
    container.appendChild(bar)
  }

  function renderRules(container, space) {
    clear(container)
    container.appendChild(
      el(
        'div',
        'osh-note',
        '勾选表示允许：发布 = 能把内容放进该频道，接收 = 能取用该频道的内容。改动立即生效，对以后打开的产品同样有效。'
      )
    )
    var channels = (space && space.channels) || []
    if (!channels.length) {
      container.appendChild(el('div', 'osh-empty', '还没有频道。安装声明了共享能力的插件后会自动出现。'))
      return
    }
    channels.forEach(function (channel) {
      var card = el('div', 'osh-rule')
      var head = el('div', 'osh-rule-head')
      head.appendChild(el('b', '', channel.name))
      head.appendChild(el('span', '', channel.description || channel.id))
      card.appendChild(head)
      if (!(channel.apps || []).length) {
        card.appendChild(el('div', 'osh-member', '尚无产品加入'))
      }
      ;(channel.apps || []).forEach(function (member) {
        var row = el('div', 'osh-member')
        row.appendChild(el('b', '', member.name))
        row.appendChild(policyBox(channel.id, member, 'publish', '发布', member.publish))
        row.appendChild(policyBox(channel.id, member, 'consume', '接收', member.consume))
        card.appendChild(row)
      })
      container.appendChild(card)
    })
  }

  function policyBox(channel, member, capability, label, checked) {
    var wrap = el('label')
    var input = el('input')
    input.type = 'checkbox'
    input.checked = !!checked
    input.dataset.ruleChannel = channel
    input.dataset.app = member.app
    input.dataset.cap = capability
    wrap.appendChild(input)
    wrap.appendChild(document.createTextNode(label))
    return wrap
  }

  /* ------------------------------------------------------------------- boot */

  function boot() {
    fetch('/__omm/fs/status' + (APP ? '?app=' + encodeURIComponent(APP) : ''), { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null })
      .then(function (data) {
        if (!data || !data.desktop) return
        state.enabled = true
        patchBridge()
        patchLinks()
        loadSpace().catch(function () {})
        pollInbox()
        setTimeout(pollInbox, 1500)
        state.pollTimer = window.setInterval(pollInbox, 8000)
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) pollInbox()
        })
        window.addEventListener('message', function (event) {
          if (event.source !== window.parent) return
          var data = event.data
          if (data && data.type === 'omm:share-nudge') pollInbox()
        })
        window.addEventListener('omm:archive-refresh', function () {
          if (state.root) refresh()
        })
      })
      .catch(function () {
        /* public website: stay dormant */
      })
  }

  window.OMMShare = {
    app: APP,
    get enabled() { return state.enabled },
    get space() { return state.space },
    get listening() { return state.handlers.length },
    refresh: refresh,
    loadSpace: loadSpace,
    publishFile: publishFile,
    publishRecord: publishRecord,
    send: send,
    openArtifact: openArtifact,
    openApp: openApp,
    onArtifact: onArtifact,
    pollInbox: pollInbox,
    mountPanel: mountPanel,
    patchBridge: patchBridge,
  }

  installBridgeTrap()
  document.addEventListener('DOMContentLoaded', function () {
    patchBridge()
    patchLinks()
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0) })
  } else {
    setTimeout(boot, 0)
  }
})()
