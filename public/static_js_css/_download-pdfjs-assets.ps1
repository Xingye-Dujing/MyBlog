$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $root 'vendor'
$pkg = 'pdfjs-dist'
$ver  = '3.11.174'
$base = "https://cdn.jsdelivr.net/npm/$pkg@$ver"

$apiUrl = 'https://data.jsdelivr.com/v1/packages/npm/' + $pkg + '@' + $ver + '?structure=flat'
$j = Invoke-RestMethod -Uri $apiUrl -TimeoutSec 60

$want = $j.files | Where-Object {
  $_.name -like '/cmaps/*' -or $_.name -like '/standard_fonts/*'
} | Sort-Object -Property name

Write-Host "files to fetch: $($want.Count)"

$ok = 0; $fail = @()
foreach ($f in $want) {
  $rel = $f.name.TrimStart('/')
  $dest = Join-Path $vendor (('pdfjs-dist/3.11.174/' + $rel) -replace '/', '\')
  $dir = Split-Path -Parent $dest
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 0) { $ok++; continue }
  $url = "$base$($f.name)"
  $attempt = 0
  while ($attempt -lt 3) {
    $attempt++
    try {
      Invoke-WebRequest -Uri $url -OutFile $dest -TimeoutSec 120 -UseBasicParsing
      if ((Get-Item $dest).Length -lt 10) { throw 'too small' }
      $ok++
      break
    } catch {
      if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }
      if ($attempt -ge 3) { $fail += $url }
      else { Start-Sleep -Milliseconds 500 }
    }
  }
  if (($ok + $fail.Count) % 40 -eq 0) { Write-Host "  ... $ok done, $($fail.Count) failed" }
}

Write-Host ""
Write-Host "=== pdfjs assets done: $ok ok, $($fail.Count) failed ==="
$fail | ForEach-Object { Write-Host "  MISSING: $_" }
