import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { IdleWalMaintenance, trimIdleSqliteWalOffMain, walTrimThresholdBytes } from './sqlite-wal-maintenance.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function fixture(): Promise<{ file: string; database: SqliteDatabase }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-idle-wal-'));
  roots.push(root);
  const file = path.join(root, 'test.sqlite');
  const database = new SqliteDatabase(file);
  database.connection.exec('PRAGMA wal_autocheckpoint=0');
  database.connection.exec('CREATE TABLE IF NOT EXISTS wal_fixtures (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
  for (let n = 0; n < 48; n += 1) {
    database.connection.prepare('INSERT INTO wal_fixtures(payload) VALUES (?)').run('a'.repeat(32 * 1024));
  }
  expect(statSync(file + '-wal').size).toBeGreaterThan(1024 * 1024);
  return { file, database };
}

describe('idle oversized WAL maintenance', () => {
  it('sets a conservative maintenance threshold relative to the main limit', () => {
    expect(walTrimThresholdBytes(512)).toBe(128 * 1024 * 1024);
    expect(walTrimThresholdBytes(2048)).toBe(256 * 1024 * 1024);
    expect(walTrimThresholdBytes(16384)).toBe(512 * 1024 * 1024);
    expect(() => walTrimThresholdBytes(0)).toThrow(/Invalid/);
  });

  it('does not checkpoint a changing WAL, and rate limits stable WAL retries', async () => {
    const { file, database } = await fixture();
    let now = 1_000;
    let calls = 0;
    const result = { busy: true, logFrames: 1, checkpointedFrames: 0 };
    const monitor = new IdleWalMaintenance(file, {
      minWalBytes: 1024, idleMs: 10, retryMs: 100, nowMs: (): number => now,
      checkpoint: async (): Promise<typeof result> => { calls += 1; return result; },
    });
    try {
      expect(await monitor.inspect(2048)).toBeNull();
      now += 10;
      expect(await monitor.inspect(2048)).toEqual(result);
      expect(calls).toBe(1);
      expect(await monitor.inspect(2048)).toBeNull();
      now += 10;
      expect(await monitor.inspect(2048)).toBeNull();
      expect(calls).toBe(1);
      database.connection.prepare('INSERT INTO wal_fixtures(payload) VALUES (?)').run('new-write');
      now += 100;
      expect(await monitor.inspect(2048)).toBeNull();
      now += 10;
      expect(await monitor.inspect(2048)).toEqual(result);
      expect(calls).toBe(2);
    } finally {
      await monitor.close();
      database.close();
    }
  });

  it('truncates a stable WAL off-main without deleting SQLite rows', async () => {
    const { file, database } = await fixture();
    try {
      const result = await trimIdleSqliteWalOffMain(file);
      expect(result.busy).toBe(false);
      expect(statSync(file + '-wal').size).toBeLessThan(64 * 1024);
      expect((database.connection.prepare('SELECT COUNT(*) AS count FROM wal_fixtures').get() as { count: number }).count).toBe(48);
      expect(database.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { database.close(); }
  });

  it('does not forcibly truncate a WAL held by a live reader', async () => {
    const { file, database } = await fixture();
    const reader = new DatabaseSync(file, { readOnly: true, timeout: 300 });
    try {
      reader.exec('BEGIN');
      expect(reader.prepare('SELECT COUNT(*) AS count FROM wal_fixtures').get()).toEqual({ count: 48 });
      database.connection.prepare('INSERT INTO wal_fixtures(payload) VALUES (?)').run('after-reader-snapshot');
      const blocked = await trimIdleSqliteWalOffMain(file);
      expect(blocked.busy).toBe(true);
      expect(statSync(file + '-wal').size).toBeGreaterThan(0);
      reader.exec('ROLLBACK');
      const completed = await trimIdleSqliteWalOffMain(file);
      expect(completed.busy).toBe(false);
      expect((database.connection.prepare('SELECT COUNT(*) AS count FROM wal_fixtures').get() as { count: number }).count).toBe(49);
      expect(database.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      try { reader.exec('ROLLBACK'); } catch { /* no active transaction */ }
      reader.close();
      database.close();
    }
  });

  it('never creates a missing database while trying to trim an old WAL', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-wal-missing-'));
    roots.push(root);
    const missing = path.join(root, 'missing.sqlite');
    await expect(trimIdleSqliteWalOffMain(missing)).rejects.toThrow(/WAL checkpoint worker/);
    const monitor = new IdleWalMaintenance(missing, { minWalBytes: 1, idleMs: 1 });
    expect(await monitor.inspect(2048)).toBeNull();
    await monitor.close();
  });
});
