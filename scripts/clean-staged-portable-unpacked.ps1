# Remove only generated, non-running Windows packaging intermediates.
# The verified staged Portable EXE and manifest remain untouched.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$staging = Join-Path $root 'apps\desktop\dist\installers'
$unpacked = Join-Path $staging 'win-unpacked'
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$candidate = Join-Path $staging "lnwjing-Portable-$version.exe"
$manifest = Join-Path $staging 'portable.yml'

if (-not (Test-Path -LiteralPath $unpacked)) {
    Write-Output 'NO_STAGED_UNPACKED_DIRECTORY'
    return
}
foreach ($directory in @($staging, $unpacked)) {
    $item = Get-Item -LiteralPath $directory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing redirected or non-directory build path: $directory"
    }
}
foreach ($file in @($candidate, $manifest)) {
    $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing redirected or non-file staged release candidate: $file"
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'lnwjing.exe') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $unpacked 'resources\app.asar') -PathType Leaf)) {
    throw 'Unpacked tree lacks the expected application payload; refusing deletion'
}
$redirected = Get-ChildItem -LiteralPath $unpacked -Force -Recurse -Attributes ReparsePoint -ErrorAction Stop |
    Select-Object -First 1
if ($null -ne $redirected) { throw 'Refusing build cleanup with nested symlink/junction' }
$prefix = [IO.Path]::GetFullPath($unpacked).TrimEnd('\') + '\'
$active = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
})
if ($active.Count -gt 0) { throw 'Refusing cleanup while a packaged test executable is running' }
if (-not $Apply) {
    Write-Output "WOULD_DELETE_STAGED_UNPACKED=$unpacked"
    return
}
Remove-Item -LiteralPath $unpacked -Recurse -Force -ErrorAction Stop
Write-Output "STAGED_UNPACKED_CLEANED=$unpacked"
Write-Output "PRESERVED_STAGED_EXE=$candidate"
