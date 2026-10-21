<#Requires -Version 5.1
.SYNOPSIS
Starts the lnwjing Secure MCP Tunnel against the running Desktop loopback HTTP
MCP with long TTL, file logging, and automatic restart when the tunnel drops.

.DESCRIPTION
- Uses a transient CONTROL_PLANE_API_KEY supplied by the Desktop safe-storage path; it never decrypts a secret itself.
- Runs `tunnel-client doctor` then `tunnel-client run`
- Passes --mcp.connection-max-ttl 168h0m0s so ChatGPT connections do not drop every 10 minutes
- Writes tunnel logs to %APPDATA%\tunnel-client\lnwjing-tunnel.log (tailed by the lnwjing dashboard)
- Requires the profile to target lnwjing Desktop's loopback HTTP MCP
- Starts lnwjing Desktop first when it is not already running; Desktop Settings own Active Project, permission profile, and native approvals
- Restarts the tunnel automatically when tunnel-client exits for any reason including TTL (exit 0)
- Opens the lnwjing log viewer window after start (use -NoViewer to skip)

.PARAMETER TunnelClientPath
Path to tunnel-client.exe. Defaults to the tunnel-client bundled with the per-user lnwjing installation.

.PARAMETER LnwjingPath
Path to lnwjing.exe (desktop app / viewer). Defaults to the per-user install location
%LOCALAPPDATA%\Programs\lnwjing\lnwjing.exe

.PARAMETER NoViewer
Do not open the lnwjing log viewer window.

.PARAMETER OpenDashboard
Open the full desktop dashboard instead of the small log viewer window.

.PARAMETER ForceRestart
Retained for compatibility. It cannot bypass the ownership lock and never stops a tunnel owned by another launcher.

.PARAMETER Once
Run tunnel-client once and exit with its code. Default is to keep restarting.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-lnwjing-tunnel.ps1"
#>

param(
  [string]$TunnelClientPath,
  [string]$LnwjingPath,
  [switch]$NoViewer,
  [switch]$OpenDashboard,
  [switch]$ForceRestart,
  [switch]$Once
)

# Auto-load .env if available
$repoRoot = Split-Path -Parent $PSScriptRoot
$candidateEnvFiles = @(
  (Join-Path $repoRoot '.env'),
  (Join-Path (Get-Location) '.env')
)
foreach ($envFile in $candidateEnvFiles) {
  if (Test-Path -LiteralPath $envFile) {
    Get-Content $envFile | ForEach-Object {
      $line = $_.Trim()
      if ($line -and -not $line.StartsWith('#') -and $line -match '^([^=]+)=(.*)$') {
        $envKey = $matches[1].Trim()
        $envVal = $matches[2].Trim().Trim('"').Trim("'")
        if (-not [System.Environment]::GetEnvironmentVariable($envKey)) {
          [System.Environment]::SetEnvironmentVariable($envKey, $envVal, [System.EnvironmentVariableTarget]::Process)
        }
      }
    }
    break
  }
}

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ([string]::IsNullOrWhiteSpace($LnwjingPath)) {
  $LnwjingPath = if ($env:LNWJING_PATH) { $env:LNWJING_PATH } else { Join-Path $env:LOCALAPPDATA 'Programs\lnwjing\lnwjing.exe' }
}
if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) {
  $TunnelClientPath = if ($env:LNWJING_TUNNEL_CLIENT_PATH) {
    $env:LNWJING_TUNNEL_CLIENT_PATH
  } else {
    Join-Path (Split-Path -Parent $LnwjingPath) 'resources\tunnel-client\tunnel-client.exe'
  }
}

$profileName = 'lnwjing'
$profileDir = Join-Path $env:APPDATA 'tunnel-client'
$logPath = Join-Path $profileDir 'lnwjing-tunnel.log'
$stopFile = Join-Path $profileDir 'lnwjing.tunnel.stop'
$mcpTtl = '168h0m0s'
$maxRapidRestarts = 5
$rapidRestartCount = 0
$rapidRestartWindowStarted = Get-Date

if (-not (Test-Path $TunnelClientPath)) { throw "Missing tunnel-client: $TunnelClientPath" }

