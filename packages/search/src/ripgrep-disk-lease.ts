import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Same-user, cross-process disk-scan budget for Desktop and MCP STDIO.
 * No daemon, background timer or periodic disk scan: lock I/O happens only
 * when a request actually needs ripgrep.
 *
 * The lock directory is shared through LOCALAPPDATA on Windows, where
 * Desktop and its MCP child processes normally run under the same account.
 * Other Windows users are intentionally NOT claimed to share this budget.
 */
const SLOT_COUNT = 2;
const WAIT_MS = 12_000;
const RETRY_MS = 250;
const STALE_GRACE_MS = 120_000;
const LOCK_PREFIX = 'lnwjing-rg-admission-v1';
const currentPid = process.pid;

export type DiskScanLease =
  | { readonly status: 'granted'; readonly release: () => Promise<void> }
  | { readonly status: 'busy' | 'aborted' };

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

export interface DiskScanLeaseOptions {
  readonly directory?: string;
  readonly waitMs?: number;
}

/**
 * Acquire both a global disk slot and a per-workspace slot. Fail closed if
 * the coordination store is inaccessible; otherwise independent MCP processes
 * could silently bypass the intended I/O budget.
 */
export async function acquireDiskScanLease(
  workspacePath: string,
  signal?: AbortSignal,
  options: DiskScanLeaseOptions = {},
): Promise<DiskScanLease> {
  if (signal?.aborted) return { status: 'aborted' };
  const directory = options.directory ?? path.join(
    process.platform === 'win32' ? (process.env.LOCALAPPDATA || os.tmpdir()) : os.tmpdir(),
    LOCK_PREFIX,
  );
  const canonicalRoot = path.resolve(workspacePath).replaceAll('\\', '/').toLowerCase().replace(/\/$/, '');
  const rootKey = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 24);
  const rootFile = path.join(directory, `root-${rootKey}.lock`);
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);

  try {
    await mkdir(directory, { recursive: true });
  } catch {
    return { status: 'busy' };
  }

  while (true) {
    if (signal?.aborted) return { status: 'aborted' };
    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const slot = (currentPid + i) % SLOT_COUNT;
      const slotLock = await tryCreateLock(path.join(directory, `slot-${slot}.lock`));
      if (slotLock === null) continue;
      const rootLock = await tryCreateLock(rootFile);
      if (rootLock !== null) {
        let released = false;
        return {
          status: 'granted',
          release: async (): Promise<void> => {
            if (released) return;
            released = true;
            try {
              await rootLock();
            } finally {
              await slotLock();
            }
          },
        };
      }
      // Root owned by another scan: do not hold a global slot while waiting.
      await slotLock();
    }
    if (Date.now() >= deadline) return { status: signal?.aborted ? 'aborted' : 'busy' };
    if (await delayOrAbort(Math.min(RETRY_MS, deadline - Date.now()), signal)) return { status: 'aborted' };
  }
}

async function tryCreateLock(filePath: string): Promise<(() => Promise<void>) | null> {
  const owner: LockOwner = { pid: currentPid, token: randomUUID() };
  let opened: Awaited<ReturnType<typeof open>> | null = null;
  try {
    opened = await open(filePath, 'wx', 0o600);
    await opened.writeFile(JSON.stringify(owner), 'utf8');
    await opened.close();
    opened = null;
  } catch (error) {
    if (opened !== null) {
      await opened.close().catch(() => undefined);
      // Never strand an empty lock after a partial write or disk-full error.
      await unlink(filePath).catch(() => undefined);
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      await removeDeadLock(filePath);
      return null;
    }
    return null;
  }
  return async (): Promise<void> => {
    try {
      const current = JSON.parse(await readFile(filePath, 'utf8')) as LockOwner;
      if (current.token === owner.token && current.pid === owner.pid) await unlink(filePath);
    } catch { /* Missing lock: never remove a successor's ownership. */ }
  };
}

async function removeDeadLock(filePath: string): Promise<void> {
  try {
    const details = await stat(filePath);
    if (!details.isFile() || Date.now() - details.mtimeMs < STALE_GRACE_MS) return;
    const owner = JSON.parse(await readFile(filePath, 'utf8')) as LockOwner;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') return;
    try {
      process.kill(owner.pid, 0);
      return; // Includes PID reuse: a live process always wins over cleanup.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
    }
    // Only reclaim a dead owner's old lock; live, recent and unknown files remain untouched.
    await unlink(filePath);
  } catch { /* Inaccessible locks are treated as occupied (fail closed). */ }
}

function delayOrAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (aborted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(aborted);
    };
    const abort = (): void => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(1, ms));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
