param([string]$BridgePath = (Join-Path $PSScriptRoot '..\packages\capabilities\src\windows-capability-bridge.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$tokens = $null; $errors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($BridgePath), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$functions = $tree.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }

class OfficeFixtureCollection {
  [object]$Value
  [int]$Count = 1
  OfficeFixtureCollection([object]$value) { $this.Value = $value }
  [object]Item([object]$index) { return $this.Value }
}
class OfficeFixtureDocument {
  [string]$Text = ([string][char]0x0E44 + [char]0x0E17 + [char]0x0E22 + [char]::ConvertFromUtf32(0x1F600))
  [object]$Content
  [object]$Sections
  [int]$Closed = 0
  [int]$PrintCalls = 0
  [void]PrintOut([bool]$background) { $this.PrintCalls++ }
  OfficeFixtureDocument() {
    $this.Content = [pscustomobject]@{ Start = 0; End = 5; Duplicate = [pscustomobject]@{ Start = 0; End = 5 } }
    $this.Sections = [OfficeFixtureCollection]::new([pscustomobject]@{ PageSetup = [pscustomobject]@{ TopMargin = 60; BottomMargin = 70; LeftMargin = 80; RightMargin = 90; PageWidth = 595; PageHeight = 842; Orientation = 0 } })
  }
  [object]Range([int]$start, [int]$end) { return [pscustomobject]@{ Start = $start; End = $end; Text = $this.Text.Substring($start, $end - $start); Font = [pscustomobject]@{ Name = 'Arial'; Size = 12; Bold = $(if ($start -lt 2) { -1 } else { 0 }); Italic = 0; Underline = 0; Color = 0 } } }
  [void]Close([bool]$save) { if ($save) { throw 'Read-only fixture must not save' }; $this.Closed++ }
}
class OfficeFixtureDocuments {
  [OfficeFixtureDocument]$Document = [OfficeFixtureDocument]::new()
  [object]Open([string]$path, [bool]$convert, [bool]$readOnly) { if ($path -ne 'fixture.docx') { throw 'Word extension did not pass its file identity' }; return $this.Document }
}
class OfficeFixtureSheet {
  [string]$Name = 'Fixture'
  [int]$PrintCalls = 0
  [void]PrintOut() { $this.PrintCalls++ }
}
class OfficeFixtureConnection {
  [bool]$Refreshing = $false
  [int]$CancelCalls = 0
  [void]CancelRefresh() { $this.CancelCalls++; $this.Refreshing = $false }
}
class OfficeFixtureBooks {
  [object]$Book
  [object[]]$OpenArguments
  [int]$Opens = 0
  OfficeFixtureBooks([object]$book) { $this.Book = $book }
  [object]Open([string]$path, [int]$updates, [bool]$readOnly) { $this.Opens++; $this.OpenArguments = @($path, $updates, $readOnly); return $this.Book }
}
class OfficeFixtureBook {
  [object]$Worksheets = [OfficeFixtureCollection]::new([OfficeFixtureSheet]::new())
  [object[]]$Connections = @([pscustomobject]@{ Name = 'Local'; Type = 1; Description = 'Metadata'; OLEDBConnection = [OfficeFixtureConnection]::new() })
  [int]$Closed = 0
  [int]$Saves = 0
  [int]$Refreshes = 0
  [void]RefreshAll() { $this.Refreshes++ }
  [string]$Name = "Fixture O'Brien.xlsm"
  [void]Save() { $this.Saves++ }
  [void]Close([bool]$save) { if ($save) { throw 'Read-only fixture must not save' }; $this.Closed++ }
}
class OfficeFixtureMacroExcel {
  [object]$Workbooks
  [int]$AutomationSecurity = 3
  [bool]$EnableEvents = $false
  [bool]$AskToUpdateLinks = $false
  [string]$InvokedMacro = ''
  OfficeFixtureMacroExcel([object]$book) { $this.Workbooks = [OfficeFixtureBooks]::new($book) }
  [object]Run([string]$name) { $this.InvokedMacro = $name; return 'completed' }
}
class OfficeFixturePresentation {
  [object]$Slides
  [int]$Closed = 0
  [int]$PrintCalls = 0
  [void]PrintOut() { $this.PrintCalls++ }
  OfficeFixturePresentation() { $this.Slides = [OfficeFixtureCollection]::new([pscustomobject]@{ SlideIndex = 1; SlideShowTransition = [pscustomobject]@{ EntryEffect = 0; Duration = 1; AdvanceOnClick = $true; AdvanceOnTime = $false; AdvanceTime = 0 } }) }
  [void]Close() { $this.Closed++ }
}
class OfficeFixturePresentations {
  [OfficeFixturePresentation]$Presentation = [OfficeFixturePresentation]::new()
  [object]Open([string]$path, [bool]$readOnly, [bool]$untitled, [bool]$window) { if ($path -ne 'fixture.pptx' -or -not $readOnly -or $window) { throw 'PowerPoint extension did not pass its file and read-only state' }; return $this.Presentation }
}
class OfficeFixtureContact {
  [int]$Class = 40
  [string]$EntryID = 'contact-id'
  [string]$Categories = ''
  [int]$Saves = 0
  [void]Save() { $this.Saves++ }
}
class OfficeFixtureNamespace {
  [OfficeFixtureContact]$Contact = [OfficeFixtureContact]::new()
  [object]GetItemFromID([string]$id) { if ($id -ne 'contact-id') { throw 'Wrong contact identity' }; return $this.Contact }
}

$word = [pscustomobject]@{ Documents = [OfficeFixtureDocuments]::new() }
$matrix = [Array]::CreateInstance([object], [int[]]@(2,2), [int[]]@(1,1)); $matrix[1,1] = '  text  '; $matrix[1,2] = 42; $matrix[2,1] = $null; $matrix[2,2] = [char]::ConvertFromUtf32(0x1F600)
$rangeShape = [pscustomobject]@{ Rows = [pscustomobject]@{ Count = 2 }; Columns = [pscustomobject]@{ Count = 2 } }
$decoded = ConvertFrom-ExcelRangeValues $matrix $rangeShape
if ($decoded.Count -ne 2 -or $decoded[0].Count -ne 2 -or $decoded[0][0] -ne '  text  ' -or $decoded[0][1] -ne 42 -or $null -ne $decoded[1][0] -or $decoded[1][1] -ne [char]::ConvertFromUtf32(0x1F600)) { throw 'Excel matrix readback lost dimensions, empty cells, Unicode or values' }
$page = Invoke-WordExtendedAction $word 'page_setup' ([pscustomobject]@{ file_path = 'fixture.docx' })
if ($page.page_setup.top_margin -ne 60 -or $word.Documents.Document.Closed -ne 1) { throw 'Word input/lifecycle regression' }
$runs = Invoke-WordExtendedAction $word 'get_runs' ([pscustomobject]@{ file_path = 'fixture.docx' })
if ($runs.runs.Count -ne 2 -or (($runs.runs | ForEach-Object { $_.text }) -join '') -ne ([string][char]0x0E44 + [char]0x0E17 + [char]0x0E22 + [char]::ConvertFromUtf32(0x1F600)) -or $runs.truncated) { throw 'Word runs lost Unicode or formatting boundaries' }
$printed = Invoke-WordExtendedAction $word 'print' ([pscustomobject]@{ file_path = 'fixture.docx' })
if ($word.Documents.Document.PrintCalls -ne 1 -or -not $printed.submitted -or $printed.completion_verified) { throw 'Word printer dispatch claimed physical completion' }
$fixtureText = $word.Documents.Document.Text + 'x'; $word.Documents.Document.Text = $fixtureText; $word.Documents.Document.Content.End = $fixtureText.Length; $word.Documents.Document.Content.Duplicate.End = $fixtureText.Length
$firstPage = Invoke-WordExtendedAction $word 'get_runs' ([pscustomobject]@{ file_path = 'fixture.docx'; parameters = [pscustomobject]@{ max_characters = 4 } })
$secondPage = Invoke-WordExtendedAction $word 'get_runs' ([pscustomobject]@{ file_path = 'fixture.docx'; range = [pscustomobject]@{ start = $firstPage.next_start; end = $fixtureText.Length }; parameters = [pscustomobject]@{ max_characters = 4 } })
if ($firstPage.next_start -ne 5 -or $firstPage.returned_utf16_units -ne 5 -or $firstPage.boundary_adjustment_utf16_units -ne 1 -or $firstPage.maximum_returned_utf16_units -ne 5 -or (($firstPage.runs.text -join '') + ($secondPage.runs.text -join '')) -ne $fixtureText) { throw 'Word UTF16 pagination cut, dropped or duplicated a surrogate pair' }
foreach ($selector in @([pscustomobject]@{ start = 4; end = 6 }, [pscustomobject]@{ start = 0; end = 4 })) {
  $refused = $false; try { [void](Invoke-WordExtendedAction $word 'get_runs' ([pscustomobject]@{ file_path = 'fixture.docx'; range = $selector })) } catch { $refused = $_.Exception.Message -like '*splits a Unicode surrogate pair*' }
  if (-not $refused) { throw 'A user-selected split Unicode boundary was accepted' }
}
$word.Documents.Document.Text = [char]::ConvertFromUtf32(0x1F600) + 'x'; $word.Documents.Document.Content.End = 3; $word.Documents.Document.Content.Duplicate.End = 3
$leading = Invoke-WordExtendedAction $word 'get_runs' ([pscustomobject]@{ file_path = 'fixture.docx'; parameters = [pscustomobject]@{ max_characters = 1 } })
if ($leading.next_start -ne 2 -or ($leading.runs.text -join '') -ne [char]::ConvertFromUtf32(0x1F600) -or $leading.boundary_adjustment_utf16_units -ne 1) { throw 'A leading supplementary character failed to make bounded progress' }

$temporary = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'lnwjing-office-' + [Guid]::NewGuid().ToString('N') + '.csv')
try {
  $csvName = [string][char]0x0E44 + [char]0x0E17 + [char]0x0E22 + ' ' + [char]::ConvertFromUtf32(0x1F600)
  [IO.File]::WriteAllText($temporary, ('Name,Note' + "`r`n" + '"  ' + $csvName + '  ","quoted ""value"",' + "`r`n" + 'next line"' + "`r`n"), [Text.UTF8Encoding]::new($true))
  $csv = Read-OfficeMergeCsv $temporary
  if ($csv.headers.Count -ne 2 -or $csv.records.Count -ne 1 -or $csv.records[0][0] -ne ('  ' + $csvName + '  ') -or $csv.records[0][1] -ne ('quoted "value",' + "`r`n" + 'next line')) { throw 'Mail merge CSV parsing lost Unicode, whitespace, quoted delimiters or multiline fields' }
  foreach ($invalidCsv in @("Name,Name`r`nA,B", "Name,Note`r`nA", "Name`r`n")) {
    [IO.File]::WriteAllText($temporary, $invalidCsv, [Text.UTF8Encoding]::new($false)); $refused = $false
    try { [void](Read-OfficeMergeCsv $temporary) } catch { $refused = $true }
    if (-not $refused) { throw 'Malformed or empty mail merge source was accepted' }
  }
  [IO.File]::WriteAllBytes($temporary, [byte[]]@(78,97,109,101,13,10,255)); $refused = $false
  try { [void](Read-OfficeMergeCsv $temporary) } catch { $refused = $true }
  if (-not $refused) { throw 'Invalid UTF-8 mail merge source was silently decoded' }
  [IO.File]::WriteAllText($temporary, 'A,B')
  $book = [OfficeFixtureBook]::new()
  $excel = [pscustomobject]@{ Workbooks = [OfficeFixtureBooks]::new($book); AutomationSecurity = 1; EnableEvents = $true; AskToUpdateLinks = $true }
  $metadata = Invoke-ExcelExtendedAction $excel 'connection_metadata' ([pscustomobject]@{ file_path = $temporary })
  if ($excel.AutomationSecurity -ne 3 -or $excel.EnableEvents -or $excel.AskToUpdateLinks -or $excel.Workbooks.OpenArguments[1] -ne 0 -or -not $excel.Workbooks.OpenArguments[2] -or $book.Closed -ne 1 -or $metadata.connections[0].name -ne 'Local') { throw 'Excel input/macro/link/read-only/lifecycle regression' }
  $printed = Invoke-ExcelExtendedAction $excel 'print' ([pscustomobject]@{ file_path = $temporary })
  if ($book.Worksheets.Value.PrintCalls -ne 1 -or -not $printed.submitted -or $printed.completion_verified) { throw 'Excel printer dispatch claimed physical completion' }
  $refreshed = Invoke-ExcelExtendedAction $excel 'refresh_connections' ([pscustomobject]@{ file_path = $temporary; timeout_seconds = 0.5 })
  if ($book.Refreshes -ne 1 -or -not $refreshed.refresh_completed -or $book.Saves -ne 1) { throw 'Excel connection refresh was not awaited before saving' }
  $book.Connections[0].OLEDBConnection.Refreshing = $true; $timedOut = $false; $savedBefore = $book.Saves
  try { [void](Invoke-ExcelExtendedAction $excel 'refresh_connections' ([pscustomobject]@{ file_path = $temporary; timeout_seconds = 0.1 })) } catch { $timedOut = $_.Exception.Message -like '*bounded timeout*' }
  if (-not $timedOut -or $book.Connections[0].OLEDBConnection.CancelCalls -ne 1 -or $book.Saves -ne $savedBefore) { throw 'Timed-out refresh reported success or saved an incomplete workbook' }
  $macroExcel = [OfficeFixtureMacroExcel]::new([OfficeFixtureBook]::new())
  $archivePath = [IO.Path]::ChangeExtension($temporary, '.xlsx')
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  Add-Type -AssemblyName System.IO.Compression
  $macroPath = [IO.Path]::ChangeExtension($temporary, '.xlsm')
  try {
    $macroArchive = [IO.Compression.ZipFile]::Open($macroPath, [IO.Compression.ZipArchiveMode]::Create); $macroArchive.Dispose()
    $macro = Invoke-ExcelExtendedAction $macroExcel 'run_macro' ([pscustomobject]@{ file_path = $macroPath; macro = 'Module1.Run' })
    if ($macroExcel.InvokedMacro -ne "'Fixture O''Brien.xlsm'!Module1.Run" -or $macro.result -ne 'completed' -or $macroExcel.AutomationSecurity -ne 3 -or $macroExcel.EnableEvents) { throw 'Explicit macro action lost workbook qualification or enabled automatic events' }
    $macroArchive = [IO.Compression.ZipFile]::Open($macroPath, [IO.Compression.ZipArchiveMode]::Update); [void]$macroArchive.CreateEntry('xl/macrosheets/sheet1.xml'); $macroArchive.Dispose(); $opensBefore = $macroExcel.Workbooks.Opens; $refused = $false
    try { [void](Open-OfficeExcelWorkbook $macroExcel $macroPath $false $true) } catch { $refused = $_.Exception.Message -like '*Excel 4 macro sheets*' }
    if (-not $refused -or $macroExcel.Workbooks.Opens -ne $opensBefore) { throw 'Explicit VBA execution opened an unapproved XLM sheet' }
  } finally { Remove-Item -LiteralPath $macroPath -Force -ErrorAction SilentlyContinue }
  foreach ($unsafeExtension in @('.xls','.xlsb','.xla','.xlt','.xlm','.xlw','.slk','.xml','.html')) {
    $unsafePath = [IO.Path]::ChangeExtension($temporary, $unsafeExtension)
    try {
      [IO.File]::WriteAllText($unsafePath, 'unsafe format'); $opensBefore = $excel.Workbooks.Opens; $refused = $false
      try { [void](Open-OfficeExcelWorkbook $excel $unsafePath $true) } catch { $refused = $_.Exception.Message -like '*macro-safe conversion*' }
      if (-not $refused -or $excel.Workbooks.Opens -ne $opensBefore) { throw 'Uninspectable workbook reached the native opener' }
    } finally { Remove-Item -LiteralPath $unsafePath -Force -ErrorAction SilentlyContinue }
  }
  try {
    $archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
    try { $entry = $archive.CreateEntry('xl/connections.xml'); $writer = [IO.StreamWriter]::new($entry.Open()); try { $writer.Write('<connections><connection refreshOnLoad="1" /></connections>') } finally { $writer.Dispose() } } finally { $archive.Dispose() }
    $previousOpens = $excel.Workbooks.Opens; $refused = $false
    try { [void](Open-OfficeExcelWorkbook $excel $archivePath $true) } catch { $refused = $_.Exception.Message -like '*approved refresh_connections*' }
    if (-not $refused -or $excel.Workbooks.Opens -ne $previousOpens) { throw 'Unapproved workbook refresh reached the native opener' }
    $archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Update)
    try { $archive.GetEntry('xl/connections.xml').Delete(); $entry = $archive.CreateEntry('xl/pivotCache/pivotCacheDefinition1.xml'); $writer = [IO.StreamWriter]::new($entry.Open()); try { $writer.Write('<pivotCacheDefinition refreshOnLoad="1" />') } finally { $writer.Dispose() } } finally { $archive.Dispose() }
    $refused = $false
    try { [void](Open-OfficeExcelWorkbook $excel $archivePath $true) } catch { $refused = $_.Exception.Message -like '*approved refresh_connections*' }
    if (-not $refused -or $excel.Workbooks.Opens -ne $previousOpens) { throw 'Unapproved pivot cache refresh reached the native opener' }
  } finally { Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue }
} finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }

