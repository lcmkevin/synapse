param(
  [switch]$SkipInstall,
  [switch]$SkipVsix,
  [switch]$SkipBinaries,
  [switch]$BuildBinaries
)

$ErrorActionPreference = "Stop"

if ($args -contains "--SkipInstall") { $SkipInstall = $true }
if ($args -contains "--SkipVsix") { $SkipVsix = $true }
if ($args -contains "--SkipBinaries") { $SkipBinaries = $true }
if ($args -contains "--BuildBinaries") { $BuildBinaries = $true }

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

New-Item -ItemType Directory -Force -Path "dist" | Out-Null

if (-not $SkipInstall) {
  npm install --ignore-scripts
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  npm --prefix extension install --ignore-scripts
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($BuildBinaries -and (-not $SkipBinaries)) {
  npx pkg . --targets node18-win-x64 --output dist/synapse-win-x64.exe
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npx pkg . --targets node18-win-arm64 --output dist/synapse-win-arm64.exe
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Compress-Archive -Path dist/synapse-win-x64.exe -DestinationPath dist/synapse-win-x64.zip -Force
  Compress-Archive -Path dist/synapse-win-arm64.exe -DestinationPath dist/synapse-win-arm64.zip -Force
  Remove-Item dist/synapse-win-x64.exe, dist/synapse-win-arm64.exe -Force
}

if (-not $SkipVsix) {
  npm --prefix extension run compile
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Remove-Item -Recurse -Force extension/node_modules/synapse-cli -ErrorAction SilentlyContinue

  Push-Location extension
  npx @vscode/vsce@2.26.0 package --out ../dist/synapse.vsix
  $exitCode = $LASTEXITCODE
  Pop-Location
  if ($exitCode -ne 0) { exit $exitCode }
}

Get-ChildItem -Path dist -File | Select-Object Name, Length
