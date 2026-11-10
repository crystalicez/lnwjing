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

export function sqliteMutationAdmissionPressure(allocatedBytes: number, freeBytes: number, walBytes: number, limitBytes: number): boolean {
  if (![allocatedBytes, freeBytes, walBytes, limitBytes].every(Number.isSafeInteger)
    || allocatedBytes < 0 || freeBytes < 0 || freeBytes > allocatedBytes
    || walBytes < 0 || limitBytes <= 0) return true;
  // The configured hard limit is for MAIN database pages, not the WAL.
  // WAL bytes are physically separate and cannot consume SQLite's max_page_count.
  // Counting them as database pages falsely freezes writes when readers pin WAL.
  const reserved = Math.max(16 * 1024 * 1024, Math.floor(limitBytes * 0.05));
  return limitBytes - (allocatedBytes - freeBytes) <= reserved;
}

/**
 * The main-page limit does not cap WAL disk usage. Check physical free space
 * only for an unusually large WAL, avoiding per-MCP-call filesystem polling
 * while SQLite is working normally. This is a low-disk safety guard, NOT a
 * promise that WAL stays within the main database quota.
 */
export function sqliteWalLowDiskPressure(walBytes: number, limitBytes: number, availableBytes: bigint): boolean {
  if (!Number.isSafeInteger(walBytes) || walBytes < 0 || !Number.isSafeInteger(limitBytes) || limitBytes <= 0
    || availableBytes < 0n) return true;
  const unusuallyLargeWal = Math.max(128 * 1024 ** 2, Math.min(512 * 1024 ** 2, Math.floor(limitBytes / 8)));
  if (walBytes < unusuallyLargeWal) return false;
  const minimumFree = Math.max(512 * 1024 ** 2, Math.min(2 * 1024 ** 3, Math.floor(limitBytes / 4)));
  return availableBytes < BigInt(minimumFree);
}

export function sqliteLimitPressure(allocatedBytes: number, freeBytes: number, limitBytes: number): boolean {
  // Free pages can be reused: a full SQLite file is not necessarily exhausted.
  return allocatedBytes - freeBytes >= limitBytes * 0.85;
}
