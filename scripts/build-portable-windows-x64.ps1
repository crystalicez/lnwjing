[CmdletBinding()]
param(
    [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DOTNET_NOLOGO = '1'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$desktopDirectory = Join-Path $repositoryRoot 'apps\desktop'
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
$artifact = Join-Path $desktopDirectory "dist\installers\lnwjing-Portable-$($package.version).exe"

if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Platform -ne 'Win32NT') {
    throw 'This script requires Windows x64.'
}
$previousRuntimeArch = $env:LNWJING_RUNTIME_ARCH
$previousTunnelArch = $env:LNWJING_TUNNEL_ARCH
$env:LNWJING_RUNTIME_ARCH = 'x64'
$env:LNWJING_TUNNEL_ARCH = 'x64'
$previousPath = $env:PATH
$previousDotnetRoot = $env:DOTNET_ROOT
$cosignShim = $null

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
        Invoke-Step 'Install dependencies (frozen lockfile)' $repositoryRoot 'corepack' @('pnpm@10.15.0', 'install', '--frozen-lockfile', '--prefer-offline')
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
    if ($null -eq (Get-Command cosign -ErrorAction SilentlyContinue)) {
        # WinGet names its official portable binary cosign-windows-amd64.exe. Provide a
        # temporary hardlink on PATH, keeping the Sigstore verification mandatory.
        $installedRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
        $installedCosign = Get-ChildItem -LiteralPath $installedRoot -Recurse -File -Filter 'cosign-windows-amd64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $installedCosign) {
            if ($null -eq (Get-Command winget -ErrorAction SilentlyContinue)) {
                throw 'Cosign >= 3.1.3 is required. Install Sigstore.Cosign through WinGet.'
            }
            Invoke-Step 'Install Sigstore cosign for tunnel verification' $repositoryRoot 'winget' @('install', '--id', 'Sigstore.Cosign', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements')
            $installedCosign = Get-ChildItem -LiteralPath $installedRoot -Recurse -File -Filter 'cosign-windows-amd64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        }
        if ($null -eq $installedCosign) { throw 'Cosign installation was not found. Check WinGet and retry.' }
        $cosignShim = Join-Path $env:TEMP ("lnwjing-cosign-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $cosignShim -Force | Out-Null
        New-Item -ItemType HardLink -Path (Join-Path $cosignShim 'cosign.exe') -Target $installedCosign.FullName | Out-Null
        $env:PATH = "$cosignShim;$env:PATH"
        if ($null -eq (Get-Command cosign -ErrorAction SilentlyContinue)) {
            throw 'Cosign installed but its temporary executable alias is unavailable.'
        }
    }
    Invoke-Step 'Stage tunnel client' $desktopDirectory 'node' @('scripts/prepare-tunnel-client.mjs')
    Invoke-Step 'Stage Windows runtime tools' $desktopDirectory 'node' @('scripts/prepare-runtime-tools.mjs')
    Invoke-Step 'Stage ECC runtime' $desktopDirectory 'node' @('scripts/prepare-ecc-runtime.mjs')
    $localSdkDirectory = Join-Path $repositoryRoot '.local-artifacts\dotnet-sdk-8'
    $localSdkExecutable = Join-Path $localSdkDirectory 'dotnet.exe'
    if (Test-Path -LiteralPath $localSdkExecutable -PathType Leaf) {
        $env:PATH = "$localSdkDirectory;$env:PATH"
        $env:DOTNET_ROOT = $localSdkDirectory
    }
    $sdk = @(& dotnet --list-sdks | Where-Object { $_ -match '^8\.' })
    if ($sdk.Count -eq 0) {
        # Do not require Administrator/UAC. Microsoft's official installer can
        # install SDK 8 in a git-ignored folder on the source drive.
        $toolsDirectory = Join-Path $repositoryRoot '.local-artifacts\build-tools'
        New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null
        $installer = Join-Path $toolsDirectory 'dotnet-install.ps1'
        if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
            Write-Host '==> Download official .NET SDK installer from Microsoft' -ForegroundColor Cyan
            Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer -UseBasicParsing
        }
        Invoke-Step 'Install .NET SDK 8 (per-user local cache)' $repositoryRoot 'powershell' @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-Channel', '8.0', '-Architecture', 'x64', '-InstallDir', $localSdkDirectory, '-NoPath')
        $env:PATH = "$localSdkDirectory;$env:PATH"
        $env:DOTNET_ROOT = $localSdkDirectory
        $sdk = @(& dotnet --list-sdks | Where-Object { $_ -match '^8\.' })
        if ($sdk.Count -eq 0) { throw 'The local .NET SDK 8 installation did not register correctly.' }
    }
    Invoke-Step 'Prepare native Windows OCR' $repositoryRoot 'powershell' @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/prepare-windows-ocr.ps1')
    Invoke-Step 'Build native secret migrator' $repositoryRoot 'powershell' @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-windows-secret-migrator.ps1')
    Invoke-Step 'Compile desktop and workspace packages' $repositoryRoot 'corepack' @('pnpm@10.15.0', '--filter', '@lnwjing/desktop...', 'build')
    Invoke-Step 'Package Portable x64 only (no installer / no publishing)' $desktopDirectory 'corepack' @('pnpm@10.15.0', 'exec', 'electron-builder', '--config', 'electron-builder.yml', '--win', 'portable', '--x64', '--publish', 'never')
    Invoke-Step 'Create portable update manifest' $desktopDirectory 'node' @('scripts/write-portable-update-manifest.mjs')

    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
        throw "Portable executable was not produced: $artifact"
    }
    $file = Get-Item -LiteralPath $artifact
    if ($file.Length -le 0) { throw 'Portable executable has zero bytes.' }
    $hash = Get-FileHash -LiteralPath $artifact -Algorithm SHA256
    Write-Host ''
    Write-Host "SUCCESS: $($file.FullName)" -ForegroundColor Green
    Write-Host "Size: $([math]::Round($file.Length / 1MB, 1)) MiB"
    Write-Host "SHA256: $($hash.Hash)"
} finally {
    $env:LNWJING_RUNTIME_ARCH = $previousRuntimeArch
    $env:LNWJING_TUNNEL_ARCH = $previousTunnelArch
    $env:PATH = $previousPath
    $env:DOTNET_ROOT = $previousDotnetRoot
    if ($null -ne $cosignShim) { Remove-Item -LiteralPath $cosignShim -Recurse -Force -ErrorAction SilentlyContinue }
}
