param(
  [string]$Tag = 'v1.0.2',
  [string]$Notes = '',
  [string]$Target = 'production'
)
# Create the Gitee release for a tag (Windows assets only are uploaded
# afterwards by upload_gitee_assets.ps1).
$ErrorActionPreference = 'Stop'
$env:GIT_TERMINAL_PROMPT = '0'
$repo = 'Xingye-Dujing/my-blog'
$api = "https://gitee.com/api/v5/repos/$repo"

$cred = ("protocol=https`nhost=gitee.com`n`n" | git credential fill 2>$null)
$token = (($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', '')
if (-not $token) { throw 'no stored gitee credential' }

$body = ''
if ($Notes) { $body = Get-Content -LiteralPath $Notes -Raw -Encoding UTF8 }

$release = $null
try {
  $release = Invoke-RestMethod -Uri (("$api/releases/tags/$Tag") + "?access_token=" + $token) -Method Get
} catch {
  if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
}

if (-not $release -or -not $release.id) {
  $release = Invoke-RestMethod -Uri ("$api/releases?access_token=" + $token) `
    -Method Post -ContentType 'application/x-www-form-urlencoded' `
    -Body @{
      tag_name = $Tag
      name = "OMM-ZEN $Tag"
      body = $body
      target_commitish = $Target
      prerelease = 'false'
    }
  Write-Output ("CREATED release {0} id={1}" -f $Tag, $release.id)
} else {
  Write-Output ("EXISTS release {0} id={1}" -f $Tag, $release.id)
}
$release.id
