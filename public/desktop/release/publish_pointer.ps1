param(
  [string]$Tag = 'v1.0.4',
  [string]$PrevTag = 'v1.0.3'
)
# Publish the newest catalog.json onto the previous release as well.
#
# The desktop programs poll a fixed catalog URL that belongs to their own
# release (…/releases/download/<their version>/catalog.json).  A program
# therefore only ever learns about a new version if the *newest* catalog is
# also served from the release it was built for.  Overwriting the previous
# release's catalog.json with the newest one turns every old program into a
# working updater; the previous release keeps its own binaries and plugin
# bundles, only the manifest points forward.
#
# The newest catalog.json must already be on the new release.
$ErrorActionPreference = 'Stop'
$env:GIT_TERMINAL_PROMPT = '0'
$repo = 'Xingye-Dujing/my-blog'
$api = "https://gitee.com/api/v5/repos/$repo"
$catalog = Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'dist') 'catalog.json'

if (-not (Test-Path $catalog)) { throw "catalog.json not found: $catalog" }

$cred = ("protocol=https`nhost=gitee.com`n`n" | git credential fill 2>$null)
$token = (($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', '')
if (-not $token) { throw 'no stored gitee credential' }

foreach ($t in @($PrevTag, $Tag)) {
  $release = Invoke-RestMethod -Uri (("$api/releases/tags/$t") + "?access_token=" + $token) -Method Get
  $rid = $release.id

  # Replace the existing attachment with the same name.
  $attach = Invoke-RestMethod -Uri ("$api/releases/$rid/attach_files?access_token=$token&per_page=100") -Method Get
  foreach ($item in $attach) {
    if ($item.name -eq 'catalog.json') {
      Invoke-RestMethod -Uri ("$api/releases/$rid/attach_files/$($item.id)?access_token=$token") -Method Delete | Out-Null
    }
  }

  $response = & curl.exe -sS -X POST "$api/releases/$rid/attach_files" -F "access_token=$token" -F "file=@$catalog"
  try {
    $json = $response | ConvertFrom-Json
    if (-not $json.id) { throw "upload failed for ${t}: $response" }
    Write-Output ("OK   {0}  catalog.json  {1} bytes (id {2})" -f $t, (Get-Item $catalog).Length, $json.id)
  } catch {
    Write-Output ("FAIL {0}: {1}" -f $t, $response)
  }
}
