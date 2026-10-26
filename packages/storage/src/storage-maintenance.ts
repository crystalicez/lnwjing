import { realpathSync, statfsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

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
  const backup = await options.createVerifiedBackup();
  if (backup?.verified !== true || backup.id.length === 0) throw new Error('Verified backup was not created');
  connection.exec('VACUUM;');
  const after = inspectSqliteCompaction(connection, minimum);
  return { performed: true, before, after };
}
