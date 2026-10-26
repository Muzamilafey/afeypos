<#
.SYNOPSIS
  One-line Afey POS installer for Windows 10/11 and Windows Server: downloads and installs everything.

.DESCRIPTION
  In PowerShell "Run as administrator":

    irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-online.ps1 | iex

  With options (head office, another port...):

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-online.ps1))) -Mode hq -PublicUrl https://hq.myshop.co.ke

  It installs Node.js 22 LTS and MongoDB 8 when missing (official installers, checksums verified), downloads Afey POS
  to C:\AfeyPOS\app, then runs installer\windows\install.ps1: database service with a replica set, configuration with
  new secrets, build, the AfeyPOS startup task, daily backups and the firewall rule. Run it again to upgrade: data
  and server\.env are kept.
#>
[CmdletBinding()]
param(
  [ValidateSet('standalone', 'hq', 'branch')][string]$Mode = $(if ($env:AFEY_MODE) { $env:AFEY_MODE } else { 'standalone' }),
  [int]$Port = $(if ($env:AFEY_PORT) { [int]$env:AFEY_PORT } else { 4000 }),
  [string]$PublicUrl = $env:AFEY_PUBLIC_URL,
  [string]$HqUrl = '',
  [string]$SyncToken = '',
  [string]$BranchCode = '',
  [string]$Root = 'C:\AfeyPOS',
  [string]$Repo = 'Muzamilafey/afeypos',
  [string]$Ref = $(if ($env:AFEY_REF) { $env:AFEY_REF } else { 'HEAD' }),
  [string]$MongoVersion = '8.0.4',
  [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is much faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Green }
function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; throw $m }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Open PowerShell with "Run as administrator" and run the command again.' }
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Afey POS needs 64-bit Windows.' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

$tmp = Join-Path $env:TEMP "afeypos-install-$(Get-Date -Format yyyyMMddHHmmss)"
New-Item -ItemType Directory -Force -Path $tmp, $Root | Out-Null

function Get-File($url, $dest) {
  $headers = @{}
  if ($env:GITHUB_TOKEN -and $url -like '*github*') { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
  for ($i = 1; $i -le 3; $i++) {
    try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -Headers $headers; return } catch { if ($i -eq 3) { Fail "Download failed: $url ($($_.Exception.Message))" }; Start-Sleep -Seconds (2 * $i) }
  }
}
function Assert-Sha256($file, $expected) {
  $actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
  if ($actual -ne $expected.Trim().ToLower()) { Fail "Checksum mismatch for $(Split-Path $file -Leaf)" }
}
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Install-Msi($file, $extra) {
  $log = "$file.log"
  $p = Start-Process msiexec.exe -ArgumentList (@('/i', "`"$file`"", '/qn', '/norestart', '/l*v', "`"$log`"") + $extra) -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "Installer $(Split-Path $file -Leaf) failed (code $($p.ExitCode)); see $log" }
}

# ---------- Node.js ----------
Step 'Node.js'
Update-Path
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  $v = (node -v).TrimStart('v').Split('.') | ForEach-Object { [int]$_ }
  $nodeOk = ($v[0] -gt 22) -or ($v[0] -eq 22 -and $v[1] -ge 9)
}
if ($nodeOk) { Write-Host "Node.js $(node -v) found" } else {
  $rel = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing) | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1
  $file = "node-$($rel.version)-$arch.msi"
  Write-Host "Downloading Node.js $($rel.version)"
  Get-File "https://nodejs.org/dist/$($rel.version)/$file" "$tmp\$file"
  Get-File "https://nodejs.org/dist/$($rel.version)/SHASUMS256.txt" "$tmp\node-sums.txt"
  $sum = (Select-String -Path "$tmp\node-sums.txt" -Pattern " $([regex]::Escape($file))$").Line.Split(' ')[0]
  Assert-Sha256 "$tmp\$file" $sum
  Install-Msi "$tmp\$file" @()
  Update-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js was installed but is not on PATH yet. Close PowerShell, open it again as administrator and rerun the command.' }
  Write-Host "Node.js $(node -v) installed"
}

# ---------- MongoDB ----------
Step 'MongoDB'
$mongod = Get-Command mongod -ErrorAction SilentlyContinue
if (-not $mongod) { $mongod = Get-ChildItem 'C:\Program Files\MongoDB\Server\*\bin\mongod.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 }
if ($mongod) { Write-Host "MongoDB found" } else {
  if ($arch -ne 'x64') { Fail 'MongoDB for Windows is only available for x64. Use an x64 PC as the server.' }
  $file = "mongodb-windows-x86_64-$MongoVersion-signed.msi"
  Write-Host "Downloading MongoDB $MongoVersion"
  Get-File "https://fastdl.mongodb.org/windows/$file" "$tmp\$file"
  Get-File "https://fastdl.mongodb.org/windows/$file.sha256" "$tmp\$file.sha256"
  Assert-Sha256 "$tmp\$file" ((Get-Content "$tmp\$file.sha256" -Raw).Split(' ')[0])
  # Server without its own service: install.ps1 creates the AfeyMongoDB service with a replica set.
  Install-Msi "$tmp\$file" @('ADDLOCAL="ServerNoService"', 'SHOULD_INSTALL_COMPASS="0"')
  Write-Host 'MongoDB installed'
}

# ---------- Afey POS ----------
Step "Downloading Afey POS ($Repo, $Ref)"
$app = Join-Path $Root 'app'
Get-File "https://codeload.github.com/$Repo/zip/$Ref" "$tmp\afeypos.zip"
Expand-Archive -Path "$tmp\afeypos.zip" -DestinationPath "$tmp\src" -Force
$top = (Get-ChildItem "$tmp\src" -Directory | Select-Object -First 1).FullName
$src = if (Test-Path "$top\AfeyPOS\package.json") { "$top\AfeyPOS" } elseif (Test-Path "$top\package.json") { $top } else { Fail "The download does not contain Afey POS ($Repo, $Ref)" }
Stop-ScheduledTask -TaskName 'AfeyPOS' -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $app | Out-Null
# Mirror the new version; keep the configuration, data and installed packages.
robocopy $src $app /MIR /XD node_modules data .git /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "Copying the files to $app failed (robocopy code $LASTEXITCODE)" }
$global:LASTEXITCODE = 0

# ---------- install / upgrade ----------
$installArgs = @{ Mode = $Mode; Port = $Port; InstallDir = $app; DataDir = (Join-Path $Root 'data'); MongoDataDir = (Join-Path $Root 'mongodb') }
if ($PublicUrl) { $installArgs.PublicUrl = $PublicUrl }
if ($HqUrl) { $installArgs.HqUrl = $HqUrl }
if ($SyncToken) { $installArgs.SyncToken = $SyncToken }
if ($BranchCode) { $installArgs.BranchCode = $BranchCode }
if ($SkipFirewall) { $installArgs.SkipFirewall = $true }
& (Join-Path $app 'installer\windows\install.ps1') @installArgs
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
