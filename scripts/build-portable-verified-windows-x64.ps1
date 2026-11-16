<#
Build and publish a Windows x64 Portable release from a verified staged
candidate. This is the Zed one-click entrypoint. All paths are derived from
this script's own project root; it never modifies a user data profile.

Previous rollback pairs are preserved by same-volume moves into .build-history
only after the staged release passes packaged MCP and GUI acceptance.
#>
[CmdletBinding()]
param(
    [switch]$PublishExistingStage,
    [switch]$InstallDependencies,
    [switch]$KeepIntermediates,
    [switch]$PreflightOnly,
    [switch]$SideBySide
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$desktop = Join-Path $root 'apps\desktop'
$staging = Join-Path $desktop 'dist\installers'
$unpacked = Join-Path $staging 'win-unpacked'
$portable = Join-Path $root 'portable'
$name = "lnwjing-Portable-$version.exe"
$currentExe = Join-Path $portable $name
$currentManifest = Join-Path $portable 'portable.yml'
$previousExe = "$currentExe.lnwjing-build-previous"
$previousManifest = "$currentManifest.lnwjing-build-previous"
$stagedExe = Join-Path $staging $name
$stagedManifest = Join-Path $staging 'portable.yml'
$history = Join-Path $portable '.build-history'
$packedElectron = Join-Path $unpacked 'lnwjing.exe'
$packedLauncher = Join-Path $unpacked 'lnwjing-mcp-stdio.cmd'

function Assert-Directory {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Unsafe Portable build directory (not a real directory): $Path"
    }
}

function Assert-FileIfPresent {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and ($item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Unsafe Portable build file: $Path"
    }
}

function Invoke-Checked {
    param([string]$Label, [string]$Cwd, [string]$Program, [string[]]$Arguments)
    Write-Host "==> $Label" -ForegroundColor Cyan
    Push-Location $Cwd
    try {
        & $Program @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

function Clear-VerifiedUnpackedStaging {
    if ($KeepIntermediates -or -not (Test-Path -LiteralPath $unpacked -PathType Container)) { return }
    try {
        Assert-Directory $unpacked
        $redirected = Get-ChildItem -LiteralPath $unpacked -Force -Recurse -Attributes ReparsePoint -ErrorAction Stop |
            Select-Object -First 1
        if ($null -ne $redirected) { throw 'Staging contains a symlink or junction.' }
        $stagingPrefix = [IO.Path]::GetFullPath($unpacked).TrimEnd('\') + '\'
        $active = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath.StartsWith($stagingPrefix, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($active.Count -gt 0) { throw 'Packaged Electron from staging is still running.' }
        Remove-Item -LiteralPath $unpacked -Recurse -Force -ErrorAction Stop
        Write-Host 'CLEANED_VERIFIED_STAGING: win-unpacked' -ForegroundColor Green
    } catch {
        Write-Warning ('Verified Portable is preserved; staging cleanup skipped: ' + $_.Exception.Message)
    }
}

if (-not [Environment]::Is64BitOperatingSystem -or
    [Environment]::OSVersion.Platform -ne 'Win32NT') {
    throw 'This build requires Windows x64.'
}
Assert-Directory $root
Assert-Directory $desktop
foreach ($directory in @($staging, $portable)) {
    if (Test-Path -LiteralPath $directory) {
        Assert-Directory $directory
    } elseif (-not $PreflightOnly) {
        New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop | Out-Null
        Assert-Directory $directory
    }
}
foreach ($file in @($currentExe, $currentManifest, $previousExe, $previousManifest,
    $stagedExe, $stagedManifest)) {
    Assert-FileIfPresent $file
}
if ((Test-Path -LiteralPath $currentExe -PathType Leaf) -ne
    (Test-Path -LiteralPath $currentManifest -PathType Leaf)) {
    throw 'Current Portable EXE and manifest must be a matching pair.'
}
if ((Test-Path -LiteralPath $previousExe -PathType Leaf) -ne
    (Test-Path -LiteralPath $previousManifest -PathType Leaf)) {
    throw 'Previous rollback EXE and manifest must be a matching pair.'
}
if (Test-Path -LiteralPath $history) { Assert-Directory $history }
if ($PublishExistingStage) {
    if (-not (Test-Path -LiteralPath $stagedExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $stagedManifest -PathType Leaf)) {
        throw 'No complete staged Portable candidate; run the build task first.'
    }
} elseif ((Test-Path -LiteralPath $stagedExe) -or (Test-Path -LiteralPath $stagedManifest)) {
    throw 'A staged candidate already exists. Publish it or inspect it before rebuilding.'
}

# Never replace an EXE while its portable runtime/MCP is active.
$prefix = [IO.Path]::GetFullPath($portable).TrimEnd('\') + '\'
$running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
})
if ($running.Count -gt 0 -and -not $SideBySide) {
    throw 'Close lnwjing Portable and its MCP runtime before publishing a new EXE.'
}
if ($PreflightOnly) {
    Write-Host "PREFLIGHT_OK: $name" -ForegroundColor Green
    Write-Host "MODE: $(if ($PublishExistingStage) { 'publish staged' } else { 'build + publish' })$(if ($SideBySide) { ' side-by-side' })"
    Write-Host "ROLLBACK_PAIR_PRESENT: $(Test-Path -LiteralPath $previousExe)"
    return
}

if (-not $PublishExistingStage) {
    $builderArguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $PSScriptRoot 'build-portable-windows-x64.ps1'), '-StageOnly')
    if (-not $InstallDependencies) { $builderArguments += '-SkipInstall' }
    Invoke-Checked 'Build a verified staged Portable x64 release' $root 'powershell.exe' $builderArguments
}
foreach ($file in @($stagedExe, $stagedManifest, $packedElectron, $packedLauncher)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Packaged release is incomplete: $file"
    }
    Assert-FileIfPresent $file
}

