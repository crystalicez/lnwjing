[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$KeepIntermediates
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DOTNET_NOLOGO = '1'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$desktopDirectory = Join-Path $repositoryRoot 'apps\desktop'
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
# electron-builder stages all Windows targets in dist/installers. The one-click
# Portable build MOVES its final artifact into a small root-level output folder
# so old unpacked runtimes and intermediate builder files never clutter it.
$stagedArtifact = Join-Path $desktopDirectory "dist\installers\lnwjing-Portable-$($package.version).exe"
$stagedManifest = Join-Path $desktopDirectory 'dist\installers\portable.yml'
$portableDirectory = Join-Path $repositoryRoot 'portable'
$artifact = Join-Path $portableDirectory "lnwjing-Portable-$($package.version).exe"

if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Platform -ne 'Win32NT') {
    throw 'This script requires Windows x64.'
}
$previousRuntimeArch = $env:LNWJING_RUNTIME_ARCH
$previousTunnelArch = $env:LNWJING_TUNNEL_ARCH
$env:LNWJING_RUNTIME_ARCH = 'x64'
$env:LNWJING_TUNNEL_ARCH = 'x64'
$previousPath = $env:PATH
$previousDotnetRoot = $env:DOTNET_ROOT
$previousCosignPath = $env:LNWJING_COSIGN_PATH

