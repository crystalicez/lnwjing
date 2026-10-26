import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { windowsContainedProcessSource } from './windows-contained-process.js';

export interface WindowsContainedLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly receiptPath: string;
  readonly cancelPath: string;
}

export interface WindowsContainmentReceipt {
  readonly kind: 'windows_job_v1';
  readonly outcome: 'completed' | 'cancelled' | 'timed_out';
  readonly exitCode: number;
  readonly activeProcesses: 0;
}

export async function prepareWindowsContainedLaunch(input: {
  readonly directory: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly windowsVerbatimArguments?: boolean;
}): Promise<WindowsContainedLaunch> {
  if (process.platform !== 'win32') throw new Error('WINDOWS_CONTAINMENT_UNSUPPORTED');
  if (![input.directory, input.executable, input.cwd].every((value) => path.isAbsolute(value))) throw new Error('WINDOWS_CONTAINMENT_ABSOLUTE_PATH_REQUIRED');
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const sourcePath = path.join(input.directory, 'containment.cs');
  const scriptPath = path.join(input.directory, 'containment.ps1');
  const specPath = path.join(input.directory, 'containment.json');
  const receiptPath = path.join(input.directory, 'containment.receipt.json');
  const cancelPath = path.join(input.directory, 'containment.cancel');
  await writeFile(sourcePath, windowsContainedProcessSource, { flag: 'wx', mode: 0o600 });
  await writeFile(scriptPath, containedLaunchScript, { flag: 'wx', mode: 0o600 });
  await writeFile(specPath, JSON.stringify({ executable: input.executable, arguments: input.args, cwd: input.cwd, timeoutMs: input.timeoutMs, windowsVerbatimArguments: input.windowsVerbatimArguments === true }), { flag: 'wx', mode: 0o600 });
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || !path.isAbsolute(systemRoot)) throw new Error('WINDOWS_CONTAINMENT_HOST_UNAVAILABLE');
  return {
    executable: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-File', scriptPath, input.directory],
    receiptPath,
    cancelPath,
  };
}

export async function readWindowsContainmentReceipt(filename: string): Promise<WindowsContainmentReceipt | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    if (!('kind' in parsed) || parsed.kind !== 'windows_job_v1'
      || !('activeProcesses' in parsed) || parsed.activeProcesses !== 0
      || !('outcome' in parsed) || (parsed.outcome !== 'completed' && parsed.outcome !== 'cancelled' && parsed.outcome !== 'timed_out')
      || !('exitCode' in parsed) || typeof parsed.exitCode !== 'number' || !Number.isInteger(parsed.exitCode)) return undefined;
    return { kind: parsed.kind, activeProcesses: 0, outcome: parsed.outcome, exitCode: parsed.exitCode };
  } catch { return undefined; }
}

/**
 * Reclaim one-use native launcher sources only after a zero-active Job receipt.
 * Keep the receipt, log and task metadata for liveness/recovery evidence.
 * Missing files and Windows sharing violations must never change job outcome.
 */
export async function pruneVerifiedWindowsContainmentInputs(receiptPath: string): Promise<number> {
  if (path.basename(receiptPath) !== 'containment.receipt.json') return 0;
  if (await readWindowsContainmentReceipt(receiptPath) === undefined) return 0;
  const directory = path.dirname(receiptPath);
  let removed = 0;
  for (const name of ['containment.cs', 'containment.ps1', 'containment.json']) {
    try {
      await unlink(path.join(directory, name));
      removed += 1;
    } catch {
      // A terminal receipt is authoritative; cleanup is best effort.
    }
  }
  return removed;
}

const CONTAINMENT_TASK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Explicit maintenance of old completed native launch inputs.
 * Caller selects one trusted per-application root and advances nextCursor.
 * Never recurse into workspaces, follow symlinks, or remove result metadata.
 */
export async function pruneVerifiedWindowsContainmentRoot(
  rootDirectory: string,
  options: { readonly userConfirmed: boolean; readonly maxDirectories?: number; readonly afterName?: string },
): Promise<{ readonly inspected: number; readonly removedFiles: number; readonly nextCursor: string | null }> {
  if (options.userConfirmed !== true) throw new Error('Native retention cleanup requires explicit confirmation');
  const limit = options.maxDirectories ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('Invalid containment cleanup batch size');
  if (options.afterName !== undefined && !CONTAINMENT_TASK_ID.test(options.afterName)) {
    throw new Error('Invalid native retention cursor');
  }
  let entries: Dirent[];
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { inspected: 0, removedFiles: 0, nextCursor: null };
    }
    throw error;
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && CONTAINMENT_TASK_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const remaining = names.filter((name) => options.afterName === undefined || name > options.afterName);
  const batch = remaining.slice(0, limit);
  let removedFiles = 0;
  for (const name of batch) {
    removedFiles += await pruneVerifiedWindowsContainmentInputs(path.join(rootDirectory, name, 'containment.receipt.json'));
  }
  return {
    inspected: batch.length,
    removedFiles,
    nextCursor: remaining.length > batch.length ? batch.at(-1) ?? null : null,
  };
}

const containedLaunchScript = String.raw`param([string]$Directory)
$ErrorActionPreference='Stop'
$job=$null
try {
 Add-Type -Path (Join-Path $Directory 'containment.cs')
 $spec=Get-Content -LiteralPath (Join-Path $Directory 'containment.json') -Raw | ConvertFrom-Json
 $job=[ContainedProcess]::Start([string]$spec.executable,[string[]]@($spec.arguments),[string]$spec.cwd,[bool]$spec.windowsVerbatimArguments)
 $end=[DateTime]::UtcNow.AddMilliseconds([double]$spec.timeoutMs)
 $outcome='completed'
 while($true) {
  if([IO.File]::Exists((Join-Path $Directory 'containment.cancel'))) {$outcome='cancelled';$job.Cancel();break}
  if([DateTime]::UtcNow -ge $end) {$outcome='timed_out';$job.Cancel();break}
  try {$exitCode=$job.WaitForExit(100);break} catch {
   if($_.Exception.InnerException -isnot [TimeoutException]) {throw}
  }
 }
 if($outcome -ne 'completed') {$exitCode=1}
 if($job.ActiveProcesses -ne 0) {throw 'CONTAINMENT_UNVERIFIED'}
 $receipt=@{kind='windows_job_v1';outcome=$outcome;exitCode=$exitCode;activeProcesses=0} | ConvertTo-Json -Compress
 $temporary=Join-Path $Directory 'containment.receipt.tmp'
 [IO.File]::WriteAllText($temporary,$receipt,(New-Object Text.UTF8Encoding($false)))
 [IO.File]::Move($temporary,(Join-Path $Directory 'containment.receipt.json'))
 exit $exitCode
} catch {
 [Console]::Error.WriteLine('CONTAINMENT_UNRESOLVED')
 exit 125
} finally {
 if($null -ne $job) {$job.Dispose()}
}
`;
