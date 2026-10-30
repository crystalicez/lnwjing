import type { DatabaseSync } from 'node:sqlite';

/** Applies to the canonical main SQLite database, not its WAL or backups. */
export const SQLITE_HARD_LIMIT_SETTING_KEY = 'sqlite_main_hard_limit_mib_v1';
export const DEFAULT_SQLITE_HARD_LIMIT_MIB = 4096;
export const MIN_SQLITE_HARD_LIMIT_MIB = 512;
export const MAX_SQLITE_HARD_LIMIT_MIB = 16384;

export function parseSqliteHardLimitMiB(value: string | null): number {
  const parsed = value === null ? DEFAULT_SQLITE_HARD_LIMIT_MIB : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= MIN_SQLITE_HARD_LIMIT_MIB
    && parsed <= MAX_SQLITE_HARD_LIMIT_MIB ? parsed : DEFAULT_SQLITE_HARD_LIMIT_MIB;
}

export interface SqliteHardLimitSnapshot {
  readonly requestedBytes: number;
  readonly effectiveBytes: number;
  readonly allocatedBytes: number;
  readonly freeBytes: number;
}

export function inspectSqliteHardLimit(connection: DatabaseSync, limitMiB: number): SqliteHardLimitSnapshot {
  const pageSize = (connection.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  const maxPages = (connection.prepare('PRAGMA max_page_count').get() as { max_page_count: number }).max_page_count;
  const pageCount = (connection.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const freePages = (connection.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
  return { requestedBytes: limitMiB * 1024 * 1024, effectiveBytes: maxPages * pageSize,
    allocatedBytes: pageCount * pageSize, freeBytes: freePages * pageSize };
}

export function applySqliteHardLimit(connection: DatabaseSync, limitMiB: number): SqliteHardLimitSnapshot {
  if (!Number.isSafeInteger(limitMiB) || limitMiB < MIN_SQLITE_HARD_LIMIT_MIB || limitMiB > MAX_SQLITE_HARD_LIMIT_MIB) {
    throw new Error('Invalid SQLite main database limit');
  }
  const pageSize = (connection.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  const pages = Math.floor(limitMiB * 1024 * 1024 / pageSize);
  // SQLite cannot lower max_page_count below currently allocated pages.
  connection.exec('PRAGMA max_page_count = ' + pages);
  return inspectSqliteHardLimit(connection, limitMiB);
}

export function sqliteLimitPressure(allocatedBytes: number, freeBytes: number, limitBytes: number): boolean {
  // Free pages can be reused: a full SQLite file is not necessarily exhausted.
  return allocatedBytes - freeBytes >= limitBytes * 0.85;
}
