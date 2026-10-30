import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SqliteDatabase } from './database.js';
import { applySqliteHardLimit, inspectSqliteHardLimit, sqliteLimitPressure,
  DEFAULT_SQLITE_HARD_LIMIT_MIB, SQLITE_HARD_LIMIT_SETTING_KEY } from './sqlite-hard-limit.js';

describe('SQLite main database hard limit', () => {
  it('defaults to four GiB, persists custom limits and reapplies after reopening', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-hard-limit-'));
    const filename = path.join(root, 'main.sqlite');
    const db = new SqliteDatabase(filename);
    const peer = new SqliteDatabase(filename);
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
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);
      try {
        const peerLimit = inspectSqliteHardLimit(peer.connection, 1024);
        expect(peerLimit.effectiveBytes).toBe(1024 ** 3);
      } finally { clock.mockRestore(); }
    } finally { peer.close(); db.close(); }
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

  it('considers reusable free pages before signaling storage pressure', () => {
    expect(sqliteLimitPressure(90, 0, 100)).toBe(true);
    expect(sqliteLimitPressure(90, 25, 100)).toBe(false);
    expect(sqliteLimitPressure(80, 0, 100)).toBe(false);
  });
});
