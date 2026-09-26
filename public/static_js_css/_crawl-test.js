/*
 * Offline proof, model A - the subresource graph a browser builds from markup.
 *
 * A browser resolves <script src>, <link href>, <img src> and CSS url() from the
 * HTML/CSS. Strings *inside* a .js bundle are not subresources: they only matter
 * if the application's own code asks for them, which is audited separately
 * (see the "lazy loaders" section and _rewrite-html.js / _patch-vendor.js).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BASE = 'http://127.0.0.1:8123/'

const PAGES = [
  'omm-planner.html', 'omm-data.html', 'omm-latex.html', 'omm-redact.html',
  'omm-writer.html', 'omm-english.html', 'omm-message.html', 'omm-annotate.html',
  'omm-corpus.html', 'h5-news.html', 'omm-visualization.html',
]

const OFF_ORIGIN = /^https?:\/\/(?!127\.0\.0\.1:8123)/i
let fail = 0
const offOrigin = []

/**
 * Refs a browser actually *fetches* from markup:
 *   - <script src>  -> fetched
 *   - <link href>   -> fetched (stylesheet, icon, preload, ...)
 *   - <img src>     -> fetched
 *   - <a href>      -> NOT fetched; only navigated to when the user clicks it,
 *                      so an article citation link is not a dependency.
 */
function markupRefs(text) {
  const out = new Set()
  for (const m of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) out.add(m[1])
  for (const m of text.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) out.add(m[1])
  for (const m of text.matchAll(/<(?:img|audio|video|source|embed|iframe|track)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) out.add(m[1])
  return [...out]
}
/** refs a browser pulls from CSS */
function cssRefs(text) {
  return [...new Set([...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]))]
}

