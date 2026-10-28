<#
Safely publish a locally built Windows Portable EXE without duplicating its
~270 MiB payload. Preserve the prior EXE and its manifest as rollback
files after SHA-512 verification until the new build has been accepted.
The script touches only the generated project
portable/ and apps/desktop/dist/installers/ folders.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$portable = Join-Path $root 'portable'
$staging = Join-Path $root 'apps\desktop\dist\installers'
$name = "lnwjing-Portable-$version.exe"
$destinationExe = Join-Path $portable $name
$destinationManifest = Join-Path $portable 'portable.yml'
$backupExe = "$destinationExe.lnwjing-build-previous"
$backupManifest = "$destinationManifest.lnwjing-build-previous"
$stagedExe = Join-Path $staging $name
$stagedManifest = Join-Path $staging 'portable.yml'

foreach ($directory in @($portable, $staging)) {
    $item = Get-Item -LiteralPath $directory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing redirected Portable output: $directory"
    }
}
foreach ($file in @($destinationExe, $destinationManifest, $stagedExe, $stagedManifest)) {
    $item = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { continue }
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing redirected Portable file: $file"
    }
}
if (-not (Test-Path -LiteralPath $stagedExe -PathType Leaf) -or -not (Test-Path -LiteralPath $stagedManifest -PathType Leaf)) {
    throw 'Portable staging executable and update manifest must both exist.'
}
# Fail closed if NSIS returned success but omitted any unpacked runtime file.
# Keep this guard even for callers that bypass the one-click build script.
& powershell -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'verify-portable-payload.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Portable payload inventory verification failed; refusing promotion.' }
$hasPreviousExe = Test-Path -LiteralPath $destinationExe -PathType Leaf
$hasPreviousManifest = Test-Path -LiteralPath $destinationManifest -PathType Leaf
if ($hasPreviousExe -ne $hasPreviousManifest) {
    throw 'Existing Portable executable and manifest must be a matching pair; refusing partial replacement.'
}
if ((Test-Path -LiteralPath $backupExe) -or (Test-Path -LiteralPath $backupManifest)) {
    throw 'A previous build rollback already exists. Check it before retrying.'
}
$prefix = [IO.Path]::GetFullPath($portable).TrimEnd('\') + '\'
$active = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
})
if ($active.Count -gt 0) { throw 'Portable or MCP is running from this directory. Close it first.' }

if ($hasPreviousExe) { Move-Item -LiteralPath $destinationExe -Destination $backupExe -ErrorAction Stop }
try {
    if ($hasPreviousManifest) { Move-Item -LiteralPath $destinationManifest -Destination $backupManifest -ErrorAction Stop }
    Move-Item -LiteralPath $stagedExe -Destination $destinationExe -ErrorAction Stop
    Move-Item -LiteralPath $stagedManifest -Destination $destinationManifest -ErrorAction Stop

    $yaml = [IO.File]::ReadAllText($destinationManifest)
    $size = [regex]::Match($yaml, '(?m)^\s+size:\s*(\d+)\s*$')
    $digest = [regex]::Match($yaml, '(?m)^sha512:\s*(\S+)\s*$')
    if (-not $size.Success -or -not $digest.Success) { throw 'Portable update manifest is incomplete.' }
    $file = Get-Item -LiteralPath $destinationExe
    if ($file.Length -ne [long]$size.Groups[1].Value) { throw 'Portable update manifest size mismatch.' }

    $hash = [Security.Cryptography.SHA512]::Create()
    try {
        $stream = [IO.File]::OpenRead($destinationExe)
        try { $actual = [Convert]::ToBase64String($hash.ComputeHash($stream)) }
        finally { $stream.Dispose() }
    } finally { $hash.Dispose() }
    if ($actual -cne $digest.Groups[1].Value) { throw 'Portable update manifest SHA-512 mismatch.' }

    # Keep the previous binary + its matching manifest until the user has
    # verified actual workspaces and MCP in the new Portable. Same-volume
    # renames avoid another ~280 MiB write while providing a rollback route.
    if ($hasPreviousExe) { Write-Host "ROLLBACK_EXE: $backupExe" -ForegroundColor Yellow }
    if ($hasPreviousManifest) { Write-Host "ROLLBACK_MANIFEST: $backupManifest" -ForegroundColor Yellow }
    Write-Host "PORTABLE_VERIFIED: $destinationExe" -ForegroundColor Green
    Write-Host "SIZE_BYTES: $($file.Length)"
} catch {
    # Restoration is non-destructive: move the failed new artifact back to
    # staging and restore old files by same-volume rename, never by deletion.
    if ((Test-Path -LiteralPath $destinationExe) -and -not (Test-Path -LiteralPath $stagedExe)) {
        Move-Item -LiteralPath $destinationExe -Destination $stagedExe -ErrorAction SilentlyContinue
    }
    if ((Test-Path -LiteralPath $destinationManifest) -and -not (Test-Path -LiteralPath $stagedManifest)) {
        Move-Item -LiteralPath $destinationManifest -Destination $stagedManifest -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $backupExe) {
        Move-Item -LiteralPath $backupExe -Destination $destinationExe -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $backupManifest) {
        Move-Item -LiteralPath $backupManifest -Destination $destinationManifest -ErrorAction SilentlyContinue
    }
    throw
}