# Test the very same win-unpacked tree that the Portable payload was built from.
# A failed acceptance run keeps the previous published EXE untouched.
$originalRunElectronStdio = $env:LNWJING_RUN_ELECTRON_STDIO
$originalPackagedExe = $env:LNWJING_STDIO_PACKAGED_EXE
$originalLauncher = $env:LNWJING_STDIO_LAUNCHER_CMD
$originalGuiExe = $env:LNWJING_PACKAGED_EXECUTABLE
try {
    $env:LNWJING_RUN_ELECTRON_STDIO = '1'
    $env:LNWJING_STDIO_PACKAGED_EXE = $packedElectron
    $env:LNWJING_STDIO_LAUNCHER_CMD = $packedLauncher
    Invoke-Checked 'Packaged MCP bridge and CMD launcher acceptance' $root 'corepack' @(
        'pnpm@10.15.0', '--filter', '@lnwjing/desktop', 'exec', 'vitest',
        'run', '--config', 'vitest.config.ts',
        'tests/desktop-stdio-electron-acceptance.test.ts', '-t', 'discovers modern MCP'
    )
    $env:LNWJING_PACKAGED_EXECUTABLE = $packedElectron
    Invoke-Checked 'Packaged GUI layout, Tools visibility and Running Projects acceptance' $desktop 'corepack' @(
        'pnpm@10.15.0', 'exec', 'playwright', 'test',
        'e2e/layout-space-efficiency.e2e.ts', 'e2e/tools-doctor.e2e.ts',
        'e2e/running-projects-controls.e2e.ts',
        '--grep', 'all ten screens use the working viewport|normal runtime renders the full first-party catalog|Running Projects scrolls',
        '--config', 'playwright.config.ts', '--workers=1'
    )
} finally {
    $env:LNWJING_RUN_ELECTRON_STDIO = $originalRunElectronStdio
    $env:LNWJING_STDIO_PACKAGED_EXE = $originalPackagedExe
    $env:LNWJING_STDIO_LAUNCHER_CMD = $originalLauncher
    $env:LNWJING_PACKAGED_EXECUTABLE = $originalGuiExe
}

# Side-by-side output is intentionally independent of the running Portable,
# its update feed and its rollback pair. Keep the original basename and the
# manifest together so hashes and update metadata continue to match.
if ($SideBySide) {
    $readyDirectory = Join-Path $portable ("ready-$version-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-$PID")
    if (Test-Path -LiteralPath $readyDirectory) {
        throw "Refusing to overwrite an existing candidate: $readyDirectory"
    }
    New-Item -ItemType Directory -Path $readyDirectory -ErrorAction Stop | Out-Null
    Assert-Directory $readyDirectory
    $readyExe = Join-Path $readyDirectory $name
    $readyManifest = Join-Path $readyDirectory 'portable.yml'
    Move-Item -LiteralPath $stagedExe -Destination $readyExe -ErrorAction Stop
    try {
        Move-Item -LiteralPath $stagedManifest -Destination $readyManifest -ErrorAction Stop
    } catch {
        Move-Item -LiteralPath $readyExe -Destination $stagedExe -ErrorAction Stop
        throw
    }
    Clear-VerifiedUnpackedStaging
    Write-Host "READY_PORTABLE: $readyExe" -ForegroundColor Green
    Write-Host "READY_MANIFEST: $readyManifest"
    Write-Host 'EXISTING_PORTABLE_AND_ROLLBACK_UNCHANGED'
    exit 0
}

