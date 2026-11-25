import { lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
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
  const directory = path.dirname(receiptPath);
  const parent = await lstat(directory).catch(() => null);
  if (parent === null || !parent.isDirectory() || parent.isSymbolicLink()) return 0;
  const canonical = await realpath(directory).catch(() => '');
  if (process.platform === 'win32' ? canonical.toLowerCase() !== path.resolve(directory).toLowerCase()
    : canonical !== path.resolve(directory)) return 0;
  // Fast path for new workers: they already remove their launcher inputs.
  const names = ['containment.cs', 'containment.ps1', 'containment.json'];
  const entries = await readdir(directory).catch(() => [] as string[]);
  const candidates = names.filter(name => entries.includes(name));
  if (candidates.length === 0) return 0;
  const proof = await lstat(receiptPath).catch(() => null);
  if (proof === null || !proof.isFile() || proof.isSymbolicLink() || proof.nlink !== 1
    || proof.dev !== parent.dev || proof.size > 4096
    || await readWindowsContainmentReceipt(receiptPath) === undefined) return 0;
  let removed = 0;
  for (const name of candidates) {
    const filename = path.join(directory, name);
    const candidate = await lstat(filename).catch(() => null);
    if (candidate === null || !candidate.isFile() || candidate.isSymbolicLink()
      || candidate.nlink !== 1 || candidate.dev !== parent.dev) continue;
    const currentParent = await lstat(directory).catch(() => null);
    const currentProof = await lstat(receiptPath).catch(() => null);
    const current = await lstat(filename).catch(() => null);
    if (currentParent === null || !currentParent.isDirectory() || currentParent.isSymbolicLink()
      || currentParent.ino !== parent.ino || currentParent.dev !== parent.dev
      || currentProof === null || !currentProof.isFile() || currentProof.isSymbolicLink()
      || currentProof.nlink !== 1 || currentProof.dev !== proof.dev || currentProof.ino !== proof.ino
      || currentProof.mtimeMs !== proof.mtimeMs || currentProof.size !== proof.size
      || current === null || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || current.ino !== candidate.ino || current.dev !== candidate.dev || current.size !== candidate.size
      || current.mtimeMs !== candidate.mtimeMs) continue;
    try { await unlink(filename); removed++; } catch { /* best effort */ }
  }
  return removed;
}

/** Old terminal shell sidecars are not durable evidence. Retain task.json,
 * receipt, and every requested nonempty stream. Never touch active/uncertain
 * tasks or redirected/hard-linked entries. Only explicit maintenance uses this.
 */
async function pruneOldTerminalShellSidecars(directory: string, taskId: string): Promise<number> {
  const parent = await lstat(directory).catch(() => null);
  if (parent === null || !parent.isDirectory() || parent.isSymbolicLink()) return 0;
  const canonical = await realpath(directory).catch(() => '');
  if (process.platform === 'win32' ? canonical.toLowerCase() !== path.resolve(directory).toLowerCase()
    : canonical !== path.resolve(directory)) return 0;
  const metadataPath = path.join(directory, 'task.json');
  const receiptPath = path.join(directory, 'containment.receipt.json');
  const metadataStat = await lstat(metadataPath).catch(() => null);
  const receiptStat = await lstat(receiptPath).catch(() => null);
  if (metadataStat === null || receiptStat === null || !metadataStat.isFile() || !receiptStat.isFile()
    || metadataStat.isSymbolicLink() || receiptStat.isSymbolicLink() || metadataStat.nlink !== 1 || receiptStat.nlink !== 1
    || metadataStat.size > 65536 || receiptStat.size > 4096) return 0;
  const receipt = await readWindowsContainmentReceipt(receiptPath);
  if (receipt === undefined) return 0;
  let metadata: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 0;
    metadata = parsed as Record<string, unknown>;
  } catch { return 0; }
  const cutoff = Date.now() - 7 * 86400 * 1000;
  const finished = typeof metadata.finished_at === 'string' ? Date.parse(metadata.finished_at) : NaN;
  const expectedState = receipt.outcome === 'completed' ? (receipt.exitCode === 0 ? 'completed' : 'failed') : receipt.outcome;
  if (metadata.version !== 1 || metadata.task_id !== taskId || metadata.containment !== 'windows_job_v1'
    || metadata.state !== expectedState || metadata.exit_code !== receipt.exitCode
    || !Number.isFinite(finished) || finished >= cutoff
    || typeof metadata.include_stdout !== 'boolean' || typeof metadata.include_stderr !== 'boolean') return 0;
  let removed = 0;
  for (const name of ['worker.pid', 'worker.started', 'stdout.log', 'stderr.log']) {
    const filename = path.join(directory, name);
    const candidate = await lstat(filename).catch(() => null);
    if (candidate === null || !candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== 1
      || candidate.dev !== parent.dev || candidate.mtimeMs >= cutoff) continue;
    if (name === 'stdout.log' && metadata.include_stdout && candidate.size > 0) continue;
    if (name === 'stderr.log' && metadata.include_stderr && candidate.size > 0) continue;
    const currentParent = await lstat(directory).catch(() => null);
    const currentMetadata = await lstat(metadataPath).catch(() => null);
    const currentReceipt = await lstat(receiptPath).catch(() => null);
    const current = await lstat(filename).catch(() => null);
    if (currentParent === null || !currentParent.isDirectory() || currentParent.isSymbolicLink()
      || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino
      || currentMetadata === null || currentMetadata.ino !== metadataStat.ino || currentMetadata.mtimeMs !== metadataStat.mtimeMs
      || currentReceipt === null || currentReceipt.ino !== receiptStat.ino || currentReceipt.mtimeMs !== receiptStat.mtimeMs
      || current === null || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || current.ino !== candidate.ino || current.dev !== candidate.dev || current.size !== candidate.size
      || current.mtimeMs !== candidate.mtimeMs) continue;
    try { await unlink(filename); removed++; } catch { /* best effort */ }
  }
  return removed;
}

