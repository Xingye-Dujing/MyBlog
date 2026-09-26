$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Modern Chrome UA -> Google serves woff2 + unicode-range subsets
$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$fonts = Join-Path $root 'fonts'
$woffDir = Join-Path $fonts 'woff2'
New-Item -ItemType Directory -Force -Path $woffDir | Out-Null

$sets = @(
  @{ name = 'literata-a'; url = 'https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,300;0,7..72,400;0,7..72,500;0,7..72,700;1,7..72,400&display=swap' },
  @{ name = 'literata-b'; url = 'https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,300;0,7..72,400;0,7..72,500;0,7..72,600;0,7..72,700;1,7..72,400&display=swap' },
  @{ name = 'literata-c'; url = 'https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,500;0,7..72,600;1,7..72,400&display=swap' },
  # NOTE: original omm-corpus.html requests opsz "1,0..72,400" which Google rejects with
  # HTTP 400 (invalid axis tuple) -> that page never actually loaded the font.
  # We request the valid 7..72 opsz italic instead, which is a strict superset.
  @{ name = 'literata-d'; url = 'https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,500;0,7..72,600;1,7..72,400&display=swap' },
  @{ name = 'h5news';     url = 'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;500;600;700;900&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Inter:wght@300;400;500;600;700&display=swap' }
)

# pass 1: fetch CSS
$pending = @{}
foreach ($s in $sets) {
  $out = Join-Path $fonts ($s.name + '.css')
  $attempt = 0
  while ($true) {
    $attempt++
    try {
      Invoke-WebRequest -Uri $s.url -OutFile $out -TimeoutSec 60 -UseBasicParsing -Headers @{ 'User-Agent' = $UA }
      break
    } catch {
      if ($attempt -ge 3) { throw "CSS download failed: $($s.url) :: $($_.Exception.Message)" }
      Start-Sleep -Milliseconds 800
    }
  }
  $css = Get-Content $out -Raw -Encoding UTF8
  $urls = [regex]::Matches($css, 'https://fonts\.gstatic\.com/[^)\s''"]+') | ForEach-Object { $_.Value } | Sort-Object -Unique
  Write-Host ("CSS {0,-12} ok, {1} font files referenced" -f $s.name, $urls.Count)
  foreach ($u in $urls) { $pending[$u] = $true }
}

Write-Host ""
Write-Host ("Unique font files to download: {0}" -f $pending.Count)

# pass 2: download every unique woff2 once
$ok = 0; $fail = @(); $i = 0
foreach ($u in $pending.Keys) {
  $i++
  $file = [System.IO.Path]::GetFileName(($u -split '\?')[0])
  $dest = Join-Path $woffDir $file
  if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 0) { $ok++; continue }
  $attempt = 0
  while ($attempt -lt 3) {
    $attempt++
    try {
      Invoke-WebRequest -Uri $u -OutFile $dest -TimeoutSec 90 -UseBasicParsing -Headers @{ 'User-Agent' = $UA } -MaximumRedirection 5
      if ((Get-Item $dest).Length -lt 100) { throw 'too small' }
      $ok++
      break
    } catch {
      if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }
      if ($attempt -ge 3) { $fail += $u } else { Start-Sleep -Milliseconds 500 }
    }
  }
  if ($i % 30 -eq 0) { Write-Host "  ... $i / $($pending.Count)" }
}
Write-Host "font files: $ok ok, $($fail.Count) failed"

# pass 3: rewrite each CSS to point at local woff2
$rewritten = 0
foreach ($s in $sets) {
  $out = Join-Path $fonts ($s.name + '.css')
  $css = Get-Content $out -Raw -Encoding UTF8
  $css = [regex]::Replace($css, 'https://fonts\.gstatic\.com/[^)\s''"]+', {
    param($m)
    'woff2/' + [System.IO.Path]::GetFileName(($m.Value -split '\?')[0])
  })
  # drop any lingering @import-style absolute refs
  $css = $css -replace 'https://fonts\.googleapis\.com/[^''")\s]+', ''
  [System.IO.File]::WriteAllText($out, $css, (New-Object System.Text.UTF8Encoding($false)))
  $rewritten++
  Write-Host ("rewrote {0}.css" -f $s.name)
}

Write-Host ""
Write-Host "=== fonts done: $rewritten css files, $ok woff2 downloaded, $($fail.Count) failed ==="
$fail | ForEach-Object { Write-Host "  MISSING: $_" }
