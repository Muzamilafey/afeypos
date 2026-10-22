# Removes the Afey POS services. Data is KEPT unless -RemoveData is given.
param([switch]$RemoveData, [string]$MongoDataDir = 'C:\AfeyPOS\mongodb', [string]$DataDir = 'C:\AfeyPOS\data')
$ErrorActionPreference = 'Continue'
Stop-ScheduledTask -TaskName 'AfeyPOS'
Unregister-ScheduledTask -TaskName 'AfeyPOS' -Confirm:$false
Unregister-ScheduledTask -TaskName 'AfeyPOS Backup' -Confirm:$false
Stop-Service AfeyMongoDB
sc.exe delete AfeyMongoDB | Out-Null
Get-NetFirewallRule -DisplayName 'Afey POS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($RemoveData) {
  $c = Read-Host "Delete ALL sales, stock and backups in $MongoDataDir and $DataDir? Type DELETE"
  if ($c -eq 'DELETE') { Remove-Item -Recurse -Force $MongoDataDir, $DataDir }
}
Write-Host 'Afey POS services removed.'
