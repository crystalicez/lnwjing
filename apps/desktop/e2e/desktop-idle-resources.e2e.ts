import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';

const run = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagedExecutable = process.env.LNWJING_PACKAGED_EXECUTABLE?.trim();
type ProcessReading = { pid: number; read: number; written: number; cpu: number; resident: number };

async function readPackagedProcessCounters(executable: string): Promise<ProcessReading[]> {
  const target = executable.replace(/'/g, "''");
  const command = [
    "$ErrorActionPreference='Stop';",
    "$target='" + target + "';",
    "Get-CimInstance Win32_Process -Filter \"Name = 'lnwjing.exe'\"",
    "| Where-Object { $_.ExecutablePath -eq $target }",
    "| ForEach-Object { [pscustomobject]@{",
    "pid=$_.ProcessId; read=[double]$_.ReadTransferCount;",
    "written=[double]$_.WriteTransferCount;",
    "cpu=([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000000;",
    "resident=[double]$_.WorkingSetSize } }",
    "| ConvertTo-Json -Compress",
  ].join(' ');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    timeout: 12_000, maxBuffer: 50_000, windowsHide: true,
  });
  if (!stdout.trim()) return [];
  const parsed: unknown = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((value) => value as ProcessReading);
}

test('packaged Windows Desktop stays bounded during an isolated idle interval', async () => {
  test.skip(process.platform !== 'win32' || !packagedExecutable
    || process.env.LNWJING_MEASURE_IDLE_RESOURCES !== '1', 'Explicit packaged Windows idle benchmark opt-in required');
  test.setTimeout(90_000);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-idle-e2e-'));
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({
      executablePath: packagedExecutable!,
      args: ['--user-data-dir=' + dataRoot],
      cwd: desktopRoot,
      env: {
        ...process.env, LNWJING_DATA_PATH: dataRoot, APPDATA: dataRoot,
        LOCALAPPDATA: dataRoot, TEMP: dataRoot, TMP: dataRoot,
        LNWJING_E2E_FIXTURE: '1', LNWJING_E2E_NODE_PATH: process.execPath,
      },
      timeout: 40_000,
    });
    await settleFirstRunAndOpenHome(await app.firstWindow());
    const before = await readPackagedProcessCounters(packagedExecutable!);
    expect(before.length).toBeGreaterThan(0);
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const duration = (Date.now() - started) / 1000;
    const after = await readPackagedProcessCounters(packagedExecutable!);
    const previous = new Map(before.map((row) => [row.pid, row]));
    const matched = after.filter((row) => previous.has(row.pid));
    expect(matched.length).toBeGreaterThan(0);
    const delta = (key: 'read' | 'written' | 'cpu'): number => matched.reduce((total, row) =>
      total + Math.max(0, row[key] - previous.get(row.pid)![key]), 0);
    const readMiBps = delta('read') / (1024 ** 2 * duration);
    const writeMiBps = delta('written') / (1024 ** 2 * duration);
    const averageCpuCores = delta('cpu') / duration;
    const residentMiB = after.reduce((total, row) => total + row.resident, 0) / 1024 ** 2;
    console.info('PACKAGED_IDLE_RESOURCE=' + JSON.stringify({
      seconds: +duration.toFixed(2), processCount: after.length,
      readMiBps: +readMiBps.toFixed(3), writeMiBps: +writeMiBps.toFixed(3),
      averageCpuCores: +averageCpuCores.toFixed(3), residentMiB: +residentMiB.toFixed(1),
    }));
    // WMI transfer counts include logical/cache I/O, not physical disk bytes.
    // These broad ceilings catch a 200 MiB/s idle loop without asserting
    // precise SSD throughput across machines.
    expect(readMiBps).toBeLessThan(200);
    expect(writeMiBps).toBeLessThan(200);
    expect(averageCpuCores).toBeLessThan(3);
  } finally {
    await app?.close();
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  }
});
