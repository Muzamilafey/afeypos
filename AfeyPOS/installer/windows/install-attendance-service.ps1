# Installs and starts the local attendance kiosk as a Windows startup task.
param([Parameter(Mandatory = $true)][string]$InstallDir, [Parameter(Mandatory = $true)][string]$NodePath)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run AfeyPOS-Attendance.cmd and approve the administrator prompt to install the startup task.' }

$root = [IO.Path]::GetFullPath($InstallDir)
$node = (Resolve-Path -LiteralPath $NodePath).Path
$npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
if (-not (Test-Path $npm)) { throw "npm.cmd was not found beside Node at $node." }
$attendanceIndex = Join-Path $root 'attendance\dist\index.html'
if (-not (Test-Path $attendanceIndex)) {
  Write-Host 'Building the attendance web app...'
  Push-Location $root
  try { & $npm run build -w @afeypos/attendance; if ($LASTEXITCODE -ne 0) { throw 'Attendance build failed.' } }
  finally { Pop-Location }
}
if (-not (Test-Path $attendanceIndex)) { throw 'The attendance web app build did not produce attendance\dist\index.html.' }

$taskName = 'AfeyPOS Attendance'
$serviceScript = Join-Path $root 'installer\windows\attendance-service.ps1'
$taskArgs = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$serviceScript`" -InstallDir `"$root`" -NodePath `"$node`""
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $taskArgs -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

$url = 'http://127.0.0.1:5175/'
$bridgeFile = Join-Path $root 'bridge\config.json'
try {
  $bridge = Get-Content -LiteralPath $bridgeFile -Raw | ConvertFrom-Json
  $bridgePort = 0
  if ($bridge.pairingToken -and $bridge.pairingToken.Length -ge 24 -and [int]::TryParse([string]$bridge.port, [ref]$bridgePort) -and $bridgePort -gt 0 -and $bridgePort -le 65535) {
    $url += '#bridgeUrl=' + [Uri]::EscapeDataString("http://127.0.0.1:$bridgePort") + '&bridgeToken=' + [Uri]::EscapeDataString($bridge.pairingToken)
  }
} catch { }

$ready = $false
$until = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $until) {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:5175/' -UseBasicParsing -TimeoutSec 3
    if ($response.Content -match '<title>Afey POS Attendance</title>') { $ready = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'The startup task was installed, but the attendance page did not answer on port 5175. Check logs\attendance-terminal.log.' }
Start-Process $url
Write-Host "Attendance terminal is ready at http://127.0.0.1:5175/ and will start when this computer reboots."
Write-Host "Windows startup task: $taskName"
