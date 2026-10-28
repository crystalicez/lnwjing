# Verify the complete NSIS payload *before* creating a release manifest or
# replacing any usable Portable. 7z only lists the archive; it never unpacks
# ~700 MiB to disk. This catches electron-builder exit-0 partial payloads.
[CmdletBinding()]
param([string]$CandidateExe)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$staging = Join-Path $root 'apps\desktop\dist\installers'
$exe = if ([string]::IsNullOrWhiteSpace($CandidateExe)) {
    Join-Path $staging "lnwjing-Portable-$version.exe"
} else {
    # Diagnostic override is for testing the fail-closed behavior only.
    # Production build/promote scripts never pass this option.
    $candidate = [IO.Path]::GetFullPath((Join-Path $root $CandidateExe))
    if (-not $candidate.StartsWith(([IO.Path]::GetFullPath($root).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Diagnostic candidate must remain within the repository.'
    }
    $candidate
}
$unpacked = Join-Path $staging 'win-unpacked'

foreach ($directory in @($staging, $unpacked)) {
    $item = Get-Item -LiteralPath $directory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Portable payload verification refuses redirected directory: $directory"
    }
}
$exeItem = Get-Item -LiteralPath $exe -Force
if ($exeItem.PSIsContainer -or ($exeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Portable executable is redirected or not a regular file.'
}
$sevenZip = Get-Command '7z' -ErrorAction SilentlyContinue
if ($null -eq $sevenZip) { $sevenZip = Get-Command '7za' -ErrorAction SilentlyContinue }
if ($null -eq $sevenZip) {
    throw 'Portable archive verification requires 7-Zip CLI (7z or 7za) on PATH; refusing unverified release.'
}
# -slt prints NSIS File commands with paths rooted at $R6. Do not treat the
# outer EXE, plugin DLL or metadata entries as extracted runtime files.
$listing = @(& $sevenZip.Source l -slt -- $exe 2>&1)
if ($LASTEXITCODE -ne 0) { throw "7-Zip could not inspect Portable NSIS archive (exit $LASTEXITCODE)." }
$actual = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($line in $listing) {
    if ($line -isnot [string] -or -not $line.StartsWith('Path = $R6\', [StringComparison]::Ordinal)) { continue }
    $relativePath = $line.Substring('Path = $R6\'.Length)
    if ([string]::IsNullOrEmpty($relativePath) -or
        $relativePath.StartsWith('\') -or
        $relativePath.Contains('..\') -or
        -not $actual.Add($relativePath)) {
        throw "Portable archive has an invalid or duplicate runtime entry: $relativePath"
    }
}
$expectedCount = 0
foreach ($file in Get-ChildItem -LiteralPath $unpacked -Recurse -File -Force -ErrorAction Stop) {
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing redirected file in unpacked runtime: $($file.FullName)"
    }
    $relativePath = $file.FullName.Substring($unpacked.TrimEnd('\').Length + 1)
    if (-not $actual.Remove($relativePath)) {
        throw "Portable NSIS payload is missing unpacked file: $relativePath"
    }
    $expectedCount++
}
if ($expectedCount -lt 1000 -or $actual.Count -ne 0) {
    throw "Portable NSIS inventory mismatch (unpacked=$expectedCount, unexpected archive files=$($actual.Count))."
}
Write-Output "PORTABLE_PAYLOAD_VERIFIED: $expectedCount complete files"
