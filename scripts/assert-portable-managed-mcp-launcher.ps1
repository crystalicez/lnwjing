<#
Validate the canonical managed Portable MCP launcher without modifying it.
Print exactly the referenced runtime folder name, or refuse on any ambiguity.
Both manual cleanup entrypoints use this shared fail-closed validation.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$LauncherPath)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) {
  throw 'The Portable MCP launcher is missing; refusing cleanup without an active runtime reference'
}
$launcherItem = Get-Item -LiteralPath $LauncherPath -Force
if (-not ($launcherItem -is [IO.FileInfo]) -or
    ($launcherItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    $launcherItem.Length -gt 4096) {
  throw 'Unrecognized or redirected MCP launcher; refusing cleanup'
}

# A signature string alone does not prove ownership: a user can customize the
# previously managed CMD without removing its header. Reconstruct its complete
# canonical contents and refuse any extra commands, substitutions or line edits.
$launcherContents = [IO.File]::ReadAllText($LauncherPath)
$launcherMatch = [regex]::Match($launcherContents, '^@echo off\r\nREM lnwjing-managed-portable-stdio-v1\r\nsetlocal\r\nset "APP=%~dp0(?<runtime>lnwjing-runtime-v\d+\.\d+\.\d+-[A-Za-z0-9_-]+)\\lnwjing\.exe"\r\n')
if (-not $launcherMatch.Success) {
  throw 'Unrecognized MCP launcher; refusing cleanup'
}
$referencedRuntime = $launcherMatch.Groups['runtime'].Value
$expectedLauncher = [string]::Join([Environment]::NewLine, @(
  '@echo off',
  'REM lnwjing-managed-portable-stdio-v1',
  'setlocal',
  ('set "APP=%~dp0' + $referencedRuntime + '\lnwjing.exe"'),
  ('set "BRIDGE=%~dp0' + $referencedRuntime + '\lnwjing-mcp-stdio-bridge.exe"'),
  'if not exist "%APP%" (',
  '  echo lnwjing portable MCP runtime is missing. Launch the Portable EXE first. 1>&2',
  '  exit /b 1',
  ')',
  'if not exist "%BRIDGE%" (',
  '  echo lnwjing portable MCP console bridge is missing. Launch the Portable EXE first. 1>&2',
  '  exit /b 1',
  ')',
  '"%BRIDGE%" "%APP%" --mcp-stdio %*',
  'exit /b %ERRORLEVEL%',
  ''
))
if ($launcherContents -cne $expectedLauncher) {
  throw 'Customized or unrecognized MCP launcher; refusing cleanup'
}
Write-Output $referencedRuntime