function Test-LnwjingTunnelRunning {
  $probe = Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '(?i)(--profile\s+lnwjing|lnwjing\.yaml)' }
  return [bool]$probe
}

function Test-LnwjingTunnelStopRequested {
  if ($env:LNWJING_TUNNEL_STOP -eq '1' -or $env:LNWJING_TUNNEL_STOP -eq 'true') { return $true }
  return Test-Path -LiteralPath $stopFile
}

function Get-LnwjingTunnelExitHint {
  if (-not (Test-Path -LiteralPath $logPath)) { return '' }
  $tail = @(Get-Content -LiteralPath $logPath -Tail 120 -ErrorAction SilentlyContinue)
  $pattern = 'TTL reached|stdio MCP command exited|MCP server|server_url|requesting tunnel-client shutdown'
  $hit = $tail | Where-Object { $_ -match $pattern } | Select-Object -Last 1
  if ([string]::IsNullOrWhiteSpace($hit)) { return '' }
  $compact = ([regex]::Replace([string]$hit, '\s+', ' ')).Trim()
  if ($compact.Length -gt 180) { $compact = $compact.Substring(0, 177) + "..." }
  return (' -- ' + $compact)
}

# Secure Tunnel forwards to the Desktop HTTP MCP. Desktop Settings, not this
# transport-only launcher process, own Active Project and authorization policy.
# Long connection ceiling so ChatGPT does not drop every 10 minutes (tunnel-client default).
$env:MCP_CONNECTION_MAX_TTL = $mcpTtl
$env:TUNNEL_CLIENT_PROFILE_DIR = $profileDir

