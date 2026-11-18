<#
.SYNOPSIS
  Installs the Afey device bridge on a till PC (Windows 10/11): receipt printer, cash drawer, scale, customer
  display and fingerprint reader for Afey POS in the browser.

.DESCRIPTION
  In PowerShell "Run as administrator", on the till PC:

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-bridge.ps1))) -ServerUrl http://192.168.1.50:9999

  -ServerUrl is the address the tills open Afey POS on (the shop server, e.g. http://192.168.1.50:9999, or the
  online one, e.g. https://walalaha.afey.co.ke). It installs Node.js 22 if missing, builds the bridge in
  C:\AfeyBridge, makes a pairing token, starts the bridge with Windows (restarting it if it stops) and prints the
  token to paste in Afey POS (Hardware > This computer: device bridge). Run it again to update: config.json
  (token, printers, fingerprint reader) is kept.
#>
param(
  [string]$ServerUrl = '',
  # More addresses the tills open Afey POS on (e.g. both the shop server and the online one).
  [string[]]$ExtraOrigins = @(),
  [int]$Port = 9123,
  [string]$Root = 'C:\AfeyBridge',
  [string]$Repo = 'Muzamilafey/afeypos',
  [string]$Ref = $(if ($env:AFEY_REF) { $env:AFEY_REF } else { 'HEAD' }),
  # Take the bridge, already built, from this Afey POS server (.../api/v1/public/bridge/files): no GitHub, no build.
  [string]$SourceUrl = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Green }
function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; throw $m }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Open PowerShell with "Run as administrator" and run the command again.' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

$app = Join-Path $Root 'app'
$configFile = Join-Path $app 'bridge\config.json'
$existing = if (Test-Path $configFile) { Get-Content $configFile -Raw | ConvertFrom-Json } else { $null }
if (-not $ServerUrl -and $existing) { $ServerUrl = $existing.server.url }
if (-not $ServerUrl) { Fail 'Give the address the tills open Afey POS on, e.g. -ServerUrl http://192.168.1.50:9999 (or https://yourshop.afey.co.ke).' }
try { $origin = ([Uri]$ServerUrl).GetLeftPart([UriPartial]::Authority) } catch { Fail "-ServerUrl $ServerUrl is not a valid address" }

$tmp = Join-Path $env:TEMP "afeybridge-$(Get-Date -Format yyyyMMddHHmmss)"
New-Item -ItemType Directory -Force -Path $tmp, $Root, (Join-Path $Root 'logs') | Out-Null

function Get-File($url, $dest) {
  $headers = @{}
  if ($env:GITHUB_TOKEN -and $url -like '*github*') { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
  for ($i = 1; $i -le 3; $i++) {
    try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -Headers $headers; return } catch { if ($i -eq 3) { Fail "Download failed: $url ($($_.Exception.Message))" }; Start-Sleep -Seconds (2 * $i) }
  }
}
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

