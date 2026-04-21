param(
  [string]$ConversationId = "shared-thread",
  [ValidateSet("realtime", "watch", "sync")]
  [string]$Mode = "realtime"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$env:LOCAL_DB_PATH = ".data/claude-chat.sqlite"
$env:DEFAULT_SOURCE = "claude"

Write-Host "Mode           : $Mode"
Write-Host "Conversation   : $ConversationId"
Write-Host "LOCAL_DB_PATH  : $env:LOCAL_DB_PATH"
Write-Host "DEFAULT_SOURCE : $env:DEFAULT_SOURCE"

Write-Host "Menjalankan backfill history Claude..."
npm run history:backfill -- --source claude

switch ($Mode) {
  "realtime" {
    npm run realtime -- --conversation $ConversationId
  }
  "watch" {
    npm run watch
  }
  "sync" {
    npm run sync
  }
}