# Preserve the older rollback only after the new candidate has passed every
# check. Renames on the same volume avoid rewriting a ~270 MiB binary.
$archiveDirectory = $null
if (Test-Path -LiteralPath $previousExe -PathType Leaf) {
    if (-not (Test-Path -LiteralPath $history)) {
        New-Item -ItemType Directory -Path $history -ErrorAction Stop | Out-Null
    }
    Assert-Directory $history
    $archiveDirectory = Join-Path $history ((Get-Date -Format 'yyyyMMdd-HHmmss') + "-previous-$PID")
    if (Test-Path -LiteralPath $archiveDirectory) {
        throw "Refusing to overwrite existing Portable rollback archive: $archiveDirectory"
    }
    New-Item -ItemType Directory -Path $archiveDirectory -ErrorAction Stop | Out-Null
    try {
        Move-Item -LiteralPath $previousExe -Destination (Join-Path $archiveDirectory $name) -ErrorAction Stop
        Move-Item -LiteralPath $previousManifest -Destination (Join-Path $archiveDirectory 'portable.yml') -ErrorAction Stop
    } catch {
        $movedExe = Join-Path $archiveDirectory $name
        if ((Test-Path -LiteralPath $movedExe) -and -not (Test-Path -LiteralPath $previousExe)) {
            Move-Item -LiteralPath $movedExe -Destination $previousExe -ErrorAction SilentlyContinue
        }
        throw
    }
    Write-Host "ARCHIVED_PRIOR_ROLLBACK: $archiveDirectory" -ForegroundColor Yellow
}

try {
    Invoke-Checked 'Publish SHA-512-verified Portable with current rollback' $root 'powershell.exe' @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $PSScriptRoot 'promote-portable-build.ps1')
    )
} catch {
    if ($null -ne $archiveDirectory -and -not (Test-Path -LiteralPath $previousExe) -and
        -not (Test-Path -LiteralPath $previousManifest)) {
        # The promotion script itself restores the published EXE on failure.
        # Restore our older rollback pair too if it has not been replaced.
        $archivedExe = Join-Path $archiveDirectory $name
        $archivedManifest = Join-Path $archiveDirectory 'portable.yml'
        if ((Test-Path -LiteralPath $archivedExe) -and (Test-Path -LiteralPath $archivedManifest)) {
            Move-Item -LiteralPath $archivedExe -Destination $previousExe -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $archivedManifest -Destination $previousManifest -ErrorAction SilentlyContinue
        }
    }
    throw
}

if (-not (Test-Path -LiteralPath $currentExe -PathType Leaf) -or
    -not (Test-Path -LiteralPath $currentManifest -PathType Leaf)) {
    throw 'Portable promotion returned without a complete published pair.'
}
Clear-VerifiedUnpackedStaging
Write-Host "SUCCESS: $currentExe" -ForegroundColor Green
Write-Host "SIZE_BYTES: $((Get-Item -LiteralPath $currentExe).Length)"

# Retain a prior working binary but discard only the generated unpacked builder
# tree after successful promotion. Never touch extracted Portable runtimes.
if (-not $KeepIntermediates -and (Test-Path -LiteralPath $unpacked -PathType Container)) {
    try {
        Assert-Directory $unpacked
        $redirected = Get-ChildItem -LiteralPath $unpacked -Force -Recurse -Attributes ReparsePoint -ErrorAction Stop |
            Select-Object -First 1
        if ($null -ne $redirected) { throw 'Nested symlink/junction in builder staging.' }
        $unpackedPrefix = [IO.Path]::GetFullPath($unpacked).TrimEnd('\') + '\'
        $active = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath.StartsWith($unpackedPrefix, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($active.Count -gt 0) { throw 'Packaged test runtime is still running.' }
        Remove-Item -LiteralPath $unpacked -Recurse -Force -ErrorAction Stop
        Write-Host 'CLEANED_TEMPORARY_WIN_UNPACKED' -ForegroundColor Green
    } catch {
        Write-Warning "Published EXE is verified, but optional builder cleanup was skipped: $($_.Exception.Message)"
    }
}
