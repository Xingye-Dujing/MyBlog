import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const FILES = [
  'omm-planner.html', 'omm-data.html', 'omm-latex.html', 'omm-redact.html',
  'omm-writer.html', 'omm-english.html', 'omm-message.html', 'omm-annotate.html',
  'omm-corpus.html', 'h5-news.html', 'omm-visualization.html',
]

const CDN = /cdn\.jsdelivr\.net|cdn\.jsdmirror\.com|cdnjs\.cloudflare\.com|cdn\.sheetjs\.com|unpkg\.com|esm\.sh|fonts\.googleapis\.com|fonts\.gstatic\.com/

let fail = 0

/* ---- 1. residual CDN scan ------------------------------------------------ */
console.log('=== 1. residual CDN references ===')
for (const f of FILES) {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
  const hits = [...new Set(t.match(CDN) || [])]
  if (hits.length) { fail++; console.log(`  FAIL ${f}: ${hits.join(', ')}`) }
  else console.log(`  ok   ${f}`)
}

/* ---- 2. every static_js_css path referenced must exist -------------------- */
console.log('\n=== 2. referenced local files exist? ===')
const refd = new Set()
for (const f of FILES) {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
  // src/href attributes and quoted paths inside JS string literals
  for (const m of t.matchAll(/static_js_css\/[A-Za-z0-9_./@%-]+/g)) refd.add(m[0])
}
let missing = 0
for (const r of [...refd].sort()) {
  const p = path.join(ROOT, r)
  const ok = fs.existsSync(p)
  if (!ok) missing++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${r}`)
}
if (missing) fail++

/* ---- 3. fonts CSS: local woff2 all present -------------------------------- */
console.log('\n=== 3. @font-face woff2 targets exist? ===')
const fontDir = path.join(__dirname, 'fonts')
for (const css of fs.readdirSync(fontDir).filter((f) => f.endsWith('.css'))) {
  const txt = fs.readFileSync(path.join(fontDir, css), 'utf8')
  const urls = [...new Set([...txt.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]))]
  let bad = 0
  for (const u of urls) {
    if (/^https?:/i.test(u)) { bad++; console.log(`  FAIL ${css}: still remote -> ${u}`); continue }
    const p = path.join(fontDir, u)
    if (!fs.existsSync(p)) { bad++; console.log(`  FAIL ${css}: missing -> ${u}`) }
  }
  console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${css}  (${urls.length} font url(s))`)
  if (bad) fail++
}

/* ---- 4. mupdf ESM is fully local ------------------------------------------ */
console.log('\n=== 4. mupdf esm local resolution ===')
{
  const p = path.join(__dirname, 'vendor/mupdf/1.28.1/mupdf.esm.js')
  const t = fs.readFileSync(p, 'utf8')
  const loader = t.match(/new URL\("([^"]+)",import\.meta\.url\)/g) || []
  const uniq = [...new Set(loader)]
  for (const u of uniq) console.log(`  ref: ${u}`)
  for (const f of ['mupdf.esm.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm']) {
    const ok = fs.existsSync(path.join(__dirname, 'vendor/mupdf/1.28.1', f))
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  vendor/mupdf/1.28.1/${f}`)
    if (!ok) fail++
  }
}

/* ---- 5. inventory -------------------------------------------------------- */
console.log('\n=== 5. inventory ===')
const all = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else all.push({ p, size: fs.statSync(p).size })
  }
})(path.join(__dirname))
const vend = all.filter((x) => x.p.includes(`${path.sep}vendor${path.sep}`))
const fnt = all.filter((x) => x.p.includes(`${path.sep}fonts${path.sep}`))
const fmt = (a) => `${a.length} files, ${(a.reduce((s, x) => s + x.size, 0) / 1048576).toFixed(2)} MB`
console.log(`  vendor : ${fmt(vend)}`)
console.log(`  fonts  : ${fmt(fnt)}`)
console.log(`  total  : ${fmt(all)}`)

console.log(`\n${fail ? '*** ' + fail + ' PROBLEM(S) ***' : 'ALL CHECKS PASSED'}`)
process.exit(fail ? 1 : 0)
