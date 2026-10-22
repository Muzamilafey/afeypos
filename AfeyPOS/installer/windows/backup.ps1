# Creates a verified full backup (also run daily by the "AfeyPOS Backup" scheduled task).
param([string]$InstallDir = (Resolve-Path "$PSScriptRoot\..\..").Path, [string]$CopyTo = '')
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $InstallDir 'server')
node --env-file=.env dist/scripts/backup.js
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Write-Error 'Backup failed'; exit $code }
if ($CopyTo) {
  $dir = (Select-String -Path (Join-Path $InstallDir 'server\.env') -Pattern '^BACKUP_DIR=(.*)$').Matches[0].Groups[1].Value
  Get-ChildItem $dir -Filter 'afeypos-full-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 2 | Copy-Item -Destination $CopyTo -Force
  Write-Host "Copied latest backup to $CopyTo"
}
