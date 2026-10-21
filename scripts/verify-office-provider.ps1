param(
  [string]$BridgePath = (Join-Path $PSScriptRoot '..\packages\capabilities\src\windows-capability-bridge.ps1'),
  [string]$OutputRoot = (Join-Path $PSScriptRoot '..\.local-artifacts\office-provider-acceptance'),
  [ValidateRange(5,300)][int]$ActionTimeoutSeconds = 60,
  [switch]$IncludeOutlookFixtures
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Invoke-Office {
  param(
    [Parameter(Mandatory=$true)][string]$App,
    [Parameter(Mandatory=$true)][string]$Action,
    [hashtable]$Payload = @{}
  )
  Write-Host ("[office-acceptance] {0}:{1} (timeout={2}s)" -f $App, $Action, $ActionTimeoutSeconds)
  $requestInput = @{}
  foreach ($key in $Payload.Keys) { $requestInput[$key] = $Payload[$key] }
  $requestInput['app'] = $App
  $requestInput['action'] = $Action
  $request = @{ capability = 'office'; input = $requestInput } | ConvertTo-Json -Compress -Depth 30

  $callId = [Guid]::NewGuid().ToString('N')
  $inputPath = Join-Path $runRoot ("office-$callId.stdin.json")
  $outputPath = Join-Path $runRoot ("office-$callId.stdout.txt")
  $errorPath = Join-Path $runRoot ("office-$callId.stderr.txt")
  $request | Set-Content -Path $inputPath -Encoding UTF8

  $escapedInputPath = $inputPath.Replace("'", "''")
  $escapedBridgePath = $BridgePath.Replace("'", "''")
  $childScript = "`$request = Get-Content -LiteralPath '$escapedInputPath' -Raw; `$request | & '$escapedBridgePath'"
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
  $argumentList = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', $encodedCommand
  )
  $process = $null
  try {
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -RedirectStandardOutput $outputPath -RedirectStandardError $errorPath -WindowStyle Hidden -PassThru
    if ($null -eq $process) { throw "$App/$Action failed to start the owned acceptance PowerShell child" }
    if (-not $process.WaitForExit($ActionTimeoutSeconds * 1000)) {
      try { $process.Kill() } catch { }
      try { [void]$process.WaitForExit(5000) } catch { }
      throw ("{0}/{1} timed out after {2}s; the owned acceptance PowerShell child was terminated" -f $App, $Action, $ActionTimeoutSeconds)
    }
    $rawLines = if (Test-Path $outputPath -PathType Leaf) { @(Get-Content $outputPath -Encoding UTF8 -ErrorAction SilentlyContinue) } else { @() }
    $stderrLines = if (Test-Path $errorPath -PathType Leaf) { @(Get-Content $errorPath -Encoding UTF8 -ErrorAction SilentlyContinue) } else { @() }
    $raw = (($rawLines -join [Environment]::NewLine)).Trim()
    $stderr = (($stderrLines -join [Environment]::NewLine)).Trim()
    if ($process.ExitCode -ne 0 -and $raw.Length -eq 0) {
      $detail = if ($stderr.Length -gt 0) { $stderr } else { "child exit $($process.ExitCode)" }
      throw "$App/$Action bridge process failed: $detail"
    }
    if ($raw.Length -eq 0) {
      $detail = if ($stderr.Length -gt 0) { ": $stderr" } else { '' }
      throw "$App/$Action produced no bridge result$detail"
    }
    $result = $raw | ConvertFrom-Json
    if (-not $result.ok) {
      $message = if ($null -ne $result.error -and $null -ne $result.error.message) { [string]$result.error.message } else { 'unknown Office provider error' }
      throw "$App/$Action failed: $message"
    }
    return $result.value
  } finally {
    foreach ($tempPath in @($inputPath, $outputPath, $errorPath)) {
      if (Test-Path $tempPath -PathType Leaf) { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
    }
    if ($null -ne $process) { $process.Dispose() }
  }
}

function Add-Evidence {
  param([System.Collections.ArrayList]$Evidence, [string]$App, [string]$Action, [string]$Status = 'passed', [hashtable]$Extra = @{})
  $row = [ordered]@{ app = $App; action = $Action; status = $Status }
  foreach ($key in $Extra.Keys) { $row[$key] = $Extra[$key] }
  [void]$Evidence.Add($row)
}

function Get-OfficeProcessSnapshot {
  $names = @('WINWORD','EXCEL','POWERPNT')
  $snapshot = @{}
  foreach ($name in $names) {
    $snapshot[$name] = @((Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id }))
  }
  return $snapshot
}

