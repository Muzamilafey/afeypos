<#
.SYNOPSIS
  Installs Afey POS as a local (single business) server on Windows 10/11 or Windows Server.

.DESCRIPTION
  - Checks Node.js 22.9+ and MongoDB 7+ are installed (install-online.ps1 downloads them for you).
  - Configures MongoDB as a single-node replica set (required for transactions) and a Windows service.
  - Creates server\.env with freshly generated secrets (kept when run again) and initialises the replica set.
  - Installs dependencies and builds the application.
  - Registers "AfeyPOS" as a startup Scheduled Task that runs as SYSTEM and restarts on failure.
  - Opens the firewall port for tills on the local network.
  - Schedules a daily backup.

  Run from an elevated PowerShell in the AfeyPOS folder:
    powershell -ExecutionPolicy Bypass -File installer\windows\install.ps1
#>
[CmdletBinding()]
param(
  [ValidateSet('standalone', 'hq', 'branch')][string]$Mode = 'standalone',
  [int]$Port = 9999,
  [string]$PublicUrl = '',
  [string]$ShopHost = '',
  [string]$HqUrl = '',
  [string]$SyncToken = '',
  [string]$BranchCode = '',
  [string]$EncryptionKey = $env:AFEY_ENCRYPTION_KEY,
  [string]$InstallDir = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$DataDir = "C:\AfeyPOS\data",
  [string]$MongoDataDir = "C:\AfeyPOS\mongodb",
  [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Green }
function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Run this script in PowerShell "Run as administrator".' }

Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js 22 LTS or newer is required. Download it from https://nodejs.org and run this script again.' }
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { Fail "Node.js $(node -v) is too old. Install Node.js 22 LTS or newer." }
Write-Host "Node.js $(node -v) found"

Step 'Checking MongoDB'
$mongod = Get-Command mongod -ErrorAction SilentlyContinue
if (-not $mongod) {
  $candidate = Get-ChildItem 'C:\Program Files\MongoDB\Server\*\bin\mongod.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
  if ($candidate) { $mongodPath = $candidate.FullName } else { Fail 'MongoDB Community Server 7 or newer is required. Install it from https://www.mongodb.com/try/download/community (choose "Install as a service" = NO; this script configures the service).' }
} else { $mongodPath = $mongod.Source }
$mongoBin = Split-Path $mongodPath
Write-Host "mongod: $mongodPath"

Step 'Configuring MongoDB as a single-node replica set'
New-Item -ItemType Directory -Force -Path $MongoDataDir, "$MongoDataDir\db", "$MongoDataDir\log" | Out-Null
$cfg = @"
storage:
  dbPath: $MongoDataDir\db
systemLog:
  destination: file
  path: $MongoDataDir\log\mongod.log
  logAppend: true
net:
  bindIp: 127.0.0.1
  port: 27017
replication:
  replSetName: rs0
"@
Set-Content -Path "$MongoDataDir\mongod.cfg" -Value $cfg -Encoding ASCII
$svc = Get-Service -Name 'AfeyMongoDB' -ErrorAction SilentlyContinue
if (-not $svc) {
  & sc.exe create AfeyMongoDB binPath= "`"$mongodPath`" --config `"$MongoDataDir\mongod.cfg`" --service" start= auto DisplayName= "Afey POS MongoDB" | Out-Null
  & sc.exe failure AfeyMongoDB reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null
}
Start-Service AfeyMongoDB
Start-Sleep -Seconds 5

Step 'Configuring, installing and building Afey POS (a few minutes the first time)'
# An upgrade replaces files the running server uses: stop it first.
Stop-ScheduledTask -TaskName 'AfeyPOS' -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# scripts\setup.mjs writes server\.env (new secrets the first time, existing values kept afterwards),
# runs npm ci and the build, and initialises the database replica set.
$setupArgs = @('scripts\setup.mjs', '--mode', $Mode, '--port', "$Port", '--data-dir', $DataDir)
if ($PublicUrl) { $setupArgs += @('--public-url', $PublicUrl) }
if ($ShopHost) { $setupArgs += @('--shop-host', $ShopHost) }
if ($HqUrl) { $setupArgs += @('--hq-url', $HqUrl) }
if ($SyncToken) { $setupArgs += @('--sync-token', $SyncToken) }
if ($BranchCode) { $setupArgs += @('--branch-code', $BranchCode) }
if ($EncryptionKey) { $setupArgs += @('--encryption-key', $EncryptionKey) }
Push-Location $InstallDir
& node @setupArgs
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Fail 'Setup failed (see the messages above).' }
# Restrict the file to Administrators and SYSTEM: it contains the encryption key.
$envFile = Join-Path $InstallDir 'server\.env'
icacls $envFile /inheritance:r /grant:r "Administrators:F" "SYSTEM:F" | Out-Null
Write-Host "Configuration: $envFile. BACK UP THIS FILE: without ENCRYPTION_KEY stored secrets cannot be decrypted."

Step 'Registering the Afey POS service (Scheduled Task, runs at startup as SYSTEM)'
$nodeExe = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument '--env-file=.env dist\server.js' -WorkingDirectory (Join-Path $InstallDir 'server')
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'AfeyPOS' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName 'AfeyPOS'

Step 'Scheduling a daily backup at 22:30'
$bAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\installer\windows\backup.ps1`""
$bTrigger = New-ScheduledTaskTrigger -Daily -At '22:30'
Register-ScheduledTask -TaskName 'AfeyPOS Backup' -Action $bAction -Trigger $bTrigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

if (-not $SkipFirewall) {
  Step "Allowing tills on the local network to reach port $Port"
  # Recreated each run so the rule follows the port (it was 4000 before 9999 became the default).
  Get-NetFirewallRule -DisplayName 'Afey POS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName 'Afey POS' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null
}

Step 'Waiting for the server to start'
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try { $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2; if ($h.status -eq 'ok') { $ok = $true; break } } catch { Start-Sleep -Seconds 2 }
}
if ($ok) {
  Write-Host "`nAfey POS is running." -ForegroundColor Green
  $url = ((Get-Content (Join-Path $InstallDir 'server\.env')) -match '^PUBLIC_APP_URL=' | Select-Object -First 1) -replace '^PUBLIC_APP_URL=', ''
  if ($Mode -eq 'branch') { Write-Host "Open http://localhost:$Port on this computer, or $url on other tills. Within a minute the business, staff and products arrive from head office: sign in with your head-office accounts." }
  else { Write-Host "Open http://localhost:$Port on this computer, or $url on other tills, and create the owner account." }
} else {
  Write-Warning "The server did not answer yet. Check: Get-ScheduledTaskInfo AfeyPOS, and docs/TROUBLESHOOTING.md"
}
