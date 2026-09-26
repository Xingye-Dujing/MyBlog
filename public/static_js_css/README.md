# static_js_css — 离线第三方资源

这个目录把原先通过 CDN 引入的第三方 JS / CSS / 字体全部落到本地，
`omm-planner` `omm-data` `omm-latex` `omm-redact` `omm-writer` `omm-english`
`omm-message` `omm-annotate` `omm-corpus` `omm-visualization` `h5-news`
这 11 个页面断网也能正常使用。

## 目录结构

```
static_js_css/
├─ vendor/                         第三方库（按 包名/版本/原路径 存放）
│  ├─ html2canvas/1.4.1/
│  ├─ pdfjs-dist/3.11.174/         build/ + cmaps/(169) + standard_fonts/(16)
│  ├─ pdf-lib/1.17.1/
│  ├─ jszip/3.10.1/
│  ├─ chart.js/4.4.0/  4.4.1/  4.5.1/    ← 三个版本分别对应 redact / h5-news / visualization
│  ├─ pptxviewjs/1.1.9/
│  ├─ jspdf/2.5.1/  4.2.1/  + pdfobject/2.1.1/
│  ├─ mammoth/1.6.0/
│  ├─ mathjax/3.2.2/es5/           tex-svg.js + output/svg/fonts/tex.js
│  ├─ mupdf/1.28.1/                mupdf.esm.js + mupdf-wasm.js + mupdf-wasm.wasm(10.4MB)
│  ├─ supabase-js/2/
│  ├─ apexcharts/7.4.0/
│  ├─ echarts/6.1.0/
│  ├─ xlsx/0.20.3/
│  └─ hydrogen-js-sdk/             Bmob-latest.min.js
└─ fonts/                          Google Fonts（CSS 已改写为本地 woff2）
   ├─ literata-a.css   300/400/500/700 + italic 400   planner · annotate
   ├─ literata-b.css   300/400/500/600/700 + italic 400 latex · visualization
   ├─ literata-c.css   400/500/600 + italic 400         redact · writer · english · message
   ├─ literata-d.css   400/500/600 + italic 400         corpus
   ├─ h5news.css       Noto Serif SC + Playfair Display + Inter   h5-news
   └─ woff2/           137 个字体子集
```

总计 **358 个文件 / 30.3 MB**（vendor 22.8 MB + fonts 8.5 MB）。

## HTML 里被改写的地方

除了 `<script src>` / `<link href>` / `@import`，下面这些**运行时才请求**的地方也已改成本地路径：

| 位置 | 说明 |
| --- | --- |
| `pdfjsLib.GlobalWorkerOptions.workerSrc` | latex / redact |
| `PDFJS_SOURCES[].lib / worker / cmap` | annotate（原来是 jsdmirror→jsDelivr→unpkg 三级回退，现只留本地） |
| `ensureMuPDF()` 的 `var urls = [...]` | redact（原来 jsdmirror / unpkg / esm.sh 三选一） |
| `SUPABASE_CDN` / `CDN` 常量 | planner / data / writer / english / annotate / corpus / message 共 7 个页面 |

## vendor 内部也做了本地化

这几个包自己会往 CDN 注入 `<script>`，已把兜底 URL 改成本地相对路径：

- `pptxviewjs` → 懒加载 JSZip 的 cdnjs 地址 → `../../jszip/3.10.1/jszip.min.js`
- `jspdf` 2.5.1 / 4.2.1 → `pdfobjectnewwindow` 模式的 pdfobject 地址 → `../../pdfobject/2.1.1/pdfobject.min.js`
- `mupdf.esm.js` → 内部 `/npm/mupdf@1.28.1/dist/mupdf-wasm.js` → `./mupdf-wasm.js`（`.wasm` 由 `mupdf-wasm.js` 按自身 URL 相对解析，三个文件同目录即可）

## 已知遗留（非依赖）

- `mathjax/es5/tex-svg.js` 里仍有 `speech-rule-engine` / `mathmaps` / `wicked-good-xpath`
  的 jsDelivr 地址。它们只在加载 MathJax `a11y`（无障碍朗读）插件时才会请求，
  而 `omm-writer.html` 的 MathJax 配置没有启用 `a11y`，所以永远不会触发。
- `h5-news.html` 里的 `https://m.s.weibo.com/...` 是正文里"数据来源"的**可点击引用链接**，
  不是资源加载，本来就该保留。

## 维护脚本

| 脚本 | 作用 |
| --- | --- |
| `_download-vendor.ps1` | 下载 22 个顶层 vendor JS |
| `_download-pdfjs-assets.ps1` | 下载 pdf.js 的 cmaps + standard_fonts（185 个） |
| `_download-fonts.ps1` | 下载 5 份 Google Fonts CSS + 137 个 woff2，并把 CSS 改写为本地路径 |
| `_rewrite-html.js` | 改写 11 个 HTML 的 CDN 引用（42 条规则，**幂等**，可重复执行） |
| `_patch-vendor.js` | 本地化 vendor 包内部的懒加载兜底 URL |
| `_verify.js` | 静态校验：残留 CDN、引用文件是否存在、@font-face 目标、mupdf 解析链 |
| `_crawl-test.js` | 起本地静态服务后，实际抓取每个页面的子资源图，验证零离站请求 |

```bash
# 更新依赖版本后重新走一遍
powershell -File static_js_css/_download-vendor.ps1
powershell -File static_js_css/_download-pdfjs-assets.ps1
powershell -File static_js_css/_download-fonts.ps1
node static_js_css/_patch-vendor.js
node static_js_css/_rewrite-html.js

# 校验
node static_js_css/_serve-test.js 8123 &   # 仅本地静态服务
node static_js_css/_verify.js
node static_js_css/_crawl-test.js
```

## 使用注意

- 路径全部是**相对路径**（`static_js_css/...`），必须保持 HTML 与本目录同级。
- `omm-redact.html` 的 MuPDF 走 `await import()` 动态 ESM 加载。浏览器对
  `file://` 下的动态 `import()` 有 CORS 限制，所以这一项（以及推荐的整体用法）
  需要用 HTTP 服务打开，不能直接双击 HTML：
  ```bash
  node static_js_css/_serve-test.js 8123     # 或 npm run dev / 任意静态服务器
  ```
  其余 10 个页面在 `file://` 下也能正常工作。
- 服务端需要正确 MIME：`application/wasm`（MuPDF）、`font/woff2`、`text/javascript`。
  Vite dev server 和常规静态服务器默认都正确。