$BridgePath = [IO.Path]::GetFullPath($BridgePath)
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
Assert-True (Test-Path $BridgePath -PathType Leaf) "Office bridge not found: $BridgePath"
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$runRoot = Join-Path $OutputRoot ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null

$wordPath = Join-Path $runRoot 'acceptance.docx'
$wordPdf = Join-Path $runRoot 'acceptance-word.pdf'
$excelPath = Join-Path $runRoot 'acceptance.xlsx'
$excelPdf = Join-Path $runRoot 'acceptance-excel.pdf'
$pptPath = Join-Path $runRoot 'acceptance.pptx'
$pptPdf = Join-Path $runRoot 'acceptance-powerpoint.pdf'
$imagePath = Join-Path $runRoot 'acceptance.png'
$evidencePath = Join-Path $runRoot 'evidence.json'
$evidence = New-Object System.Collections.ArrayList
$beforeProcesses = Get-OfficeProcessSnapshot
$draftId = $null

try {
  Add-Type -AssemblyName System.Drawing
  $bitmap = New-Object System.Drawing.Bitmap 32,32
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.FillRectangle([System.Drawing.Brushes]::Black, 8, 8, 16, 16)
    $bitmap.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }

  foreach ($app in @('word','excel','powerpoint')) {
    $status = Invoke-Office $app 'status'
    Assert-True ($status.ready -eq $true) "$app provider is not ready"
    Add-Evidence $evidence $app 'status' 'passed' @{ provider = [string]$status.provider; version = [string]$status.version }
  }

  # Word: create, table/image/header/comment/tracked change, export, reopen/inspect.
  Invoke-Office 'word' 'create' @{ file_path = $wordPath; text = 'lnwjing Office acceptance document' } | Out-Null
  Invoke-Office 'word' 'insert_table' @{ file_path = $wordPath; table = @{ rows = 2; columns = 2 } } | Out-Null
  Invoke-Office 'word' 'update_table_cells' @{ file_path = $wordPath; table = @{ index = 1; row = 1; column = 1 }; text = 'verified' } | Out-Null
  Invoke-Office 'word' 'insert_image' @{ file_path = $wordPath; image_path = $imagePath } | Out-Null
  Invoke-Office 'word' 'update_header_footer' @{ file_path = $wordPath; text = 'lnwjing acceptance'; parameters = @{ section = 1; kind = 1; target = 'header' } } | Out-Null
  Invoke-Office 'word' 'add_comment' @{ file_path = $wordPath; range = @{ start = 0; end = 6 }; text = 'acceptance comment' } | Out-Null
  Invoke-Office 'word' 'set_track_changes' @{ file_path = $wordPath; parameters = @{ enabled = $true } } | Out-Null
  Invoke-Office 'word' 'append_text' @{ file_path = $wordPath; text = [Environment]::NewLine + 'tracked acceptance text' } | Out-Null
  $wordInspect = Invoke-Office 'word' 'inspect_document' @{ file_path = $wordPath }
  Assert-True ([int]$wordInspect.tables -ge 1) 'Word table was not persisted'
  $wordComments = Invoke-Office 'word' 'get_comments' @{ file_path = $wordPath }
  Assert-True (@($wordComments.comments).Count -ge 1) 'Word comment was not persisted'
  $wordRevisions = Invoke-Office 'word' 'get_revisions' @{ file_path = $wordPath }
  Assert-True (@($wordRevisions.revisions).Count -ge 1) 'Word tracked revision was not persisted'
  Invoke-Office 'word' 'set_track_changes' @{ file_path = $wordPath; parameters = @{ enabled = $false } } | Out-Null
  Invoke-Office 'word' 'set_character_format' @{ file_path = $wordPath; range = @{ start = 0; end = 6 }; parameters = @{ bold = $true; size = 16 } } | Out-Null
  $runs = Invoke-Office 'word' 'get_runs' @{ file_path = $wordPath; range = @{ start = 0; end = 6 } }
  Assert-True (@($runs.runs).Count -ge 1 -and [int]$runs.runs[0].font.bold -eq -1) 'Word character formatting was not read back as a formatting run'
  Invoke-Office 'word' 'add_bookmark' @{ file_path = $wordPath; range = @{ start = 0; end = 6 }; parameters = @{ name = 'AcceptanceBookmark' } } | Out-Null
  Invoke-Office 'word' 'add_footnote' @{ file_path = $wordPath; range = @{ start = 6; end = 6 }; text = 'Thai note' } | Out-Null
  $notes = Invoke-Office 'word' 'get_footnotes' @{ file_path = $wordPath }
  Assert-True (@($notes.notes).Count -eq 1) 'Word footnote did not survive reopen'
  Invoke-Office 'word' 'replace_image' @{ file_path = $wordPath; index = 1; image_path = $imagePath } | Out-Null
  Invoke-Office 'word' 'set_page_setup' @{ file_path = $wordPath; parameters = @{ section = 1; top_margin = 60 } } | Out-Null
  $pageSetup = Invoke-Office 'word' 'page_setup' @{ file_path = $wordPath }
  Assert-True ([Math]::Abs([double]$pageSetup.page_setup.top_margin - 60) -lt 0.1) 'Word page setup did not survive reopen'
  Add-Evidence $evidence 'word' 'runs-character-format-bookmark-footnote-image-page-setup-reopen'
  Invoke-Office 'word' 'export_pdf' @{ file_path = $wordPath; target_path = $wordPdf } | Out-Null
  Assert-True (Test-Path $wordPdf -PathType Leaf) 'Word PDF export was not created'
  Add-Evidence $evidence 'word' 'create-edit-table-image-header-comment-track-export-reopen'

  # Excel: values/formulas/table/chart/pivot/filter/freeze/validation, export, reopen.
  Invoke-Office 'excel' 'create' @{ file_path = $excelPath; sheet = 'Data' } | Out-Null
  $values = @(
    @('Category','Amount'),
    @('A',10),
    @('B',20),
    @('A',30)
  )
  Invoke-Office 'excel' 'write_values' @{ file_path = $excelPath; sheet = 'Data'; range = 'A1:B4'; values = $values } | Out-Null
  Invoke-Office 'excel' 'write_formulas' @{ file_path = $excelPath; sheet = 'Data'; range = 'C1:C2'; formulas = @(@('Formula'),@('=SUM(B2:B4)')) } | Out-Null
  Invoke-Office 'excel' 'create_table' @{ file_path = $excelPath; sheet = 'Data'; range = 'A1:B4'; name = 'AcceptanceTable'; parameters = @{ style = 'TableStyleMedium2' } } | Out-Null
  Invoke-Office 'excel' 'create_chart' @{ file_path = $excelPath; sheet = 'Data'; range = 'A1:B4'; name = 'AcceptanceChart'; parameters = @{ chart_type = 51; left = 360; top = 20; width = 420; height = 260 } } | Out-Null
  Invoke-Office 'excel' 'create_pivot' @{ file_path = $excelPath; sheet = 'Data'; range = 'A1:B4'; name = 'AcceptancePivot'; parameters = @{ destination = 'E1'; row_fields = @('Category'); data_fields = @('Amount') } } | Out-Null
  Invoke-Office 'excel' 'filter' @{ file_path = $excelPath; sheet = 'Data'; range = 'A1:B4'; parameters = @{ field = 1; criteria = 'A' } } | Out-Null
  Invoke-Office 'excel' 'clear_filter' @{ file_path = $excelPath; sheet = 'Data' } | Out-Null
  Invoke-Office 'excel' 'freeze_panes' @{ file_path = $excelPath; sheet = 'Data'; parameters = @{ rows = 1; columns = 0 } } | Out-Null
  Invoke-Office 'excel' 'set_data_validation' @{ file_path = $excelPath; sheet = 'Data'; range = 'D2:D10'; parameters = @{ type = 'whole'; formula1 = '1' } } | Out-Null
  $tables = Invoke-Office 'excel' 'read_tables' @{ file_path = $excelPath }
  Assert-True (@($tables.tables | Where-Object { $_.name -eq 'AcceptanceTable' }).Count -eq 1) 'Excel table was not persisted'
  $charts = Invoke-Office 'excel' 'read_charts' @{ file_path = $excelPath }
  Assert-True (@($charts.charts | Where-Object { $_.name -eq 'AcceptanceChart' }).Count -eq 1) 'Excel chart was not persisted'
  $pivots = Invoke-Office 'excel' 'read_pivots' @{ file_path = $excelPath }
  Assert-True (@($pivots.pivots | Where-Object { $_.name -eq 'AcceptancePivot' }).Count -eq 1) 'Excel pivot was not persisted'
  $formulaErrors = Invoke-Office 'excel' 'formula_errors' @{ file_path = $excelPath }
  Assert-True (@($formulaErrors.errors).Count -eq 0) 'Excel workbook contains formula errors'
  Invoke-Office 'excel' 'create_named_range' @{ file_path = $excelPath; sheet = 'Data'; range = 'A1:B4'; name = 'AcceptanceRange' } | Out-Null
  $named = Invoke-Office 'excel' 'read_named_ranges' @{ file_path = $excelPath }
  Assert-True (@($named.names | Where-Object { $_.name -eq 'AcceptanceRange' }).Count -eq 1) 'Excel named range did not survive reopen'
  Invoke-Office 'excel' 'set_border' @{ file_path = $excelPath; sheet = 'Data'; range = 'A1:B4'; parameters = @{ line_style = 1; weight = 2; color = 255 } } | Out-Null
  Invoke-Office 'excel' 'set_conditional_formatting' @{ file_path = $excelPath; sheet = 'Data'; range = 'B2:B4'; parameters = @{ type = 1; operator = 5; formula1 = '15'; color = 255 } } | Out-Null
  $conditions = Invoke-Office 'excel' 'read_conditional_formatting' @{ file_path = $excelPath; sheet = 'Data'; range = 'B2:B4' }
  Assert-True (@($conditions.conditions).Count -eq 1) 'Excel conditional formatting did not survive reopen'
  Invoke-Office 'excel' 'add_sheet' @{ file_path = $excelPath; name = 'CopyTarget' } | Out-Null
  Invoke-Office 'excel' 'copy_sheet' @{ file_path = $excelPath; sheet = 'Data'; new_name = 'CopiedData'; parameters = @{ target_sheet = 'CopyTarget' } } | Out-Null
  $copy = Invoke-Office 'excel' 'read_values' @{ file_path = $excelPath; sheet = 'CopiedData'; range = 'A1:B4' }
  Assert-True ($null -ne $copy.values) 'Excel copied sheet values were not preserved'
  Add-Evidence $evidence 'excel' 'named-range-border-conditional-format-copy-sheet-reopen'
  Invoke-Office 'excel' 'export_pdf' @{ file_path = $excelPath; target_path = $excelPdf } | Out-Null
  Assert-True (Test-Path $excelPdf -PathType Leaf) 'Excel PDF export was not created'
  Add-Evidence $evidence 'excel' 'create-formula-table-chart-pivot-filter-freeze-validation-export-reopen'

  # PowerPoint: create, add slide/text/media/table/chart/notes, export, reopen.
  Invoke-Office 'powerpoint' 'create' @{ file_path = $pptPath; text = 'lnwjing acceptance' } | Out-Null
  $slide = Invoke-Office 'powerpoint' 'add_slide' @{ file_path = $pptPath; parameters = @{ layout = 12 } }
  $slideIndex = [int]$slide.slide
  Invoke-Office 'powerpoint' 'add_textbox' @{ file_path = $pptPath; slide = $slideIndex; text = 'Acceptance slide'; parameters = @{ left = 40; top = 40; width = 500; height = 80 } } | Out-Null
  Invoke-Office 'powerpoint' 'add_image' @{ file_path = $pptPath; slide = $slideIndex; image_path = $imagePath; parameters = @{ left = 40; top = 130; width = 120; height = 120 } } | Out-Null
  Invoke-Office 'powerpoint' 'add_table' @{ file_path = $pptPath; slide = $slideIndex; parameters = @{ rows = 2; columns = 2; left = 190; top = 130; width = 300; height = 120; values = @(@('A','B'),@('1','2')) } } | Out-Null
  Invoke-Office 'powerpoint' 'add_chart' @{ file_path = $pptPath; slide = $slideIndex; parameters = @{ chart_type = 51; left = 40; top = 280; width = 480; height = 260; title = 'Acceptance Chart' } } | Out-Null
  Invoke-Office 'powerpoint' 'set_notes' @{ file_path = $pptPath; slide = $slideIndex; text = 'acceptance notes' } | Out-Null
  $pptInspect = Invoke-Office 'powerpoint' 'inspect_presentation' @{ file_path = $pptPath }
  Assert-True ([int]$pptInspect.slide_count -ge 2) 'PowerPoint slides were not persisted'
  $pptTables = Invoke-Office 'powerpoint' 'get_tables' @{ file_path = $pptPath }
  Assert-True (@($pptTables.items).Count -ge 1) 'PowerPoint table was not persisted'
  $pptCharts = Invoke-Office 'powerpoint' 'get_charts' @{ file_path = $pptPath }
  Assert-True (@($pptCharts.items).Count -ge 1) 'PowerPoint chart was not persisted'
  $newShape = Invoke-Office 'powerpoint' 'add_shape' @{ file_path = $pptPath; slide = $slideIndex; text = 'Extension shape'; parameters = @{ type = 1; left = 20; top = 20; width = 100; height = 50 } }
  Invoke-Office 'powerpoint' 'edit_shape' @{ file_path = $pptPath; slide = $slideIndex; shape = [string]$newShape.id; parameters = @{ fill_color = 255; left = 30 } } | Out-Null
  Invoke-Office 'powerpoint' 'set_background' @{ file_path = $pptPath; slide = $slideIndex; parameters = @{ color = 16777215 } } | Out-Null
  Invoke-Office 'powerpoint' 'set_transition' @{ file_path = $pptPath; slide = $slideIndex; parameters = @{ effect = 0; duration = 1; advance_on_click = $true } } | Out-Null
  $transition = Invoke-Office 'powerpoint' 'get_transitions' @{ file_path = $pptPath; slide = $slideIndex }
  Assert-True ([bool]$transition.transition.advance_on_click) 'PowerPoint transition did not survive reopen'
  $slideImage = Join-Path $runRoot 'slide-export.png'
  $exported = Invoke-Office 'powerpoint' 'export_images' @{ file_path = $pptPath; slide = $slideIndex; target_path = $slideImage }
  Assert-True ([long]$exported.output.bytes -gt 0) 'PowerPoint slide image was not verified'
  Add-Evidence $evidence 'powerpoint' 'shape-background-transition-slide-image-reopen'
  Invoke-Office 'powerpoint' 'export_pdf' @{ file_path = $pptPath; target_path = $pptPdf } | Out-Null
  Assert-True (Test-Path $pptPdf -PathType Leaf) 'PowerPoint PDF export was not created'
  Add-Evidence $evidence 'powerpoint' 'create-slide-text-image-table-chart-notes-export-reopen'

  # Outlook: probe separately after Word/Excel/PowerPoint so a host-specific COM startup hang cannot erase earlier evidence.
  # A bounded status failure is valid acceptance evidence for truthful readiness downgrade. Do not continue into
  # mailbox reads/draft mutation when the provider cannot prove a healthy COM session.
  $outlookAcceptance = 'passed'
  $outlookReady = $false
  if ($IncludeOutlookFixtures) { try {
    Write-Host '[office-acceptance] outlook:status'
    $outlookStatus = Invoke-Office 'outlook' 'status'
    if ($outlookStatus.ready -eq $true) {
      $outlookReady = $true
      Add-Evidence $evidence 'outlook' 'status' 'passed' @{ provider = [string]$outlookStatus.provider; version = [string]$outlookStatus.version }
    } else {
      $outlookAcceptance = 'degraded'
      Add-Evidence $evidence 'outlook' 'status' 'not_ready' @{ reason = 'Outlook COM status returned ready=false; semantic actions must remain unavailable until a later bounded probe succeeds.' }
    }
  } catch {
    $outlookAcceptance = 'degraded'
    $outlookFailure = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
    if ($outlookFailure.Length -gt 500) { $outlookFailure = $outlookFailure.Substring(0, 500) }
    Add-Evidence $evidence 'outlook' 'status' 'not_ready' @{ reason = $outlookFailure }
    Write-Warning ("[office-acceptance] Outlook degraded: {0}" -f $outlookFailure)
  } }

  # Outlook: bounded read and safe local draft lifecycle only after the readiness probe succeeds. Never send.
  if ($IncludeOutlookFixtures -and $outlookReady) {
    Write-Host '[office-acceptance] outlook:list_folders'
    $folders = Invoke-Office 'outlook' 'list_folders' @{}
    Assert-True ($null -ne $folders.folders) 'Outlook folder listing failed'
    Write-Host '[office-acceptance] outlook:list_messages'
    $messages = Invoke-Office 'outlook' 'list_messages' @{ max_messages = 1 }
    Write-Host '[office-acceptance] outlook:create_draft'
    $draft = Invoke-Office 'outlook' 'create_draft' @{
      subject = ('lnwjing acceptance ' + [Guid]::NewGuid().ToString('N'))
      body = 'Local draft created by lnwjing provider acceptance. This draft is deleted without sending.'
    }
    $draftId = [string]$draft.draft_id
    Assert-True ($draftId.Length -gt 0) 'Outlook draft did not return an id'
    Write-Host '[office-acceptance] outlook:update_draft'
    Invoke-Office 'outlook' 'update_draft' @{ draft_id = $draftId; subject = 'lnwjing acceptance updated'; body = 'updated local acceptance draft' } | Out-Null
    Write-Host '[office-acceptance] outlook:delete_draft'
    Invoke-Office 'outlook' 'delete' @{ draft_id = $draftId } | Out-Null
    $draftId = $null
    Add-Evidence $evidence 'outlook' 'folders-messages-draft-create-update-delete-no-send'
  } elseif ($IncludeOutlookFixtures) {
    Add-Evidence $evidence 'outlook' 'folders-messages-draft-create-update-delete-no-send' 'skipped_not_ready' @{ reason = 'Skipped because the bounded Outlook COM status probe did not prove readiness.' }
  } else {
    Add-Evidence $evidence 'outlook' 'folders-messages-draft-create-update-delete-no-send' 'skipped_not_requested' @{ reason = 'Live Outlook account fixtures require explicit IncludeOutlookFixtures opt-in.' }
  }

  Start-Sleep -Milliseconds 1200
  $afterProcesses = Get-OfficeProcessSnapshot
  foreach ($name in @('WINWORD','EXCEL','POWERPNT')) {
    $newPids = @($afterProcesses[$name] | Where-Object { $beforeProcesses[$name] -notcontains $_ })
    Assert-True ($newPids.Count -eq 0) "Office provider left orphan $name process(es): $($newPids -join ',')"
  }
  Add-Evidence $evidence 'office' 'no-orphan-owned-processes'

  $summary = [ordered]@{
    status = if ($outlookAcceptance -eq 'passed') { 'passed' } else { 'passed_with_degraded_outlook' }
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    bridge = [IO.Path]::GetFileName($BridgePath)
    artifacts = @{
      docx = [IO.Path]::GetFileName($wordPath)
      xlsx = [IO.Path]::GetFileName($excelPath)
      pptx = [IO.Path]::GetFileName($pptPath)
      pdfCount = 3
    }
    evidence = $evidence
  }
  $summary | ConvertTo-Json -Depth 20 | Set-Content -Path $evidencePath -Encoding UTF8
  $summary | ConvertTo-Json -Depth 20
} catch {
  if ($null -ne $draftId -and $draftId.Length -gt 0) {
    try { Invoke-Office 'outlook' 'delete' @{ draft_id = $draftId } | Out-Null } catch { }
  }
  $failure = [ordered]@{
    status = 'failed'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    error = [string]$_.Exception.Message
    evidence = $evidence
  }
  $failure | ConvertTo-Json -Depth 20 | Set-Content -Path $evidencePath -Encoding UTF8
  throw
}
