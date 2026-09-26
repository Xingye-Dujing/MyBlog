$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $root 'vendor'
New-Item -ItemType Directory -Force -Path $vendor | Out-Null

$files = @(
  @{ u = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';                        p = 'html2canvas/1.4.1/html2canvas.min.js' },
  @{ u = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';                                   p = 'pdfjs-dist/3.11.174/build/pdf.min.js' },
  @{ u = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';                            p = 'pdfjs-dist/3.11.174/build/pdf.worker.min.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';                                     p = 'pdf-lib/1.17.1/pdf-lib.min.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/jszip@3.10.1/dist/jszip.min.js';                                        p = 'jszip/3.10.1/jszip.min.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/chart.js@4.4.0/dist/chart.umd.min.js';                                  p = 'chart.js/4.4.0/chart.umd.min.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/chart.js@4.4.1/dist/chart.umd.min.js';                                  p = 'chart.js/4.4.1/chart.umd.min.js' },
  @{ u = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js';                                   p = 'chart.js/4.5.1/chart.umd.min.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/pptxviewjs@1.1.9/dist/PptxViewJS.min.js';                               p = 'pptxviewjs/1.1.9/PptxViewJS.min.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';                                    p = 'jspdf/2.5.1/jspdf.umd.min.js' },
  @{ u = 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js';                                     p = 'jspdf/4.2.1/jspdf.umd.min.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/mammoth@1.6.0/mammoth.browser.min.js';                                  p = 'mammoth/1.6.0/mammoth.browser.min.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/apexcharts@7.4.0/dist/apexcharts.min.js';                                p = 'apexcharts/7.4.0/apexcharts.min.js' },
  @{ u = 'https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js';                                     p = 'echarts/6.1.0/echarts.min.js' },
  @{ u = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';                                    p = 'xlsx/0.20.3/xlsx.full.min.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/hydrogen-js-sdk/dist/Bmob-latest.min.js';                               p = 'hydrogen-js-sdk/Bmob-latest.min.js' },
  @{ u = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';                       p = 'supabase-js/2/supabase.min.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/mathjax@3/es5/tex-svg.js';                                              p = 'mathjax/3.2.2/es5/tex-svg.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/mathjax@3/es5/output/svg/fonts/tex.js';                                 p = 'mathjax/3.2.2/es5/output/svg/fonts/tex.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/mupdf@1.28.1/+esm';                                                     p = 'mupdf/1.28.1/mupdf.esm.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/mupdf@1.28.1/dist/mupdf-wasm.js';                                      p = 'mupdf/1.28.1/mupdf-wasm.js' },
  @{ u = 'https://cdn.jsdmirror.com/npm/mupdf@1.28.1/dist/mupdf-wasm.wasm';                                    p = 'mupdf/1.28.1/mupdf-wasm.wasm' }
)

$ok = 0; $fail = @()
foreach ($f in $files) {
  $dest = Join-Path $vendor ($f.p -replace '/', '\')
  $dir = Split-Path -Parent $dest
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 0) {
    Write-Host "SKIP  $($f.p)"
    $ok++
    continue
  }
  $attempt = 0
  while ($attempt -lt 3) {
    $attempt++
    try {
      Invoke-WebRequest -Uri $f.u -OutFile $dest -TimeoutSec 180 -UseBasicParsing -MaximumRedirection 5
      $len = (Get-Item $dest).Length
      if ($len -lt 100) { throw "too small ($len bytes)" }
      Write-Host ("OK    {0}  ({1:N0} bytes)" -f $f.p, $len)
      $ok++
      break
    } catch {
      if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }
      if ($attempt -ge 3) { $fail += $f.u; Write-Host "FAIL  $($f.u) :: $($_.Exception.Message)" }
      else { Start-Sleep -Milliseconds 800 }
    }
  }
}

Write-Host ""
Write-Host "=== vendor JS done: $ok ok, $($fail.Count) failed ==="
if ($fail.Count) { $fail | ForEach-Object { Write-Host "  MISSING: $_" } }
