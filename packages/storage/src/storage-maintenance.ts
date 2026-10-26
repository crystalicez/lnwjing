import { lstatSync, opendirSync, realpathSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteBackupService } from './backup-service.js';
import { SqliteDatabase } from './database.js';

export interface SqliteCompactionPlan {
  readonly allocatedBytes: number;
  readonly freeBytes: number;
  readonly reclaimablePercent: number;
  readonly recommended: boolean;
}

function pragmaNumber(connection: DatabaseSync, name: 'page_count' | 'page_size' | 'freelist_count'): number {
  const row = connection.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SQLite ${name} is unavailable`);
  }
  return value;
}

/** Reads only SQLite page metadata. No content scan or write to user data. */
export function inspectSqliteCompaction(
  connection: DatabaseSync,
  minimumReclaimBytes = 64 * 1024 * 1024,
): SqliteCompactionPlan {
  const pages = pragmaNumber(connection, 'page_count');
  const pageSize = pragmaNumber(connection, 'page_size');
  const freePages = pragmaNumber(connection, 'freelist_count');
  const allocatedBytes = pages * pageSize;
  const freeBytes = freePages * pageSize;
  const reclaimablePercent = allocatedBytes === 0 ? 0 : freeBytes / allocatedBytes * 100;
  // VACUUM causes a full database rewrite. Avoid premature SSD wear.
  return {
    allocatedBytes,
    freeBytes,
    reclaimablePercent,
    recommended: freeBytes >= minimumReclaimBytes && reclaimablePercent >= 20,
  };
}

export interface ManualCompactionOptions {
  readonly databasePath: string;
  readonly userConfirmed: boolean;
  /** Must create AND validate a durable SQLite backup, or reject the operation. */
  readonly createVerifiedBackup: () => Promise<{ readonly verified: true; readonly id: string }>;
  readonly minimumReclaimBytes?: number;
  /** Fail closed unless the host has stopped its MCP/watchers/task writers. */
  readonly assertRuntimeStopped: () => Promise<boolean>;
}

/**
 * Explicit-only, never called on startup/idle. Caller must quiesce application
 * writers first, and use SqliteBackupService.create('manual') as backup provider.
 */
export async function compactSqliteWithBackup(
  connection: DatabaseSync,
  options: ManualCompactionOptions,
): Promise<{ readonly performed: boolean; readonly before: SqliteCompactionPlan; readonly after: SqliteCompactionPlan }> {
  if (options.userConfirmed !== true) throw new Error('SQLite compaction requires explicit user confirmation');
  const minimum = options.minimumReclaimBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error('Invalid compaction threshold');
  const before = inspectSqliteCompaction(connection, minimum);
  if (!before.recommended) return { performed: false, before, after: before };

  // A caller cannot accidentally compact a different opened database.
  const main = connection.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get() as { file?: string } | undefined;
  if (main?.file === undefined || path.normalize(realpathSync(main.file)) !== path.normalize(realpathSync(options.databasePath))) {
    throw new Error('Compaction target does not match the open canonical database');
  }
  const disk = statfsSync(path.dirname(options.databasePath), { bigint: true });
  const available = disk.bavail * disk.bsize;
  // Manual backup plus VACUUM can temporarily require at least two full copies.
  if (available < BigInt(before.allocatedBytes) * 2n + 64n * 1024n * 1024n) {
    throw new Error('Insufficient free disk space for safe SQLite compaction');
  }
  if (await options.assertRuntimeStopped() !== true) {
    throw new Error('SQLite compaction requires offline exclusive maintenance');
  }
  // The offline caller has stopped lnwjing writers. SQLite still verifies an
  // exclusive lock can be obtained, and we keep exclusive locking through
  // the backup + VACUUM. Do not run this function from a live Desktop runtime.
  const previousMode = connection.prepare('PRAGMA locking_mode').get() as { locking_mode?: string } | undefined;
  try {
    const mode = connection.prepare('PRAGMA locking_mode=EXCLUSIVE').get() as { locking_mode?: string } | undefined;
    if (mode?.locking_mode?.toLowerCase() !== 'exclusive') throw new Error('SQLite exclusive locking is unavailable');
    connection.exec('BEGIN EXCLUSIVE; COMMIT;');
    const backup = await options.createVerifiedBackup();
    if (backup?.verified !== true || typeof backup.id !== 'string' || backup.id.length === 0) {
      throw new Error('Verified backup was not created');
    }
    // The backup may have consumed the same volume. Verify free space again
    // before the VACUUM full rewrite instead of relying on the preflight value.
    const afterBackupDisk = statfsSync(path.dirname(options.databasePath), { bigint: true });
    if (afterBackupDisk.bavail * afterBackupDisk.bsize < BigInt(before.allocatedBytes) + 64n * 1024n * 1024n) {
      throw new Error('Insufficient disk space after backup for SQLite compaction');
    }
    connection.exec('VACUUM;');
  } finally {
    if (previousMode?.locking_mode?.toLowerCase() !== 'exclusive') {
      connection.exec('PRAGMA locking_mode=NORMAL;');
    }
  }
  const after = inspectSqliteCompaction(connection, minimum);
  return { performed: true, before, after };
}

/**
 * Offline-only composition for a future maintenance command/UI workflow.
 * The host MUST have terminated Desktop, MCP, watchers and managed writers
 * before calling. Never invoke this from an active DesktopRuntime.
 */
export async function compactOfflineSqliteProfile(options: {
  readonly databasePath: string;
  readonly backupDirectory: string;
  readonly userConfirmed: boolean;
  readonly assertRuntimeStopped: () => Promise<boolean>;
  readonly minimumReclaimBytes?: number;
}): Promise<{
  readonly performed: boolean;
  readonly backupId: string | null;
  readonly before: SqliteCompactionPlan;
  readonly after: SqliteCompactionPlan;
}> {
  if (options.userConfirmed !== true) throw new Error('Offline compaction requires explicit user confirmation');
  if (await options.assertRuntimeStopped() !== true) throw new Error('Offline compaction requires all application writers stopped');
  // Never let a compaction request silently run pending schema migrations.
  // Migrations have their own backup, compatibility and disk-space gates.
  const probe = new DatabaseSync(options.databasePath, { readOnly: true });
  try {
    const latest = probe.prepare(
      "SELECT 1 FROM schema_migrations WHERE id = '026_checkpoint_storage_metadata'",
    ).get();
    if (latest === undefined) throw new Error('Update the profile schema before offline compaction');
  } finally {
    probe.close();
  }
  const database = new SqliteDatabase(options.databasePath, { backupDirectory: options.backupDirectory });
  const backupService = new SqliteBackupService(database, {
    databaseFilename: options.databasePath, backupDirectory: options.backupDirectory,
  });
  let backupId: string | null = null;
  try {
    const result = await compactSqliteWithBackup(database.connection, {
      databasePath: options.databasePath, userConfirmed: true,
      assertRuntimeStopped: options.assertRuntimeStopped,
      ...(options.minimumReclaimBytes === undefined ? {} : { minimumReclaimBytes: options.minimumReclaimBytes }),
      createVerifiedBackup: async () => {
        const saved = await backupService.create('manual');
        if (!(await backupService.verifyBackupForCleanup(saved.id))) {
          throw new Error('Offline compaction backup integrity check failed');
        }
        backupId = saved.id;
        return { verified: true, id: saved.id };
      },
    });
    return { ...result, backupId };
  } finally {
    database.close();
  }
}

/**
 * Bounded, metadata-only directory inspection. Does not read file contents,
 * follow directory symlinks, create caches, or traverse beyond maxEntries.
 */
export function inspectBoundedDirectorySize(
  directory: string,
  maxEntries = 512,
  maxDepth = 3,
): { readonly bytes: number; readonly inspectedEntries: number; readonly truncated: boolean } {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) throw new Error('Invalid storage inspection cap');
  const pending = [{ directory, depth: 0 }];
  let inspectedEntries = 0;
  let bytes = 0;
  let truncated = false;
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    let directoryHandle;
    try {
      if (lstatSync(item.directory).isSymbolicLink()) { truncated = true; continue; }
      directoryHandle = opendirSync(item.directory);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
        truncated ||= error.code === 'EACCES';
        continue;
      }
      throw error;
    }
    try {
      while (inspectedEntries < maxEntries) {
        const entry = directoryHandle.readSync();
        if (entry === null) break;
        inspectedEntries += 1;
        if (entry.isSymbolicLink()) continue;
        const name = path.join(item.directory, entry.name);
        if (entry.isDirectory()) {
          if (item.depth < maxDepth) pending.push({ directory: name, depth: item.depth + 1 });
          else truncated = true;
        } else if (entry.isFile()) {
          try { bytes += lstatSync(name).size; }
          catch { truncated = true; }
        }
      }
      if (inspectedEntries >= maxEntries) truncated = true;
    } finally {
      directoryHandle.closeSync();
    }
    if (truncated && inspectedEntries >= maxEntries) break;
  }
  return { bytes, inspectedEntries, truncated };
}
