param([switch]$HoldMutex, [string]$ReadyPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
if ($HoldMutex) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $mutex = [Threading.Mutex]::new($false, ('Local\lnwjing-office-powerpoint-' + $identity))
  try {
    if (-not $mutex.WaitOne(10000)) { throw 'Fixture could not acquire its bounded mutex' }
    [IO.File]::WriteAllText($ReadyPath, 'held')
    Start-Sleep -Seconds 30
  } finally { $mutex.Dispose() }
  exit
}
$tokens = $null; $errors = $null
$bridge = Join-Path $PSScriptRoot '..\packages\capabilities\src\windows-capability-bridge.ps1'
$tree = [Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($bridge), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
foreach ($function in $tree.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $function.Extent.Text }
class PowerPointLifetimeFixture {
  [object]$Presentations = [pscustomobject]@{ Count = 0 }
  [int]$AutomationSecurity = 1
  [int]$Quits = 0
  [void]Quit() { $this.Quits++ }
}
$script:activeFixture = $null
$script:newFixture = [PowerPointLifetimeFixture]::new()
function Get-OfficeActivePowerPointApplication { return $script:activeFixture }
function New-OfficePowerPointApplication { return $script:newFixture }
$scope = Open-OfficePowerPointApplication ([pscustomobject]@{ timeout_seconds = 1 })
if (-not $scope.owned) { throw 'New PowerPoint application was classified as borrowed' }
Close-OfficePowerPointApplication $scope
if ($script:newFixture.Quits -ne 1) { throw 'Empty request-created application was not closed' }

$script:activeFixture = [PowerPointLifetimeFixture]::new(); $script:activeFixture.Presentations.Count = 1
$scope = Open-OfficePowerPointApplication ([pscustomobject]@{ timeout_seconds = 1 }); $scope.application.AutomationSecurity = 3
if ($scope.owned) { throw 'Existing application was classified as request-created' }
Close-OfficePowerPointApplication $scope
if ($script:activeFixture.Quits -ne 0 -or $script:activeFixture.AutomationSecurity -ne 1 -or $script:activeFixture.Presentations.Count -ne 1) { throw 'Borrowed user application was closed or changed' }

$script:activeFixture = $null; $script:newFixture = [PowerPointLifetimeFixture]::new()
$scope = Open-OfficePowerPointApplication ([pscustomobject]@{ timeout_seconds = 1 }); $scope.application.Presentations.Count = 1
Close-OfficePowerPointApplication $scope
if ($script:newFixture.Quits -ne 0) { throw 'An unrelated presentation opened during the request was closed' }

$script:presentationOpens = 0
$presentations = [Collections.ArrayList]::new(); [void]$presentations.Add([pscustomobject]@{ FullName = 'C:\fixture\Open.pptx' })
Add-Member -InputObject $presentations -MemberType ScriptMethod -Name Open -Value { param($path,$readOnly,$untitled,$withWindow) $script:presentationOpens++; $script:presentationArguments = @($path,$readOnly,$untitled,$withWindow); return [pscustomobject]@{ FullName = $path } }
$fixtureApp = [pscustomobject]@{ Presentations = $presentations }; $refused = $false
try { [void](Open-OfficePowerPointPresentation $fixtureApp 'c:\fixture\open.pptx' $true) } catch { $refused = $_.Exception.Message -like '*already open*' }
if (-not $refused -or $script:presentationOpens -ne 0) { throw 'Existing borrowed presentation reached Open' }
$opened = Open-OfficePowerPointPresentation $fixtureApp 'C:\fixture\New.pptx' $false $false $true
if ($opened.FullName -ne 'C:\fixture\New.pptx' -or $script:presentationOpens -ne 1 -or $script:presentationArguments[1] -or $script:presentationArguments[2] -or -not $script:presentationArguments[3]) { throw 'Request-owned presentation lost its path, writable mode or visible chart window' }

$ready = Join-Path ([IO.Path]::GetTempPath()) ('lnwjing-office-mutex-' + [Guid]::NewGuid().ToString('N') + '.ready')
$holder = $null
try {
  $holder = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),'-HoldMutex','-ReadyPath',('"' + $ready + '"')) -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline -and -not $holder.HasExited) { Start-Sleep -Milliseconds 20 }
  if (-not (Test-Path -LiteralPath $ready)) { throw 'Mutex fixture never reported acquisition' }
  $timedOut = $false; $watch = [Diagnostics.Stopwatch]::StartNew()
  try { [void](Open-OfficePowerPointApplication ([pscustomobject]@{ timeout_seconds = 0.1 })) } catch { $timedOut = $_.Exception.Message -like '*acquisition timed out*' }
  if (-not $timedOut -or $watch.Elapsed.TotalSeconds -gt 2) { throw 'Contended application acquisition was not bounded' }
  $holder.Kill(); [void]$holder.WaitForExit(5000)
  $scope = Open-OfficePowerPointApplication ([pscustomobject]@{ timeout_seconds = 1 })
  Close-OfficePowerPointApplication $scope
  $scope = Open-OfficePowerPointApplication ([pscustomobject]@{ timeout_seconds = 1 })
  Close-OfficePowerPointApplication $scope
} finally {
  if ($null -ne $holder) { if (-not $holder.HasExited) { $holder.Kill(); [void]$holder.WaitForExit(5000) }; $holder.Dispose() }
  Remove-Item -LiteralPath $ready -Force -ErrorAction SilentlyContinue
}
Write-Output 'PowerPoint borrowed/created ownership, bounded contention and abandoned-lock recovery passed.'
