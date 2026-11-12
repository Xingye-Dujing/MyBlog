param(
  [string]$Tag = 'v1.0.6',
  [string]$AssetDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'dist'),
  [string[]]$Names
)
# Upload the Windows release assets to the Gitee release.
# Gitee only keeps the Windows set: the repository attachment quota (1 GB for
# the whole repo) cannot hold the macOS DMGs as well.
$ErrorActionPreference = 'Stop'
$env:GIT_TERMINAL_PROMPT = '0'
$repo = 'Xingye-Dujing/my-blog'
$api = "https://gitee.com/api/v5/repos/$repo"

$cred = ("protocol=https`nhost=gitee.com`n`n" | git credential fill 2>$null)
$token = (($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', '')
if (-not $token) { throw 'no stored gitee credential' }

$release = Invoke-RestMethod -Uri (("$api/releases/tags/$Tag") + "?access_token=" + $token) -Method Get
$rid = $release.id

if (-not $Names -or $Names.Count -eq 0) {
  $version = $Tag.TrimStart('v')
  $Names = @()
  $Names += (Get-ChildItem $AssetDir -Filter 'OMM-*.exe' | ForEach-Object Name)
  $Names += 'OMM-ZEN-Framework-win64.zip', 'catalog.json', 'plugin-template.zip', 'plugin-spec.md'
  $Names += (Get-ChildItem (Join-Path $AssetDir 'plugins') -Filter "*-$version.zip" | ForEach-Object Name)
} else {
  $expanded = @()
  foreach ($v in $Names) { $expanded += ($v -split ',') }
  $Names = $expanded
}

foreach ($name in $Names) {
  $inPlugins = Join-Path $AssetDir ("plugins\" + $name)
  if ($name -like 'plugin-*' -and (Test-Path $inPlugins)) { $path = $inPlugins }
  else { $path = Join-Path $AssetDir $name }
  if (-not (Test-Path $path)) { Write-Output "MISSING $name"; continue }

  # Replace a stale attachment with the same name (exact match only).
  $attach = Invoke-RestMethod -Uri ("$api/releases/$rid/attach_files?access_token=$token&per_page=100") -Method Get
  foreach ($item in $attach) {
    if ($item.name -eq $name) {
      try {
        Invoke-RestMethod -Uri ("$api/releases/$rid/attach_files/$($item.id)?access_token=$token") -Method Delete | Out-Null
      } catch {
        Write-Output ("WARN delete {0}: {1}" -f $name, $_.Exception.Response.StatusCode.value__)
      }
    }
  }

  $response = & curl.exe -sS -X POST "$api/releases/$rid/attach_files" -F "access_token=$token" -F "file=@$path"
  if ($LASTEXITCODE -ne 0) { Write-Output "FAIL upload $name"; continue }
  try {
    $json = $response | ConvertFrom-Json
    if (-not $json.id) {
      Write-Output ("FAIL {0}: {1}" -f $name, $response)
      continue
    }
    Write-Output ("OK   {0}  {1} bytes  (id {2})" -f $name, (Get-Item $path).Length, $json.id)
  } catch {
    Write-Output ("FAIL {0}: {1}" -f $name, $response)
  }
}
