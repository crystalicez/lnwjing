import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SQLITE_LIFECYCLE_LOCK_FILENAME = 'sqlite-lifecycle.lock';

const LOCK_WAIT_INTERVAL_MS = 25;
const LOCK_WAIT_TIMEOUT_MS = 120_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface LockOwner {
  readonly pid: number;
  readonly ownerId?: string;
}

export function withSqliteLifecycleLockSync<T>(directory: string, operation: () => T): T {
  mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, SQLITE_LIFECYCLE_LOCK_FILENAME);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  const ownerId = randomUUID();
  let descriptor: number | undefined;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx');
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'EEXIST') && !isWindowsLiveOwnerContention(error, lockPath)) throw error;
      if (reclaimDeadOwnerLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for SQLite lifecycle lock: ${lockPath}`);
      Atomics.wait(sleepCell, 0, 0, LOCK_WAIT_INTERVAL_MS);
    }
  }

  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, ownerId, acquiredAt: new Date().toISOString() }), 'utf8');
    return operation();
  } finally {
    const created = fstatSync(descriptor);
    closeSync(descriptor);
    try {
      const current = lstatSync(lockPath);
      if (current.isFile() && current.dev === created.dev && current.ino === created.ino
        && readLockOwner(lockPath)?.ownerId === ownerId) {
        rmSync(lockPath);
      }
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'ENOENT')) process.stderr.write('SQLite lifecycle lock cleanup failed\n');
    }
  }
}

export function isWindowsLiveOwnerContention(error: unknown, lockPath: string): boolean {
  if (process.platform !== 'win32' || (!hasErrorCode(error, 'EPERM') && !hasErrorCode(error, 'EACCES'))) return false;
  try {
    if (!lstatSync(lockPath).isFile()) return false;
    const owner = readLockOwner(lockPath);
    return owner !== null && processIsAlive(owner.pid);
  } catch {
    return false;
  }
}

function reclaimDeadOwnerLock(lockPath: string): boolean {
  try {
    const before = lstatSync(lockPath);
    if (!before.isFile()) return false;
    const owner = readLockOwner(lockPath);
    if (owner === null || processIsAlive(owner.pid)) return false;
    // A creator can briefly expose an empty lock file before recording its
    // identity. Never reclaim it until its owner is provably dead.
    const current = lstatSync(lockPath);
    if (current.dev !== before.dev || current.ino !== before.ino) return false;
    if (readLockOwner(lockPath)?.pid !== owner.pid) return false;
    rmSync(lockPath);
    return true;
  } catch (error: unknown) {
    return hasErrorCode(error, 'ENOENT');
  }
}

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('pid' in parsed)
      || !Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return null;
    const ownerId = 'ownerId' in parsed && typeof parsed.ownerId === 'string' ? parsed.ownerId : undefined;
    return { pid: parsed.pid as number, ...(ownerId === undefined ? {} : { ownerId }) };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
