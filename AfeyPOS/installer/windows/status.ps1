# Quick health check for support calls.
param([int]$Port = 4000)
Get-Service AfeyMongoDB | Format-Table -AutoSize
Get-ScheduledTask -TaskName 'AfeyPOS' | Get-ScheduledTaskInfo | Format-List LastRunTime, LastTaskResult, NextRunTime
try { Invoke-RestMethod "http://127.0.0.1:$Port/health" | ConvertTo-Json -Depth 4 } catch { Write-Warning "Server not responding on port ${Port}: $_" }
