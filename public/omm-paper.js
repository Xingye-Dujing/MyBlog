/* ================================================================
 * omm-paper.js — 面向人文学科论文的辅助功能
 *
 *  - 编码者信度（一致率 + Cohen's κ，Landis & Koch 解释）
 *  - 引文精确定位（PDF 页码 / 表格行号 / 访谈段落号与字符区间）
 *  - 编码层级树（Mermaid 源码 + Markdown 大纲，可直接进论文）
 *  - 典型引文标记与导出
 *  - 论文附录一键导出（方法摘要 + 材料 + 码表 + 树 + 信度 + 引文）
 * ================================================================ */
;(function () {
  'use strict'

  var H = null
  var ZP = {}
  var lastResult = null

  function E(id) {
    return H.el(id)
  }
  function esc(s) {
    return H.esc(s)
  }
  function notify(m) {
    H.notify(m)
  }
  function save() {
    H.Store.save()
  }
  function fmtPct(v) {
    return (v * 100).toFixed(1) + '%'
  }
  function fmtK(v) {
    return (Math.round(v * 1000) / 1000).toFixed(3)
  }
  function mdCell(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
  }

  // ---------- 引文定位 ----------
  function locator(doc, start, end) {
    if (!doc) return '—'
    if (doc.kind === 'table') return '表格《' + doc.title + '》'
    if (doc.kind === 'pdf') {
      var info = H.PDFV && H.PDFV.cache && H.PDFV.cache[doc.id]
      if (info)
        return 'P' + (H.PDFV.pageOf(info, Math.max(0, start || 0)) + 1)
      return 'PDF 原文（页码不可用）'
    }
    var s = Math.max(0, start || 0)
    var e = Math.max(s, end || 0)
    var before = String(doc.text || '').slice(0, s)
    var para = before.split('\n').length
    return '第 ' + para + ' 段 · 字符 ' + (s + 1) + '–' + e
  }

  // ---------- 编码树 ----------
  function buildTree() {
    var codes = H.sortedCodes()
    var byId = {}
    codes.forEach(function (c) {
      byId[c.id] = { code: c, children: [] }
    })
    var roots = []
    codes.forEach(function (c) {
      var p = c.parent && byId[c.parent] ? byId[c.parent] : null
      if (p) p.children.push(byId[c.id])
      else roots.push(byId[c.id])
    })
    return { roots: roots, byId: byId, codes: codes }
  }
  function nodeLabel(n) {
    var c = n.code
    var cnt = H.annCount(c.id)
    return c.no + ' ' + c.name + '（' + (H.LVNAME[c.level] || c.level) + '，' + cnt + ' 次）'
  }
  function mermaidOf(tree) {
    var lines = ['flowchart TD']
    function walk(n) {
      var c = n.code
      var id = 'C' + String(c.id).replace(/[^A-Za-z0-9]/g, '')
      lines.push('  ' + id + '["' + mdCell(c.no + ' ' + c.name) + '"]')
      n.children.forEach(function (ch) {
        var cid = 'C' + String(ch.code.id).replace(/[^A-Za-z0-9]/g, '')
        lines.push('  ' + id + ' --> ' + cid)
        walk(ch)
      })
    }
    tree.roots.forEach(walk)
    if (!tree.roots.length) lines.push('  EMPTY["（码表为空）"]')
    return lines.join('\n')
  }
  function mdTreeOf(tree) {
    var lines = []
    function walk(n, depth) {
      lines.push(new Array(depth + 1).join('  ') + '- ' + nodeLabel(n))
      n.children.forEach(function (ch) {
        walk(ch, depth + 1)
      })
    }
    tree.roots.forEach(function (n) {
      walk(n, 0)
    })
    if (!lines.length) lines.push('- （码表为空）')
    return lines.join('\n')
  }
  function treeHTML(tree) {
    var h = ''
    function walk(n, depth) {
      var c = n.code
      h +=
        '<div class="tr-node" style="padding-left:' +
        depth * 18 +
        'px"><span class="tr-dot" style="--c:' +
        esc(c.color || '') +
        '"></span><span class="tr-name">' +
        esc(c.no + ' ' + c.name) +
        '</span><span class="tr-count">' +
        H.annCount(c.id) +
        ' 次 · ' +
        esc(H.LVNAME[c.level] || c.level) +
        '</span></div>'
      n.children.forEach(function (ch) {
        walk(ch, depth + 1)
      })
    }
    tree.roots.forEach(function (n) {
      walk(n, 0)
    })
    return h || '<div class="fm-hint">码表为空。</div>'
  }

  function showCodeTree() {
    var tree = buildTree()
    var h =
      '<div class="tr-tree">' +
      treeHTML(tree) +
      '</div>' +
      '<div class="tr-hint">层级来自码号的“上级码”字段；次数包含文本编码片段与表格行编码。下面这段 Mermaid 源码可直接粘进支持 Mermaid 的 Markdown 编辑器生成论文配图。</div>' +
      '<div class="tr-code" id="f-tr-code">' +
      esc(mermaidOf(tree)) +
      '</div>' +
      '<div class="fm-foot">' +
      '<button type="button" class="fm-sub ghost" id="f-tr-close">关闭</button>' +
      '<button type="button" class="fm-sub" id="f-tr-md">下载 Markdown 大纲</button>' +
      '<button type="button" class="fm-sub" id="f-tr-copy">复制 Mermaid 源码</button>' +
      '</div>'
    H.openModal('编码结构 · 层级树', h, null)
    E('f-tr-close').addEventListener('click', H.closeModal)
    E('f-tr-copy').addEventListener('click', function () {
      var txt = mermaidOf(tree)
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(txt).then(
          function () {
            notify('Mermaid 源码已复制')
          },
          function () {
            fallbackCopy(txt)
          },
        )
      else fallbackCopy(txt)
    })
    E('f-tr-md').addEventListener('click', function () {
      var out =
        '# 编码结构 · ' +
        H.P.title +
        '\n\n' +
        mdTreeOf(tree) +
        '\n\n```mermaid\n' +
        mermaidOf(tree) +
        '\n```\n'
      H.download('zenmark-code-tree.md', out, 'text/markdown;charset=utf-8')
      notify('编码树已下载')
    })
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea')
    ta.value = txt
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      notify('已复制')
    } catch (e) {
      notify('复制失败，请手动选择')
    }
    ta.remove()
  }

  // ---------- 编码者信度 ----------
  function currentTableDoc() {
    var ui = window.ZenTable && window.ZenTable.ui
    var d = H.docById(ui && ui.docId)
    if (d && d.kind === 'table') return d
    var list = H.P.docs.filter(function (x) {
      return x.kind === 'table'
    })
    return list.length ? list[0] : null
  }
  function codeKey(c) {
    return { id: c.id, no: String(c.no), name: String(c.name) }
  }
  function matchCode(label) {
    var q = String(label == null ? '' : label).trim()
    if (!q) return null
    var low = q.toLowerCase()
    var codes = H.sortedCodes()
    var c = codes.filter(function (x) {
      return String(x.id) === q || String(x.no) === q
    })[0]
    if (c) return c
    c = codes.filter(function (x) {
      return String(x.no) === String(parseInt(q, 10))
    })[0]
    if (c) return c
    c = codes.filter(function (x) {
      return String(x.name).toLowerCase() === low
    })[0]
    return c || null
  }
  function parseSecond(text) {
    var out = []
    String(text || '')
      .split(/\r?\n/)
      .forEach(function (line) {
        if (!line.trim()) return
        var parts = line.split(/[,\t;，；]/)
        if (parts.length < 2) return
        var key = parts[0].trim()
        var lab = parts[1].trim()
        var c = matchCode(lab)
        out.push({ key: key, label: lab, code: c ? c.id : null })
      })
    return out
  }
  function normKey(k, src) {
    var s = String(k == null ? '' : k).trim()
    if (src === 'table') {
      var m = s.match(/(\d+)/)
      // 第二编码者按弹窗提示与导出的“表格编码表”填写 1 基行号，
      // 而 cellCodes.row / primaryMap 的键是表格原文数组的 0 基下标。
      // 不换算会让两列永远对不上：全部项目落入 missing，κ 恒为 0。
      return m ? String(Math.max(0, parseInt(m[1], 10) - 1)) : ''
    }
    return s
  }
  function primaryMap(src, round, col) {
    var m = {}
    if (src === 'table') {
      var td = currentTableDoc()
      if (!td) return m
      H.P.cellCodes.forEach(function (cc) {
        if (cc.table !== td.id) return
        if (cc.col && cc.col !== col) return
        if ((cc.round || 1) !== round) return
        var k = String(cc.row)
        ;(m[k] || (m[k] = [])).push(cc.code)
      })
    } else {
      H.P.anns.forEach(function (a) {
        ;(m[a.id] || (m[a.id] = [])).push(a.code)
      })
    }
    return m
  }
  function keyLabel(k, src) {
    if (src === 'table') {
      var td = currentTableDoc()
      var data = null
      if (td && window.ZenTable) {
        // getData 是异步的；这里只做同步兜底，完整文本在结果里用行号表示
      }
      return '第 ' + (parseInt(k, 10) + 1) + ' 行'
    }
    var a = H.annById(k)
    return a ? String(a.quote).slice(0, 24) : k
  }
  function kappaOf(pairs) {
    var N = pairs.length
    if (!N) return null
    var agree = 0,
      ca = {},
      cb = {}
    pairs.forEach(function (p) {
      if (p.a === p.b) agree++
      ca[p.a] = (ca[p.a] || 0) + 1
      cb[p.b] = (cb[p.b] || 0) + 1
    })
    var po = agree / N
    var pe = 0
    Object.keys(ca).forEach(function (k) {
      pe += (ca[k] / N) * ((cb[k] || 0) / N)
    })
    var kappa = pe >= 0.999999 ? 1 : (po - pe) / (1 - pe)
    return { N: N, po: po, pe: pe, kappa: kappa, ca: ca, cb: cb }
  }
  function verdict(k) {
    if (k < 0) return { text: '低于随机一致', cls: 'bad' }
    if (k <= 0.2) return { text: '极低一致 · slight', cls: 'bad' }
    if (k <= 0.4) return { text: '一般一致 · fair', cls: 'bad' }
    if (k <= 0.6) return { text: '中等一致 · moderate', cls: 'mid' }
    if (k <= 0.8) return { text: '较高一致 · substantial', cls: 'good' }
    return { text: '几乎完全一致 · almost perfect', cls: 'good' }
  }
  function compute(src, round, col, text) {
    var pri = primaryMap(src, round, col)
    var sec = {}
    var unmatched = 0
    parseSecond(text).forEach(function (r) {
      var k = normKey(r.key, src)
      if (!k) return
      if (!r.code) {
        unmatched++
        return
      }
      ;(sec[k] || (sec[k] = [])).push(r.code)
    })
    var keys = {}
    Object.keys(pri).forEach(function (k) {
      keys[k] = 1
    })
    Object.keys(sec).forEach(function (k) {
      keys[k] = 1
    })
    var single = [],
      multi = 0,
      jacSum = 0,
      jacN = 0,
      missing = 0,
      dis = []
    Object.keys(keys).forEach(function (k) {
      var A = pri[k] || [],
        B = sec[k] || []
      if (!A.length || !B.length) {
        missing++
        return
      }
      if (A.length === 1 && B.length === 1) {
        single.push({ k: k, a: A[0], b: B[0] })
        if (A[0] !== B[0])
          dis.push({ k: k, a: A[0], b: B[0] })
        return
      }
      multi++
      var sa = {},
        sb = {},
        inter = 0
      A.forEach(function (x) {
        sa[x] = 1
      })
      B.forEach(function (x) {
        sb[x] = 1
      })
      Object.keys(sa).forEach(function (x) {
        if (sb[x]) inter++
      })
      var union = Object.keys(sa).length + Object.keys(sb).length - inter
      if (union > 0) {
        jacSum += inter / union
        jacN++
      }
    })
    var st = kappaOf(single)
    return {
      ts: H.nowStr(),
      source: src,
      round: round,
      col: col,
      unmatched: unmatched,
      missing: missing,
      multi: multi,
      jaccard: jacN ? jacSum / jacN : null,
      stat: st,
      disagreements: dis.slice(0, 30),
    }
  }
  function resultHTML(r) {
    if (!r || !r.stat)
      return '<div class="fm-hint">没有可比对的单编码项目，请检查第二编码者数据的项目编号与码号。</div>'
    var v = verdict(r.stat.kappa)
    var h = '<div class="st-block" style="padding-top:6px">'
    h +=
      '<div class="rl-top"><span class="rl-score">' +
      fmtK(r.stat.kappa) +
      '</span><span class="rl-verdict ' +
      v.cls +
      '">Cohen’s κ · ' +
      v.text +
      '</span></div>'
    h +=
      '<div class="rl-note">Landis &amp; Koch 参照：≤.20 极低｜.21–.40 一般｜.41–.60 中等｜.61–.80 较高｜≥.81 几乎完全一致。人文社科质性研究通常报告 κ ≥ .60，低于此值建议回到码表修订操作性定义后重新编码。</div>'
    h += '<div class="rl-grid">'
    h +=
      '<div class="rl-cell"><div class="k">可比对项 N</div><div class="v">' +
      r.stat.N +
      '</div></div>'
    h +=
      '<div class="rl-cell"><div class="k">一致率 Po</div><div class="v">' +
      fmtPct(r.stat.po) +
      '</div></div>'
    h +=
      '<div class="rl-cell"><div class="k">期望一致 Pe</div><div class="v">' +
      fmtPct(r.stat.pe) +
      '</div></div>'
    h += '</div>'
    h += '<div class="st-row"><span>多编码项（另算 Jaccard）</span><b>' + r.multi + '</b></div>'
    h +=
      '<div class="st-row"><span>多编码项平均重合度</span><b>' +
      (r.jaccard == null ? '—' : fmtPct(r.jaccard)) +
      '</b></div>'
    h +=
      '<div class="st-row"><span>第二编码者未匹配码号</span><b>' +
      r.unmatched +
      '</b></div>'
    h +=
      '<div class="st-row"><span>只有一方编码的项目</span><b>' +
      r.missing +
      '</b></div>'
    if (r.disagreements.length) {
      h += '<div class="help-h">分歧项目（前 ' + r.disagreements.length + ' 条）</div>'
      h += '<div class="rl-dis">'
      r.disagreements.forEach(function (d) {
        var ca = H.codeById(d.a),
          cb = H.codeById(d.b)
        h +=
          '<div>' +
          esc(keyLabel(d.k, r.source)) +
          '：<i>' +
          esc(ca ? ca.no + ' ' + ca.name : d.a) +
          '</i> ↔ <i>' +
          esc(cb ? cb.no + ' ' + cb.name : d.b) +
          '</i></div>'
      })
      h += '</div>'
    }
    h += '</div>'
    return h
  }
  function resultText(r) {
    if (!r || !r.stat) return '无可比对数据。'
    var v = verdict(r.stat.kappa)
    var lines = [
      '编码者信度检验',
      '数据来源：' +
        (r.source === 'table' ? '表格编码 · 第 ' + r.round + ' 轮 · 列“' + r.col + '”' : '文本编码片段'),
      '检验时间：' + r.ts,
      '可比对项 N = ' + r.stat.N,
      '观察一致率 Po = ' + fmtPct(r.stat.po),
      '期望一致率 Pe = ' + fmtPct(r.stat.pe),
      "Cohen's κ = " + fmtK(r.stat.kappa) + '（' + v.text + '）',
      '多编码项 = ' + r.multi + (r.jaccard == null ? '' : '，平均 Jaccard = ' + fmtPct(r.jaccard)),
      '第二编码者未匹配码号 = ' + r.unmatched + '；仅一方编码的项目 = ' + r.missing,
    ]
    if (r.disagreements.length) {
      lines.push('', '分歧项目：')
      r.disagreements.forEach(function (d) {
        var ca = H.codeById(d.a),
          cb = H.codeById(d.b)
        lines.push(
          '  · ' +
            keyLabel(d.k, r.source) +
            '：' +
            (ca ? ca.no + ' ' + ca.name : d.a) +
            ' ↔ ' +
            (cb ? cb.no + ' ' + cb.name : d.b),
        )
      })
    }
    return lines.join('\n')
  }
  function showReliability() {
    if (!H.P.anns.length && !H.P.cellCodes.length) {
      notify('还没有编码结果')
      return
    }
    var srcs = []
    if (window.ZenTable && window.ZenTable.hasTableDocs() && H.P.cellCodes.length)
      srcs.push({ v: 'table', label: '表格编码' })
    if (H.P.anns.length) srcs.push({ v: 'text', label: '文本编码片段' })
    if (!srcs.length) {
      notify('还没有可检验的编码')
      return
    }
    var rounds = []
    for (var i = 1; i <= 5; i++) rounds.push({ v: i, label: '第 ' + i + ' 轮' })
    var h =
      '<div class="fm-row"><div class="fm-lb">数据来源</div><div class="fm-f"><div class="se" id="f-rl-src"><span class="se-v"></span><span class="se-a">▾</span></div></div></div>' +
      '<div class="fm-row"><div class="fm-lb">轮次</div><div class="fm-f"><div class="se" id="f-rl-round"><span class="se-v"></span><span class="se-a">▾</span></div></div></div>' +
      '<div class="fm-row"><div class="fm-lb">编码列</div><div class="fm-f"><div class="se" id="f-rl-col"><span class="se-v"></span><span class="se-a">▾</span></div></div></div>' +
      '<div class="fm-row"><div class="fm-lb">第二编码者</div><div class="fm-f">' +
      '<span class="ph-btn" id="f-rl-pick">选择 CSV / TXT</span>' +
      '<textarea class="fm-ta" id="f-rl-text" style="min-height:96px" placeholder="每行一条：项目编号, 码号编号或名称&#10;表格示例：1,01　或　1,议题属性&#10;文本示例：片段ID,01"></textarea>' +
      '<div class="fm-hint">可从“导出 → 编码表 / 表格编码表”取得第一编码者的项目编号与码号，交给第二位编码者标注后贴回或导入。项目编号：表格用原表行号（从 1 起），文本用片段 ID。</div>' +
      '<input type="file" id="f-rl-file" accept=".csv,.txt,text/csv" style="display:none" />' +
      '</div></div>' +
      '<div id="f-rl-out"></div>' +
      '<div class="fm-foot">' +
      '<button type="button" class="fm-sub ghost" id="f-rl-close">关闭</button>' +
      '<button type="button" class="fm-sub" id="f-rl-save">保存结果</button>' +
      '<button type="button" class="fm-sub" id="f-rl-run">计算信度</button>' +
      '</div>'
    H.openModal('编码者信度 · Inter-coder Reliability', h, null)
    H.selMount(E('f-rl-src'), srcs, srcs[0].v, refreshCols)
    H.selMount(E('f-rl-round'), rounds, (window.ZenTable && window.ZenTable.ui.round) || 1, null)
    H.selMount(E('f-rl-col'), [{ v: '', label: '（不适用）' }], '', null)
    function refreshCols() {
      var src = H.selVal(E('f-rl-src'))
      if (src !== 'table') {
        H.selMount(E('f-rl-col'), [{ v: '', label: '（不适用）' }], '', null)
        return
      }
      var td = currentTableDoc()
      if (!td || !window.ZenTable) {
        H.selMount(E('f-rl-col'), [{ v: '', label: '（无表格）' }], '', null)
        return
      }
      window.ZenTable.getData(td.id).then(function (data) {
        if (!data) return
        var items = data.headers.map(function (x) {
          return { v: x, label: x }
        })
        var cur = window.ZenTable.ui.col || data.headers[0]
        H.selMount(E('f-rl-col'), items, cur, null)
      })
    }
    refreshCols()
    E('f-rl-pick').addEventListener('click', function () {
      E('f-rl-file').click()
    })
    E('f-rl-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]
      if (!f) return
      var fr = new FileReader()
      fr.onload = function () {
        E('f-rl-text').value = String(fr.result || '')
        notify('第二编码者数据已载入')
      }
      fr.readAsText(f, 'utf-8')
      e.target.value = ''
    })
    E('f-rl-close').addEventListener('click', H.closeModal)
    E('f-rl-run').addEventListener('click', function () {
      var src = H.selVal(E('f-rl-src'))
      var round = parseInt(H.selVal(E('f-rl-round')), 10) || 1
      var col = H.selVal(E('f-rl-col'))
      var text = E('f-rl-text').value
      if (!text.trim()) return notify('请先填入或导入第二编码者的标注')
      lastResult = compute(src, round, col, text)
      E('f-rl-out').innerHTML = resultHTML(lastResult)
    })
    E('f-rl-save').addEventListener('click', function () {
      if (!lastResult) return notify('请先计算信度')
      H.P.reliability = H.P.reliability || []
      var stored = JSON.parse(JSON.stringify(lastResult))
      stored.id = H.uid('rl')
      H.P.reliability.push(stored)
      save()
      notify('信度结果已保存到项目，将进入论文附录')
      H.closeModal()
    })
  }

  // ---------- 典型引文 ----------
  function starredItems() {
    var out = []
    H.P.anns.forEach(function (a) {
      if (!a.star) return
      var c = H.codeById(a.code),
        d = H.docById(a.doc)
      out.push({
        kind: '文本片段',
        text: a.quote,
        code: c ? c.no + ' ' + c.name : '—',
        source: d ? d.title : '—',
        ref: H.annRef(a),
        note: a.memo || '',
        round: '',
      })
    })
    H.P.marks.forEach(function (m) {
      if (!m.star) return
      var d = H.docById(m.doc)
      out.push({
        kind: '阅读批注',
        text: m.quote,
        code: '批注 · ' + (m.sty || 'hl'),
        source: d ? d.title : '—',
        ref: H.markRef(m),
        note: m.text || '',
        round: '',
      })
    })
    ;(H.P.cellCodes || []).forEach(function (cc) {
      if (!cc.star) return
      var c = H.codeById(cc.code),
        d = H.docById(cc.table)
      out.push({
        kind: '表格行',
        text: '__TABLE__' + cc.table + '|' + cc.row + '|' + cc.col,
        code: c ? c.no + ' ' + c.name : '—',
        source: d ? d.title : '—',
        ref: '第 ' + (cc.row + 1) + ' 行 · 列“' + cc.col + '”',
        note: cc.memo || '',
        round: '第 ' + (cc.round || 1) + ' 轮',
      })
    })
    return out
  }
  function resolveTableTexts(items) {
    var ids = {}
    items.forEach(function (x) {
      if (x.text.indexOf('__TABLE__') === 0) {
        var p = x.text.slice(9).split('|')
        ids[p[0]] = 1
      }
    })
    var ks = Object.keys(ids)
    if (!ks.length || !window.ZenTable) return Promise.resolve(items)
    return Promise.all(
      ks.map(function (id) {
        return window.ZenTable.getData(id).then(function (data) {
          return { id: id, data: data }
        })
      }),
    ).then(function (list) {
      var map = {}
      list.forEach(function (x) {
        map[x.id] = x.data
      })
      items.forEach(function (x) {
        if (x.text.indexOf('__TABLE__') !== 0) return
        var p = x.text.slice(9).split('|')
        var data = map[p[0]]
        var row = data && data.rows[parseInt(p[1], 10)]
        var ci = data ? data.headers.indexOf(p[2]) : -1
        x.text = row && ci >= 0 ? String(row[ci] || '') : '（表格原文不在本机，请重新导入 CSV）'
      })
      return items
    })
  }
  function starredMarkdown(items) {
    var out = '# 典型引文 · ' + H.P.title + '\n\n'
    out +=
      '导出时间：' +
      H.nowStr() +
      '　共 ' +
      items.length +
      ' 条。引文定位：PDF 为页码，表格为行号与列名，访谈文本为段落号与字符区间。\n\n'
    if (!items.length) return out + '（尚未标记典型引文。）\n'
    items.forEach(function (x, i) {
      out +=
        '## ' +
        (i + 1) +
        '. ' +
        (x.code || '引用') +
        (x.round ? ' · ' + x.round : '') +
        '\n\n'
      out += '> ' + String(x.text).replace(/\n/g, ' ') + '\n\n'
      out +=
        '出处：' +
        x.source +
        '　〔' +
        x.ref +
        '〕　类型：' +
        x.kind +
        '\n\n'
      if (x.note) out += '分析备注：' + x.note + '\n\n'
    })
    return out
  }
  function exportStarred() {
    resolveTableTexts(starredItems()).then(function (items) {
      H.download('zenmark-starred-quotes.md', starredMarkdown(items), 'text/markdown;charset=utf-8')
      notify('已导出典型引文 · ' + items.length + ' 条')
    })
  }

  // ---------- 论文附录 ----------
  function materialRows() {
    var rows = ['| 材料 | 类型 | 来源/说明 | 编码片段 | 批注 |', '| --- | --- | --- | --- | --- |']
    H.P.docs.forEach(function (d) {
      var nn = 0,
        mm = 0
      H.P.anns.forEach(function (a) {
        if (a.doc === d.id) nn++
      })
      H.P.marks.forEach(function (m) {
        if (m.doc === d.id) mm++
      })
      var cc = H.P.cellCodes
        ? H.P.cellCodes.filter(function (x) {
            return x.table === d.id
          }).length
        : 0
      rows.push(
        '| ' +
          mdCell(d.title) +
          ' | ' +
          mdCell(d.type || d.kind || '') +
          ' | ' +
          mdCell([d.source, d.date, d.note].filter(Boolean).join('；')) +
          ' | ' +
          (nn + cc) +
          ' | ' +
          mm +
          ' |',
      )
    })
    if (rows.length === 2) rows.push('| （无材料） | | | | |')
    return rows.join('\n')
  }
  function codebookBlock() {
    var lines = []
    ;['open', 'axial', 'selective'].forEach(function (lv) {
      var g = H.sortedCodes().filter(function (c) {
        return c.level === lv
      })
      if (!g.length) return
      lines.push('### ' + (H.LVNAME[lv] || lv) + '\n')
      g.forEach(function (c) {
        lines.push('- **' + c.no + '　' + c.name + '**（使用 ' + H.annCount(c.id) + ' 次）')
        if (c.parent) {
          var pc = H.codeById(c.parent)
          if (pc) lines.push('  - 上级码：' + pc.no + ' ' + pc.name)
        }
        if (c.def) lines.push('  - 操作性定义：' + c.def)
        if (c.incl) lines.push('  - 纳入标准：' + c.incl)
        if (c.excl) lines.push('  - 排除标准：' + c.excl)
        if (c.eg) lines.push('  - 典型例证：' + c.eg)
        if (c.memo) lines.push('  - 编码备忘：' + c.memo)
      })
      lines.push('')
    })
    if (!lines.length) lines.push('（码表为空。）')
    return lines.join('\n')
  }
  function reliabilityBlock() {
    var rs = H.P.reliability || []
    if (!rs.length) return '（尚未进行编码者信度检验；可在“编码 → 信度”中计算并保存结果。）'
    var lines = []
    rs.forEach(function (r, i) {
      lines.push('### 检验 ' + (i + 1) + '\n')
      lines.push('```text')
      lines.push(resultText(r))
      lines.push('```\n')
    })
    return lines.join('\n')
  }
  function exportAppendix() {
    resolveTableTexts(starredItems()).then(function (quotes) {
      var tree = buildTree()
      var lvCount = { open: 0, axial: 0, selective: 0 }
      H.P.codes.forEach(function (c) {
        if (lvCount[c.level] != null) lvCount[c.level]++
      })
      var rounds = {}
      ;(H.P.cellCodes || []).forEach(function (cc) {
        rounds[cc.round || 1] = (rounds[cc.round || 1] || 0) + 1
      })
      var roundStr = Object.keys(rounds)
        .sort()
        .map(function (r) {
          return '第 ' + r + ' 轮 ' + rounds[r] + ' 次'
        })
        .join('；') || '无表格编码'

      var out = '# 论文附录 · ' + H.P.title + '\n\n'
      if (H.P.desc) out += '> ' + H.P.desc + '\n\n'
      out += '导出时间：' + H.nowStr() + '\n\n'

      out += '## 一、研究材料与方法数据\n\n'
      out +=
        '- 材料总数：' +
        H.P.docs.length +
        '（访谈/文本 ' +
        H.P.docs.filter(function (d) {
          return d.kind === 'text'
        }).length +
        '，PDF ' +
        H.P.docs.filter(function (d) {
          return d.kind === 'pdf'
        }).length +
        '，表格 ' +
        H.P.docs.filter(function (d) {
          return d.kind === 'table'
        }).length +
        '）\n'
      out +=
        '- 码号总数：' +
        H.P.codes.length +
        '（开放式 ' +
        lvCount.open +
        '，轴心式 ' +
        lvCount.axial +
        '，选择式 ' +
        lvCount.selective +
        '）\n'
      out +=
        '- 编码片段：' +
        H.P.anns.length +
        '　阅读批注：' +
        H.P.marks.length +
        '　备忘录：' +
        H.P.memos.length +
        '\n'
      out += '- 表格行编码：' + (H.P.cellCodes || []).length + '（' + roundStr + '）\n'
      out += '- 典型引文：' + quotes.length + '\n\n'
      out += materialRows() + '\n\n'

      out += '## 二、码表（Codebook）\n\n'
      out += codebookBlock() + '\n'

      out += '## 三、编码结构\n\n'
      out += mdTreeOf(tree) + '\n\n'
      out += '```mermaid\n' + mermaidOf(tree) + '\n```\n\n'

      out += '## 四、编码者信度\n\n'
      out += reliabilityBlock() + '\n\n'

      out += '## 五、典型引文\n\n'
      out += starredMarkdown(quotes).replace(/^# [^\n]*\n\n/, '').replace(/^导出时间：[^\n]*\n\n/, '')

      H.download('zenmark-paper-appendix.md', out, 'text/markdown;charset=utf-8')
      notify('论文附录已导出 · ' + quotes.length + ' 条典型引文')
    })
  }

  // ---------- AI 工作区：只读项目快照 ----------
  function snapshotBase() {
    var P = H.P
    var codes = H.sortedCodes().map(function (c) {
      var pc = c.parent && H.codeById(c.parent)
      return {
        id: c.id,
        no: c.no,
        name: c.name,
        level: c.level,
        parent: pc ? pc.no + ' ' + pc.name : '',
        def: c.def || '',
        incl: c.incl || '',
        excl: c.excl || '',
        count: H.annCount(c.id),
      }
    })
    var rounds = {}
    ;(P.cellCodes || []).forEach(function (cc) {
      rounds[cc.round || 1] = (rounds[cc.round || 1] || 0) + 1
    })
    var counts = {
      docs: P.docs.length,
      textDocs: P.docs.filter(function (d) {
        return d.kind === 'text'
      }).length,
      pdfDocs: P.docs.filter(function (d) {
        return d.kind === 'pdf'
      }).length,
      tableDocs: P.docs.filter(function (d) {
        return d.kind === 'table'
      }).length,
      codes: P.codes.length,
      anns: P.anns.length,
      marks: P.marks.length,
      memos: P.memos.length,
      notes: P.notes.length,
      cellCodes: (P.cellCodes || []).length,
      reliability: (P.reliability || []).length,
      starred: starredItems().length,
      rounds: rounds,
    }
    return {
      app: 'omm-annotate',
      version: 1,
      generatedAt: H.nowStr(),
      project: { title: P.title, desc: P.desc || '' },
      counts: counts,
      materials: P.docs.map(function (d) {
        return {
          id: d.id,
          title: d.title,
          kind: d.kind || 'text',
          type: d.type || '',
          source: d.source || '',
          date: d.date || '',
          columns: d.columns || [],
          rowCount: d.rowCount || 0,
        }
      }),
      codes: codes,
      tableCoding: (P.cellCodes || []).slice(0, 5000).map(function (cc) {
        var c = H.codeById(cc.code)
        return {
          table: cc.table,
          row: cc.row,
          col: cc.col,
          code: c ? c.no + ' ' + c.name : cc.code,
          round: cc.round || 1,
          status: cc.status || 'done',
          star: !!cc.star,
        }
      }),
      reliability: (P.reliability || []).map(function (r) {
        return {
          id: r.id,
          ts: r.ts,
          source: r.source,
          round: r.round,
          col: r.col,
          kappa: r.stat && r.stat.kappa,
          agreement: r.stat && r.stat.po,
          N: r.stat && r.stat.N,
        }
      }),
      starred: starredItems()
        .slice(0, 40)
        .map(function (x) {
          return {
            kind: x.kind,
            code: x.code,
            source: x.source,
            ref: x.ref,
            note: x.note,
            round: x.round,
            text: x.text.indexOf('__TABLE__') === 0 ? '（表格原文不在本机，请重新导入 CSV）' : x.text,
          }
        }),
      tree: (function () {
        var out = []
        function walk(n, depth) {
          out.push({ depth: depth, no: n.code.no, name: n.code.name, count: H.annCount(n.code.id) })
          n.children.forEach(function (ch) {
            walk(ch, depth + 1)
          })
        }
        buildTree().roots.forEach(function (n) {
          walk(n, 0)
        })
        return out
      })(),
    }
  }
  function snapshot() {
    return H ? snapshotBase() : null
  }
  function snapshotAsync() {
    if (!H) return Promise.resolve(null)
    return resolveTableTexts(starredItems()).then(function (items) {
      var s = snapshotBase()
      s.starred = items.slice(0, 40).map(function (x) {
        return {
          kind: x.kind,
          code: x.code,
          source: x.source,
          ref: x.ref,
          note: x.note,
          round: x.round,
          text: x.text,
        }
      })
      return s
    })
  }
  function snapshotMarkdown() {
    if (!H) return ''
    var s = snapshotBase()
    var lv = { open: 0, axial: 0, selective: 0 }
    s.codes.forEach(function (c) {
      if (lv[c.level] != null) lv[c.level]++
    })
    var lines = [
      '# 质性编码项目 · ' + s.project.title,
      '',
      '> 数据来自 OMM Annotate（ZenMark）的实时只读快照，供 AI 工作区作为上下文引用。',
      '',
      '## 方法数据',
      '- 材料：' + s.counts.docs + '（文本 ' + s.counts.textDocs + ' / PDF ' + s.counts.pdfDocs + ' / 表格 ' + s.counts.tableDocs + '）',
      '- 码号：' + s.counts.codes + '（开放 ' + lv.open + ' / 轴心 ' + lv.axial + ' / 选择 ' + lv.selective + '）',
      '- 编码片段：' + s.counts.anns + '；阅读批注：' + s.counts.marks + '；表格行编码：' + s.counts.cellCodes,
      '- 典型引文：' + s.counts.starred + '；已保存信度检验：' + s.counts.reliability,
      '',
      '## 码表',
    ]
    s.codes.slice(0, 120).forEach(function (c) {
      lines.push('- ' + c.no + ' ' + c.name + '（' + c.level + '，' + c.count + ' 次）' + (c.def ? '：' + c.def : ''))
    })
    if (!s.codes.length) lines.push('- （码表为空）')
    lines.push('', '## 编码结构')
    s.tree.forEach(function (n) {
      lines.push(new Array(n.depth + 1).join('  ') + '- ' + n.no + ' ' + n.name + '（' + n.count + '）')
    })
    if (s.reliability.length) {
      lines.push('', '## 编码者信度')
      s.reliability.forEach(function (r) {
        lines.push(
          '- κ=' + fmtK(r.kappa || 0) + '，一致率=' + fmtPct(r.agreement || 0) + '，N=' + r.N +
            '（' + (r.source === 'table' ? '表格第 ' + r.round + ' 轮 · ' + r.col : '文本片段') + '）',
        )
      })
    }
    lines.push('', '## 典型引文（最多 20 条）')
    s.starred.slice(0, 20).forEach(function (x) {
      lines.push('- [' + x.code + '] ' + String(x.text).replace(/\n/g, ' ') + '　—— ' + x.source + '〔' + x.ref + '〕' + (x.note ? '　备注：' + x.note : ''))
    })
    if (!s.starred.length) lines.push('- （尚未标记典型引文）')
    return lines.join('\n')
  }

  function init() {
    H = window.ZenTableHost
    if (!H) return
  }

  ZP.init = init
  ZP.locator = locator
  ZP.showReliability = showReliability
  ZP.showCodeTree = showCodeTree
  ZP.exportAppendix = exportAppendix
  ZP.exportStarred = exportStarred
  ZP.starredItems = starredItems
  ZP.codeTree = buildTree
  ZP.mermaid = mermaidOf
  ZP.snapshot = snapshot
  ZP.snapshotAsync = snapshotAsync
  ZP.snapshotMarkdown = snapshotMarkdown

  window.ZenPaper = ZP

  /* AI 工作区只读入口：可同步取结构化快照，也可异步补全表格原文引文。 */
  window.ZenAnnotateAI = {
    snapshot: snapshot,
    snapshotAsync: snapshotAsync,
    snapshotMarkdown: snapshotMarkdown,
    locator: locator,
    version: 1,
  }
})()
