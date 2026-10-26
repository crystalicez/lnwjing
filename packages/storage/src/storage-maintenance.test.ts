import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { compactSqliteWithBackup, inspectSqliteCompaction } from './storage-maintenance.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('manual-only SQLite storage maintenance', () => {
  it('requires explicit confirmation and a verified backup before VACUUM', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-sqlite-maintenance-'));
    roots.push(root);
    const filename = path.join(root, 'state.sqlite');
    const database = new SqliteDatabase(filename);
    const connection = database.connection;
    try {
      connection.exec('CREATE TABLE filler(data BLOB NOT NULL);');
      const insert = connection.prepare('INSERT INTO filler(data) VALUES (zeroblob(8192))');
      connection.exec('BEGIN;');
      for (let i = 0; i < 200; i += 1) insert.run();
      connection.exec('COMMIT;');
      connection.exec('DELETE FROM filler;');
      const before = inspectSqliteCompaction(connection, 4096);
      expect(before.recommended).toBe(true);
      let backups = 0;
      const makeBackup = async (): Promise<{ id: string }> => {
        backups += 1;
        const backupPath = path.join(root, 'safe-copy.sqlite').replaceAll("'", "''");
        connection.exec(`VACUUM INTO '${backupPath}';`);
        expect((await stat(path.join(root, 'safe-copy.sqlite'))).size).toBeGreaterThan(0);
        return { id: 'manual-verified', verified: true as const };
      };
      await expect(compactSqliteWithBackup(connection, {
        databasePath: filename, userConfirmed: false, createVerifiedBackup: makeBackup, minimumReclaimBytes: 4096,
      })).rejects.toThrow(/confirmation/);
      expect(backups).toBe(0);

      const result = await compactSqliteWithBackup(connection, {
        databasePath: filename, userConfirmed: true, createVerifiedBackup: makeBackup, minimumReclaimBytes: 4096,
      });
      expect(result.performed).toBe(true);
      expect(backups).toBe(1);
      expect(result.after.allocatedBytes).toBeLessThan(result.before.allocatedBytes);
      expect(result.after.recommended).toBe(false);
    } finally {
      database.close();
    }
  });

  it('does not create a backup or rewrite a compact database', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      let calls = 0;
      const result = await compactSqliteWithBackup(database.connection, {
        databasePath: ':memory:', userConfirmed: true, createVerifiedBackup: async () => { calls += 1; return { id: 'unused', verified: true as const }; },
      });
      expect(result.performed).toBe(false);
      expect(calls).toBe(0);
    } finally {
      database.close();
    }
  });
});
