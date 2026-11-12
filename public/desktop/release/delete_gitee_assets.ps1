param(
  [string]$Tag = 'v1.0.7',
  [string]$Keep = 'catalog.json'
)
# Free space in the Gitee repository.
#
# Gitee's attachment quota (1 GB for the whole repository) is shared by every
# Release, so the newest Windows set often does not fit.  This script deletes
# the large assets of an older Release while keeping the small manifest files
# (catalog.json by default) that old programs still poll.
#
# The deleted files stay available on the GitHub Release, which has no such
# quota.
#
#   powershell -NoProfile -ExecutionPolicy Bypass `
#     -File desktop\release\delete_gitee_assets.ps1 -Tag v1.0.3 -Keep catalog.json
$ErrorActionPreference = 'Stop'
$env:GIT_TERMINAL_PROMPT = '0'
$repo = 'Xingye-Dujing/my-blog'
$api = "https://gitee.com/api/v5/repos/$repo"

$cred = ("protocol=https`nhost=gitee.com`n`n" | git credential fill 2>$null)
$token = (($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', '')
if (-not $token) { throw 'no stored gitee credential' }

$release = Invoke-RestMethod -Uri (("$api/releases/tags/$Tag") + "?access_token=" + $token) -Method Get
$rid = $release.id

$keep = @($Keep -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$attach = Invoke-RestMethod -Uri ("$api/releases/$rid/attach_files?access_token=$token&per_page=100") -Method Get
$deleted = 0
foreach ($item in $attach) {
  $name = $item.name
  if ($keep -contains $name) { continue }
  if ($name -like 'v*.tar.gz') { continue }   # the source archive is not an attachment
  try {
    Invoke-RestMethod -Uri ("$api/releases/$rid/attach_files/$($item.id)?access_token=$token") -Method Delete | Out-Null
    Write-Output ("DELETE {0}" -f $name)
    $deleted++
  } catch {
    Write-Output ("WARN   {0}: {1}" -f $name, $_.Exception.Response.StatusCode.value__)
  }
}
Write-Output ("Deleted {0} asset(s) from {1}" -f $deleted, $Tag)
