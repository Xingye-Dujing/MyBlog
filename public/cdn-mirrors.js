/*!
 * cdn-mirrors.js —— 第三方 CDN 多源回退加载器
 *
 * 背景：这批页面（omm-*.html / h5-news.html）依赖十来个第三方库。过去每个库只有
 * 一个 CDN 链接，任何一个源被墙、抽风、限流或改路径，整页功能就废掉。
 * 这里给每个库配多个镜像，加载失败时自动换下一个。
 *
 * 设计要点：
 *  1. **不改变正常路径的行为**。原来的 <script src> 标签原样保留为主源，仍然是
 *     解析器阻塞、按顺序执行；只有它真的失败（404 / DNS / CSP / 断网）才会回退。
 *  2. **回退时仍然阻塞解析**。用 onerror + document.write 续写下一个 <script>，
 *     因此「同步、按序」的语义不变 —— 页面里那些在顶层就用 pdfjsLib / Chart 的代码
 *     不会因为改成异步加载而炸掉。
 *  3. 镜像表集中在本文件，换源/加源只改这一处。
 *
 * 用法：
 *   <script src="cdn-mirrors.js"></script>
 *   <script src="主源" onerror="CDNM.scriptFallback(this,'key')"></script>
 */
;(function (global) {
  'use strict'

  /* ------------------------------------------------------------------ *
   * 镜像表
   * 每项都是「已实测返回正确内容」的完整 URL 列表，顺序 = 优先级。
   * 探活脚本：见本文件末尾注释（node .workbuddy/cdn-mirrors/）。
   * ------------------------------------------------------------------ */
  var CDNJS = 'https://cdnjs.cloudflare.com/ajax/libs/'
  var NPMS = 'https://cdn.jsdmirror.com/npm/'
  var JSD = 'https://cdn.jsdelivr.net/npm/'
  var UNPKG = 'https://unpkg.com/'
  var NPMM = 'https://registry.npmmirror.com/'

  /** 5 个 Google Fonts CSS 镜像（字体文件随 CSS 内部指向各自的 gstatic 等价域） */
  var FONT_HOSTS = [
    'https://fonts.googleapis.com/css2?',
    'https://fonts.googleapis.cn/css2?',
    'https://fonts.loli.net/css2?',
    'https://fonts.font.im/css2?',
    'https://fonts.geekzu.org/css2?',
  ]
  function fonts(query) {
    return FONT_HOSTS.map(function (h) {
      return h + query
    })
  }

  var Q_FULL =
    'family=Literata:ital,opsz,wght@0,7..72,300;0,7..72,400;0,7..72,500;0,7..72,600;0,7..72,700;1,7..72,400&display=swap'
  var Q_SUB =
    'family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,500;0,7..72,600;1,7..72,400&display=swap'
  var Q_ALT =
    'family=Literata:ital,opsz,wght@0,7..72,300;0,7..72,400;0,7..72,500;0,7..72,700;1,7..72,400&display=swap'
  var Q_H5 =
    'family=Noto+Serif+SC:wght@400;500;600;700;900&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Inter:wght@300;400;500;600;700&display=swap'

  var MIRRORS = {
    /* ---------- 截图 / 导出 ---------- */
    html2canvas: [
      CDNJS + 'html2canvas/1.4.1/html2canvas.min.js',
      JSD + 'html2canvas@1.4.1/dist/html2canvas.min.js',
      NPMS + 'html2canvas@1.4.1/dist/html2canvas.min.js',
      UNPKG + 'html2canvas@1.4.1/dist/html2canvas.min.js',
      NPMM + 'html2canvas/1.4.1/files/dist/html2canvas.min.js',
    ],
    // writer/redact 原先用 cdnjs 版，visualization 用 jsdmirror 版，内容一致
    jspdf251: [
      CDNJS + 'jspdf/2.5.1/jspdf.umd.min.js',
      JSD + 'jspdf@2.5.1/dist/jspdf.umd.min.js',
      NPMS + 'jspdf@2.5.1/dist/jspdf.umd.min.js',
      UNPKG + 'jspdf@2.5.1/dist/jspdf.umd.min.js',
      NPMM + 'jspdf/2.5.1/files/dist/jspdf.umd.min.js',
    ],
    jspdf421: [
      JSD + 'jspdf@4.2.1/dist/jspdf.umd.min.js',
      NPMS + 'jspdf@4.2.1/dist/jspdf.umd.min.js',
      UNPKG + 'jspdf@4.2.1/dist/jspdf.umd.min.js',
      NPMM + 'jspdf/4.2.1/files/dist/jspdf.umd.min.js',
    ],

    /* ---------- PDF ---------- */
    pdfjsLib: [
      NPMS + 'pdfjs-dist@3.11.174/build/pdf.min.js',
      JSD + 'pdfjs-dist@3.11.174/build/pdf.min.js',
      'https://fastly.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
      UNPKG + 'pdfjs-dist@3.11.174/build/pdf.min.js',
      NPMM + 'pdfjs-dist/3.11.174/files/build/pdf.min.js',
    ],
    pdfjsWorker: [
      NPMS + 'pdfjs-dist@3.11.174/build/pdf.worker.min.js',
      JSD + 'pdfjs-dist@3.11.174/build/pdf.worker.min.js',
      'https://fastly.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
      UNPKG + 'pdfjs-dist@3.11.174/build/pdf.worker.min.js',
      NPMM + 'pdfjs-dist/3.11.174/files/build/pdf.worker.min.js',
    ],
    // cmaps / standard_fonts 是 pdf.js 按需 fetch 的目录，作为基址使用
    pdfjsCmap: [
      NPMS + 'pdfjs-dist@3.11.174/cmaps/',
      JSD + 'pdfjs-dist@3.11.174/cmaps/',
      'https://fastly.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
      UNPKG + 'pdfjs-dist@3.11.174/cmaps/',
      NPMM + 'pdfjs-dist/3.11.174/files/cmaps/',
    ],
    pdfjsStdFont: [
      NPMS + 'pdfjs-dist@3.11.174/standard_fonts/',
      JSD + 'pdfjs-dist@3.11.174/standard_fonts/',
      UNPKG + 'pdfjs-dist@3.11.174/standard_fonts/',
      NPMM + 'pdfjs-dist/3.11.174/files/standard_fonts/',
    ],
    pdfLib: [
      NPMS + 'pdf-lib@1.17.1/dist/pdf-lib.min.js',
      JSD + 'pdf-lib@1.17.1/dist/pdf-lib.min.js',
      UNPKG + 'pdf-lib@1.17.1/dist/pdf-lib.min.js',
      NPMM + 'pdf-lib/1.17.1/files/dist/pdf-lib.min.js',
    ],
    // MuPDF 是 ESM，且 dist/mupdf.js 会 import 同目录的 mupdf-wasm.js
    //（后者再用 import.meta.url 定位 mupdf-wasm.wasm），所以基址粒度到包根目录。
    mupdf: [
      NPMS + 'mupdf@1.28.1/dist/',
      JSD + 'mupdf@1.28.1/dist/',
      'https://fastly.jsdelivr.net/npm/mupdf@1.28.1/dist/',
      UNPKG + 'mupdf@1.28.1/dist/',
    ],
    mupdfEsm: [
      NPMS + 'mupdf@1.28.1/+esm',
      'https://esm.sh/mupdf@1.28.1',
    ],

    /* ---------- 文档 ---------- */
    jszip: [
      NPMS + 'jszip@3.10.1/dist/jszip.min.js',
      JSD + 'jszip@3.10.1/dist/jszip.min.js',
      UNPKG + 'jszip@3.10.1/dist/jszip.min.js',
      NPMM + 'jszip/3.10.1/files/dist/jszip.min.js',
    ],
    // npmmirror 对该包 403，只保留 3 个源
    pptxviewjs: [
      NPMS + 'pptxviewjs@1.1.9/dist/PptxViewJS.min.js',
      JSD + 'pptxviewjs@1.1.9/dist/PptxViewJS.min.js',
      UNPKG + 'pptxviewjs@1.1.9/dist/PptxViewJS.min.js',
    ],
    mammoth: [
      NPMS + 'mammoth@1.6.0/mammoth.browser.min.js',
      JSD + 'mammoth@1.6.0/mammoth.browser.min.js',
      UNPKG + 'mammoth@1.6.0/mammoth.browser.min.js',
      NPMM + 'mammoth/1.6.0/files/mammoth.browser.min.js',
    ],

    /* ---------- 图表 ---------- */
    // 注意：chart.js 4.4.x 的包里**没有** chart.umd.min.js（4.5 才加），
    // jsdelivr 系是按需即时压缩才 200 的；unpkg / npmmirror 只能给未压缩的 chart.umd.js。
    chart440: [
      NPMS + 'chart.js@4.4.0/dist/chart.umd.min.js',
      JSD + 'chart.js@4.4.0/dist/chart.umd.min.js',
      UNPKG + 'chart.js@4.4.0/dist/chart.umd.js',
      NPMM + 'chart.js/4.4.0/files/dist/chart.umd.js',
    ],
    chart441: [
      NPMS + 'chart.js@4.4.1/dist/chart.umd.min.js',
      JSD + 'chart.js@4.4.1/dist/chart.umd.min.js',
      UNPKG + 'chart.js@4.4.1/dist/chart.umd.js',
      NPMM + 'chart.js/4.4.1/files/dist/chart.umd.js',
    ],
    chart451: [
      JSD + 'chart.js@4.5.1/dist/chart.umd.min.js',
      NPMS + 'chart.js@4.5.1/dist/chart.umd.min.js',
      UNPKG + 'chart.js@4.5.1/dist/chart.umd.min.js',
      NPMM + 'chart.js/4.5.1/files/dist/chart.umd.min.js',
    ],
    // npmmirror 对 apexcharts 403
    apexcharts: [
      JSD + 'apexcharts@7.4.0/dist/apexcharts.min.js',
      NPMS + 'apexcharts@7.4.0/dist/apexcharts.min.js',
      UNPKG + 'apexcharts@7.4.0/dist/apexcharts.min.js',
    ],
    echarts: [
      JSD + 'echarts@6.1.0/dist/echarts.min.js',
      NPMS + 'echarts@6.1.0/dist/echarts.min.js',
      UNPKG + 'echarts@6.1.0/dist/echarts.min.js',
      NPMM + 'echarts/6.1.0/files/dist/echarts.min.js',
    ],

    /* ---------- 表格 ---------- */
    // SheetJS 自 0.19 起不再往 npm 发包，0.20.3 只存在于官方 CDN，无同版本镜像。
    // 这里只列唯一可用源；不要为了「凑数」塞 0.18.x，那会静默降级。
    xlsx0203: ['https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'],

    /* ---------- 公式 ---------- */
    mathjax: [
      NPMS + 'mathjax@3/es5/tex-svg.js',
      JSD + 'mathjax@3/es5/tex-svg.js',
      UNPKG + 'mathjax@3/es5/tex-svg.js',
      NPMM + 'mathjax/3.2.2/files/es5/tex-svg.js',
    ],

    /* ---------- SDK ---------- */
    // 原来的裸 URL（@supabase/supabase-js@2）由 CDN 解析到 dist/umd/supabase.js，
    // 这里显式写出该路径，避免镜像的默认入口解析规则不同。
    supabase: [
      NPMS + '@supabase/supabase-js@2/dist/umd/supabase.js',
      JSD + '@supabase/supabase-js@2/dist/umd/supabase.js',
      UNPKG + '@supabase/supabase-js@2/dist/umd/supabase.js',
    ],
    bmob: [
      // 原主源是「不带版本」的 URL，会跟着 latest 漂移；保留它当首选以维持原有行为，
      // 回退时改用固定版本，避免上游发新版把接口改坏。
      NPMS + 'hydrogen-js-sdk/dist/Bmob-latest.min.js',
      NPMS + 'hydrogen-js-sdk@3.0.2/dist/Bmob-latest.min.js',
      JSD + 'hydrogen-js-sdk@3.0.2/dist/Bmob-latest.min.js',
      UNPKG + 'hydrogen-js-sdk@3.0.2/dist/Bmob-latest.min.js',
    ],

    /* ---------- 字体 ---------- */
    fontLiterataFull: fonts(Q_FULL),
    fontLiterataSub: fonts(Q_SUB),
    fontLiterataAlt: fonts(Q_ALT),
    // omm-corpus.html 原本那条链接的斜体元组写成 opsz 0..72，超出 Literata 下界，
    // Google 一直返回 400 —— 线上从来没生效过。统一指到等价的 fontLiterataSub。
    fontLiterataCorpus: fonts(Q_SUB),
    fontH5News: fonts(Q_H5),
  }

  /* ------------------------------------------------------------------ */

  function warn(key, url) {
    if (global.console && console.warn) {
      console.warn('[CDNM] ' + key + ' 所有镜像均失败，最后尝试：' + (url || '(无)'))
    }
  }

  function list(key) {
    return (MIRRORS[key] || []).slice()
  }

  /** 记录已尝试过的 url，跨 document.write 生成的元素传递下去，避免来回打转 */
  function readTried(el) {
    var raw = el.getAttribute('data-cdnm-tried')
    if (!raw) return []
    try {
      return raw
        .split('|')
        .filter(Boolean)
        .map(decodeURIComponent)
    } catch (e) {
      return []
    }
  }
  function writeTried(el, seen) {
    el.setAttribute('data-cdnm-tried', seen.map(encodeURIComponent).join('|'))
  }

  /**
   * 从镜像表里挑下一个「还没试过」的源。
   * 不依赖当前 url 在表中的位置：各页面原本的主源优先级并不一致
   * （pdf.js 有页面用 jsdelivr、有页面用 jsdmirror），所以这里统一按表内优先级
   * 顺扫，已试过的跳过。
   */
  function pickNext(key, seen) {
    var arr = MIRRORS[key] || []
    for (var i = 0; i < arr.length; i++) {
      if (seen.indexOf(arr[i]) === -1) return arr[i]
    }
    return null
  }

  /** 非解析期（动态插入的脚本）没有 document.write可用，改为直接建元素注入 */
  function injectAsync(tag, key, url, triedAttr) {
    var el = document.createElement(tag)
    el.setAttribute('data-cdnm-tried', triedAttr)
    if (tag === 'script') {
      el.src = url
      el.async = false
      el.onerror = function () {
        scriptFallback(el, key)
      }
    } else {
      el.rel = 'stylesheet'
      el.href = url
      el.onerror = function () {
        linkFallback(el, key)
      }
    }
    document.head.appendChild(el)
    return el
  }

  /**
   * <script onerror> 处理器。
   * 解析阶段的 <script> 加载失败后，直接改 src 不会重新触发加载（元素已 fire），
   * 所以用 document.write 就地续写下一个标签 —— 解析器依然阻塞、依然按序，
   * 因此页面里顶层就用 pdfjsLib / Chart 的代码不会因为改成异步而失效。
   */
  function scriptFallback(el, key) {
    var cur = el.getAttribute('src')
    var seen = readTried(el)
    if (cur && seen.indexOf(cur) === -1) seen.push(cur)
    var next = pickNext(key, seen)
    if (!next) {
      warn(key, cur)
      return false
    }
    if (global.console && console.warn) {
      console.warn('[CDNM] ' + key + ' 加载失败，回退到 ' + next)
    }
    seen.push(next)
    var tried = seen.map(encodeURIComponent).join('|')
    // 已离开解析阶段：退化成异步注入，避免 document.write 抹掉整个文档
    if (document.readyState !== 'loading') {
      injectAsync('script', key, next, tried)
      return true
    }
    document.write(
      '<script src="' + next + '" data-cdnm-tried="' + tried + '" onerror="CDNM.scriptFallback(this,\'' + key + '\')"><\/script>'
    )
    return true
  }

  /** <link rel=stylesheet onerror> 处理器，逻辑同上 */
  function linkFallback(el, key) {
    var cur = el.getAttribute('href')
    var seen = readTried(el)
    if (cur && seen.indexOf(cur) === -1) seen.push(cur)
    var next = pickNext(key, seen)
    if (!next) {
      warn(key, cur)
      return false
    }
    if (global.console && console.warn) {
      console.warn('[CDNM] ' + key + ' 加载失败，回退到 ' + next)
    }
    seen.push(next)
    var tried = seen.map(encodeURIComponent).join('|')
    if (document.readyState !== 'loading') {
      injectAsync('link', key, next, tried)
      return true
    }
    document.write(
      '<link rel="stylesheet" href="' + next + '" data-cdnm-tried="' + tried + '" onerror="CDNM.linkFallback(this,\'' + key + '\')">'
    )
    return true
  }

  /**
   * 给「动态创建、还没设 src」的 <script> 装上多源回退。
   * 元素是动态插入的，改 src 可以正常重新加载，所以直接切 src 即可。
   * 用于 supabase ensureLib() 那种 s.src = XXX; s.onerror = ... 的写法。
   */
  function loadScriptInto(el, key) {
    var arr = MIRRORS[key] || []
    if (!arr.length) return false
    el.src = arr[0]
    var prevOnError = el.onerror
    var seen = [arr[0]]
    el.onerror = function () {
      var next = pickNext(key, seen)
      if (!next) {
        warn(key, seen[seen.length - 1])
        if (prevOnError) prevOnError.call(el)
        return
      }
      if (global.console && console.warn) {
        console.warn('[CDNM] ' + key + ' 加载失败，回退到 ' + next)
      }
      seen.push(next)
      el.src = next // 动态插入的元素改 src 可以正常重新加载
    }
    return true
  }

  /**
   * 给 pdf.js 这类「只接受单个 URL、且由库内部自己去 fetch」的字段挑一个可用源。
   * 立刻用主源顶上（保证同步可用），再并发探活其它镜像，探到更好的就换。
   * pdf.js 是懒加载 worker 的，通常在探测返回前就已经开始读文档，因此两边都能兜住。
   */
  function pickUrl(key, setter) {
    var arr = MIRRORS[key] || []
    if (!arr.length) return Promise.resolve(null)
    setter(arr[0])
    if (arr.length === 1 || typeof fetch !== 'function') return Promise.resolve(arr[0])

    // 按优先级依次探活，第一个成功的即采用
    return arr
      .slice(1)
      .reduce(function (chain, url) {
        return chain.then(function (found) {
          if (found) return found
          return fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1' } })
            .then(function (r) {
              return r && (r.ok || r.status === 206) ? url : null
            })
            .catch(function () {
              return null
            })
        })
      }, Promise.resolve(null))
      .then(function (found) {
        if (found && found !== arr[0]) {
          if (global.console && console.log) console.log('[CDNM] ' + key + ' 改用 ' + found)
          setter(found)
        }
        return found || arr[0]
      })
  }

  /** 把 lib / worker / cmap 三组等长镜像拼成 annotate 需要的 {lib,worker,cmap} 数组 */
  function zip(libKey, workerKey, cmapKey) {
    var libs = MIRRORS[libKey] || []
    var workers = MIRRORS[workerKey] || []
    var cmaps = MIRRORS[cmapKey] || []
    var n = Math.max(libs.length, workers.length)
    var out = []
    for (var i = 0; i < n; i++) {
      out.push({ lib: libs[i], worker: workers[i], cmap: cmaps[i] })
    }
    return out
  }

  global.CDNM = {
    mirrors: list,
    scriptFallback: scriptFallback,
    linkFallback: linkFallback,
    loadScriptInto: loadScriptInto,
    pickUrl: pickUrl,
    zip: zip,
    _table: MIRRORS,
  }
})(window)
