# Upgrades Afey POS in place: backup, update code, rebuild, restart.
param([string]$InstallDir = (Resolve-Path "$PSScriptRoot\..\..").Path, [string]$NewReleaseZip = '')
$ErrorActionPreference = 'Stop'
Write-Host '==> Backing up before upgrade'
& "$PSScriptRoot\backup.ps1" -InstallDir $InstallDir
Stop-ScheduledTask -TaskName 'AfeyPOS' -ErrorAction SilentlyContinue
Push-Location $InstallDir
if ($NewReleaseZip) {
  Write-Host "==> Extracting $NewReleaseZip (server\.env is kept)"
  $tmp = Join-Path $env:TEMP "afeypos-upgrade-$(Get-Date -Format yyyyMMddHHmmss)"
  Expand-Archive -Path $NewReleaseZip -DestinationPath $tmp
  $src = (Get-ChildItem $tmp | Select-Object -First 1).FullName
  robocopy $src $InstallDir /E /XD node_modules data .git /XF .env | Out-Null
} elseif (Test-Path .git) {
  git pull --ff-only
}
# Keeps server\.env (secrets, mode, port); installs dependencies, builds, checks the database.
node scripts\setup.mjs
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'Upgrade failed; the backup is in the backups folder.' -ForegroundColor Red; exit 1 }
Pop-Location
Start-ScheduledTask -TaskName 'AfeyPOS'
Write-Host 'Upgrade complete. Database indexes are updated automatically on start.' -ForegroundColor Green
