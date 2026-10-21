# Builds the WinRT Windows OCR helper (native/windows-ocr) into
# native/windows-ocr/bin. Requires the .NET SDK 8+ (see
# scripts/check-wave-prereqs.ps1).
[CmdletBinding()]
param(
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$ocrDir = Join-Path $projectRoot 'native\windows-ocr'

$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
  Write-Error 'dotnet CLI not found. Install the .NET SDK 8+ first.'
}

& dotnet publish (Join-Path $ocrDir 'lnwjing-windows-ocr.csproj') `
  -c $Configuration -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:PublishReadyToRun=true `
  -o (Join-Path $ocrDir 'bin')
if ($LASTEXITCODE -ne 0) { Write-Error 'dotnet publish failed.' }

$helper = Join-Path $ocrDir 'bin\lnwjing-windows-ocr.exe'
if (-not (Test-Path $helper)) { Write-Error "Expected helper was not produced: $helper" }
Write-Host "Built $helper"