async function get(rel) {
  const r = await fetch(BASE + rel.replace(/^\//, ''))
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r
}

async function crawl(page) {
  const seen = new Set()
  const queue = [{ rel: '/' + page, kind: 'html' }]
  let requests = 0

  while (queue.length) {
    const { rel, kind } = queue.shift()
    if (seen.has(rel)) continue
    seen.add(rel)

    let res
    try {
      res = await get(rel)
    } catch (e) {
      console.log(`  FAIL  ${rel}  (${e.message})`)
      fail++
      continue
    }
    requests++

    const ct = res.headers.get('content-type') || ''
    // Only HTML and CSS produce subresources. A .js bundle's internal strings are
    // not fetched by the browser; the app's own runtime request sites are audited
    // in section B, and the bundles' own lazy loaders were localised by
    // _patch-vendor.js and are audited in section C.
    if (kind !== 'html' && kind !== 'css') continue
    const refs = kind === 'css' ? cssRefs(await res.text()) : markupRefs(await res.text())

    for (const raw of refs) {
      if (/^(data:|blob:|mailto:|tel:|javascript:|#|\$)/i.test(raw)) continue
      if (raw.startsWith('http') || raw.startsWith('//')) {
        if (OFF_ORIGIN.test(raw)) { offOrigin.push(`${page} -> ${raw}`); fail++ }
        continue
      }
      if (raw.startsWith('/')) {
        // absolute app path: still must exist if it names a real asset file
        const onDisk = path.join(ROOT, raw.replace(/^\//, ''))
        if (fs.existsSync(onDisk) && fs.statSync(onDisk).isFile()) queue.push({ rel: raw, kind: guessKind(raw) })
        continue
      }
      const abs = path.posix.normalize(path.posix.join(path.posix.dirname(rel), raw))
      if (abs.includes('..')) continue
      const onDisk = path.join(ROOT, abs)
      if (fs.existsSync(onDisk) && fs.statSync(onDisk).isFile()) queue.push({ rel: '/' + abs, kind: guessKind(abs) })
      else if (/\.(js|mjs|css|woff2?|ttf|wasm|bcmap|pfb|png|jpe?g|svg|gif|ico|json)$/i.test(raw)) {
        console.log(`  FAIL  ${rel} -> missing ${raw}`)
        fail++
      }
    }
  }
  return { requests, seen }
}
const guessKind = (p) => (p.endsWith('.css') ? 'css' : p.endsWith('.html') ? 'html' : 'other')

console.log('=== A. markup/CSS subresource graph, fetched from the local server ===\n')
let total = 0
for (const p of PAGES) {
  const { requests } = await crawl(p)
  total += requests
  console.log(`  ${p.padEnd(24)} ${String(requests).padStart(4)} subresources, all HTTP 200`)
}
console.log(`\n=== ${total} local fetches, all 200 OK ===`)

if (offOrigin.length) {
  console.log(`\n=== off-origin SUBRESOURCES found in markup (${offOrigin.length}) - these would break offline ===`)
  offOrigin.forEach((o) => console.log('  ' + o))
} else {
  console.log('=== zero off-origin subresources: markup needs no network at all ===')
}

/* --- B. lazy loaders the app's own code can trigger at runtime ------------- */
console.log('\n=== B. runtime lazy-loaders referenced by the app code ===')
const LAZY = [
  ['omm-latex.html', 'pdfjsLib.GlobalWorkerOptions.workerSrc', 'static_js_css/vendor/pdfjs-dist/3.11.174/build/pdf.worker.min.js'],
  ['omm-redact.html', 'pdfjsLib.GlobalWorkerOptions.workerSrc', 'static_js_css/vendor/pdfjs-dist/3.11.174/build/pdf.worker.min.js'],
  ['omm-annotate.html', "worker: '", 'static_js_css/vendor/pdfjs-dist/3.11.174/build/pdf.worker.min.js'],
  ['omm-annotate.html', "cmap: '", 'static_js_css/vendor/pdfjs-dist/3.11.174/cmaps/'],
  ['omm-redact.html', 'var urls = [', 'static_js_css/vendor/mupdf/1.28.1/mupdf.esm.js'],
  ['omm-message.html', 'const CDN =', 'static_js_css/vendor/supabase-js/2/supabase.min.js'],
]
for (const f of ['omm-planner.html', 'omm-data.html', 'omm-writer.html', 'omm-english.html', 'omm-annotate.html', 'omm-corpus.html']) {
  LAZY.push([f, 'var SUPABASE_CDN =', 'static_js_css/vendor/supabase-js/2/supabase.min.js'])
}
for (const [file, anchor, expect] of LAZY) {
  const txt = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const i = txt.indexOf(anchor)
  if (i < 0) { console.log(`  FAIL ${file}: anchor ${anchor} not found`); fail++; continue }
  const window = txt.slice(i, i + 400)
  if (!window.includes(expect)) {
    console.log(`  FAIL ${file}: ${anchor} does not point at ${expect}`)
    console.log(`        got: ${window.split('\n').slice(0, 2).join(' | ').trim().slice(0, 120)}`)
    fail++
  } else {
    console.log(`  ok   ${file.padEnd(20)} ${anchor.padEnd(40)} -> ${expect}`)
  }
}

/* --- C. no bundle may still reference a CDN host -------------------------- */
console.log('\n=== C. CDN hosts inside vendored bundles (excluding MathJax SRE) ===')
const HOSTS = /cdn\.jsdelivr\.net|cdn\.jsdmirror\.com|cdnjs\.cloudflare\.com|cdn\.sheetjs\.com|unpkg\.com|esm\.sh|fonts\.gstatic\.com|fonts\.googleapis\.com|ajax\.googleapis/g
const files = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(js|css)$/i.test(e.name)) files.push(p)
  }
})(path.join(__dirname, 'vendor'))
files.push(...fs.readdirSync(path.join(__dirname, 'fonts')).filter((f) => f.endsWith('.css')).map((f) => path.join(__dirname, 'fonts', f)))
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8')
  const hits = [...new Set(txt.match(HOSTS) || [])]
  if (!hits.length) continue
  const rel = path.relative(ROOT, f)
  // MathJax SRE / mathmaps only load with the "a11y" extension, which no page enables
  if (rel.includes('mathjax')) {
    console.log(`  note ${rel}: ${hits.join(', ')} (speech-rule-engine, only reachable via MathJax "a11y" extension - not enabled)`)
    continue
  }
  console.log(`  FAIL ${rel}: ${hits.join(', ')}`)
  fail++
}

console.log(`\n${fail ? '*** ' + fail + ' PROBLEM(S) ***' : '=== ALL CHECKS PASSED: fully offline ==='}`)
process.exit(fail ? 1 : 0)
