param(
  [string]$ConversationId = "",
  [string]$ProjectName = "cloud-sync",
  [string]$ClaudeHome = "",
  [switch]$Full
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$env:LOCAL_DB_PATH = ".data/claude-chat.sqlite"
$env:DEFAULT_SOURCE = "claude"

Write-Host "Mode           : native pull claude"
Write-Host "Conversation   : $ConversationId"
Write-Host "ProjectName    : $ProjectName"
Write-Host "ClaudeHome     : $(if ($ClaudeHome) { $ClaudeHome } else { '[default ~/.claude]' })"
Write-Host "LOCAL_DB_PATH  : $env:LOCAL_DB_PATH"
Write-Host "DEFAULT_SOURCE : $env:DEFAULT_SOURCE"

Write-Host "Menarik update terbaru dari cloud..."
npm run sync

Write-Host "Menulis mirror thread ke native Claude..."
$argsList = @("run", "native:writeback", "--", "--target", "claude", "--project-name", $ProjectName)
if ($ConversationId) {
  $argsList += @("--conversation", $ConversationId)
}
if ($ClaudeHome) {
  $argsList += @("--claude-home", $ClaudeHome)
}
if ($Full) {
  $argsList += "--full"
}

npm @argsList
