param(
  [ValidateSet("win-x64", "win-arm64")]
  [string]$Runtime = "win-x64"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $root "tray\CodexHud.Tray.csproj"
$output = Join-Path $root "tray\publish\$Runtime"

dotnet publish $project -c Release -r $Runtime --self-contained true -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o $output
Copy-Item (Join-Path $root "codex-hud.ps1") $output -Force
Copy-Item (Join-Path $root "hud.js") $output -Force
Copy-Item (Join-Path $root "config.json") $output -Force
Copy-Item (Join-Path $root "openai.ico") $output -Force
Write-Host "Published tray executable to $output\CodexHud.Tray.exe"