# ---------- Node.js ----------
Step 'Node.js'
Update-Path
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  $v = (node -v).TrimStart('v').Split('.') | ForEach-Object { [int]$_ }
  $nodeOk = $v[0] -ge 22
}
if ($nodeOk) { Write-Host "Node.js $(node -v) found" } else {
  $rel = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing) | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1
  $file = "node-$($rel.version)-$arch.msi"
  Write-Host "Downloading Node.js $($rel.version)"
  Get-File "https://nodejs.org/dist/$($rel.version)/$file" "$tmp\$file"
  Get-File "https://nodejs.org/dist/$($rel.version)/SHASUMS256.txt" "$tmp\node-sums.txt"
  $sum = (Select-String -Path "$tmp\node-sums.txt" -Pattern " $([regex]::Escape($file))$").Line.Split(' ')[0]
  if ((Get-FileHash -Algorithm SHA256 "$tmp\$file").Hash.ToLower() -ne $sum.ToLower()) { Fail "Checksum mismatch for $file" }
  $p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$tmp\$file`"", '/qn', '/norestart') -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "Node.js installer failed (code $($p.ExitCode))" }
  Update-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js was installed but is not on PATH yet. Close PowerShell, open it again as administrator and rerun the command.' }
}
$nodeExe = (Get-Command node).Source

# ---------- the bridge ----------
function Stop-Bridge {
  Stop-ScheduledTask -TaskName 'AfeyBridge' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='node.exe'" | Where-Object { $_.CommandLine -like '*AfeyBridge*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
New-Item -ItemType Directory -Force -Path (Join-Path $app 'bridge') | Out-Null
if ($SourceUrl) {
  # The Afey POS server hands out the bridge it built itself.
  Step "Getting the device bridge from $origin"
  try { $pack = Invoke-RestMethod -Uri $SourceUrl -UseBasicParsing -TimeoutSec 60 } catch { Fail "Could not get the bridge from $SourceUrl ($($_.Exception.Message)). Is Afey POS reachable from this PC?" }
  if (-not $pack.files) { Fail "The server did not send the bridge files ($SourceUrl)" }
  Stop-Bridge
  $dist = Join-Path $app 'bridge\dist'
  if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
  foreach ($f in $pack.files.PSObject.Properties) {
    if ($f.Name -match '\.\.' -or $f.Name -match '^[\\/]' -or $f.Name -match ':') { continue }
    $target = Join-Path (Join-Path $app 'bridge') ($f.Name -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    [IO.File]::WriteAllText($target, [string]$f.Value, (New-Object Text.UTF8Encoding $false))
  }
} else {
  Step "Downloading the device bridge ($Repo, $Ref)"
  Get-File "https://codeload.github.com/$Repo/zip/$Ref" "$tmp\afeypos.zip"
  Expand-Archive -Path "$tmp\afeypos.zip" -DestinationPath "$tmp\src" -Force
  $top = (Get-ChildItem "$tmp\src" -Directory | Select-Object -First 1).FullName
  $src = if (Test-Path "$top\AfeyPOS\bridge\package.json") { "$top\AfeyPOS" } elseif (Test-Path "$top\bridge\package.json") { $top } else { Fail "The download does not contain the device bridge ($Repo, $Ref)" }
  Stop-Bridge
  Copy-Item "$src\tsconfig.base.json" (Join-Path $app 'tsconfig.base.json') -Force
  robocopy "$src\bridge" (Join-Path $app 'bridge') /MIR /XD node_modules dist /XF config.json /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "Copying the bridge failed (robocopy code $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0

  Step 'Building the bridge'
  Push-Location (Join-Path $app 'bridge')
  & npm install --no-save --no-package-lock --no-audit --no-fund typescript@5.9.3 '@types/node@22.18.8' | Out-Host
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'Installing the build tools failed (see above). Check the internet connection and run the command again.' }
  & npx tsc -p tsconfig.json | Out-Host
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'Building the bridge failed (see above).' }
  Pop-Location
}
if (-not (Test-Path (Join-Path $app 'bridge\dist\index.js'))) { Fail 'The bridge files are incomplete. Run the installer again.' }

# ---------- config.json (kept on updates) ----------
Step 'Configuration'
$origins = @($origin) + $ExtraOrigins + @("http://localhost:9999", "http://127.0.0.1:9999")
if ($existing) {
  $cfg = $existing
  $cfg | Add-Member -NotePropertyName server -NotePropertyValue ([pscustomobject]@{ url = $ServerUrl }) -Force
  $cfg | Add-Member -NotePropertyName allowedOrigins -NotePropertyValue @(@($existing.allowedOrigins) + $origins | Where-Object { $_ } | Select-Object -Unique) -Force
  $cfg | Add-Member -NotePropertyName port -NotePropertyValue $Port -Force
  Write-Host 'Kept the pairing token, printers and fingerprint reader of this PC.'
} else {
  $bytes = New-Object byte[] 36
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ([Convert]::ToBase64String($bytes)).Replace('+', 'A').Replace('/', 'B').Replace('=', '')
  $cfg = [ordered]@{
    port = $Port; host = '127.0.0.1'; allowedOrigins = @($origins | Select-Object -Unique); pairingToken = $token
    server = @{ url = $ServerUrl }; biometricDevice = @{ deviceId = ''; deviceKey = '' }; printers = @{}
    display = $null; scale = $null; fingerprint = @{ vendor = 'simulator' }
  }
}
# Written without a BOM: the bridge reads it as plain UTF-8 JSON.
[IO.File]::WriteAllText($configFile, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
$token = (Get-Content $configFile -Raw | ConvertFrom-Json).pairingToken

# ---------- start with Windows, restart if it stops ----------
Step 'Starting the bridge with Windows'
$runner = Join-Path $Root 'run-bridge.cmd'
@"
@echo off
rem Keeps the Afey device bridge running: started at boot by the AfeyBridge task, restarted if it stops.
cd /d "$app\bridge"
:loop
"$nodeExe" "$app\bridge\dist\index.js" >> "$Root\logs\bridge.log" 2>&1
timeout /t 5 /nobreak > nul
goto loop
"@ | Set-Content -Path $runner -Encoding ASCII
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'AfeyBridge' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName 'AfeyBridge'

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  try { $s = Invoke-RestMethod "http://127.0.0.1:$Port/status" -Headers @{ 'X-Afey-Bridge-Token' = $token } -TimeoutSec 2; if ($s.ok) { $ok = $true; break } } catch { Start-Sleep -Seconds 1 }
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

$ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -ExpandProperty IPAddress) -join ', '
Write-Host ''
if ($ok) { Write-Host 'The Afey device bridge is running.' -ForegroundColor Green } else { Write-Host "The bridge did not answer yet. Check $Root\logs\bridge.log" -ForegroundColor Yellow }
Write-Host ''
Write-Host 'In Afey POS on THIS PC: Hardware > This computer: device bridge' -ForegroundColor Cyan
Write-Host "  Bridge address : http://127.0.0.1:$Port"
Write-Host "  Pairing token  : $token"
Write-Host "  Then: Test connection, choose 'Straight to the receipt printer (device bridge)', pick the printer, Print test."
Write-Host ''
Write-Host "Afey POS server : $ServerUrl"
Write-Host "This PC's IP    : $ips"
Write-Host "Config          : $configFile   Log: $Root\logs\bridge.log"
