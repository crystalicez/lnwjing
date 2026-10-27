import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CLIENT_DIRECTORY = 'sqlite-live-clients';

export interface SqliteClientLease {
  readonly filename: string;
  readonly ownerId: string;
  readonly device: number;
  readonly inode: number;
}

/**
 * One small, per-connection lifetime record. Call under the SQLite lifecycle
 * lock after opening the DB so a concurrent restore cannot miss the new owner.
 * No heartbeat or disk writes occur while the connection is idle.
 */
export function registerSqliteClientSync(backupDirectory: string): SqliteClientLease {
  const directory = path.join(backupDirectory, CLIENT_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  if (!lstatSync(directory).isDirectory()) throw new Error('SQLite client lease directory is redirected');
  const ownerId = randomUUID();
  const filename = path.join(directory, `${process.pid}-${ownerId}.json`);
  const fd = openSync(filename, 'wx');
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ownerId, acquiredAt: new Date().toISOString() }));
    const identity = fstatSync(fd);
    return { filename, ownerId, device: identity.dev, inode: identity.ino };
  } catch (error) {
    rmSync(filename, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
}

/** Call while holding the lifecycle lock, after the owned SQLite connection closes. */
export function releaseSqliteClientSync(lease: SqliteClientLease): void {
  if (!existsSync(lease.filename)) return;
  const identity = lstatSync(lease.filename);
  if (identity.dev !== lease.device || identity.ino !== lease.inode || !identity.isFile()) return;
  const owner = readLease(lease.filename);
  if (owner?.ownerId === lease.ownerId && owner.pid === process.pid) rmSync(lease.filename);
}

/**
 * A registered process can still have active SQLite WAL/SHM handles even if
 * the short-lived lifecycle lock is free. Fail closed before restore rather
 * than trusting a successful checkpoint as a writer-exclusion mechanism.
 */
export function assertNoActiveSqliteClientsSync(backupDirectory: string): void {
  const directory = path.join(backupDirectory, CLIENT_DIRECTORY);
  if (!existsSync(directory)) return;
  if (!lstatSync(directory).isDirectory()) throw new Error('SQLite client lease directory is redirected');
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const filename = path.join(directory, name);
    const original = lstatSync(filename);
    if (!original.isFile()) throw new Error('Active SQLite runtime connection registry is invalid');
    const owner = readLease(filename);
    if (owner === null) throw new Error('Active SQLite runtime connection registry is unreadable');
    if (isAlive(owner.pid)) {
      throw new Error('Restore blocked by an active SQLite runtime connection; stop Desktop and MCP STDIO before retrying');
    }
    // The lifecycle lock excludes concurrent registration and release. Verify
    // file identity again before retiring an owner whose PID has exited.
    const current = lstatSync(filename);
    if (current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error('Active SQLite runtime connection registry changed during restore');
    }
    if (readLease(filename)?.ownerId !== owner.ownerId) {
      throw new Error('Active SQLite runtime connection registry changed during restore');
    }
    rmSync(filename);
  }
}

function readLease(filename: string): { readonly pid: number; readonly ownerId: string } | null {
  try {
    const value: unknown = JSON.parse(readFileSync(filename, 'utf8'));
    if (typeof value !== 'object' || value === null || !('pid' in value) || !('ownerId' in value)
      || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
      || typeof value.ownerId !== 'string' || value.ownerId.length < 16) return null;
    return { pid: value.pid as number, ownerId: value.ownerId };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
  }
}
