<#
Safe local Portable runtime cache audit/cleanup.
Default: DRY-RUN. -Apply must be explicit and no Portable process may be running.
Never follows reparse points, deletes unrecognized directories, or touches user data.
#>
[CmdletBinding()]
param(
  [string]$PortableDirectory = '',
  [ValidateRange(1, 10)][int]$RetainReadyCount = 2,
  [ValidateRange(1, 365)][int]$MinimumAgeDays = 7,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if (-not $PortableDirectory) { $PortableDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'portable' }
$portable = (Resolve-Path -LiteralPath $PortableDirectory -ErrorAction Stop).ProviderPath
$root = Get-Item -LiteralPath $portable -Force
if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Refusing non-directory or redirected Portable root'
}
$launcher = Join-Path $portable 'lnwjing-mcp-stdio.cmd'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw 'The Portable MCP launcher is missing; refusing cleanup without an active runtime reference'
}
$launcherItem = Get-Item -LiteralPath $launcher -Force
if ($launcherItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'Refusing redirected MCP launcher'
}
$launcherContents = Get-Content -LiteralPath $launcher -Raw
if (-not $launcherContents.Contains('REM lnwjing-managed-portable-stdio-v1')) {
  throw 'Unrecognized MCP launcher; refusing cleanup'
}
$runtimePattern = '^lnwjing-runtime-v(?<version>\d+\.\d+\.\d+)-(?<build>[A-Za-z0-9_-]+)$'
$all = @(Get-ChildItem -LiteralPath $portable -Directory -Force | Where-Object {
  if ($_.Name -notmatch $runtimePattern -or
      ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  $expected = "lnwjing-v$($Matches['version'])-$($Matches['build'])"
  $marker = Join-Path $_.FullName '.lnwjing-ready'
  $executable = Join-Path $_.FullName 'lnwjing.exe'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
      -not (Test-Path -LiteralPath $executable -PathType Leaf)) { return $false }
  if (((Get-Item -LiteralPath $marker -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      ((Get-Item -LiteralPath $executable -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  [IO.File]::ReadAllText($marker) -ceq $expected
} | Sort-Object LastWriteTimeUtc -Descending)
$preserved = @($all | Select-Object -First $RetainReadyCount | ForEach-Object Name)
foreach ($folder in $all) {
  if ($launcherContents.Contains($folder.Name)) { $preserved += $folder.Name }
}
$preserved = @($preserved | Select-Object -Unique)
$now = [DateTime]::UtcNow
$candidates = @($all | Where-Object {
  ($preserved -notcontains $_.Name) -and (($now - $_.LastWriteTimeUtc).TotalDays -ge $MinimumAgeDays)
})
if ($Apply) {
  $prefix = $portable.TrimEnd('\') + '\'
  $running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($running.Count -gt 0) { throw 'Portable processes are running; stop them before cleanup' }
}
Write-Output ('MODE=' + $(if ($Apply) { 'APPLY' } else { 'DRY-RUN' }))
Write-Output ('RETAINED=' + ($preserved -join ','))
Write-Output ('CANDIDATES=' + $candidates.Count)
foreach ($folder in $candidates) {
  if ($Apply) {
    if (([DateTime]::UtcNow - (Get-Item -LiteralPath $folder.FullName -Force).LastWriteTimeUtc).TotalDays -lt $MinimumAgeDays) {
      throw ('Runtime age changed during cleanup; refusing deletion of ' + $folder.Name)
    }
    # Validate nested links only for directories explicitly selected for deletion.
    if (@(Get-ChildItem -LiteralPath $folder.FullName -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop).Count -gt 0) {
      throw ('Reparse point inside cache; refusing cleanup of ' + $folder.Name)
    }
    Remove-Item -LiteralPath $folder.FullName -Recurse -Force -ErrorAction Stop
    Write-Output ('DELETED=' + $folder.Name)
  } else {
    Write-Output ('WOULD_DELETE=' + $folder.Name)
  }
}