function Invoke-Step {
    param([string]$Label, [string]$Directory, [string]$Executable, [string[]]$Arguments)
    Write-Host "==> $Label" -ForegroundColor Cyan
    Push-Location $Directory
    try {
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

try {
    if (-not $SkipInstall) {
        # A double-click build must never block on pnpm's purge/reinstall question.
        # Scope CI=true to installation so packaging keeps its normal local behavior.
        $previousCI = $env:CI
        try {
            $env:CI = 'true'
            Invoke-Step 'Install dependencies (frozen lockfile)' $repositoryRoot 'corepack' @('pnpm@10.15.0', 'install', '--frozen-lockfile', '--prefer-offline')
        } finally {
            $env:CI = $previousCI
        }
    }
    Invoke-Step 'Install Electron runtime' $repositoryRoot 'corepack' @('pnpm@10.15.0', '--filter', '@lnwjing/desktop', 'electron:install')
    # Use an isolated .NET 8 SDK under the ignored build tree, without altering the system installation.
    $sdkAvailable = $false
    if ($null -ne (Get-Command dotnet -ErrorAction SilentlyContinue)) {
        $sdkAvailable = @(& dotnet --list-sdks 2>$null | Where-Object { $_ -match '^8\.' }).Count -gt 0
    }
    if (-not $sdkAvailable) {
        $sdkDir = Join-Path $desktopDirectory 'build\\dotnet-sdk'
        $sdkExe = Join-Path $sdkDir 'dotnet.exe'
        $bootstrap = Join-Path $sdkDir 'dotnet-install.ps1'
        New-Item -ItemType Directory -Force -Path $sdkDir | Out-Null
        if (-not (Test-Path -LiteralPath $sdkExe -PathType Leaf)) {
            Write-Host '==> Download official .NET 8 SDK into local build cache' -ForegroundColor Cyan
            Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $bootstrap -UseBasicParsing
            & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $bootstrap -Channel '8.0' -Architecture 'x64' -InstallDir $sdkDir -NoPath
            if ($LASTEXITCODE -ne 0) { throw 'Local .NET 8 SDK installation failed' }
        }
        if (-not (Test-Path -LiteralPath $sdkExe -PathType Leaf)) { throw 'Local .NET 8 SDK executable was not found' }
        $env:DOTNET_ROOT = $sdkDir
        $env:PATH = "$sdkDir;$env:PATH"
        $sdkAvailable = @(& $sdkExe --list-sdks | Where-Object { $_ -match '^8\.' }).Count -gt 0
        if (-not $sdkAvailable) { throw 'Local .NET SDK does not provide version 8' }
    }
    if ([string]::IsNullOrWhiteSpace($env:LNWJING_COSIGN_PATH) -and $null -eq (Get-Command cosign -ErrorAction SilentlyContinue)) {
        # The tunnel stager supports LNWJING_COSIGN_PATH directly. Use WinGet's
        # executable without a temporary hardlink or full package-tree scan.
        $installedRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
        $installedCosign = Get-ChildItem -LiteralPath $installedRoot -Directory -Filter 'Sigstore.Cosign_*' -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Filter 'cosign-windows-amd64.exe' -ErrorAction SilentlyContinue } |
            Select-Object -First 1
        if ($null -eq $installedCosign) {
            if ($null -eq (Get-Command winget -ErrorAction SilentlyContinue)) {
                throw 'Cosign >= 3.1.3 is required. Install Sigstore.Cosign through WinGet.'
            }
            Invoke-Step 'Install Sigstore cosign for tunnel verification' $repositoryRoot 'winget' @('install', '--id', 'Sigstore.Cosign', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements')
            $installedCosign = Get-ChildItem -LiteralPath $installedRoot -Directory -Filter 'Sigstore.Cosign_*' -ErrorAction SilentlyContinue |
                ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Filter 'cosign-windows-amd64.exe' -ErrorAction SilentlyContinue } |
                Select-Object -First 1
        }
        if ($null -eq $installedCosign) { throw 'Cosign installation was not found. Check WinGet and retry.' }
        $env:LNWJING_COSIGN_PATH = $installedCosign.FullName
    }
    # The runtime-tools stager also invokes the tunnel-client stager.
    # Do not stage it twice: each pass re-extracts and verifies the archive.
    Invoke-Step 'Stage Windows runtime tools (including tunnel client)' $desktopDirectory 'node' @('scripts/prepare-runtime-tools.mjs')
    Invoke-Step 'Stage ECC runtime' $desktopDirectory 'node' @('scripts/prepare-ecc-runtime.mjs')
    Invoke-Step 'Prepare native Windows OCR' $repositoryRoot 'powershell' @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/prepare-windows-ocr.ps1')
    Invoke-Step 'Build native secret migrator' $repositoryRoot 'powershell' @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-windows-secret-migrator.ps1')
    Invoke-Step 'Compile desktop and workspace packages' $repositoryRoot 'corepack' @('pnpm@10.15.0', '--filter', '@lnwjing/desktop...', 'build')
    Invoke-Step 'Package Portable x64 only (no installer / no publishing)' $desktopDirectory 'corepack' @('pnpm@10.15.0', 'exec', 'electron-builder', '--config', 'electron-builder.yml', '--win', 'portable', '--x64', '--publish', 'never')
    # Manifest generation computes SHA512 and SHA256 in ONE streaming read of the EXE.
    # Do not reread ~270 MiB with PowerShell Get-FileHash after the move.
    $manifestOutput = Invoke-Step 'Create portable update manifest' $desktopDirectory 'node' @('scripts/write-portable-update-manifest.mjs')
    $manifestText = $manifestOutput -join "`n"
    if ($manifestText -notmatch 'SHA256:\s*([A-Fa-f0-9]{64})') { throw 'Portable checksum was not produced by manifest generation.' }
    $artifactSha256 = $Matches[1].ToUpperInvariant()

    if (-not (Test-Path -LiteralPath $stagedArtifact -PathType Leaf)) {
        throw "Portable executable was not produced: $stagedArtifact"
    }
    if (-not (Test-Path -LiteralPath $stagedManifest -PathType Leaf)) {
        throw "Portable update manifest was not produced: $stagedManifest"
    }
    $stagedFile = Get-Item -LiteralPath $stagedArtifact
    if ($stagedFile.Length -le 0) { throw 'Portable executable has zero bytes.' }

    # Rename on the same volume instead of copying ~270 MiB. This output folder
    # is generated/ignored; do not touch runtime directories from prior launches.
    New-Item -ItemType Directory -Path $portableDirectory -Force | Out-Null
    $outputFolder = Get-Item -LiteralPath $portableDirectory -Force
    if (($outputFolder.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Portable output directory must not be a symlink or junction.'
    }
    foreach ($destination in @($artifact, (Join-Path $portableDirectory 'portable.yml'))) {
        if (Test-Path -LiteralPath $destination) {
            $existing = Get-Item -LiteralPath $destination -Force
            if ($existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to overwrite a non-file or redirected Portable output: $destination"
            }
        }
    }
    Move-Item -LiteralPath $stagedArtifact -Destination $artifact -Force
    Move-Item -LiteralPath $stagedManifest -Destination (Join-Path $portableDirectory 'portable.yml') -Force

    $file = Get-Item -LiteralPath $artifact
    if ($file.Length -ne $stagedFile.Length) { throw 'Portable artifact size changed while moving it.' }
    # Same-volume Move-Item preserves bytes; size is verified above and the
    # SHA256 was derived from the streaming manifest staging pass (unsigned local build).
    Write-Host ''
    Write-Host "SUCCESS: $($file.FullName)" -ForegroundColor Green
    Write-Host "Size: $([math]::Round($file.Length / 1MB, 1)) MiB"
    Write-Host "SHA256: $artifactSha256"

    # win-unpacked is a temporary electron-builder staging tree (~700 MiB),
    # not the installed Portable runtime. Reclaim it only AFTER the final
    # artifact is safely published. Preserve it on request for diagnostics.
    if (-not $KeepIntermediates) {
        $stagingDirectory = Join-Path $desktopDirectory 'dist\installers\win-unpacked'
        if (Test-Path -LiteralPath $stagingDirectory -PathType Container) {
            try {
                $stagingItem = Get-Item -LiteralPath $stagingDirectory -Force
                if (($stagingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw 'Refusing to remove a redirected builder staging directory.'
                }
                $redirected = Get-ChildItem -LiteralPath $stagingDirectory -Force -Recurse -Attributes ReparsePoint -ErrorAction Stop | Select-Object -First 1
                if ($null -ne $redirected) { throw 'Refusing builder cleanup with nested symlink/junctions.' }
                $prefix = [IO.Path]::GetFullPath($stagingDirectory).TrimEnd('\') + '\'
                $running = @(Get-CimInstance Win32_Process | Where-Object {
                    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
                })
                if ($running.Count -gt 0) { throw 'Builder staging executable is still running.' }
                Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction Stop
                Write-Host 'Cleaned temporary win-unpacked staging tree.'
            } catch {
                Write-Warning ('Builder staging cleanup skipped: ' + $_.Exception.Message)
            }
        }
    }
} finally {
    $env:LNWJING_RUNTIME_ARCH = $previousRuntimeArch
    $env:LNWJING_TUNNEL_ARCH = $previousTunnelArch
    $env:PATH = $previousPath
    $env:DOTNET_ROOT = $previousDotnetRoot
    $env:LNWJING_COSIGN_PATH = $previousCosignPath
}
