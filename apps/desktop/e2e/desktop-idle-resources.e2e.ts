import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';
import { electronExecutablePath } from './electron-runtime.js';

const run = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagedExecutable = process.env.LNWJING_PACKAGED_EXECUTABLE?.trim();
type ProcessReading = { pid: number; started: string; read: number; written: number; cpu: number; resident: number };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (address === null || typeof address === 'string') throw new Error('No isolated loopback port');
  return address.port;
}

/** Sample only this launched process tree, never other running lnwjing instances. */
async function readProcessCounters(rootPid: number): Promise<ProcessReading[]> {
  const command = [
    "$ErrorActionPreference='Stop';",
    "$root=" + rootPid + ";",
    "$processes=@(Get-CimInstance Win32_Process);",
    "$owned=[System.Collections.Generic.HashSet[int]]::new();",
    "[void]$owned.Add($root);",
    "do {$count=$owned.Count; foreach($p in $processes) {if($owned.Contains([int]$p.ParentProcessId)){[void]$owned.Add([int]$p.ProcessId)}}} while($count -ne $owned.Count);",
    "$processes | Where-Object {$owned.Contains([int]$_.ProcessId)}",
    "| ForEach-Object { [pscustomobject]@{",
    "pid=$_.ProcessId; started=$_.CreationDate.ToUniversalTime().ToString('o'); read=[double]$_.ReadTransferCount;",
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
  return (Array.isArray(parsed) ? parsed : [parsed]) as ProcessReading[];
}

test('Windows Desktop stays bounded during an isolated idle interval', async () => {
  test.skip(process.platform !== 'win32' || process.env.LNWJING_MEASURE_IDLE_RESOURCES !== '1', 'Explicit Windows idle benchmark opt-in required');
  const requestedSampleSeconds = Number(process.env.LNWJING_IDLE_SAMPLE_SECONDS ?? '10');
  const sampleSeconds = Number.isFinite(requestedSampleSeconds)
    ? Math.min(120, Math.max(5, Math.floor(requestedSampleSeconds))) : 10;
  test.setTimeout(80_000 + sampleSeconds * 1_000);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-idle-e2e-'));
  let app: ElectronApplication | undefined;
  try {
    const profile = path.join(dataRoot, 'profile');
    const workspace = path.join(dataRoot, 'workspace');
    await Promise.all([profile, workspace].map(dir => mkdir(dir)));
    const env = { ...process.env };
    delete env.LNWJING_E2E_FIXTURE;
    delete env.LNWJING_UNRESTRICTED;
    delete env.LNWJING_E2E_NODE_PATH;
    app = await _electron.launch({
      executablePath: packagedExecutable || electronExecutablePath(desktopRoot),
      args: ['--user-data-dir=' + profile, '--disable-background-networking', ...(packagedExecutable ? [] : [path.join(desktopRoot, 'dist', 'main', 'main.js')])],
      cwd: desktopRoot,
      env: {
        ...env, LNWJING_DATA_PATH: profile, LNWJING_WORKSPACE: workspace, APPDATA: dataRoot,
        LOCALAPPDATA: dataRoot, TEMP: dataRoot, TMP: dataRoot,
        LNWJING_MCP_PORT: String(await freePort()),
      },
      timeout: 40_000,
    });
    await settleFirstRunAndOpenHome(await app.firstWindow());
    const rootPid = app.process().pid;
    expect(rootPid).toBeDefined();
    // Allow startup probes and first render to settle before sampling idle.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const before = await readProcessCounters(rootPid!);
    expect(before.some(row => row.pid === rootPid)).toBe(true);
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, sampleSeconds * 1_000));
    const after = await readProcessCounters(rootPid!);
    const duration = (Date.now() - started) / 1000;
    const previous = new Map(before.map((row) => [row.pid, row]));
    const matched = after.filter((row) => previous.get(row.pid)?.started === row.started);
    expect(matched.some(row => row.pid === rootPid)).toBe(true);
    const delta = (key: 'read' | 'written' | 'cpu'): number => matched.reduce((total, row) =>
      total + Math.max(0, row[key] - previous.get(row.pid)![key]), 0);
    const readMiBps = delta('read') / (1024 ** 2 * duration);
    const writeMiBps = delta('written') / (1024 ** 2 * duration);
    const averageCpuCores = delta('cpu') / duration;
    const residentMiB = after.reduce((total, row) => total + row.resident, 0) / 1024 ** 2;
    console.info((packagedExecutable ? 'PACKAGED_IDLE_RESOURCE=' : 'SOURCE_IDLE_RESOURCE=') + JSON.stringify({
      seconds: +duration.toFixed(2), processCount: after.length, matchedProcessCount: matched.length,
      residentBeforeMiB: +(before.reduce((total, row) => total + row.resident, 0) / 1024 ** 2).toFixed(1),
      readBytes: delta('read'), writtenBytes: delta('written'),
      readMiBps: +readMiBps.toFixed(3), writeMiBps: +writeMiBps.toFixed(3),
      averageCpuCores: +averageCpuCores.toFixed(3), residentMiB: +residentMiB.toFixed(1),
    }));
    // WMI transfer counts include logical/cache I/O, not physical disk bytes.
    // Deltas cover matching process identities only; transient children can be missed.
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
