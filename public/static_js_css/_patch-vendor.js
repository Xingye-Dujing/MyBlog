import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const V = path.join(__dirname, 'vendor')

/* 1. grab pdfobject 2.1.1 (only jsPDF's unused "pdfobjectnewwindow" output
      mode ever asks for it, but we localise it so no bundle can reach out). */
const pdfobjectDest = path.join(V, 'pdfobject/2.1.1/pdfobject.min.js')
if (!fs.existsSync(pdfobjectDest) || fs.statSync(pdfobjectDest).size < 100) {
  fs.mkdirSync(path.dirname(pdfobjectDest), { recursive: true })
  const r = await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js')
  if (!r.ok) throw new Error('pdfobject download failed: HTTP ' + r.status)
  fs.writeFileSync(pdfobjectDest, Buffer.from(await r.arrayBuffer()))
  console.log(`downloaded pdfobject/2.1.1/pdfobject.min.js (${fs.statSync(pdfobjectDest).size} bytes)`)
} else {
  console.log('pdfobject/2.1.1/pdfobject.min.js already present')
}

/* 2. rewrite lazy-loader fallbacks inside the vendored bundles.
      Paths are relative to each bundle, so they resolve without a server root. */
const PATCHES = [
  {
    file: 'pptxviewjs/1.1.9/PptxViewJS.min.js',
    from: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    to: '../../jszip/3.10.1/jszip.min.js',
    why: 'pptxviewjs lazily injects JSZip from cdnjs when window.JSZip is absent',
  },
  {
    file: 'jspdf/2.5.1/jspdf.umd.min.js',
    from: 'https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js',
    to: '../../pdfobject/2.1.1/pdfobject.min.js',
    why: 'jsPDF "pdfobjectnewwindow" output mode',
  },
  {
    file: 'jspdf/4.2.1/jspdf.umd.min.js',
    from: 'https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js',
    to: '../../pdfobject/2.1.1/pdfobject.min.js',
    why: 'jsPDF "pdfobjectnewwindow" output mode',
  },
]

let fail = 0
console.log('')
for (const p of PATCHES) {
  const fp = path.join(V, p.file)
  const txt = fs.readFileSync(fp, 'utf8')
  const n = txt.split(p.from).length - 1
  if (n !== 1) {
    console.log(`  FAIL ${p.file}: expected 1 occurrence of ${p.from}, found ${n}`)
    fail++
    continue
  }
  fs.writeFileSync(fp, txt.split(p.from).join(p.to), 'utf8')
  console.log(`  ok   ${p.file}  ->  ${p.to}   (${p.why})`)
}
process.exit(fail ? 1 : 0)
