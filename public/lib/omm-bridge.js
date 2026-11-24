/* OMM Bridge v1 — Annotate / English / Corpus 共用的跨应用数据互通桥。
 * 产品只需声明 <script src="lib/omm-bridge.js" data-self="omm-xxx">；
 * 数据包格式、传输与 API 全部在此实现，无产品专属分支。
 */
;(function () {
  'use strict'
  /* OMM Bridge v1 —— 统一的数据包格式：
     { omm:'bridge', v:1, app, kind, exportedAt, meta:{}, items:[
         { t:'word',     w, ph, m, ex, exZh, note, tags[], src }
         { t:'sentence', en, zh, note, tags[], src }
         { t:'template', en, zh, note, tags[], src }
         { t:'phrase',   en, zh, note, tags[], src }
         { t:'doc',      title, text, lang, zh }
     ] }
     三个应用都认识这个包，互不认识的字段自动忽略。 */
  var script = document.currentScript
  var SELF = script && script.getAttribute('data-self')
  if (!SELF) throw new Error('OMM Bridge: missing data-self')
  var INBOX = 'omm.bridge.inbox.v1'
  var APPS = {
    'omm-annotate': 'OMM Annotate',
    'omm-english': 'OMM English',
    'omm-corpus': 'OMM Corpus',
  }
  var FILES = {
    'omm-annotate': 'omm-annotate.html',
    'omm-english': 'omm-english.html',
    'omm-corpus': 'omm-corpus.html',
  }
  var ch = null
  try {
    if (window.BroadcastChannel) ch = new BroadcastChannel('omm-bridge')
  } catch (e) {}

  function nz(v) { return ZenUtil.nz(v) }
  function low(v) { return ZenUtil.low(v) }
  function kz(v) { return ZenUtil.kz(v) }
  function nowISO() { return ZenUtil.nowISO() }
  function fileStamp() { return ZenUtil.fileStamp() }
  function tags(v) { return ZenUtil.tags(v) }
  function download(name, content, mime) { return ZenUtil.download(name, content, mime || 'application/json;charset=utf-8') }
  function saveJSON(name, obj) {
    return ZenUtil.saveJSON(name, obj)
  }

  /* ---------- item 构造 ---------- */
  function itWord(o) {
    o = o || {}
    return {
      t: 'word',
      w: nz(o.w),
      ph: nz(o.ph),
      m: nz(o.m),
      ex: nz(o.ex),
      exZh: nz(o.exZh),
      note: nz(o.note),
      tags: tags(o.tags),
      src: nz(o.src),
    }
  }
  function itSent(o, t) {
    o = o || {}
    return {
      t: t || 'sentence',
      en: nz(o.en),
      zh: nz(o.zh),
      note: nz(o.note),
      tags: tags(o.tags),
      src: nz(o.src),
    }
  }
  function itDoc(o) {
    o = o || {}
    return {
      t: 'doc',
      title: nz(o.title),
      text: nz(o.text),
      lang: nz(o.lang) || 'en',
      zh: nz(o.zh),
    }
  }
  /* 清洗任意一件 item，保证字段齐备 */
  function itOf(it) {
    if (!it || typeof it !== 'object') return null
    var t = nz(it.t || it.type) || 'sentence'
    if (t === 'word') {
      if (nz(it.w)) {
        it.t = 'word'
        it.ph = nz(it.ph)
        it.m = nz(it.m)
        it.ex = nz(it.ex)
        it.exZh = nz(it.exZh)
        it.note = nz(it.note)
        it.tags = tags(it.tags)
        it.src = nz(it.src)
        return it
      }
      if (!nz(it.en)) return null
      return itWord({
        w: it.en,
        ph: it.phon,
        m: it.zh,
        ex: it.ex,
        exZh: it.exZh,
        note: it.note,
        tags: it.tags,
        src: it.src,
      })
    }
    if (t === 'doc') {
      if (!nz(it.title) && !nz(it.text)) return null
      it.t = 'doc'
      it.title = nz(it.title) || nz(it.text).slice(0, 24)
      it.text = nz(it.text)
      it.lang = nz(it.lang) || 'en'
      it.zh = nz(it.zh)
      return it
    }
    var body = nz(it.en) || nz(it.text) || nz(it.sentence)
    if (!body) return null
    it.t = t === 'sentence' || t === 'template' || t === 'phrase' ? t : kindMap(t)
    it.en = body
    it.zh = nz(it.zh)
    it.note = nz(it.note)
    it.tags = tags(it.tags)
    it.src = nz(it.src)
    return it
  }
  function kindMap(k) {
    k = low(k)
    if (k === 'word' || k === 'vocab' || k === 'vocabulary') return 'word'
    if (k === 'template' || k === 'pattern') return 'template'
    if (k === 'phrase' || k === 'collocation' || k === 'collocations') return 'phrase'
    return 'sentence'
  }
  function label(it) {
    if (!it) return ''
    if (it.t === 'word') return it.w
    if (it.t === 'doc') return it.title
    return it.en
  }
  function keyOf(it) {
    if (!it) return ''
    if (it.t === 'word') return 'word:' + low(it.w)
    if (it.t === 'doc') return 'doc:' + kz(it.title)
    return it.t + ':' + kz(it.en)
  }

  /* ---------- 外部格式 → bridge items ---------- */
  function wordish(e) {
    if (!e) return null
    if (Array.isArray(e)) {
      var w = nz(e[0])
      if (!w) return null
      return itWord({ w: w, ph: e[1], m: e[2], ex: e[3], exZh: e[4] })
    }
    if (typeof e === 'string') return nz(e) ? itSent({ en: e }) : null
    if (typeof e !== 'object') return null
    if (e.t === 'word' || nz(e.w) || nz(e.word))
      return itWord({
        w: e.w || e.word || e.en,
        ph: e.ph || e.phonetic || e.phon,
        m: e.m || e.meaning || e.trans || e.zh,
        ex: e.ex || e.example,
        exZh: e.exZh || e.exampleZh,
        note: e.note || e.notes,
        tags: e.tags,
        src: e.src || e.source,
      })
    if (low(e.t) === 'doc') return itDoc(e)
    return itSent(
      {
        en: e.en || e.text || e.sentence,
        zh: e.zh || e.trans,
        note: e.note || e.notes,
        tags: e.tags,
        src: e.src || e.source,
      },
      e.t || e.type || 'sentence',
    )
  }
  /* OMM Annotate 的笔记记录 → item */
  function noteToItem(n) {
    if (!n) return null
    var k = kindMap(n.kind || n.type || 'sentence')
    if (k === 'word')
      return itWord({
        w: n.en || n.text || n.w,
        ph: n.phon,
        m: n.zh || n.trans,
        ex: n.ex,
        exZh: n.exZh,
        note: n.note || n.notes,
        tags: n.tags,
        src: n.src || n.source,
      })
    return itSent(
      {
        en: n.en || n.text,
        zh: n.zh || n.trans,
        note: n.note || n.notes,
        tags: n.tags,
        src: n.src || n.source,
      },
      k,
    )
  }
  /* OMM Corpus 的语料条目 → item */
  function entryToItem(e) {
    if (!e) return null
    var k = kindMap(e.type)
    if (k === 'word')
      return itWord({
        w: e.en,
        ph: '',
        m: e.zh,
        ex: '',
        exZh: '',
        note: e.notes,
        tags: e.tags,
        src: e.source,
      })
    if (low(e.type) === 'paragraph')
      return itDoc({ title: nz(e.en).slice(0, 24) || '段落', text: e.en, zh: e.zh })
    return itSent({ en: e.en, zh: e.zh, note: e.notes, tags: e.tags, src: e.source }, k)
  }
  function normalize(raw) {
    var o = raw
    if (typeof o === 'string') {
      try {
        o = JSON.parse(o)
      } catch (e) {
        return []
      }
    }
    if (!o || typeof o !== 'object') return []
    /* 1. 标准 bridge 包 */
    if (o.omm === 'bridge' && Array.isArray(o.items)) return o.items.map(itOf).filter(Boolean)
    /* 2. OMM Annotate 项目备份 */
    if (o.project) {
      var pr = o.project
      if (Array.isArray(pr.notes) && pr.notes.length)
        return pr.notes.map(noteToItem).filter(Boolean)
      return []
    }
    /* 3. 裸笔记数组 */
    if (Array.isArray(o.notes) && o.notes.length && (o.notes[0].kind || o.notes[0].en))
      return o.notes.map(noteToItem).filter(Boolean)
    /* 4. OMM Corpus 导出 / 状态 */
    if (Array.isArray(o.entries) && o.entries.length)
      return o.entries.map(entryToItem).filter(Boolean)
    /* 5. 词表数组 或 {words:[...]} */
    if (Array.isArray(o.words) && o.words.length) return o.words.map(wordish).filter(Boolean)
    if (Array.isArray(o)) return o.map(wordish).filter(Boolean)
    /* 6. OMM English 全量备份 → 收集全部词书 */
    if (o.books) {
      var out = []
      Object.keys(o.books).forEach(function (bk) {
        var b = o.books[bk]
        if (!b) return
        ;(b.w || []).forEach(function (e) {
          var w = wordish(e)
          if (!w || w.t !== 'word') return
          var nt = (o.notes && o.notes[low(w.w)]) || null
          if (nt) {
            if (nt.ex) w.ex = w.ex || nt.ex
            if (nt.zh) w.note = w.note || nt.zh
            if (nt.story) w.note = w.note || nt.story
            if (nt.exZh) w.exZh = w.exZh || nt.exZh
          }
          w.src = w.src || b.name || ''
          out.push(w)
        })
      })
      if (out.length) return out
    }
    return []
  }
  function parse(text) {
    return normalize(text)
  }

  /* ---------- 写入前的确认（防止误改数据） ---------- */
  function appName(id) {
    return APPS[id] || id
  }
  var _confirmer = null
  function setConfirmer(fn) {
    _confirmer = fn
  }
  function summary(items) {
    var c = { word: 0, sentence: 0, template: 0, phrase: 0, doc: 0 }
    ;(items || []).forEach(function (it) {
      if (it && c[it.t] != null) c[it.t]++
    })
    var NL = {
      word: '个单词',
      sentence: '个句子',
      template: '个模板',
      phrase: '个搭配',
      doc: '篇文章',
    }
    var parts = []
    ;['word', 'sentence', 'template', 'phrase', 'doc'].forEach(function (k) {
      if (c[k]) parts.push(c[k] + NL[k])
    })
    return parts.length ? parts.join('、') : (items || []).length + ' 项'
  }
  /* ask(): 返回 Promise<boolean>。宿主应用可通过 setConfirmer 提供自带样式的弹窗，
     未提供时退回 window.confirm。confirmer 签名 (msg, okText, done)，返回 Promise 亦可。 */
  function ask(msg, okText) {
    return new Promise(function (resolve) {
      var done = false
      function fin(v) {
        if (done) return
        done = true
        resolve(!!v)
      }
      try {
        if (_confirmer) {
          var r = _confirmer(msg, okText || '继续', fin)
          if (r && typeof r.then === 'function')
            r.then(
              function (v) {
                fin(v !== false)
              },
              function () {
                fin(false)
              },
            )
        } else window.ZenUI.dialog.confirm(msg, { ok: okText || '继续' }).then(fin, function () { fin(false) })
      } catch (e) {
        try {
          window.ZenUI.dialog.confirm(msg, { ok: okText || '继续' }).then(fin, function () { fin(false) })
        } catch (e2) {
          fin(false)
        }
      }
    })
  }
  function sendMsg(toApp, items) {
    return (
      '即将向 ' +
      appName(toApp) +
      ' 发送 ' +
      summary(items) +
      '。发送后会在 ' +
      appName(toApp) +
      ' 中写入这些数据，操作不可撤销，是否继续？'
    )
  }
  function recvMsg(fromApp, items) {
    return (
      '即将导入来自 ' +
      appName(fromApp || 'omm-bridge') +
      ' 的 ' +
      summary(items) +
      '。这会修改本页数据，且不可撤销，是否继续？'
    )
  }

  /* ---------- 信封 ---------- */
  function env(items, meta) {
    return {
      omm: 'bridge',
      v: 1,
      app: SELF,
      kind: 'notes',
      exportedAt: nowISO(),
      meta: meta || {},
      items: items || [],
    }
  }

  /* ---------- 跨应用直传（同源 localStorage 收件箱 + BroadcastChannel） ---------- */
  var LEASE_MS = 120000
  function readBox() {
    var a = ZenUtil.getJSON(INBOX, [])
    return Array.isArray(a) ? a : []
  }
  function writeBox(a) {
    try {
      localStorage.setItem(INBOX, JSON.stringify(a))
      return true
    } catch (e) {
      return false
    }
  }
  /* 只租借、不删除。页面在确认或应用途中关闭时，消息仍在收件箱里。 */
  function peek() {
    var box = readBox(),
      now = Date.now(),
      ids = Object.create(null)
    box.forEach(function (p) {
      if (p && p.id) ids[p.id] = true
    })
    for (var i = 0; i < box.length; i++) {
      var p = box[i]
      if (!p || !p.env || (p.to && p.to !== SELF)) continue
      if (p.lease && p.lease.until > now) continue
      if (!p.id) {
        do {
          p.id = 'p' + now + Math.random().toString(36).slice(2, 8)
        } while (ids[p.id])
        ids[p.id] = true
      }
      var token = now + '-' + Math.random().toString(36).slice(2, 10)
      p.lease = { token: token, until: now + LEASE_MS }
      if (!writeBox(box)) return null
      var packet = Object.assign({}, p)
      delete packet.lease
      return { id: p.id, token: token, packet: packet }
    }
    return null
  }
  function settle(id, token, applied) {
    var box = readBox(),
      found = false,
      keep = []
    box.forEach(function (p) {
      if (p && p.id === id && p.lease && p.lease.token === token) {
        found = true
        if (applied) return
        delete p.lease
      }
      keep.push(p)
    })
    return found ? writeBox(keep) : false
  }
  function release(id, token) { return settle(id, token, true) }
  function requeue(id, token) { return settle(id, token, false) }
  function openApp(file) {
    var a = document.createElement('a')
    a.href = file
    a.target = '_blank'
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    setTimeout(function () {
      try {
        a.remove()
      } catch (e) {}
    }, 600)
  }
  function deliver(appId, items, meta) {
    if (!FILES[appId]) return false
    var box = readBox()
    box.push({
      id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6),
      to: appId,
      from: SELF,
      ts: nowISO(),
      env: env(items, meta),
    })
    if (!writeBox(box)) return false
    try {
      if (ch) ch.postMessage({ t: 'inbox' })
    } catch (e) {}
    try {
      localStorage.setItem('omm.bridge.ping.v1', nowISO())
    } catch (e) {}
    openApp(FILES[appId])
    return true
  }
  function watch(apply) {
    var running = false
    async function run() {
      if (running) return
      running = true
      try {
        while (true) {
          var lease = peek()
          if (!lease) break
          var applied = false
          try {
            applied = (await apply(lease.packet)) === true
          } catch (e) {
            if (window.console) console.error(e)
          }
          if (applied) release(lease.id, lease.token)
          else requeue(lease.id, lease.token)
          /* 取消或失败后立即重试会反复弹窗，留给下一次消息/可见性事件。 */
          if (!applied) break
        }
      } finally {
        running = false
      }
    }
    setTimeout(run, 300)
    window.addEventListener('storage', function (e) {
      if (e.key === INBOX) run()
    })
    if (ch)
      ch.onmessage = function () {
        run()
      }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) run()
    })
  }

  window.OMMBridge = {
    self: SELF,
    apps: APPS,
    files: FILES,
    nameOf: function (id) {
      return APPS[id] || id
    },
    setConfirmer: setConfirmer,
    summary: summary,
    ask: ask,
    sendMsg: sendMsg,
    recvMsg: recvMsg,
    nz: nz,
    low: low,
    kz: kz,
    tags: tags,
    fileStamp: fileStamp,
    download: download,
    saveJSON: saveJSON,
    env: env,
    normalize: normalize,
    parse: parse,
    word: itWord,
    sent: itSent,
    doc: itDoc,
    itOf: itOf,
    kindMap: kindMap,
    noteToItem: noteToItem,
    entryToItem: entryToItem,
    wordish: wordish,
    label: label,
    keyOf: keyOf,
    deliver: deliver,
    openApp: openApp,
    watch: watch,
    peek: peek,
    release: release,
    requeue: requeue,
    clearBox: writeBox,
  }
})()
    