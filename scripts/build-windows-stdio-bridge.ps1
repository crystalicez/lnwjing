$ErrorActionPreference = 'Stop'
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { throw 'The MCP STDIO console bridge can only be built on Windows' }
$rustc = Get-Command rustc -ErrorAction SilentlyContinue
if ($null -eq $rustc) { throw 'rustc is required to build the Windows MCP STDIO console bridge' }

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'native\windows-stdio-bridge\src\main.rs'
$output = Join-Path $root 'apps\desktop\build\lnwjing-mcp-stdio-bridge.exe'
$stage = "$output.$([guid]::NewGuid().ToString('N')).tmp"
$hostTriple = (& rustc --version --verbose | Where-Object { $_ -match '^host: ' } | Select-Object -First 1) -replace '^host: ', ''
if ($hostTriple -notin @('x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnu')) {
    throw "Windows x64 rustc host is required; found $hostTriple"
}
New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
try {
    & rustc --edition=2021 -C opt-level=s -C panic=abort $source -o $stage
    if ($LASTEXITCODE -ne 0) { throw 'Windows MCP STDIO bridge compilation failed' }
    $reader = [System.IO.BinaryReader]::new([System.IO.File]::OpenRead($stage))
    try {
        $null = $reader.BaseStream.Seek(0x3c, [IO.SeekOrigin]::Begin)
        $peOffset = $reader.ReadInt32()
        $null = $reader.BaseStream.Seek($peOffset + 4, [IO.SeekOrigin]::Begin)
        $machine = $reader.ReadUInt16()
        $null = $reader.BaseStream.Seek($peOffset + 24 + 68, [IO.SeekOrigin]::Begin)
        $subsystem = $reader.ReadUInt16()
    }
    finally { $reader.Dispose() }
    if ($machine -ne 0x8664 -or $subsystem -ne 3) {
        throw "Bridge executable must be a Windows x64 console process (machine=$machine, subsystem=$subsystem)"
    }
    $newHash = (Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash
    $oldHash = if (Test-Path -LiteralPath $output -PathType Leaf) {
        (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
    } else { $null }
    if ($newHash -ne $oldHash) { Move-Item -LiteralPath $stage -Destination $output -Force }
    Write-Host "Verified Windows x64 console STDIO bridge: $output"
    Write-Host "SHA-256: $newHash"
}
finally {
    # rustc/MSVC can emit a PDB beside the temporary PE; do not leave a
    # randomly named untracked debug artifact in the source tree.
    Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$stage.pdb" -Force -ErrorAction SilentlyContinue
}
