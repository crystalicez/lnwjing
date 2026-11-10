import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SqliteDatabase } from './database.js';
import { applySqliteHardLimit, inspectSqliteHardLimit, sqliteLimitPressure,
  DEFAULT_SQLITE_HARD_LIMIT_MIB, SQLITE_HARD_LIMIT_SETTING_KEY, sqliteMutationAdmissionPressure, sqliteWalLowDiskPressure } from './sqlite-hard-limit.js';

describe('SQLite main database hard limit', () => {
  it('defaults to four GiB, persists custom limits and reapplies after reopening', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-hard-limit-'));
    const filename = path.join(root, 'main.sqlite');
    const db = new SqliteDatabase(filename);
    const peer = new SqliteDatabase(filename);
    const passive = new SqliteDatabase(filename);
    try {
      const initial = inspectSqliteHardLimit(db.connection, DEFAULT_SQLITE_HARD_LIMIT_MIB);
      expect(initial.requestedBytes).toBe(4 * 1024 ** 3);
      expect(initial.effectiveBytes).toBe(initial.requestedBytes);
      db.connection.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run(SQLITE_HARD_LIMIT_SETTING_KEY, '1024');
      const configured = db.syncHardLimit();
      expect(configured.effectiveBytes).toBe(1024 ** 3);
      expect(configured.allocatedBytes).toBeLessThan(configured.effectiveBytes);
      // An already-open process still has its original connection-local cap.
      expect(inspectSqliteHardLimit(peer.connection, 1024).effectiveBytes).toBe(4 * 1024 ** 3);
      // A new mutation must use the persisted limit immediately, without
      // waiting for passive read-only connections' 10-second poll.
      expect(peer.mutationAdmissionMessage()).toBeNull();
      expect(inspectSqliteHardLimit(peer.connection, 1024).effectiveBytes).toBe(1024 ** 3);
      expect(inspectSqliteHardLimit(passive.connection, 1024).effectiveBytes).toBe(4 * 1024 ** 3);
      // NTP correction or resume can move the clock backwards. This must
      // force the passive connection to re-read settings, not defer it forever.
      const clockBackwards = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 30_000);
      try {
        expect(inspectSqliteHardLimit(passive.connection, 1024).effectiveBytes).toBe(1024 ** 3);
      } finally { clockBackwards.mockRestore(); }
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);
      try {
        expect(inspectSqliteHardLimit(passive.connection, 1024).effectiveBytes).toBe(1024 ** 3);
      } finally { clock.mockRestore(); }
      expect((db.connection.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number }).journal_size_limit)
        .toBe(16 * 1024 * 1024);
    } finally { passive.close(); peer.close(); db.close(); }
    const reopened = new SqliteDatabase(filename);
    try {
      expect(inspectSqliteHardLimit(reopened.connection, 1024).effectiveBytes).toBe(1024 ** 3);
      expect(reopened.syncHardLimit().effectiveBytes).toBe(1024 ** 3);
    } finally {
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not pretend to shrink an already larger database or delete its rows', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      db.connection.exec('CREATE TABLE sentinel (payload TEXT)');
      db.connection.prepare('INSERT INTO sentinel (payload) VALUES (?)').run('keep');
      // Use tiny pages for the SQLite primitive without allocating hundreds of MiB.
      const count = (db.connection.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
      db.connection.exec('PRAGMA max_page_count = ' + count);
      const effective = (db.connection.prepare('PRAGMA max_page_count').get() as { max_page_count: number }).max_page_count;
      expect(effective).toBeGreaterThanOrEqual(count);
      expect(() => db.connection.prepare('INSERT INTO sentinel (payload) VALUES (?)').run('x'.repeat(1024 * 256)))
        .toThrow();
      expect(db.connection.prepare('SELECT payload FROM sentinel').get()).toEqual({ payload: 'keep' });
      expect(applySqliteHardLimit(db.connection, 512).effectiveBytes).toBe(512 * 1024 ** 2);
    } finally { db.close(); }
  });

  it('reserves headroom for main database pages without treating WAL as main pages', () => {
    const cap = 512 * 1024 * 1024;
    expect(sqliteMutationAdmissionPressure(100 * 1024 ** 2, 0, 0, cap)).toBe(false);
    expect(sqliteMutationAdmissionPressure(470 * 1024 ** 2, 0, 0, cap)).toBe(false);
    expect(sqliteMutationAdmissionPressure(470 * 1024 ** 2, 0, 20 * 1024 ** 2, cap)).toBe(false);
    expect(sqliteMutationAdmissionPressure(490 * 1024 ** 2, 0, 0, cap)).toBe(true);
    expect(sqliteMutationAdmissionPressure(100 * 1024 ** 2, 0, 450 * 1024 ** 2, cap)).toBe(false);
    expect(sqliteMutationAdmissionPressure(490 * 1024 ** 2, 80 * 1024 ** 2, 0, cap)).toBe(false);
    expect(sqliteMutationAdmissionPressure(100, 0, Number.NaN, cap)).toBe(true);
    expect(sqliteMutationAdmissionPressure(100, 101, 0, cap)).toBe(true);
    expect(sqliteMutationAdmissionPressure(-1, 0, 0, cap)).toBe(true);
  });

  it('guards only large WAL under low real disk space, independently of main-page pressure', () => {
    const mib = 1024 ** 2;
    const limit = 2048 * mib;
    expect(sqliteWalLowDiskPressure(255 * mib, limit, 1n)).toBe(false);
    expect(sqliteWalLowDiskPressure(256 * mib, limit, 2n * 1024n ** 3n)).toBe(false);
    expect(sqliteWalLowDiskPressure(256 * mib, limit, 512n * BigInt(mib))).toBe(false);
    expect(sqliteWalLowDiskPressure(256 * mib, limit, 511n * BigInt(mib))).toBe(true);
    expect(sqliteWalLowDiskPressure(-1, limit, 1n)).toBe(true);
    expect(sqliteWalLowDiskPressure(256 * mib, limit, -1n)).toBe(true);
  });

  it('pauses only on actual low disk with oversized WAL and recovers when space returns', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-wal-space-'));
    const filename = path.join(root, 'main.sqlite');
    const mib = 1024 ** 2;
    let freeSpace = 2n * 1024n ** 3n;
    const db = new SqliteDatabase(filename, {
      walSizeProvider: (): number => 256 * mib,
      diskAvailableBytesProvider: (): bigint => freeSpace,
    });
    try {
      db.connection.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
        .run(SQLITE_HARD_LIMIT_SETTING_KEY, '2048');
      db.syncHardLimit();
      expect(db.mutationAdmissionMessage(true)).toBeNull();
      freeSpace = 511n * BigInt(mib);
      expect(db.mutationAdmissionMessage(true)).toMatch(/Large SQLite WAL and low free disk space/);
      freeSpace = 1024n * BigInt(mib);
      expect(db.mutationAdmissionMessage(true)).toBeNull();
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('considers reusable free pages before signaling storage pressure', () => {
    expect(sqliteLimitPressure(90, 0, 100)).toBe(true);
    expect(sqliteLimitPressure(90, 25, 100)).toBe(false);
    expect(sqliteLimitPressure(80, 0, 100)).toBe(false);
  });
});
