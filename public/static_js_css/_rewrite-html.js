'use strict'
/*
 * Rewrites every CDN reference in the 11 omm-*.html / h5-news.html files so they
 * load from static_js_css/ instead of the network.
 *
 * Safety model:
 *  1. Every pattern is verified to match EXACTLY ONCE in its target file.
 *  2. If any pattern is missing / duplicated, nothing is written at all.
 *  3. After rewriting we re-scan for any residual CDN hostname.
 *  4. UTF-8 in, UTF-8 out (no BOM), CRLF preserved byte-for-byte elsewhere.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const S = 'static_js_css'
const CRLF = '\r\n'

/* ------------------------------------------------------------------ blocks */
const GF_A_OLD = [
  '    <link',
  '      href="https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,300;0,7..72,400;0,7..72,500;0,7..72,700;1,7..72,400&display=swap"',
  '      rel="stylesheet"',
  '    />',
  '',
].join(CRLF)
const GF_A_NEW = `    <link rel="stylesheet" href="${S}/fonts/literata-a.css" />${CRLF}`

const GF_B_OLD = [
  '    <link',
  '      href="https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,300;0,7..72,400;0,7..72,500;0,7..72,600;0,7..72,700;1,7..72,400&display=swap"',
  '      rel="stylesheet"',
  '    />',
  '',
].join(CRLF)
const GF_B_NEW = `    <link rel="stylesheet" href="${S}/fonts/literata-b.css" />${CRLF}`

const IMP_C_OLD =
  "      @import url('https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,500;0,7..72,600;1,7..72,400&display=swap');"
const IMP_C_NEW = `      @import url('${S}/fonts/literata-c.css');`

// omm-corpus.html requested opsz "1,0..72,400". Google answers HTTP 400 for that,
// so this page has never actually received the italic face. We point it at the
// valid local set instead (a strict superset of what it asked for).
const IMP_D_OLD =
  "      @import url('https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,500;0,7..72,600;1,0..72,400&display=swap');"
const IMP_D_NEW = `      @import url('${S}/fonts/literata-d.css');`

const H5_FONT_OLD = [
  '    <link',
  '      href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;500;600;700;900&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Inter:wght@300;400;500;600;700&display=swap"',
  '      rel="stylesheet"',
  '    />',
  '',
].join(CRLF)
const H5_FONT_NEW = `    <link rel="stylesheet" href="${S}/fonts/h5news.css" />${CRLF}`

// crossorigin="anonymous" is dropped: it existed for the cross-origin CDN and
// is meaningless (and potentially noisy) for same-origin local files.
const H5_SCRIPT_OLD = [
  '    <script',
  '      src="https://cdn.jsdmirror.com/npm/chart.js@4.4.0/dist/chart.umd.min.js"',
  '      crossorigin="anonymous"',
  '    ></script>',
  '    <script',
  '      src="https://cdn.jsdmirror.com/npm/hydrogen-js-sdk/dist/Bmob-latest.min.js"',
  '      crossorigin="anonymous"',
  '    ></script>',
  '',
].join(CRLF)
const H5_SCRIPT_NEW =
  `    <script src="${S}/vendor/chart.js/4.4.0/chart.umd.min.js"></script>${CRLF}` +
  `    <script src="${S}/vendor/hydrogen-js-sdk/Bmob-latest.min.js"></script>${CRLF}`

const ANNOTATE_SRC_OLD = [
  '        var PDFJS_SOURCES = [',
  '          {',
  "            lib: 'https://cdn.jsdmirror.com/npm/pdfjs-dist@3.11.174/build/pdf.min.js',",
  "            worker: 'https://cdn.jsdmirror.com/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',",
  "            cmap: 'https://cdn.jsdmirror.com/npm/pdfjs-dist@3.11.174/cmaps/',",
  '          },',
  '          {',
  "            lib: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',",
  "            worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',",
  "            cmap: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',",
  '          },',
  '          {',
  "            lib: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',",
  "            worker: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js',",
  "            cmap: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',",
  '          },',
  '        ]',
  '',
].join(CRLF)

