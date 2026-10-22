# Restores a full backup. This REPLACES all data in the database.
param([Parameter(Mandatory = $true)][string]$BackupFile, [string]$InstallDir = (Resolve-Path "$PSScriptRoot\..\..").Path)
$ErrorActionPreference = 'Stop'
$confirm = Read-Host "This replaces ALL Afey POS data with $BackupFile. Type RESTORE to continue"
if ($confirm -ne 'RESTORE') { Write-Host 'Cancelled'; exit 1 }
Write-Host 'Taking a safety backup of the current data first...'
& "$PSScriptRoot\backup.ps1" -InstallDir $InstallDir
Stop-ScheduledTask -TaskName 'AfeyPOS' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dist\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Push-Location (Join-Path $InstallDir 'server')
node --env-file=.env dist/scripts/restore.js "$BackupFile" --drop-existing
$code = $LASTEXITCODE
Pop-Location
Start-ScheduledTask -TaskName 'AfeyPOS'
if ($code -ne 0) { Write-Error 'Restore failed. The safety backup is in the backup folder.'; exit $code }
Write-Host 'Restore complete. Users must sign in again.' -ForegroundColor Green
