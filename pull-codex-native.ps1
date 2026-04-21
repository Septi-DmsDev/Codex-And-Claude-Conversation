param(
  [string]$ConversationId = "",
  [string]$CodexHome = "",
  [switch]$Full
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$env:LOCAL_DB_PATH = ".data/codex-chat.sqlite"
$env:DEFAULT_SOURCE = "codex"

Write-Host "Mode           : native pull codex"
Write-Host "Conversation   : $ConversationId"
Write-Host "CodexHome      : $(if ($CodexHome) { $CodexHome } else { '[default ~/.codex]' })"
Write-Host "LOCAL_DB_PATH  : $env:LOCAL_DB_PATH"
Write-Host "DEFAULT_SOURCE : $env:DEFAULT_SOURCE"

Write-Host "Menarik update terbaru dari cloud..."
npm run sync

Write-Host "Menulis mirror thread ke native Codex..."
$argsList = @("run", "native:writeback", "--", "--target", "codex")
if ($ConversationId) {
  $argsList += @("--conversation", $ConversationId)
}
if ($CodexHome) {
  $argsList += @("--codex-home", $CodexHome)
}
if ($Full) {
  $argsList += "--full"
}

npm @argsList