$scriptRootResolved = (Resolve-Path -LiteralPath $PSScriptRoot -ErrorAction Stop).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
$lockHelperRequested = Join-Path $PSScriptRoot 'lib\\lnwjing-tunnel-lock.ps1'
$lockHelperResolved = (Resolve-Path -LiteralPath $lockHelperRequested -ErrorAction Stop).Path
$lockHelperItem = Get-Item -LiteralPath $lockHelperResolved -Force -ErrorAction Stop
$trustedPrefix = $scriptRootResolved + [IO.Path]::DirectorySeparatorChar
if (-not $lockHelperResolved.StartsWith($trustedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Tunnel lock helper resolved outside the trusted script directory.'
}
if ($lockHelperItem.PSIsContainer -or (($lockHelperItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
  throw 'Tunnel lock helper must be a trusted regular file, not a directory or reparse point.'
}
. $lockHelperResolved
$lockOwner = $null
try {
  $selfProbe = Get-LnwjingTunnelProcessProbe -OwnerPid $PID
  if ($selfProbe.state -ne 'live') { throw "Could not verify launcher process ownership: $($selfProbe.reason)" }
  $lockClaim = Enter-LnwjingTunnelLock -ProfileDir $profileDir -OwnerPid $PID -OwnerStartedAt $selfProbe.processStartedAt -ProcessStartProvider { param($ownerPid) Get-LnwjingTunnelProcessProbe -OwnerPid $ownerPid }
  if (-not $lockClaim.acquired) {
    Write-Host ("lnwjing tunnel is already owned by PID {0} (started {1})." -f $lockClaim.owner.pid, $lockClaim.owner.processStartedAt)
    exit 0
  }
  $lockOwner = $lockClaim.owner
  # Only the winning owner may clear a previous session's stop marker.
  if ((Test-LnwjingTunnelLockOwner -Left $lockOwner -Right $lockClaim.owner) -and (Test-Path -LiteralPath $stopFile)) {
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction Stop
  }
  if ($ForceRestart) { Write-Host 'lnwjing tunnel: -ForceRestart cannot bypass the ownership lock.' }
  if (Test-LnwjingTunnelRunning) { Write-Host 'lnwjing tunnel: existing tunnel-client process detected as status evidence; the lock remains authoritative.' }
  if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
    throw 'CONTROL_PLANE_API_KEY is not set. Use Desktop Start Tunnel so Electron safeStorage can supply the key; this compatibility launcher never decrypts secret files.'
  }
  $profilePath = Join-Path $profileDir 'lnwjing.yaml'
  if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { throw "Missing tunnel profile: $profilePath. Open lnwjing Desktop and run Configure Tunnel first." }
  $profileText = Get-Content -LiteralPath $profilePath -Raw
  if ($profileText -notmatch '(?m)^\s*server_urls:\s*$' -or $profileText -notmatch '(?i)https?://(?:127\.0\.0\.1|localhost|\[?::1\]?):\d+/mcp') {
    throw 'Tunnel profile is not configured for lnwjing Desktop HTTP MCP. Open lnwjing Desktop and run Configure Tunnel again.'
  }
  if (-not (Test-Path -LiteralPath $LnwjingPath -PathType Leaf)) { throw "Missing lnwjing Desktop executable: $LnwjingPath" }
  $desktopWasStarted = $false
  if ($null -eq (Get-Process -Name 'lnwjing' -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    Write-Host 'lnwjing tunnel: starting Desktop host required for HTTP MCP and native approvals ...'
    if (-not $NoViewer -and -not $OpenDashboard) {
      Start-Process -FilePath $LnwjingPath -ArgumentList @('--log-viewer')
    } else {
      Start-Process -FilePath $LnwjingPath
    }
    $desktopWasStarted = $true
    Start-Sleep -Seconds 2
  }

  Write-Host "lnwjing tunnel: running doctor ..."
  & $TunnelClientPath doctor --profile $profileName --profile-dir $profileDir --explain
  if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor failed with exit code $LASTEXITCODE" }

  Write-Host "lnwjing tunnel: starting (TTL $mcpTtl, log: $logPath)"
  Write-Host 'lnwjing tunnel: MCP target = Desktop loopback HTTP; Desktop Settings own Active Project and approvals.'
  Write-Host 'lnwjing tunnel: auto-restart is ON (TTL/exit 0 still restarts). Ctrl+C or LNWJING_TUNNEL_STOP=1 to stop.'

  if (-not $desktopWasStarted -and -not $NoViewer -and (Test-Path $LnwjingPath)) {
    if ($OpenDashboard) {
      Start-Process -FilePath $LnwjingPath
    } else {
      Start-Process -FilePath $LnwjingPath -ArgumentList @('--log-viewer')
    }
  }

  while ($true) {
    if (Test-LnwjingTunnelStopRequested) {
      Write-Host 'lnwjing tunnel: stop requested.'
      exit 0
    }

    & $TunnelClientPath run --profile $profileName --profile-dir $profileDir --log.file $logPath --mcp.connection-max-ttl $mcpTtl
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = -1 }
    $hint = Get-LnwjingTunnelExitHint

    if ($Once) {
      Write-Host ("lnwjing tunnel: tunnel-client exited ({0}){1}" -f $exitCode, $hint)
      exit $exitCode
    }
    if (Test-LnwjingTunnelStopRequested) {
      Write-Host ("lnwjing tunnel: stop requested after exit ({0}){1}" -f $exitCode, $hint)
      exit 0
    }

    $elapsed = ((Get-Date) - $rapidRestartWindowStarted).TotalSeconds
    if ($elapsed -gt 30) {
      $rapidRestartCount = 0
      $rapidRestartWindowStarted = Get-Date
    }
    $rapidRestartCount += 1
    if ($rapidRestartCount -gt $maxRapidRestarts) {
      throw ("tunnel-client exited {0} times in a short window; automatic restart paused. Fix the Desktop MCP/profile and start again.{1}" -f $maxRapidRestarts, $hint)
    }
    $delaySeconds = [int][Math]::Min(30, 3 * [Math]::Pow(2, $rapidRestartCount - 1))
    Write-Host ("lnwjing tunnel: tunnel-client exited ({0}){1} - restarting in {2} seconds (attempt {3}/{4}) ..." -f $exitCode, $hint, $delaySeconds, $rapidRestartCount, $maxRapidRestarts)
    Start-Sleep -Seconds $delaySeconds
  }
}
finally {
  Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:TUNNEL_CLIENT_PROFILE_DIR -ErrorAction SilentlyContinue
  if ($null -ne $lockOwner) {
    $released = Release-LnwjingTunnelLock -ProfileDir $profileDir -Owner $lockOwner
    if (-not $released) { throw 'Tunnel ownership release could not be confirmed; the lock was retained for retry' }
  }
}
