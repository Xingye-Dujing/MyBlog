/* ================================================================
 * omm-table.js — 表格编码（接在 omm-annotate.html 内）
 *
 * 设计要点：
 *  - 码表与访谈标注完全共用（P.codes），编码记录单独放 P.cellCodes
 *  - 表格原文放 IndexedDB（键 'table:<docId>'），不占 localStorage
 *  - 云同步（方案 A）只带元数据与编码结果；换设备重新导入同名 CSV 可按行号挂回
 *  - 支持多轮次编码：一轮 = 开放式，二轮 = 轴心式（用上级码归并），旧记录不覆盖
 * ================================================================ */
;(function () {
  'use strict'

  var H = null
  var ZT = {}

  var UI_KEY = 'zenmark.table.ui.v1'
  var ui = {
    docId: '',
    col: '',
    round: 1,
    filter: 'all',
    code: 'all',
    q: '',
    page: 0,
    pageSize: 80,
    focus: false,
    row: 0,
  }
  var cache = {} // docId -> { name, headers, rows }
  var loading = {}
  var warned = {}
  var pop = null
  var popTarget = null
  var popFiltered = []
  var popIdx = 0

  // ---------- 宿主能力 ----------
  function E(id) {
    return H.el(id)
  }
  function esc(s) {
    return H.esc(s)
  }
  function uid(p) {
    return H.uid(p)
  }
  function nowStr() {
    return H.nowStr()
  }
  function notify(m) {
    H.notify(m)
  }
  function saveStore(project) {
    return H.Store.save(project)
  }
  function clamp(v, a, b) {
    return H.clamp(v, a, b)
  }

  // ---------- UI 状态（本机记住，不进同步包） ----------
  function loadUI() {
    try {
      var raw = localStorage.getItem(UI_KEY)
      if (!raw) return
      var o = JSON.parse(raw)
      for (var k in o) if (k in ui) ui[k] = o[k]
    } catch (e) {}
  }
  function saveUI() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify(ui))
    } catch (e) {}
  }

  // ---------- IndexedDB ----------
  function keyOf(id) {
    return 'table:' + id
  }
  function getData(id) {
    if (cache[id]) return Promise.resolve(cache[id])
    if (loading[id]) return loading[id]
    loading[id] = H.IDB.get(keyOf(id))
      .then(function (v) {
        delete loading[id]
        if (v && Array.isArray(v.rows)) {
          cache[id] = v
          return v
        }
        return null
      })
      .catch(function () {
        delete loading[id]
        return null
      })
    return loading[id]
  }
  // ---------- CSV 解析（支持引号、逗号、分号、Tab、BOM、引号内换行） ----------
  function parseCSV(text) {
    text = String(text || '').replace(/^\uFEFF/, '')
    var first = text.split(/\r?\n/, 1)[0] || ''
    var delim = ',',
      best = 0
    ;[',', '\t', ';'].forEach(function (d) {
      var n = first.split(d).length - 1
      if (n > best) {
        best = n
        delim = d
      }
    })
    var rows = [],
      row = [],
      f = '',
      i = 0,
      inQ = false
    while (i < text.length) {
      var c = text.charAt(i)
      if (inQ) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') {
            f += '"'
            i += 2
            continue
          }
          inQ = false
          i++
          continue
        }
        f += c
        i++
        continue
      }
      if (c === '"' && f === '') {
        inQ = true
        i++
        continue
      }
      if (c === delim) {
        row.push(f)
        f = ''
        i++
        continue
      }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && text.charAt(i + 1) === '\n') i++
        row.push(f)
        f = ''
        rows.push(row)
        row = []
        i++
        continue
      }
      f += c
      i++
    }
    if (f !== '' || row.length) {
      row.push(f)
      rows.push(row)
    }
    rows = rows.filter(function (r) {
      return r.some(function (x) {
        return String(x).trim() !== ''
      })
    })
    if (!rows.length) return { headers: [], rows: [] }
    var headers = rows[0].map(function (x, i) {
      return String(x).trim() || '列 ' + (i + 1)
    })
    var body = rows.slice(1).map(function (r) {
      var out = headers.map(function (_, i) {
        return r[i] == null ? '' : String(r[i])
      })
      for (var j = headers.length; j < r.length; j++) out.push(String(r[j]))
      return out
    })
    return { headers: headers, rows: body }
  }

  // ---------- 导入 ----------
  function readCsvFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onload = function () {
        try {
          var parsed = parseCSV(String(reader.result || ''))
          if (!parsed || !parsed.headers.length) throw new Error('CSV 解析失败：' + file.name)
          resolve(parsed)
        } catch (error) {
          reject(error)
        }
      }
      reader.onerror = function () {
        reject(new Error('读取 CSV 失败：' + file.name))
      }
      reader.readAsText(file, 'utf-8')
    })
  }

  function importCsvFiles(files) {
    if (!H) return Promise.resolve(false)
    var arr = Array.prototype.slice.call(files || [])
    if (!arr.length) return Promise.resolve(false)

    return Promise.all(arr.map(readCsvFile))
      .then(function (results) {
        var docs = H.P.docs.slice()
        var byTitle = Object.create(null)
        docs.forEach(function (doc) {
          if (doc.kind === 'table') byTitle[doc.title] = doc
        })
        var plans = results.map(function (parsed, index) {
          var file = arr[index]
          var base = file.name.replace(/\.csv$/i, '')
          var exist = byTitle[base] || null
          var recovered = !!exist
          var oldCols = exist && exist.columns ? exist.columns.slice() : null
          var id = exist ? exist.id : uid('d')
          var doc = exist ? Object.assign({}, exist) : {
            id: id,
            title: base,
            source: 'CSV · ' + parsed.rows.length + ' 行',
            type: '表格',
            date: '',
            note: '由 CSV 导入，原文存于本机浏览器数据库。',
            text: '',
            kind: 'table',
            columns: parsed.headers,
            rowCount: parsed.rows.length,
          }
          doc.columns = parsed.headers
          doc.rowCount = parsed.rows.length
          doc.source = 'CSV · ' + parsed.rows.length + ' 行'
          if (!exist) docs.push(doc)
          byTitle[base] = doc
          return {
            id: id,
            base: base,
            parsed: parsed,
            recovered: recovered,
            changed: !!oldCols && oldCols.join('|') !== parsed.headers.join('|'),
            data: { name: base, headers: parsed.headers, rows: parsed.rows },
          }
        })
        var entries = plans.map(function (plan) {
          return [keyOf(plan.id), plan.data]
        })
        var rollback = entries.map(function (entry) {
          return H.IDB.get(entry[0]).then(function (value) {
            return [entry[0], value]
          })
        })

        return Promise.all(rollback).then(function (previous) {
          // 所有原文先在一个 IndexedDB 事务里落盘；任一文件失败则事务整体回滚。
          return H.IDB.putMany(entries).then(function () {
            var project = Object.assign({}, H.P, { docs: docs })
            if (saveStore(project) === false) {
              // 元数据未提交，恢复本次写入前的 IndexedDB 原文。
              return H.IDB.putMany(previous).then(function () {
                notify('表格元数据保存失败，已回滚 CSV 导入')
                return false
              })
            }
            H.P.docs = docs
            plans.forEach(function (plan) {
              cache[plan.id] = plan.data
            })
            var last = plans[plans.length - 1]
            H.S.docId = last.id
            ui.docId = last.id
            if (ui.col && last.parsed.headers.indexOf(ui.col) < 0)
              ui.col = last.parsed.headers[0] || ''
            saveUI()
            H.renderAll()
            plans.forEach(function (plan) {
              if (plan.recovered) {
                notify(
                  plan.changed
                    ? '已恢复表格原文，但列名有变化，请检查已有编码是否仍对齐'
                    : '已恢复表格原文，原有编码已保留',
                )
              } else notify('已导入表格：' + plan.base + '（' + plan.parsed.rows.length + ' 行）')
            })
            return true
          })
        })
      })
      .catch(function (error) {
        notify('CSV 导入失败：' + (error && error.message ? error.message : String(error)))
        return false
      })
  }

  // ---------- 数据查询 ----------
  function tableDocs() {
    return (H.P.docs || []).filter(function (d) {
      return d.kind === 'table'
    })
  }
  function hasTableDocs() {
    return tableDocs().length > 0
  }
  function cellCodesOf(tableId, col) {
    return (H.P.cellCodes || []).filter(function (cc) {
      return cc.table === tableId && (!col || cc.col === col)
    })
  }
  function groupByRow(list) {
    var m = {}
    list.forEach(function (cc) {
      ;(m[cc.row] || (m[cc.row] = [])).push(cc)
    })
    return m
  }
  function filteredRows(data, coded) {
    var q = (ui.q || '').trim().toLowerCase()
    var rows = data.rows.map(function (r, i) {
      return { i: i, cells: r }
    })
    if (q)
      rows = rows.filter(function (x) {
        return x.cells.join(' ').toLowerCase().indexOf(q) >= 0
      })
    if (ui.code !== 'all')
      rows = rows.filter(function (x) {
        return (coded[x.i] || []).some(function (cc) {
          return cc.code === ui.code
        })
      })
    if (ui.filter === 'uncoded')
      rows = rows.filter(function (x) {
        return !coded[x.i]
      })
    else if (ui.filter === 'coded')
      rows = rows.filter(function (x) {
        return !!coded[x.i]
      })
    else if (ui.filter === 'review')
      rows = rows.filter(function (x) {
        return (coded[x.i] || []).some(function (cc) {
          return cc.status === 'review'
        })
      })
    return rows
  }

  // ---------- 渲染 ----------
  function ensureCurrentDoc() {
    var d = H.curDoc()
    if (d && d.kind === 'table') {
      ui.docId = d.id
      return d
    }
    var list = tableDocs()
    if (!list.length) {
      ui.docId = ''
      return null
    }
    var pick = list.filter(function (x) {
      return x.id === ui.docId
    })[0]
    if (!pick) pick = list[0]
    ui.docId = pick.id
    H.S.docId = pick.id
    saveUI()
    return pick
  }
  function checkMissing() {
    var d = H.docById(ui.docId)
    if (!d || d.kind !== 'table') return
    getData(d.id).then(function (v) {
      if (!v && !warned[d.id]) {
        warned[d.id] = 1
        notify('本机没有这份表格的原文，请重新导入同名 CSV 以恢复编码')
      }
    })
  }
  function render() {
    if (!H || H.S.view !== 'table') return
    var bar = E('tb-toolbar'),
      stage = E('tb-stage')
    if (!bar || !stage) return
    var d = ensureCurrentDoc()
    if (!d) {
      bar.innerHTML = ''
      stage.innerHTML =
        '<div class="tb-empty">尚无表格材料。<br />点顶部“导入”选择 .csv，即可开始逐行编码。</div>'
      return
    }
    getData(d.id).then(function (data) {
      if (H.S.view !== 'table') return
      if (!data) {
        bar.innerHTML = ''
        stage.innerHTML =
          '<div class="tb-empty">本机没有这份表格的原文。<br />请重新导入同名 CSV（列名需一致），已有的 ' +
          cellCodesOf(d.id).length +
          ' 条编码会按行号挂回。</div>'
        return
      }
      if (!ui.col || data.headers.indexOf(ui.col) < 0) ui.col = data.headers[0] || ''
      renderToolbar(d, data)
      renderStage(d, data)
    })
  }
  function filterLabel(v) {
    return { all: '全部行', uncoded: '未编码', coded: '已编码', review: '待复核' }[v] || '全部行'
  }
  function codeLabel() {
    if (ui.code === 'all') return '全部类目'
    var c = H.codeById(ui.code)
    return c ? c.no + ' ' + c.name : '全部类目'
  }
  function renderToolbar(d, data) {
    var bar = E('tb-toolbar')
    var coded = groupByRow(cellCodesOf(d.id, ui.col))
    var total = data.rows.length,
      doneN = Object.keys(coded).length
    var pct = total ? Math.round((doneN / total) * 100) : 0
    var h = ''
    h += '<span class="mini-label">表格</span>'
    h +=
      '<div class="se mini" id="tb-doc"><span class="se-v"></span><span class="se-a">▾</span></div>'
    h +=
      '<div class="se mini" id="tb-col"><span class="se-v"></span><span class="se-a">▾</span></div>'
    h +=
      '<div class="se mini" id="tb-round"><span class="se-v"></span><span class="se-a">▾</span></div>'
    h +=
      '<div class="se mini" id="tb-filter"><span class="se-v"></span><span class="se-a">▾</span></div>'
    h +=
      '<div class="se mini" id="tb-code"><span class="se-v"></span><span class="se-a">▾</span></div>'
    h +=
      '<input type="text" id="tb-q" class="tb-q" autocomplete="off" spellcheck="false" placeholder="检索本列文本" />'
    h += '<span class="spacer"></span>'
    h +=
      '<div class="tb-progress"><span>已编码 <b>' +
      doneN +
      '</b> / ' +
      total +
      '</span><span class="tb-bar"><i style="width:' +
      pct +
      '%"></i></span><span>' +
      pct +
      '%</span></div>'
    h +=
      '<span class="ph-btn' +
      (ui.focus ? ' on' : '') +
      '" data-taction="focus">' +
      (ui.focus ? '退出聚焦' : '聚焦模式') +
      '</span>'
    bar.innerHTML = h
    var refresh = function () {
      saveUI()
      render()
    }
    H.selMount(
      E('tb-doc'),
      tableDocs().map(function (x) {
        return { v: x.id, label: x.title }
      }),
      d.id,
      function (v) {
        H.S.docId = v
        ui.docId = v
        ui.page = 0
        ui.row = 0
        ui.col = ''
        refresh()
      },
    )
    H.selMount(
      E('tb-col'),
      data.headers.map(function (x) {
        return { v: x, label: '列：' + x }
      }),
      ui.col,
      function (v) {
        ui.col = v
        ui.page = 0
        ui.row = 0
        refresh()
      },
    )
    var rounds = []
    for (var r = 1; r <= 5; r++)
      rounds.push({
        v: r,
        label: '第 ' + r + ' 轮' + (r === 1 ? ' · 开放式' : r === 2 ? ' · 轴心式' : ''),
      })
    H.selMount(E('tb-round'), rounds, ui.round, function (v) {
      ui.round = parseInt(v, 10) || 1
      refresh()
    })
    H.selMount(
      E('tb-filter'),
      ['all', 'uncoded', 'coded', 'review'].map(function (v) {
        return { v: v, label: filterLabel(v) }
      }),
      ui.filter,
      function (v) {
        ui.filter = v
        ui.page = 0
        ui.row = 0
        refresh()
      },
    )
    H.selMount(
      E('tb-code'),
      [{ v: 'all', label: '全部类目' }].concat(
        H.sortedCodes().map(function (c) {
          return { v: c.id, label: c.no + ' ' + c.name }
        }),
      ),
      ui.code,
      function (v) {
        ui.code = v
        ui.page = 0
        ui.row = 0
        refresh()
      },
    )
    var qi = E('tb-q')
    if (qi) {
      qi.value = ui.q || ''
      qi.addEventListener('input', function () {
        ui.q = qi.value
        ui.page = 0
        ui.row = 0
        saveUI()
        renderStage(d, data)
      })
    }
  }
  function renderStage(d, data) {
    if (ui.focus) renderFocus(d, data)
    else renderGrid(d, data)
  }
  function chipHTML(cs) {
    if (!cs.length) return ''
    var seen = {},
      parts = []
    cs.forEach(function (cc) {
      var c = H.codeById(cc.code)
      var key = (cc.round || 1) + ':' + cc.code
      if (seen[key]) return
      seen[key] = 1
      var label = c ? c.no + ' ' + c.name : '—'
      parts.push(
        '<span class="tb-chip ' +
          (cc.status === 'review' ? 'review' : 'done') +
          '" style="--c:' +
          esc(c ? c.color : '') +
          '">R' +
          (cc.round || 1) +
          ' ' +
          esc(label) +
          '</span>',
      )
    })
    return parts.join('') + '<br />'
  }
  function renderGrid(d, data) {
    var stage = E('tb-stage')
    var coded = groupByRow(cellCodesOf(d.id, ui.col))
    var rows = filteredRows(data, coded)
    var totalPages = Math.max(1, Math.ceil(rows.length / ui.pageSize))
    ui.page = clamp(ui.page, 0, totalPages - 1)
    var pageRows = rows.slice(ui.page * ui.pageSize, (ui.page + 1) * ui.pageSize)
    var colIdx = data.headers.indexOf(ui.col)
    var h = '<div class="tb-wrap">'
    if (!pageRows.length) {
      h +=
        '<div class="tb-empty">' +
        (data.rows.length ? '当前筛选下没有行。' : '这份表格没有数据行。') +
        '</div>'
    } else {
      h += '<table class="tb-grid"><thead><tr><th class="tb-no">#</th>'
      data.headers.forEach(function (hd) {
        h +=
          '<th' +
          (hd === ui.col ? ' style="color:var(--text)"' : '') +
          ' title="' +
          esc(hd) +
          '">' +
          esc(hd) +
          '</th>'
      })
      h += '</tr></thead><tbody>'
      pageRows.forEach(function (x) {
        h += '<tr' + (ui.row === x.i ? ' class="cur"' : '') + '>'
        h += '<td class="tb-no">' + (x.i + 1) + '</td>'
        data.headers.forEach(function (hd, ci) {
          var val = x.cells[ci] == null ? '' : String(x.cells[ci])
          if (ci === colIdx) {
            var cs = coded[x.i] || []
            var last = cs[cs.length - 1]
            var c = last ? H.codeById(last.code) : null
            h +=
              '<td class="tb-val' +
              (cs.length ? ' has' : '') +
              '" data-trow="' +
              x.i +
              '" style="--c:' +
              esc(c ? c.color : '') +
              '" title="点击指派类目">' +
              chipHTML(cs) +
              esc(val || '（空）') +
              '</td>'
          } else {
            h += '<td title="' + esc(val) + '">' + esc(val) + '</td>'
          }
        })
        h += '</tr>'
      })
      h += '</tbody></table>'
    }
    h += '<div class="tb-pager">'
    h +=
      '<span class="tb-pg" data-taction="first"' +
      (ui.page === 0 ? ' disabled' : '') +
      '>«</span>'
    h +=
      '<span class="tb-pg" data-taction="prev"' +
      (ui.page === 0 ? ' disabled' : '') +
      '>‹ 上一页</span>'
    h +=
      '<span>第 ' +
      (ui.page + 1) +
      ' / ' +
      totalPages +
      ' 页 · 共 ' +
      rows.length +
      ' 行</span>'
    h +=
      '<span class="tb-pg" data-taction="next"' +
      (ui.page >= totalPages - 1 ? ' disabled' : '') +
      '>下一页 ›</span>'
    h +=
      '<span class="tb-pg" data-taction="last"' +
      (ui.page >= totalPages - 1 ? ' disabled' : '') +
      '>»</span>'
    h += '</div></div>'
    stage.innerHTML = h
  }
  function renderFocus(d, data) {
    var stage = E('tb-stage')
    var coded = groupByRow(cellCodesOf(d.id, ui.col))
    var rows = filteredRows(data, coded)
    if (!rows.length) {
      stage.innerHTML = '<div class="tb-empty">当前筛选下没有行。</div>'
      return
    }
    ui.row = clamp(ui.row, 0, rows.length - 1)
    var cur = rows[ui.row]
    var cs = coded[cur.i] || []
    var colIdx = data.headers.indexOf(ui.col)
    var h = '<div class="tb-focus"><div class="tb-fcard">'
    h +=
      '<div class="tb-fhead"><span class="mini-label">聚焦编码</span><span class="tb-fnum">第 ' +
      (ui.row + 1) +
      ' / ' +
      rows.length +
      ' 行 · 原表第 ' +
      (cur.i + 1) +
      ' 行</span><span class="spacer"></span>' +
      '<span class="ph-btn" data-taction="prevRow">‹</span>' +
      '<span class="ph-btn" data-taction="nextRow">›</span></div>'
    h +=
      '<div class="tb-frow"><div class="tb-fnum">列：' +
      esc(ui.col) +
      ' · 第 ' +
      ui.round +
      ' 轮</div><div class="tb-ftext">' +
      esc(colIdx >= 0 ? cur.cells[colIdx] || '（空）' : '') +
      '</div></div>'
    h += '<div class="tb-fother">'
    data.headers.forEach(function (hd, ci) {
      if (ci === colIdx) return
      h +=
        '<div><b>' +
        esc(hd) +
        '：</b>' +
        esc(cur.cells[ci] == null ? '' : cur.cells[ci]) +
        '</div>'
    })
    h += '</div>'
    h +=
      '<div class="tb-fassign"><span class="mini-label" style="margin-right:6px">已有</span>' +
      (cs.length ? chipHTML(cs) : '<span class="tb-chip">未编码</span>') +
      '</div>'
    h += '<div class="tb-fcodes"><div class="fm-chk">'
    H.sortedCodes().forEach(function (c, i) {
      var on = cs.some(function (cc) {
        return cc.code === c.id && (cc.round || 1) === ui.round
      })
      h +=
        '<span class="fm-chip' +
        (on ? ' on' : '') +
        '" data-trow="' +
        cur.i +
        '" data-tcode="' +
        c.id +
        '"><span class="tb-fkey">' +
        (i < 9 ? i + 1 : '') +
        '</span>' +
        esc(c.no + ' ' + c.name) +
        '</span>'
    })
    h += '</div></div></div></div>'
    stage.innerHTML = h
  }

  // ---------- 指派 ----------
  function assign(row, codeId, status, star) {
    var d = H.curDoc()
    if (!d || d.kind !== 'table' || !codeId) return false
    var exists = (H.P.cellCodes || []).some(function (cc) {
      return (
        cc.table === d.id &&
        cc.row === row &&
        cc.col === ui.col &&
        cc.code === codeId &&
        (cc.round || 1) === ui.round
      )
    })
    if (exists) {
      notify('这一行在本轮已指派过该码号')
      return false
    }
    H.P.cellCodes.push({
      id: uid('tc'),
      table: d.id,
      row: row,
      col: ui.col,
      code: codeId,
      round: ui.round,
      memo: '',
      status: status || 'done',
      star: !!star,
      ts: nowStr(),
    })
    saveStore()
    H.renderStatus()
    render()
    notify(
      '已指派 · ' +
        (H.codeById(codeId) ? H.codeById(codeId).name : '') +
        (status === 'review' ? '（待复核）' : ''),
    )
    return true
  }
  function toggleRowCode(row, codeId) {
    var d = H.curDoc()
    if (!d) return
    var idx = -1
    ;(H.P.cellCodes || []).forEach(function (cc, i) {
      if (
        cc.table === d.id &&
        cc.row === row &&
        cc.col === ui.col &&
        cc.code === codeId &&
        (cc.round || 1) === ui.round
      )
        idx = i
    })
    if (idx >= 0) {
      H.P.cellCodes.splice(idx, 1)
      saveStore()
      H.renderStatus()
      render()
      return
    }
    assign(row, codeId, 'done')
  }

  // ---------- 指派浮层 ----------
  function buildPop() {
    pop = document.createElement('div')
    pop.id = 'tb-pop'
    pop.innerHTML =
      '<div class="tb-pop-q" id="tb-pop-q"></div>' +
      '<input type="text" id="tb-pop-input" autocomplete="off" spellcheck="false" placeholder="选码号 / 输入新码号名称" />' +
      '<div id="tb-pop-list" class="sug inline"></div>' +
      '<div class="tb-pop-foot">' +
      '<div data-tpop="done">已确认</div><div data-tpop="review">待复核</div>' +
      '<div data-tpop="star">★引文</div><div data-tpop="new">新建</div>' +
      '<div data-tpop="close">取消</div></div>'
    document.body.appendChild(pop)
    E('tb-pop-input').addEventListener('input', function () {
      renderPopList(this.value.trim())
    })
    E('tb-pop-input').addEventListener('keydown', onPopKey)
    pop.addEventListener('click', onPopClick)
    document.addEventListener('mousedown', function (e) {
      if (!pop || !pop.classList.contains('open')) return
      if (!e.target || !e.target.closest) return
      if (pop.contains(e.target) || e.target.closest('td.tb-val')) return
      closePop()
    })
  }
  function renderPopList(q) {
    popFiltered = H.sortedCodes().filter(function (c) {
      if (!q) return true
      var k = q.toLowerCase()
      return (
        c.name.toLowerCase().indexOf(k) >= 0 ||
        String(c.no).indexOf(k) >= 0 ||
        (c.def || '').toLowerCase().indexOf(k) >= 0
      )
    })
    popIdx = 0
    var box = E('tb-pop-list')
    if (!popFiltered.length) {
      box.innerHTML = '<div class="sug-empty">无匹配码号 · 点“新建”或回车创建</div>'
      return
    }
    var h = ''
    popFiltered.slice(0, 30).forEach(function (c, i) {
      h +=
        '<div class="sug-item' +
        (i === 0 ? ' hl' : '') +
        '" data-tcode="' +
        c.id +
        '"><span class="sug-key">' +
        (i < 9 ? i + 1 : '·') +
        '</span><span class="sug-dot" style="--c:' +
        esc(c.color) +
        '"></span><span class="sug-name">' +
        esc(c.no + ' ' + c.name) +
        '</span></div>'
    })
    box.innerHTML = h
  }
  function movePop(d) {
    var n = popFiltered.length
    if (!n) return
    popIdx = (popIdx + d + n) % n
    E('tb-pop-list')
      .querySelectorAll('.sug-item')
      .forEach(function (node, i) {
        node.classList.toggle('hl', i === popIdx)
      })
    var cur = E('tb-pop-list').querySelector('.sug-item.hl')
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' })
  }
  function onPopKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      movePop(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      movePop(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      var q = E('tb-pop-input').value.trim()
      if (popFiltered[popIdx]) popAssign(popFiltered[popIdx].id, 'done')
      else if (q) popNew(q, 'done')
    } else if (/^[1-9]$/.test(e.key)) {
      var c = popFiltered[parseInt(e.key, 10) - 1]
      if (c) popAssign(c.id, 'done')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closePop()
    }
    e.stopPropagation()
  }
  function onPopClick(e) {
    if (!e.target || !e.target.closest) return
    var it = e.target.closest('#tb-pop-list .sug-item')
    if (it) {
      popAssign(it.getAttribute('data-tcode'), 'done')
      return
    }
    var a = e.target.closest('[data-tpop]')
    if (!a) return
    var act = a.getAttribute('data-tpop')
    if (act === 'close') return closePop()
    var q = E('tb-pop-input').value.trim()
    if (act === 'new') return popNew(q, 'done')
    var picked = popFiltered[popIdx] || popFiltered[0]
    if (act === 'star') {
      var row0 = popTarget ? popTarget.row : -1
      if (picked) popAssign(picked.id, 'done', true)
      else if (row0 >= 0) {
        var d0 = H.curDoc()
        var last = null
        ;(H.P.cellCodes || []).forEach(function (cc) {
          if (
            cc.table === d0.id &&
            cc.row === row0 &&
            cc.col === ui.col &&
            (cc.round || 1) === ui.round
          )
            last = cc
        })
        closePop()
        if (last) {
          last.star = !last.star
          saveStore()
          H.renderStatus()
          render()
          notify(last.star ? '已标为典型引文' : '已取消典型引文')
        } else notify('这一行还没有编码，请先指派码号')
      }
      return
    }
    if (picked) popAssign(picked.id, act === 'review' ? 'review' : 'done')
    else if (q) popNew(q, act === 'review' ? 'review' : 'done')
    else notify('请先选择一个码号')
  }
  function popAssign(codeId, status, star) {
    var row = popTarget ? popTarget.row : -1
    closePop()
    if (row >= 0) assign(row, codeId, status, star)
  }
  function popNew(name, status) {
    var row = popTarget ? popTarget.row : -1
    closePop()
    H.openCodeModal(null, {
      name: name || '',
      onCreated: function (c) {
        if (row >= 0) assign(row, c.id, status)
        else notify('码号已新建')
      },
    })
  }
  function closePop() {
    if (!pop) return
    pop.classList.remove('open')
    popTarget = null
  }
  function showPop(row, anchor) {
    var d = H.curDoc()
    var data = d && cache[d.id]
    if (!data) return notify('表格原文尚未载入')
    popTarget = { row: row }
    var colIdx = data.headers.indexOf(ui.col)
    var val = colIdx >= 0 && data.rows[row] ? String(data.rows[row][colIdx] || '') : ''
    E('tb-pop-q').textContent = '第 ' + (row + 1) + ' 行：' + val.slice(0, 120)
    E('tb-pop-input').value = ''
    renderPopList('')
    pop.classList.add('open')
    var r =
      anchor && anchor.getBoundingClientRect
        ? anchor.getBoundingClientRect()
        : { bottom: 120, left: 100, top: 100 }
    var top = r.bottom + 8
    var left = clamp(r.left, 10, Math.max(10, window.innerWidth - 300 - 10))
    if (top + pop.offsetHeight > window.innerHeight - 10)
      top = Math.max(10, r.top - pop.offsetHeight - 8)
    pop.style.top = top + 'px'
    pop.style.left = left + 'px'
    setTimeout(function () {
      try {
        E('tb-pop-input').focus()
      } catch (e) {}
    }, 20)
  }

  // ---------- 动作 / 键盘 ----------
  function handleAction(a) {
    if (a === 'focus') {
      ui.focus = !ui.focus
      ui.row = 0
      saveUI()
      render()
      return
    }
    if (a === 'first') ui.page = 0
    else if (a === 'prev') ui.page = Math.max(0, ui.page - 1)
    else if (a === 'next') ui.page = ui.page + 1
    else if (a === 'last') ui.page = 1e9
    else if (a === 'prevRow') ui.row = Math.max(0, ui.row - 1)
    else if (a === 'nextRow') ui.row = ui.row + 1
    else return
    saveUI()
    render()
  }
  function bindGlobal() {
    document.addEventListener('click', function (e) {
      if (!H || !e.target || !e.target.closest) return
      var chip = e.target.closest('.fm-chip[data-trow][data-tcode]')
      if (chip) {
        e.stopPropagation()
        toggleRowCode(parseInt(chip.getAttribute('data-trow'), 10), chip.getAttribute('data-tcode'))
        return
      }
      var cell = e.target.closest('td.tb-val[data-trow]')
      if (cell) {
        e.stopPropagation()
        showPop(parseInt(cell.getAttribute('data-trow'), 10), cell)
        return
      }
      var act = e.target.closest('[data-taction]')
      if (act && E('tb-toolbar') && E('tb-toolbar').contains(act)) {
        e.stopPropagation()
        handleAction(act.getAttribute('data-taction'))
        return
      }
      if (act && E('tb-stage') && E('tb-stage').contains(act)) {
        e.stopPropagation()
        handleAction(act.getAttribute('data-taction'))
      }
    })
    document.addEventListener('keydown', function (e) {
      if (!H || H.S.view !== 'table' || !ui.focus) return
      if (E('modal') && E('modal').classList.contains('open')) return
      if (E('custom-confirm') && E('custom-confirm').classList.contains('active')) return
      if (pop && pop.classList.contains('open')) return
      var tag = (e.target.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      var d = H.curDoc()
      var data = d && cache[d.id]
      if (!data) return
      var rows = filteredRows(data, groupByRow(cellCodesOf(d.id, ui.col)))
      var cur = rows[ui.row]
      if (/^[1-9]$/.test(e.key)) {
        var c = H.sortedCodes()[parseInt(e.key, 10) - 1]
        if (c && cur) {
          e.preventDefault()
          toggleRowCode(cur.i, c.id)
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        ui.row = ui.row + 1
        saveUI()
        render()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        ui.row = Math.max(0, ui.row - 1)
        saveUI()
        render()
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault()
        if (!cur) return
        var list = cellCodesOf(d.id, ui.col).filter(function (cc) {
          return cc.row === cur.i && (cc.round || 1) === ui.round
        })
        var last = list[list.length - 1]
        if (!last) return notify('这一行还没有编码')
        last.status = last.status === 'review' ? 'done' : 'review'
        saveStore()
        H.renderStatus()
        render()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        ui.focus = false
        saveUI()
        render()
      }
    })
  }

  // ---------- 导出 ----------
  function exportCsv() {
    if (!H) return
    var list = H.P.cellCodes || []
    if (!list.length) return notify('还没有表格编码')
    var rows = [
      ['材料', '行号', '编码列', '本列原文', '类目编号', '类目名称', '编码层级', '上级码', '轮次', '状态', '备注', '时间'],
    ]
    list
      .slice()
      .sort(function (a, b) {
        if (a.table !== b.table) return String(a.table).localeCompare(String(b.table))
        return a.row - b.row || (a.round || 1) - (b.round || 1)
      })
      .forEach(function (cc) {
        var d = H.docById(cc.table)
        var data = cache[cc.table]
        var colIdx = data ? data.headers.indexOf(cc.col) : -1
        var text =
          colIdx >= 0 && data.rows[cc.row] ? String(data.rows[cc.row][colIdx] || '') : ''
        var c = H.codeById(cc.code)
        var pc = c && c.parent ? H.codeById(c.parent) : null
        rows.push([
          d ? d.title : '',
          cc.row + 1,
          cc.col,
          text,
          c ? c.no : '',
          c ? c.name : '',
          c ? H.LVNAME[c.level] || '' : '',
          pc ? pc.no + ' ' + pc.name : '',
          '第 ' + (cc.round || 1) + ' 轮',
          cc.status === 'review' ? '待复核' : '已确认',
          cc.memo || '',
          cc.ts || '',
        ])
      })
    var csv = rows
      .map(function (r) {
        return r
          .map(function (v) {
            return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'
          })
          .join(',')
      })
      .join('\r\n')
    H.download('zenmark-table-coding.csv', '\ufeff' + csv, 'text/csv;charset=utf-8')
    notify('已导出表格编码表 · ' + list.length + ' 条')
  }

  // ---------- 宿主回调 ----------
  function onRenderAll() {
    if (!H) return
    if (H.S.view === 'table') render()
  }
  function onView() {
    if (!H) return
    ensureCurrentDoc()
    render()
    checkMissing()
  }
  function onDocDeleted(id) {
    if (!H) return
    H.P.cellCodes = (H.P.cellCodes || []).filter(function (cc) {
      return cc.table !== id
    })
    delete cache[id]
    delete loading[id]
    delete warned[id]
    H.IDB.del(keyOf(id))
    if (ui.docId === id) ui.docId = ''
    saveUI()
  }
  function onClearAll() {
    Object.keys(cache).forEach(function (k) {
      H.IDB.del(keyOf(k))
    })
    cache = {}
    loading = {}
    warned = {}
    ui.docId = ''
    ui.col = ''
    ui.round = 1
    ui.filter = 'all'
    ui.code = 'all'
    ui.q = ''
    ui.page = 0
    ui.focus = false
    ui.row = 0
    saveUI()
    closePop()
  }

  function init() {
    H = window.ZenTableHost
    if (!H) return
    loadUI()
    buildPop()
    bindGlobal()
  }

  ZT.init = init
  ZT.render = render
  ZT.onRenderAll = onRenderAll
  ZT.onView = onView
  ZT.onDocDeleted = onDocDeleted
  ZT.onClearAll = onClearAll
  ZT.importCsvFiles = importCsvFiles
  ZT.hasTableDocs = hasTableDocs
  ZT.getData = getData
  ZT.ui = ui
  ZT.isActive = function () {
    return !!(H && H.S.view === 'table')
  }
  ZT.exportCsv = exportCsv

  window.ZenTable = ZT
})()