const ANNOTATE_SRC_NEW =
  [
    '        // 离线本地版：原先是 jsdmirror / jsDelivr / unpkg 三级 CDN 回退，',
    '        // 现在只保留本地副本，断网也能直接用。',
    '        var PDFJS_SOURCES = [',
    '          {',
    `            lib: '${S}/vendor/pdfjs-dist/3.11.174/build/pdf.min.js',`,
    `            worker: '${S}/vendor/pdfjs-dist/3.11.174/build/pdf.worker.min.js',`,
    `            cmap: '${S}/vendor/pdfjs-dist/3.11.174/cmaps/',`,
    '          },',
    '        ]',
    '',
  ].join(CRLF)

const MUPDF_OLD = [
  '          var urls = [',
  "            'https://cdn.jsdmirror.com/npm/mupdf@1.28.1/+esm',",
  "            'https://unpkg.com/mupdf@1.28.1/dist/mupdf.js',",
  "            'https://esm.sh/mupdf@1.28.1',",
  '          ]',
].join(CRLF)

const MUPDF_NEW = [
  '          // 离线本地引擎：与 static_js_css/vendor/mupdf/1.28.1/ 同源',
  '          // （mupdf.esm.js 内的 wasm 路径已改为相对路径，无需联网取 .wasm）',
  '          var urls = [',
  `            '${S}/vendor/mupdf/1.28.1/mupdf.esm.js',`,
  '          ]',
].join(CRLF)

/* -------------------------------------------------------------- utilities */
const scriptSrc = (remote) => `<script src="${remote}"></script>`
const localScript = (rel) => `<script src="${S}/${rel}"></script>`

// Several pages lazily inject the Supabase browser SDK from a JS constant
// (assigned to a dynamically created <script>.src) rather than a <script src>
// tag, so a tag-only scan misses it.
const SUPABASE_CDN_OLD = "var SUPABASE_CDN = 'https://cdn.jsdmirror.com/npm/@supabase/supabase-js@2',"
const SUPABASE_CDN_NEW = `var SUPABASE_CDN = '${S}/vendor/supabase-js/2/supabase.min.js',`

