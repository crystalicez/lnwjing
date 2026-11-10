import { lstat, opendir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

/**
 * Conservative disposable-only profile reclaim. Never walks user repositories
 * or deletes SQLite, backups, checkpoints, recovery trash, authoritative
 * workspace indexes or active logs. Abandoned *staging* index files are eligible
 * only after an age and verified-dead writer-PID check.
 */
export interface DisposableReclaimResult {
  readonly inspected: number;
  readonly removed: number;
  /** Logical size of successfully unlinked files, NOT verified NTFS bytes freed. */
  readonly removedLogicalBytes: number;
  readonly truncated: boolean;
}

export interface DisposableReclaimOptions {
  readonly nowMs?: number;
  readonly minimumAgeMs?: number;
  readonly maxEntries?: number;
  readonly maxRemovals?: number;
}

const SUBDIRECTORIES = ['logs', 'diagnostics', 'crash-dumps', 'workspace-index'] as const;
const ALLOWED_EXTENSIONS = /\.(?:log|txt|jsonl|ndjson|trace|dmp|gz)$/i;
/** The exact JsonWorkspaceIndexStore atomic staging filename shapes only. */
const INDEX_STAGING_NAME = /^.+\.json(?:\.meta\.json)?\.([1-9]\d{0,9})\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
const DEFAULT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2048;
const MAX_REMOVALS = 128;

function assertSafeProfileRoot(root: string): void {
  if (!path.isAbsolute(root)) throw new Error('Disposable cleanup requires an absolute profile');
  const file = lstatSync(root);
  if (!file.isDirectory() || file.isSymbolicLink()) throw new Error('Disposable cleanup profile is redirected');
  const resolved = realpathSync(root);
  if (process.platform === 'win32'
    ? resolved.toLowerCase() !== path.resolve(root).toLowerCase()
    : resolved !== path.resolve(root)) throw new Error('Disposable cleanup profile is not canonical');
}

interface Candidate {
  readonly filename: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly parentDev: number;
  readonly parentIno: number;
  readonly writerPid: number | null;
}

/** Only ESRCH establishes dead ownership. EPERM and other errors preserve files. */
function ownerDefinitelyGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return false;
  try { process.kill(pid, 0); return false; }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export async function reclaimExpiredDisposableFiles(
  profileRoot: string,
  options: DisposableReclaimOptions = {},
): Promise<DisposableReclaimResult> {
  assertSafeProfileRoot(profileRoot);
  const now = options.nowMs ?? Date.now();
  const age = options.minimumAgeMs ?? DEFAULT_AGE_MS;
  const entryLimit = options.maxEntries ?? MAX_ENTRIES;
  const removalLimit = options.maxRemovals ?? MAX_REMOVALS;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(age) || age < DEFAULT_AGE_MS
    || !Number.isSafeInteger(entryLimit) || entryLimit < 1 || entryLimit > MAX_ENTRIES
    || !Number.isSafeInteger(removalLimit) || removalLimit < 1 || removalLimit > MAX_REMOVALS) {
    throw new Error('Invalid disposable cleanup bounds');
  }
  const cutoff = now - age;
  const candidates: Candidate[] = [];
  let inspected = 0;
  let truncated = false;
  const root = path.resolve(profileRoot);
  const rootStat = await lstat(root);
  for (const directoryName of SUBDIRECTORIES) {
    const directory = path.join(root, directoryName);
    let info;
    try { info = await lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== rootStat.dev) {
      truncated = true;
      continue;
    }
    const dir = await opendir(directory);
    try {
    for await (const entry of dir) {
      if (inspected >= entryLimit) { truncated = true; break; }
      inspected++;
      if (!entry.isFile()) continue;
      const writerPid = directoryName === 'workspace-index'
        ? Number(INDEX_STAGING_NAME.exec(entry.name)?.[1] ?? 0) : null;
      if (directoryName === 'workspace-index'
        ? writerPid === null || writerPid === 0
        : !ALLOWED_EXTENSIONS.test(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      try {
        const stat = await lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
          || stat.dev !== rootStat.dev || !Number.isSafeInteger(stat.size)
          || stat.size < 0 || stat.mtimeMs >= cutoff
          || writerPid !== null && !ownerDefinitelyGone(writerPid)) continue;
        candidates.push({ filename, size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino,
          parentDev: info.dev, parentIno: info.ino, writerPid });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    } finally { await dir.close().catch(() => undefined); }
    if (inspected >= entryLimit) break;
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.filename.localeCompare(b.filename));
  let removed = 0;
  let removedLogicalBytes = 0;
  for (const candidate of candidates.slice(0, removalLimit)) {
    // Re-check the parent: it may have become a junction or been replaced
    // between enumerating the directory and unlinking the candidate.
    const parent = path.dirname(candidate.filename);
    const parentStat = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (parentStat === null || !parentStat.isDirectory() || parentStat.isSymbolicLink()
      || parentStat.dev !== candidate.parentDev || parentStat.ino !== candidate.parentIno) continue;
    const parentResolved = realpathSync(parent);
    if (process.platform === 'win32'
      ? parentResolved.toLowerCase() !== parent.toLowerCase()
      : parentResolved !== parent) continue;
    const stat = await lstat(candidate.filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat === null || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.dev !== candidate.dev || stat.ino !== candidate.ino || stat.size !== candidate.size
      || stat.mtimeMs !== candidate.mtimeMs || stat.mtimeMs >= cutoff
      || candidate.writerPid !== null && !ownerDefinitelyGone(candidate.writerPid)) continue;
    try {
      await unlink(candidate.filename);
      removed++;
      removedLogicalBytes += candidate.size;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return {
    inspected, removed, removedLogicalBytes,
    truncated: truncated || candidates.length > removalLimit,
  };
}
