param(
  [int]$Port = 3030
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

Write-Host "Dashboard port : $Port"
Write-Host "Database       : $env:LOCAL_DB_PATH"

npm run dashboard -- --port $Port