/* ------------------------------------------------------------ the manifest */
const RULES = [
  // ---- omm-planner.html : 2
  ['omm-planner.html', GF_A_OLD, GF_A_NEW],
  ['omm-planner.html', scriptSrc('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'), localScript('vendor/html2canvas/1.4.1/html2canvas.min.js')],
  ['omm-planner.html', SUPABASE_CDN_OLD, SUPABASE_CDN_NEW],

  // ---- omm-data.html : 1
  ['omm-data.html', GF_A_OLD, GF_A_NEW],
  ['omm-data.html', SUPABASE_CDN_OLD, SUPABASE_CDN_NEW],

  // ---- omm-latex.html : 3
  ['omm-latex.html', GF_B_OLD, GF_B_NEW],
  ['omm-latex.html', scriptSrc('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js'), localScript('vendor/pdfjs-dist/3.11.174/build/pdf.min.js')],
  ['omm-latex.html',
    "          pdfjsLib.GlobalWorkerOptions.workerSrc =" + CRLF + "            'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'",
    "          pdfjsLib.GlobalWorkerOptions.workerSrc =" + CRLF + `            '${S}/vendor/pdfjs-dist/3.11.174/build/pdf.worker.min.js'`],

  // ---- omm-redact.html : 11
  ['omm-redact.html', scriptSrc('https://cdn.jsdmirror.com/npm/pdfjs-dist@3.11.174/build/pdf.min.js'), localScript('vendor/pdfjs-dist/3.11.174/build/pdf.min.js')],
  ['omm-redact.html', scriptSrc('https://cdn.jsdmirror.com/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'), localScript('vendor/pdf-lib/1.17.1/pdf-lib.min.js')],
  ['omm-redact.html', scriptSrc('https://cdn.jsdmirror.com/npm/jszip@3.10.1/dist/jszip.min.js'), localScript('vendor/jszip/3.10.1/jszip.min.js')],
  ['omm-redact.html', scriptSrc('https://cdn.jsdmirror.com/npm/chart.js@4.4.1/dist/chart.umd.min.js'), localScript('vendor/chart.js/4.4.1/chart.umd.min.js')],
  ['omm-redact.html', scriptSrc('https://cdn.jsdmirror.com/npm/pptxviewjs@1.1.9/dist/PptxViewJS.min.js'), localScript('vendor/pptxviewjs/1.1.9/PptxViewJS.min.js')],
  ['omm-redact.html', scriptSrc('https://cdn.jsdmirror.com/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'), localScript('vendor/jspdf/2.5.1/jspdf.umd.min.js')],
  ['omm-redact.html', scriptSrc('https://cdn.jsdmirror.com/npm/mammoth@1.6.0/mammoth.browser.min.js'), localScript('vendor/mammoth/1.6.0/mammoth.browser.min.js')],
  ['omm-redact.html', scriptSrc('https://cdn.jsdmirror.com/npm/html2canvas@1.4.1/dist/html2canvas.min.js'), localScript('vendor/html2canvas/1.4.1/html2canvas.min.js')],
  ['omm-redact.html', IMP_C_OLD, IMP_C_NEW],
  ['omm-redact.html',
    "              pdfjsLib.GlobalWorkerOptions.workerSrc =" + CRLF + "                'https://cdn.jsdmirror.com/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'",
    "              pdfjsLib.GlobalWorkerOptions.workerSrc =" + CRLF + `                '${S}/vendor/pdfjs-dist/3.11.174/build/pdf.worker.min.js'`],
  ['omm-redact.html', MUPDF_OLD, MUPDF_NEW],

  // ---- omm-writer.html : 4
  ['omm-writer.html', scriptSrc('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'), localScript('vendor/html2canvas/1.4.1/html2canvas.min.js')],
  ['omm-writer.html', scriptSrc('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'), localScript('vendor/jspdf/2.5.1/jspdf.umd.min.js')],
  ['omm-writer.html', `<script async src="https://cdn.jsdmirror.com/npm/mathjax@3/es5/tex-svg.js"></script>`, `<script async src="${S}/vendor/mathjax/3.2.2/es5/tex-svg.js"></script>`],
  ['omm-writer.html', IMP_C_OLD, IMP_C_NEW],
  ['omm-writer.html', SUPABASE_CDN_OLD, SUPABASE_CDN_NEW],

  // ---- omm-english.html : 1
  ['omm-english.html', IMP_C_OLD, IMP_C_NEW],
  ['omm-english.html', SUPABASE_CDN_OLD, SUPABASE_CDN_NEW],

  // ---- omm-message.html : 2
  ['omm-message.html', IMP_C_OLD, IMP_C_NEW],
  ['omm-message.html', "        const CDN = 'https://cdn.jsdmirror.com/npm/@supabase/supabase-js@2'", `        const CDN = '${S}/vendor/supabase-js/2/supabase.min.js'`],

  // ---- omm-annotate.html : 2
  ['omm-annotate.html', GF_A_OLD, GF_A_NEW],
  ['omm-annotate.html', ANNOTATE_SRC_OLD, ANNOTATE_SRC_NEW],
  ['omm-annotate.html', SUPABASE_CDN_OLD, SUPABASE_CDN_NEW],

  // ---- omm-corpus.html : 1
  ['omm-corpus.html', IMP_D_OLD, IMP_D_NEW],
  ['omm-corpus.html', SUPABASE_CDN_OLD, SUPABASE_CDN_NEW],

  // ---- h5-news.html : 2
  ['h5-news.html', H5_FONT_OLD, H5_FONT_NEW],
  ['h5-news.html', H5_SCRIPT_OLD, H5_SCRIPT_NEW],

  // ---- omm-visualization.html : 7
  ['omm-visualization.html', GF_B_OLD, GF_B_NEW],
  ['omm-visualization.html', scriptSrc('https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js'), localScript('vendor/chart.js/4.5.1/chart.umd.min.js')],
  ['omm-visualization.html', scriptSrc('https://cdn.jsdelivr.net/npm/apexcharts@7.4.0/dist/apexcharts.min.js'), localScript('vendor/apexcharts/7.4.0/apexcharts.min.js')],
  ['omm-visualization.html', scriptSrc('https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js'), localScript('vendor/echarts/6.1.0/echarts.min.js')],
  ['omm-visualization.html', scriptSrc('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'), localScript('vendor/xlsx/0.20.3/xlsx.full.min.js')],
  ['omm-visualization.html', scriptSrc('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'), localScript('vendor/html2canvas/1.4.1/html2canvas.min.js')],
  ['omm-visualization.html', scriptSrc('https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js'), localScript('vendor/jspdf/4.2.1/jspdf.umd.min.js')],
]

