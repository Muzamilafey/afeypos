<#
.SYNOPSIS
  Installs Afey POS as a local (single business) server on Windows 10/11 or Windows Server.

.DESCRIPTION
  - Checks Node.js 20+ and MongoDB 7+ are installed.
  - Configures MongoDB as a single-node replica set (required for transactions) and a Windows service.
  - Creates server\.env with freshly generated secrets.
  - Installs dependencies and builds the application.
  - Registers "AfeyPOS" as a startup Scheduled Task that runs as SYSTEM and restarts on failure.
  - Opens the firewall port for tills on the local network.
  - Schedules a daily backup.

  Run from an elevated PowerShell in the AfeyPOS folder:
    powershell -ExecutionPolicy Bypass -File installer\windows\install.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 4000,
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
$mongosh = Get-Command mongosh -ErrorAction SilentlyContinue
if ($mongosh) {
  & mongosh --quiet --eval 'try { rs.status().ok } catch (e) { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] }).ok }'
} else {
  Write-Warning 'mongosh not found. Initialise the replica set once with: mongosh --eval "rs.initiate()" (see docs/INSTALL-WINDOWS.md).'
}

Step 'Creating configuration (server\.env)'
$envFile = Join-Path $InstallDir 'server\.env'
New-Item -ItemType Directory -Force -Path $DataDir, "$DataDir\backups", "$DataDir\uploads" | Out-Null
if (-not (Test-Path $envFile)) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $jwt = New-Object byte[] 48; $rng.GetBytes($jwt)
  $key = New-Object byte[] 32; $rng.GetBytes($key)
  $content = Get-Content (Join-Path $InstallDir 'server\.env.example') -Raw
  $content = $content -replace 'NODE_ENV=development', 'NODE_ENV=production'
  $content = $content -replace 'PORT=4000', "PORT=$Port"
  $content = $content -replace 'JWT_ACCESS_SECRET=.*', ("JWT_ACCESS_SECRET=" + [Convert]::ToBase64String($jwt).Replace('+','-').Replace('/','_').TrimEnd('='))
  $content = $content -replace 'ENCRYPTION_KEY=.*', ("ENCRYPTION_KEY=" + [Convert]::ToBase64String($key))
  $content = $content -replace 'BACKUP_DIR=.*', "BACKUP_DIR=$DataDir\backups"
  $content = $content -replace 'UPLOAD_DIR=.*', "UPLOAD_DIR=$DataDir\uploads"
  $content = $content -replace 'WEB_DIST_DIR=.*', ("WEB_DIST_DIR=" + (Join-Path $InstallDir 'web\dist'))
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress
  $content = $content -replace 'PUBLIC_APP_URL=.*', "PUBLIC_APP_URL=http://${ip}:$Port"
  $content = $content -replace 'API_PUBLIC_URL=.*', "API_PUBLIC_URL=http://${ip}:$Port"
  $content = $content -replace 'CORS_ORIGINS=.*', "CORS_ORIGINS=http://${ip}:$Port,http://localhost:$Port"
  Set-Content -Path $envFile -Value $content -Encoding UTF8
  # Restrict the file to Administrators and SYSTEM: it contains the encryption key.
  icacls $envFile /inheritance:r /grant:r "Administrators:F" "SYSTEM:F" | Out-Null
  Write-Host "Created $envFile. BACK UP THIS FILE: without ENCRYPTION_KEY stored secrets cannot be decrypted."
} else { Write-Host 'Keeping existing server\.env' }

Step 'Installing dependencies and building'
Push-Location $InstallDir
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed' }
npm run build
if ($LASTEXITCODE -ne 0) { Fail 'Build failed' }
Pop-Location

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
  if (-not (Get-NetFirewallRule -DisplayName 'Afey POS' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Afey POS' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null
  }
}

Step 'Waiting for the server to start'
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try { $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2; if ($h.status -eq 'ok') { $ok = $true; break } } catch { Start-Sleep -Seconds 2 }
}
if ($ok) {
  Write-Host "`nAfey POS is running." -ForegroundColor Green
  Write-Host "Open http://localhost:$Port on this computer, or http://<this-computer-ip>:$Port on other tills, and complete the setup."
} else {
  Write-Warning "The server did not answer yet. Check: Get-ScheduledTaskInfo AfeyPOS, and docs/TROUBLESHOOTING.md"
}
