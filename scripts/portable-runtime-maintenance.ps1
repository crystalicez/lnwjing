<#
Portable runtime maintenance. Dry run by default; never touch user profile,
AppData, unrelated folders, unknown runtime names, or the outer Portable EXE.
Apply only when no executable is running anywhere under portable/.
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [ValidateRange(1, 10)][int]$KeepLatest = 1,
    [ValidateRange(1, 365)][int]$MinimumAgeDays = 7,
    [switch]$IncludePartial
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$portableDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'portable'
if (-not (Test-Path -LiteralPath $portableDir -PathType Container)) {
    Write-Host 'No local Portable directory: nothing to maintain.'
    exit 0
}
$root = Get-Item -LiteralPath $portableDir -Force
if (($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Refusing to clean a Portable folder that is a junction/symlink.'
}
$rootPath = [IO.Path]::GetFullPath($root.FullName).TrimEnd('\') + '\'
$now = Get-Date
$launcher = Join-Path $root.FullName 'lnwjing-mcp-stdio.cmd'
$referencedRuntime = $null
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
    $referencedRuntime = & (Join-Path $PSScriptRoot 'assert-portable-managed-mcp-launcher.ps1') -LauncherPath $launcher
}
$runtimePattern = '^lnwjing-runtime-v(?<version>\d+\.\d+\.\d+)-(?<build>[A-Za-z0-9_-]+)$'
$partialPattern = '^lnwjing-runtime-v\d+\.\d+\.\d+-[A-Za-z0-9_-]+\.partial-\d+$'
$directories = @(Get-ChildItem -LiteralPath $root.FullName -Force -Directory | Where-Object {
    $_.Name -match $runtimePattern
} | Sort-Object LastWriteTimeUtc -Descending)
$preserved = @($directories | Select-Object -First $KeepLatest | ForEach-Object { $_.FullName })
$candidates = @()
foreach ($directory in $directories) {
    if ($directory.FullName -in $preserved) { continue }
    if (($now - $directory.LastWriteTime).TotalDays -lt $MinimumAgeDays) { continue }
    if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    if ($directory.Name -ceq $referencedRuntime) { continue }
    if ($directory.Name -cnotmatch $runtimePattern) { continue }
    $expected = "lnwjing-v$($Matches['version'])-$($Matches['build'])"
    $ready = Join-Path $directory.FullName '.lnwjing-ready'
    $exe = Join-Path $directory.FullName 'lnwjing.exe'
    if (-not (Test-Path -LiteralPath $ready -PathType Leaf) -or
        -not (Test-Path -LiteralPath $exe -PathType Leaf)) { continue }
    if ([IO.File]::ReadAllText($ready) -cne $expected) { continue }
    $candidates += $directory
}
if ($IncludePartial) {
    foreach ($directory in @(Get-ChildItem -LiteralPath $root.FullName -Force -Directory)) {
        if ($directory.Name -notmatch $partialPattern) { continue }
        if (($now - $directory.LastWriteTime).TotalDays -lt $MinimumAgeDays) { continue }
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        $candidates += $directory
    }
}
if ($candidates.Count -eq 0) {
    Write-Host 'No eligible stale Portable runtime directories. No files changed.'
    exit 0
}
if ($null -eq $referencedRuntime) {
    throw 'The Portable MCP launcher is missing; refusing cleanup without an active runtime reference'
}
foreach ($candidate in $candidates) {
    Write-Host ("{0}: {1}" -f $(if($Apply){'Proposed cleanup'}else{'DRY-RUN'}), $candidate.FullName)
}
if (-not $Apply) {
    Write-Host 'No files changed. To apply, run this script with -Apply.'
    exit 0
}
# Fail closed if any Portable executable or subprocess is active. The outer
# NSIS launcher remains alive while the inner Electron host is running.
$inUse = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)
})
if ($inUse.Count -gt 0) {
    throw 'Portable executable activity detected. Close Portable and its MCP clients; no files removed.'
}
foreach ($candidate in $candidates) {
    # Avoid recursively following a nested junction/reparse point into a
    # user project. Scan metadata only after explicit -Apply.
    $redirect = @(Get-ChildItem -LiteralPath $candidate.FullName -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop | Select-Object -First 1)
    if ($redirect.Count -gt 0) {
        Write-Warning ("Skipped redirected candidate: " + $candidate.FullName)
        continue
    }
    Remove-Item -LiteralPath $candidate.FullName -Recurse -Force -ErrorAction Stop
    Write-Host ("Removed: " + $candidate.FullName)
}