/* ------------------------------------------------------------------- apply */
const files = [...new Set(RULES.map((r) => r[0]))]
const text = new Map()
for (const f of files) text.set(f, fs.readFileSync(path.join(ROOT, f), 'utf8'))

// --- phase 1: strict pre-flight (nothing is written yet) ---------------------
// Idempotent: a rule whose search pattern is already gone but whose
// replacement is already present counts as "applied on a previous run".
const problems = []
const pending = []
for (const [file, oldStr, newStr] of RULES) {
  if (typeof oldStr !== 'string' || oldStr.length === 0) {
    problems.push(`${file}: empty/invalid search pattern`)
    continue
  }
  if (typeof newStr !== 'string' || newStr.length === 0) {
    problems.push(`${file}: empty replacement for -> ${oldStr.slice(0, 60)}`)
    continue
  }
  const t = text.get(file)
  const n = t.split(oldStr).length - 1
  if (n === 1) {
    pending.push([file, oldStr, newStr])
  } else if (n === 0) {
    const already = t.split(newStr).length - 1
    if (already >= 1) continue // already rewritten, nothing to do
    problems.push(`${file}: pattern not found and replacement not present  ::  ${oldStr.split('\n')[0].trim().slice(0, 90)}`)
  } else {
    problems.push(`${file}: expected exactly 1 match, found ${n}  ::  ${oldStr.split('\n')[0].trim().slice(0, 90)}`)
  }
}
if (problems.length) {
  console.error(`PRE-FLIGHT FAILED (${problems.length} problem(s)) - NO files written\n`)
  problems.forEach((p) => console.error('  ' + p))
  process.exit(1)
}
console.log(`pre-flight OK: ${RULES.length} rules total, ${pending.length} still to apply\n`)

// --- phase 2: rewrite in memory ---------------------------------------------
const before = new Map(files.map((f) => [f, fs.statSync(path.join(ROOT, f)).size]))
for (const [file, oldStr, newStr] of pending) {
  text.set(file, text.get(file).split(oldStr).join(newStr))
}

// --- phase 3: residual-CDN scan ---------------------------------------------
const CDN_HOSTS = /cdn\.jsdelivr\.net|cdn\.jsdmirror\.com|cdnjs\.cloudflare\.com|cdn\.sheetjs\.com|unpkg\.com|esm\.sh|fonts\.googleapis\.com|fonts\.gstatic\.com/g
let dirty = 0
for (const f of files) {
  const hits = [...new Set(text.get(f).match(CDN_HOSTS) || [])]
  if (hits.length) {
    dirty++
    console.log(`  [${f}] residual CDN host(s): ${hits.join(', ')}`)
  }
}

// --- phase 4: commit ----------------------------------------------------------
console.log('')
for (const f of files) {
  const p = path.join(ROOT, f)
  fs.writeFileSync(p, text.get(f), 'utf8') // utf8, no BOM
  const after = fs.statSync(p).size
  console.log(`${f.padEnd(24)} ${before.get(f).toLocaleString().padStart(9)} -> ${after.toLocaleString().padStart(9)} bytes`)
}
console.log(`\n=== done: ${pending.length} replacements applied, ${RULES.length} rules total, ${dirty} file(s) with residual CDN hosts ===`)
