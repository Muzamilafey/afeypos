# Quick health check for support calls.
param([int]$Port = 9999)
Get-Service AfeyMongoDB | Format-Table -AutoSize
Get-ScheduledTask -TaskName 'AfeyPOS' | Get-ScheduledTaskInfo | Format-List LastRunTime, LastTaskResult, NextRunTime
$keeperLog = Join-Path (Resolve-Path "$PSScriptRoot\..\..").Path 'logs\keeper.log'
if (Test-Path $keeperLog) { Write-Host 'Last starts and stops of the server:'; Get-Content $keeperLog -Tail 8 }
if (Test-Path (Join-Path (Resolve-Path "$PSScriptRoot\..\..").Path 'server\.maintenance')) { Write-Warning 'server\.maintenance exists: the server is kept stopped (an upgrade or restore did not finish). Delete it to start again.' }
try { Invoke-RestMethod "http://127.0.0.1:$Port/health" | ConvertTo-Json -Depth 4 } catch { Write-Warning "Server not responding on port ${Port}: $_" }
