# Keeps the Afey POS server running on this computer (started by the 'AfeyPOS' scheduled task at startup and
# every 5 minutes). It waits for the database, starts the server and starts it again whenever it stops, so a
# crash, a power cut or a restart of Windows never leaves the tills without a server. A branch server then
# syncs with head office again by itself as soon as the internet is back.
#
# Upgrades and restores create server\.maintenance while they work: the server is then left stopped.
param([string]$InstallDir = (Resolve-Path "$PSScriptRoot\..\..").Path, [string]$Node = '')

$ErrorActionPreference = 'Continue'
$serverDir = Join-Path $InstallDir 'server'
$flag = Join-Path $serverDir '.maintenance'
$logDir = Join-Path $InstallDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log([string]$msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path (Join-Path $logDir 'keeper.log') -Value $line
}

# One keeper at a time (the 5-minute trigger finds the running one and leaves).
$mutex = New-Object System.Threading.Mutex($false, 'Global\AfeyPOSKeeper')
if (-not $mutex.WaitOne(0)) { exit 0 }

# The installer passes node.exe's full path (SYSTEM's PATH may not have it).
$node = if ($Node -and (Test-Path $Node)) { $Node } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
function PortOpen([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.ConnectAsync('127.0.0.1', $p).Wait(1500) -and $c.Connected } catch { $false } finally { $c.Dispose() }
}
$envFile = Join-Path $serverDir '.env'
$port = 9999
$mongoPort = 0
foreach ($l in (Get-Content $envFile -ErrorAction SilentlyContinue)) {
  if ($l -match '^PORT=(\d+)') { $port = [int]$Matches[1] }
  if ($l -match '^MONGODB_URI=mongodb://[^/]*:(\d+)/') { $mongoPort = [int]$Matches[1] }
}

$delay = 5
Log "keeper started (server port $port)"
while ($true) {
  if (Test-Path $flag) { Start-Sleep -Seconds 10; continue }

  # The database first: start its service if Windows has not yet (or it stopped).
  $svc = Get-Service -Name 'AfeyMongoDB' -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne 'Running') {
    Log 'starting the database service AfeyMongoDB'
    Start-Service -Name 'AfeyMongoDB' -ErrorAction SilentlyContinue
  }
  if ($mongoPort) {
    for ($i = 0; $i -lt 60; $i++) {
      if (PortOpen $mongoPort) { break }
      Start-Sleep -Seconds 2
    }
  }

  # Already running (started by hand, or a keeper that was stopped without its server)? Watch it instead.
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dist\server.js*' }
  if ($running) {
    Wait-Process -Id $running[0].ProcessId -ErrorAction SilentlyContinue
    continue
  }

  $out = Join-Path $logDir ("server-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Log 'starting the server'
  $started = Get-Date
  $p = Start-Process -FilePath $node -ArgumentList '--env-file=.env', 'dist\server.js' -WorkingDirectory $serverDir -NoNewWindow -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  $p.WaitForExit()
  Log "the server stopped (exit code $($p.ExitCode))"

  # Quick restarts; slow down (up to a minute) only when it keeps stopping right after starting.
  if (((Get-Date) - $started).TotalMinutes -gt 2) { $delay = 5 } else { $delay = [Math]::Min(60, $delay * 2) }
  Start-Sleep -Seconds $delay

  # Old logs: keep two weeks.
  Get-ChildItem $logDir -Filter 'server-*.log*' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -ErrorAction SilentlyContinue
}
