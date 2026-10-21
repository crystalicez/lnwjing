function Test-LnwjingTunnelLockInteger {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][long]$Minimum,
    [Parameter(Mandatory = $true)][long]$Maximum
  )

  if ($null -eq $Value) { return $false }
  $numericTypes = @(
    [TypeCode]::Byte, [TypeCode]::SByte, [TypeCode]::Int16, [TypeCode]::UInt16,
    [TypeCode]::Int32, [TypeCode]::UInt32, [TypeCode]::Int64, [TypeCode]::UInt64,
    [TypeCode]::Single, [TypeCode]::Double, [TypeCode]::Decimal
  )
  if ($numericTypes -notcontains [Type]::GetTypeCode($Value.GetType())) { return $false }
  try {
    $numeric = [decimal]$Value
    return $numeric -eq [decimal]::Truncate($numeric) -and $numeric -ge $Minimum -and $numeric -le $Maximum
  } catch { return $false }
}

function Test-LnwjingTunnelLockTimestamp {
  param([Parameter(Mandatory = $true)]$Value)

  if ($Value -isnot [string] -or $Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') { return $false }
  $parsed = [DateTimeOffset]::MinValue
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  if (-not [DateTimeOffset]::TryParseExact($Value, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) { return $false }
  return $parsed.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture) -ceq $Value
}

function Test-LnwjingTunnelLockRecord {
  param([Parameter(Mandatory = $true)]$Record)

  return $null -ne $Record `
    -and (Test-LnwjingTunnelLockInteger -Value $Record.version -Minimum 1 -Maximum 1) `
    -and (Test-LnwjingTunnelLockInteger -Value $Record.pid -Minimum 1 -Maximum 2147483647) `
    -and (Test-LnwjingTunnelLockTimestamp -Value $Record.processStartedAt) `
    -and (Test-LnwjingTunnelLockTimestamp -Value $Record.acquiredAt)
}

function Read-LnwjingTunnelLockRecord {
  param([Parameter(Mandatory = $true)][string]$LockPath)

  try {
    $record = Get-Content -LiteralPath $LockPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if (Test-LnwjingTunnelLockRecord -Record $record) { return $record }
  } catch { }
  return $null
}

function Test-LnwjingTunnelLockOwner {
  param(
    [Parameter(Mandatory = $true)]$Left,
    [Parameter(Mandatory = $true)]$Right
  )

  if ($null -eq $Left -or $null -eq $Right) { return $false }
  return ([long]$Left.pid -eq [long]$Right.pid) `
    -and (([string]$Left.processStartedAt) -ceq ([string]$Right.processStartedAt)) `
    -and (([string]$Left.acquiredAt) -ceq ([string]$Right.acquiredAt))
}

function Restore-LnwjingTunnelLockQuarantine {
  param(
    [Parameter(Mandatory = $true)][string]$QuarantinePath,
    [Parameter(Mandatory = $true)][string]$LockPath
  )

  if (-not (Test-Path -LiteralPath $QuarantinePath)) { return }
  try { [IO.File]::Move($QuarantinePath, $LockPath) } catch [IO.IOException] { }
}

function Get-LnwjingTunnelLockMutexName {
  param([Parameter(Mandatory = $true)][string]$ProfileDir)

  $normalized = [IO.Path]::GetFullPath($ProfileDir).TrimEnd([char[]]@([char]'\', [char]'/')).ToLowerInvariant()
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash(([Text.UTF8Encoding]::new($false)).GetBytes($normalized))
    $hex = -join ($hash | ForEach-Object { $_.ToString('x2', [Globalization.CultureInfo]::InvariantCulture) })
    return 'Local\lnwjing-tunnel-lock-' + $hex.Substring(0, 24)
  } finally { $sha.Dispose() }
}

function Invoke-LnwjingTunnelLockCriticalSection {
  param(
    [Parameter(Mandatory = $true)][string]$ProfileDir,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )

  $mutex = [Threading.Mutex]::new($false, (Get-LnwjingTunnelLockMutexName -ProfileDir $ProfileDir))
  $held = $false
  try {
    try { $held = $mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Timed out waiting for the lnwjing tunnel lock critical section' }
    return & $Action
  } finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Get-LnwjingTunnelProcessProbe {
  param([Parameter(Mandatory = $true)][int]$OwnerPid)

  try {
    $ownerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnerPid" -ErrorAction Stop
    if ($null -eq $ownerProcess) { return [pscustomobject]@{ state = 'gone' } }
    return [pscustomobject]@{
      state = 'live'
      processStartedAt = $ownerProcess.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    }
  } catch {
    return [pscustomobject]@{ state = 'unverifiable'; reason = 'process_probe_failed' }
  }
}

function New-LnwjingTunnelLockPublishRecord {
  param(
    [Parameter(Mandatory = $true)][string]$LockPath,
    [Parameter(Mandatory = $true)]$Owner
  )

  $publishPath = "$LockPath.publish.$($Owner.pid).$([Guid]::NewGuid().ToString('N'))"
  $stream = [IO.File]::Open($publishPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $payload = $Owner | ConvertTo-Json -Compress
    $bytes = ([Text.UTF8Encoding]::new($false)).GetBytes($payload)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  return $publishPath
}

function Enter-LnwjingTunnelLock {
  param(
    [Parameter(Mandatory = $true)][string]$ProfileDir,
    [Parameter(Mandatory = $true)][int]$OwnerPid,
    [Parameter(Mandatory = $true)][string]$OwnerStartedAt,
    [Parameter(Mandatory = $true)][scriptblock]$ProcessStartProvider,
    [scriptblock]$AfterStaleQuarantine
  )

  New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
  $lockPath = Join-Path $ProfileDir 'lnwjing.tunnel.lock'
  $owner = [pscustomobject][ordered]@{
    version = 1
    pid = $OwnerPid
    processStartedAt = $OwnerStartedAt
    acquiredAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
  }
  if (-not (Test-LnwjingTunnelLockRecord -Record $owner)) { throw 'Tunnel lock owner metadata is invalid' }

  return Invoke-LnwjingTunnelLockCriticalSection -ProfileDir $ProfileDir -Action {
    if (-not (Test-Path -LiteralPath $lockPath)) {
      $publishPath = New-LnwjingTunnelLockPublishRecord -LockPath $lockPath -Owner $owner
      try { [IO.File]::Move($publishPath, $lockPath) } finally { Remove-Item -LiteralPath $publishPath -Force -ErrorAction SilentlyContinue }
      return [pscustomobject]@{ acquired = $true; owner = $owner }
    }

    $existing = Read-LnwjingTunnelLockRecord -LockPath $lockPath
    if ($null -eq $existing) { throw "Tunnel lock has invalid owner metadata: $lockPath" }
    try { $probe = & $ProcessStartProvider ([int]$existing.pid) } catch { $probe = [pscustomobject]@{ state = 'unverifiable'; reason = 'process_probe_failed' } }
    if ($null -eq $probe -or $probe.state -notin @('live', 'gone', 'unverifiable')) { $probe = [pscustomobject]@{ state = 'unverifiable'; reason = 'invalid_probe_result' } }
    if ($probe.state -eq 'unverifiable') {
      $reason = if ([string]::IsNullOrWhiteSpace([string]$probe.reason)) { 'process_probe_failed' } else { [string]$probe.reason }
      throw "Tunnel lock owner liveness is unverifiable: $reason"
    }
    if ($probe.state -eq 'live' -and ([string]$probe.processStartedAt) -ceq ([string]$existing.processStartedAt)) {
      return [pscustomobject]@{ acquired = $false; owner = $existing }
    }

    $publishPath = New-LnwjingTunnelLockPublishRecord -LockPath $lockPath -Owner $owner
    $quarantinePath = "$lockPath.stale.$OwnerPid.$([Guid]::NewGuid().ToString('N'))"
    try {
      [IO.File]::Move($lockPath, $quarantinePath)
      $moved = Read-LnwjingTunnelLockRecord -LockPath $quarantinePath
      if (-not (Test-LnwjingTunnelLockOwner -Left $moved -Right $existing)) {
        Restore-LnwjingTunnelLockQuarantine -QuarantinePath $quarantinePath -LockPath $lockPath
        throw "Tunnel lock changed while stale recovery was in progress: $lockPath"
      }
      if ($null -ne $AfterStaleQuarantine) { & $AfterStaleQuarantine }
      [IO.File]::Move($publishPath, $lockPath)
    } catch {
      Restore-LnwjingTunnelLockQuarantine -QuarantinePath $quarantinePath -LockPath $lockPath
      throw
    } finally { Remove-Item -LiteralPath $publishPath -Force -ErrorAction SilentlyContinue }
    # The fixed owner is now authoritative. Quarantine cleanup is best effort;
    # failing the claim here would leave a published owner without its handle.
    if ([IO.File]::Exists($quarantinePath)) {
      try { [IO.File]::Delete($quarantinePath) } catch { }
    }
    return [pscustomobject]@{ acquired = $true; owner = $owner }
  }
}

function Release-LnwjingTunnelLock {
  param(
    [Parameter(Mandatory = $true)][string]$ProfileDir,
    [Parameter(Mandatory = $true)]$Owner
  )

  return Invoke-LnwjingTunnelLockCriticalSection -ProfileDir $ProfileDir -Action {
    $lockPath = Join-Path $ProfileDir 'lnwjing.tunnel.lock'
    $current = Read-LnwjingTunnelLockRecord -LockPath $lockPath
    if (-not (Test-LnwjingTunnelLockOwner -Left $current -Right $Owner)) { return $false }

    $releasePath = "$lockPath.released.$($Owner.pid).$([Guid]::NewGuid().ToString('N'))"
    try {
      [IO.File]::Move($lockPath, $releasePath)
      $moved = Read-LnwjingTunnelLockRecord -LockPath $releasePath
      if (-not (Test-LnwjingTunnelLockOwner -Left $moved -Right $Owner)) {
        Restore-LnwjingTunnelLockQuarantine -QuarantinePath $releasePath -LockPath $lockPath
        return $false
      }
      Remove-Item -LiteralPath $releasePath -Force -ErrorAction Stop
      return $true
    } catch {
      Restore-LnwjingTunnelLockQuarantine -QuarantinePath $releasePath -LockPath $lockPath
      return $false
    }
  }
}