// One directory enumeration per interactive cleanup pass. A sorted in-memory
// cursor avoids rereading tens of thousands of task directories every 32 jobs.
const cleanupDirectoryCache = new Map<string, { names: readonly string[]; sampledAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const CONTAINMENT_TASK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Explicit maintenance of old completed native launch inputs.
 * Caller selects one trusted per-application root and advances nextCursor.
 * Never recurse into workspaces, follow symlinks, or remove result metadata.
 */
export async function pruneVerifiedWindowsContainmentRoot(
  rootDirectory: string,
  options: { readonly userConfirmed: boolean; readonly maxDirectories?: number; readonly afterName?: string; readonly pruneShellSidecars?: boolean },
): Promise<{ readonly inspected: number; readonly removedFiles: number; readonly nextCursor: string | null }> {
  if (options.userConfirmed !== true) throw new Error('Native retention cleanup requires explicit confirmation');
  const limit = options.maxDirectories ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('Invalid containment cleanup batch size');
  if (options.afterName !== undefined && !CONTAINMENT_TASK_ID.test(options.afterName)) {
    throw new Error('Invalid native retention cursor');
  }
  const cacheKey = path.resolve(rootDirectory);
  const now = Date.now();
  const cached = cleanupDirectoryCache.get(cacheKey);
  let names: readonly string[];
  if (cached !== undefined && now - cached.sampledAt < CACHE_TTL_MS) {
    names = cached.names;
  } else {
    let entries: Dirent[];
    try {
      entries = await readdir(rootDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return { inspected: 0, removedFiles: 0, nextCursor: null };
      }
      throw error;
    }
    names = entries
      .filter((entry) => entry.isDirectory() && CONTAINMENT_TASK_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    if (cleanupDirectoryCache.size >= 3) cleanupDirectoryCache.clear();
    cleanupDirectoryCache.set(cacheKey, { names, sampledAt: now });
  }
  let start = 0;
  let end = names.length;
  const after = options.afterName;
  if (after !== undefined) {
    // Upper bound in the sorted snapshot; avoid an O(n) filter per page.
    while (start < end) {
      const middle = start + Math.floor((end - start) / 2);
      if (names[middle]! <= after) start = middle + 1;
      else end = middle;
    }
  }
  const batch = names.slice(start, start + limit);
  let removedFiles = 0;
  for (const name of batch) {
    const directory = path.join(rootDirectory, name);
    removedFiles += await pruneVerifiedWindowsContainmentInputs(path.join(directory, 'containment.receipt.json'));
    if (options.pruneShellSidecars === true) removedFiles += await pruneOldTerminalShellSidecars(directory, name);
  }
  const nextCursor = start + batch.length < names.length ? batch.at(-1) ?? null : null;
  if (nextCursor === null) cleanupDirectoryCache.delete(cacheKey);
  return { inspected: batch.length, removedFiles, nextCursor };
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
 $rootExitedAt=[DateTime]::MinValue
 $lastConsoleDrainAt=[DateTime]::MinValue
 while($true) {
  if([IO.File]::Exists((Join-Path $Directory 'containment.cancel'))) {$outcome='cancelled';$job.Cancel();break}
  if([DateTime]::UtcNow -ge $end) {$outcome='timed_out';$job.Cancel();break}
  try {$exitCode=$job.WaitForExit(100);break} catch {
   if($_.Exception.InnerException -isnot [TimeoutException]) {throw}
  }
  if($job.RootExited) {
   $now=[DateTime]::UtcNow
   if($rootExitedAt -eq [DateTime]::MinValue) {$rootExitedAt=$now}
   # A console host normally disappears as soon as its last client exits.
   # After a two-second grace, inspect job-owned PIDs and drain ONLY a stable
   # set of verified System32 console hosts. Never touch ordinary descendants
   # or bypass the kernel's zero-active proof.
   if($now -ge $rootExitedAt.AddSeconds(2) -and $now -ge $lastConsoleDrainAt.AddMilliseconds(1500)) {
    $lastConsoleDrainAt=$now
    if($job.TryDrainOrphanedConsoleHosts()) {
     [Console]::Error.WriteLine('CONTAINMENT_ORPHANED_CONSOLE_HOST_CLEARED')
    }
   }
  }
 }
 if($outcome -ne 'completed') {$exitCode=1}
 if($job.ActiveProcesses -ne 0) {throw 'CONTAINMENT_UNVERIFIED'}
 $receipt=@{kind='windows_job_v1';outcome=$outcome;exitCode=$exitCode;activeProcesses=0} | ConvertTo-Json -Compress
 $temporary=Join-Path $Directory 'containment.receipt.tmp'
 [IO.File]::WriteAllText($temporary,$receipt,(New-Object Text.UTF8Encoding($false)))
 [IO.File]::Move($temporary,(Join-Path $Directory 'containment.receipt.json'))
 # The source and launch spec are single-use. Once zero-active proof is durable,
 # remove them even if the caller never polls the completed task. A sharing
 # violation is harmless: host-side verified cleanup remains the fallback.
 foreach($name in @('containment.cs','containment.json','containment.ps1')) {
  try {[IO.File]::Delete((Join-Path $Directory $name))} catch {}
 }
 exit $exitCode
} catch {
 [Console]::Error.WriteLine('CONTAINMENT_UNRESOLVED')
 exit 125
} finally {
 if($null -ne $job) {$job.Dispose()}
}
`;