$powerpoint = [pscustomobject]@{ Presentations = [OfficeFixturePresentations]::new() }
$transition = Invoke-PowerPointExtendedAction $powerpoint 'get_transitions' ([pscustomobject]@{ file_path = 'fixture.pptx'; slide = 1 })
if (-not $transition.transition.advance_on_click -or $powerpoint.Presentations.Presentation.Closed -ne 1) { throw 'PowerPoint input/lifecycle regression' }
$printed = Invoke-PowerPointExtendedAction $powerpoint 'print' ([pscustomobject]@{ file_path = 'fixture.pptx' })
if ($powerpoint.Presentations.Presentation.PrintCalls -ne 1 -or -not $printed.submitted -or $printed.completion_verified) { throw 'PowerPoint printer dispatch claimed physical completion' }

$namespace = [OfficeFixtureNamespace]::new()
$contact = Invoke-OutlookExtendedAction $null $namespace 'set_categories' ([pscustomobject]@{ contact_id = 'contact-id'; categories = @('Thai', 'Work') })
if ($contact.contact_id -ne 'contact-id' -or $contact.categories -ne 'Thai, Work' -or $namespace.Contact.Saves -ne 1) { throw 'Outlook input/identity/save regression' }
Write-Output 'Office bridge helper boundary, Unicode, macro/link policy, readback and lifecycle checks passed.'
