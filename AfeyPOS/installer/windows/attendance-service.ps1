# Long-running local web server for the attendance kiosk. Registered as the SYSTEM startup task.
param([Parameter(Mandatory = $true)][string]$InstallDir, [Parameter(Mandatory = $true)][string]$NodePath)

$ErrorActionPreference = 'Continue'
$root = [IO.Path]::GetFullPath($InstallDir)
$nodeDir = Split-Path -Parent $NodePath
$npm = Join-Path $nodeDir 'npm.cmd'
$env:PATH = "$nodeDir;$env:PATH"
$logDir = Join-Path $root 'logs'
$logFile = Join-Path $logDir 'attendance-terminal.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location $root

function Log([string]$Message) {
  Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
}

if (-not (Test-Path $npm)) { Log "npm.cmd was not found beside Node at $NodePath"; exit 1 }
Log 'Attendance terminal service started (127.0.0.1:5175)'
while ($true) {
  try {
    & $npm run preview -w @afeypos/attendance -- --host 127.0.0.1 --port 5175 --strictPort 2>&1 | ForEach-Object {
      Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $_"
    }
    $code = $LASTEXITCODE
    Log "Attendance web server exited with code $code; restarting in five seconds"
  } catch {
    Log "Attendance web server failed: $($_.Exception.Message); retrying in five seconds"
  }
  Start-Sleep -Seconds 5
}
