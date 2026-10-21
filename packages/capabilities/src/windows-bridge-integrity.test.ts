import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PowerShellWindowsCapabilityBridge } from './windows-bridge.js';
import {
  WINDOWS_CAPABILITY_BRIDGE_SHA256,
  WINDOWS_CAPABILITY_BRIDGE_SIZE_BYTES,
} from './windows-capability-integrity.generated.js';

const temporaryRoots: string[] = [];

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    child.stdin.on('finish', () => {
      child.stdout.write('{"ok":true,"value":{"trusted":true}}');
      child.emit('close', 0);
    });
    return child as ReturnType<typeof spawn>;
  });
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PowerShellWindowsCapabilityBridge integrity', () => {
  it('keeps the embedded production identity synchronized with the shipped bridge bytes', async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-capability-bridge.ps1');
    const bytes = await readFile(scriptPath);
    expect(bytes.byteLength).toBe(WINDOWS_CAPABILITY_BRIDGE_SIZE_BYTES);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(WINDOWS_CAPABILITY_BRIDGE_SHA256);
  });

  it('executes a script only when its SHA-256 matches the embedded expectation', async () => {
    const root = await temporaryRoot();
    const scriptPath = path.join(root, 'bridge.ps1');
    const script = '$input | Out-Null; Write-Output \'{"ok":true,"value":{"trusted":true}}\'';
    await writeFile(scriptPath, script, 'utf8');
    const expectedScriptSha256 = sha256(script);
    const bridge = new PowerShellWindowsCapabilityBridge({ scriptPath, expectedScriptSha256, platform: 'win32' });

    await expect(bridge.execute({ capability: 'system_info', input: { action: 'summary' } })).resolves.toEqual({ ok: true, value: { trusted: true } });
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['-File', scriptPath]), expect.objectContaining({ shell: false }));
  }, 15_000);

  it('fails closed after the script changes, even if it was valid on a previous call', async () => {
    const root = await temporaryRoot();
    const scriptPath = path.join(root, 'bridge.ps1');
    const trusted = '$input | Out-Null; Write-Output \'{"ok":true,"value":{"trusted":true}}\'';
    await writeFile(scriptPath, trusted, 'utf8');
    const bridge = new PowerShellWindowsCapabilityBridge({ scriptPath, expectedScriptSha256: sha256(trusted), platform: 'win32' });
    await expect(bridge.execute({ capability: 'system_info', input: {} })).resolves.toMatchObject({ ok: true });

    await writeFile(scriptPath, '$input | Out-Null; Write-Output \'{"ok":true,"value":{"tampered":true}}\'', 'utf8');

    await expect(bridge.execute({ capability: 'system_info', input: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Windows bridge script integrity check failed' },
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('fails closed when the bridge byte count differs from the embedded expectation', async () => {
    const root = await temporaryRoot();
    const scriptPath = path.join(root, 'bridge.ps1');
    const trusted = '$input | Out-Null; Write-Output \'{"ok":true,"value":{"trusted":true}}\'';
    await writeFile(scriptPath, trusted, 'utf8');
    const bridge = new PowerShellWindowsCapabilityBridge({
      scriptPath,
      expectedScriptSha256: sha256(trusted),
      expectedScriptSizeBytes: Buffer.byteLength(trusted, 'utf8') + 1,
      platform: 'win32',
    });

    await expect(bridge.execute({ capability: 'system_info', input: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Windows bridge script integrity check failed' },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('passes the full Office payload so top-level document paths survive nested action parameters', async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-capability-bridge.ps1');
    const script = await readFile(scriptPath, 'utf8');
    expect(script).toContain("'office' { Invoke-OfficeAction ([string](Get-Field $payload 'app')) ([string](Get-Field $payload 'action')) $payload }");
    expect(script).toContain("$parametersValue = Get-Field $Parameters 'parameters'");
  });

  it('normalizes JSON matrix values before Excel writes and uses an unambiguous pivot-cache source', async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-capability-bridge.ps1');
    const script = await readFile(scriptPath, 'utf8');
    expect(script).toContain('function ConvertTo-ExcelRangeValues');
    expect(script).toContain('$excelValues = ConvertTo-ExcelRangeValues $values $target');
    expect(script).toContain('$excelFormulas = ConvertTo-ExcelRangeValues $formulas $target');
    expect(script).toContain('$target.Value2 = ConvertTo-ExcelRangeValues $fillValues $target');
    expect(script).toContain("$sourceData = [string]$sourceRange.Address($true, $true, -4150, $true)");
    expect(script).toContain('$workbook.PivotCaches().Create(1, $sourceData)');
    expect(script).not.toContain('$workbook.PivotCaches().Create(1, $sourceRange)');
    expect(script).toContain('$field.Position = $pivot.RowFields().Count');
    expect(script).toContain('$field.Position = $pivot.ColumnFields().Count');
    expect(script).not.toContain('$field.Position = $pivot.RowFields().Count + 1');
    expect(script).not.toContain('$field.Position = $pivot.ColumnFields().Count + 1');
    expect(script).toContain("$operator = if ($formula2.Length -gt 0) { 1 } else { 3 }");
    expect(script).toContain("'equal' { $operator = 3 }");
    expect(script).toContain("elseif ($formula2.Length -gt 0) { $target.Validation.Add($validationType, 1, $operator, $formula, $formula2) }");
    expect(script).toContain('# PowerPoint chart insertion requires an active presentation window on some Office 16 builds;');
    expect(script).toContain('$presentation.SaveAs($target, 32)');
    expect(script).not.toContain('$presentation.ExportAsFixedFormat($target, 2)');
  });

  it('never quits the user Outlook instance from read-only bridge actions', async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-capability-bridge.ps1');
    const script = await readFile(scriptPath, 'utf8');
    const outlookStart = script.indexOf("if ($App -eq 'outlook')");
    const outlookEnd = script.indexOf('throw "Unsupported office app: $App"', outlookStart);
    expect(outlookStart).toBeGreaterThanOrEqual(0);
    expect(outlookEnd).toBeGreaterThan(outlookStart);
    const outlookSection = script.slice(outlookStart, outlookEnd);
    expect(outlookSection).not.toContain('$outlook.Quit()');
    expect(outlookSection).toContain('Release-ComObject $outlook');
  });

  it('keeps UI Automation observations compatible with the Windows PowerShell 5.x baseline used by Windows 10/11', async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-capability-bridge.ps1');
    const script = await readFile(scriptPath, 'utf8');

    expect(script).toContain('elements = $items.ToArray()');
    expect(script).not.toContain('elements = @($items)');
    expect(script).toContain('[System.Windows.Automation.AutomationElement]::RootElement');
    expect(script).toContain('[void]$Items.Add');
    expect(script).toContain('function Get-FiniteUiBounds');
    expect(script).toContain('[double]::IsInfinity($value)');
    expect(script).toContain('bounds = $bounds');
    expect(script).not.toContain('bounds = [ordered]@{ x = [double]$rect.X; y = [double]$rect.Y; width = [double]$rect.Width; height = [double]$rect.Height }');
    expect(script).toContain("$failureMessage = 'Windows native capability failed'");
    expect(script).toContain("$failureMessage = $failureMessage + ': ' + $detail");
    expect(script).toContain("([string](Get-Field $Parameters 'text')).ToCharArray()");
    expect(script).not.toContain("foreach ($character in [string](Get-Field $Parameters 'text'))");
    expect(script).toContain('$pressedKeys = @()');
    expect(script).toContain('[array]::Reverse($releaseKeys)');
    expect(script).toContain('finally { $releaseKeys = @($pressedKeys)');
    expect(script).not.toContain('Select-Object -Reverse');
  });

  it('prefers a visible capturable window for ambiguous selectors and accepts app.name aliases', async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-capability-bridge.ps1');
    const script = await readFile(scriptPath, 'utf8');

    expect(script).toContain('[switch]$PreferCapturable');
    expect(script).toContain("$name = Get-Field $Parameters 'name'");
    expect(script).toContain("$_.process_name -ieq $name -or $_.title -like \"*$name*\"");
    expect(script).toContain("if ($_.process_name -ieq $name) { 0 } else { 1 }");
    expect(script).toContain("$window = Resolve-Window $Parameters -PreferCapturable");
    expect(script).toContain("-PreferCapturable");
    expect(script).toContain("[bool]$_.visible -and -not [bool]$_.minimized");
    expect(script).toContain("[int]$_.bounds.width -gt 0 -and [int]$_.bounds.height -gt 0");
    expect(script).toContain("Sort-Object @{ Expression = { [int64]$_.bounds.width * [int64]$_.bounds.height }; Descending = $true }");
    expect(script).toContain('[object]$WindowIndexOverride = $null');
    expect(script).toContain('$matches = $capturable');
    expect(script).toContain("Resolve-Window (Get-Field $Parameters 'app') -PreferCapturable -WindowIndexOverride $windowIndex");
    expect(script).not.toContain('$window = $windows[[int]$windowIndex]');
    expect(script).toContain("$failureCode = 'INVALID_INPUT'");
    expect(script).toContain("$failureMessage = $detail");
  });

  it('validates captured PNG bytes before returning them and includes round-trip integrity metadata', async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-capability-bridge.ps1');
    const script = await readFile(scriptPath, 'utf8');

    expect(script).toContain('[System.IO.MemoryStream]::new($bytes, $false)');
    expect(script).toContain('[System.Drawing.Image]::FromStream($verifyStream, $true, $true)');
    expect(script).toContain("throw 'Capture image validation failed'");
    expect(script).toContain('[System.Security.Cryptography.SHA256]::Create()');
    expect(script).toContain('[LnwjingNative]::PrintWindow($captureHwnd, $hdc, 2)');
    expect(script).toContain('SetProcessDpiAwarenessContext(new IntPtr(-4))');
    expect(script).toContain('$physicalPixelCoordinates = [LnwjingNative]::EnsurePhysicalPixelCoordinates()');
    expect(script).toContain('if (-not $usedPrintWindow) { $graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size) }');
    expect(script).toContain('if (-not $physicalPixelCoordinates) { $scaleX = $dpiScale; $scaleY = $dpiScale }');
    expect(script).toContain('origin_x = $x; origin_y = $y; scale_x = $scaleX; scale_y = $scaleY');
    expect(script).toContain("capture_space = $captureSpace");
    expect(script).toContain('byte_length = [int]$bytes.Length');
    expect(script).toContain('sha256 = $sha256');
  });

  it('rejects a missing or malformed expected hash before starting PowerShell', async () => {
    const root = await temporaryRoot();
    const scriptPath = path.join(root, 'bridge.ps1');
    await writeFile(scriptPath, 'Write-Output \'{}\'', 'utf8');
    const bridge = new PowerShellWindowsCapabilityBridge({ scriptPath, expectedScriptSha256: 'missing', platform: 'win32' });

    await expect(bridge.execute({ capability: 'system_info', input: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Windows bridge integrity manifest is missing or invalid' },
    });
  });
  it('returns FILE_TOO_LARGE when bridge stdout exceeds the retained response budget', async () => {
    const payload = JSON.stringify({ ok: true, value: { payload: 'x'.repeat(4_096) } });
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      child.stdin.on('finish', () => {
        child.stdout.write(payload);
        child.emit('close', 0);
      });
      return child as ReturnType<typeof spawn>;
    });
    const bridge = new PowerShellWindowsCapabilityBridge({
      scriptPath: path.resolve('bridge.ps1'),
      platform: 'win32',
      maxOutputBytes: 1_024,
    });

    await expect(bridge.execute({ capability: 'system_info', input: { action: 'summary' } })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'FILE_TOO_LARGE',
        message: 'Windows bridge response exceeded the bounded output limit',
        recoverable: true,
      },
    });
  });
  it('does not repeatedly rescan the accumulated stdout string for large bridge responses', async () => {
    const payload = JSON.stringify({ ok: true, value: { payload: 'x'.repeat(512 * 1024) } });
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      child.stdin.on('finish', () => {
        for (let offset = 0; offset < payload.length; offset += 4_096) {
          child.stdout.write(payload.slice(offset, offset + 4_096));
        }
        child.emit('close', 0);
      });
      return child as ReturnType<typeof spawn>;
    });
    const byteLengthSpy = vi.spyOn(Buffer, 'byteLength');
    try {
      const bridge = new PowerShellWindowsCapabilityBridge({
        scriptPath: path.resolve('bridge.ps1'),
        platform: 'win32',
      });
      await expect(bridge.execute({ capability: 'system_info', input: { action: 'summary' } })).resolves.toMatchObject({ ok: true });

      const wholePayloadRescans = byteLengthSpy.mock.calls.filter(([value]) =>
        typeof value === 'string' && value.startsWith('{"ok":true') && value.length > 64 * 1024,
      );
      expect(wholePayloadRescans).toEqual([]);
    } finally {
      byteLengthSpy.mockRestore();
    }
  });
});

async function temporaryRoot(): Promise<string> {
  // GitHub Hosted Windows runners may expose os.tmpdir() through an infrastructure
  // junction. Canonicalize that parent first so the fixture itself is a regular,
  // non-reparse path while production integrity checks remain fail-closed.
  const canonicalTemp = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(canonicalTemp, 'lnwjing-bridge-integrity-'));
  temporaryRoots.push(root);
  return root;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
