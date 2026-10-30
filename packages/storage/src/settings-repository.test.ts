import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteSettingsRepository } from './settings-repository.js';

describe('SqliteSettingsRepository disk writes', () => {
  it('commits many changed settings in one WAL transaction and persists their final values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-settings-batch-'));
    const batchedFile = path.join(root, 'batched.sqlite');
    const sequentialFile = path.join(root, 'sequential.sqlite');
    const batched = new SqliteDatabase(batchedFile);
    const sequential = new SqliteDatabase(sequentialFile);
    const values: Array<readonly [string, string]> = Array.from({ length: 24 }, (_, index) =>
      [`setting-${index}`, `value-${index}`]);
    try {
      const batchedSettings = new SqliteSettingsRepository(batched);
      const sequentialSettings = new SqliteSettingsRepository(sequential);
      const batchedBefore = (await stat(batchedFile + '-wal')).size;
      const sequentialBefore = (await stat(sequentialFile + '-wal')).size;
      batchedSettings.setMany(values);
      for (const [key, value] of values) sequentialSettings.set(key, value);
      const batchedGrowth = (await stat(batchedFile + '-wal')).size - batchedBefore;
      const sequentialGrowth = (await stat(sequentialFile + '-wal')).size - sequentialBefore;
      expect(batchedGrowth).toBeGreaterThan(0);
      expect(batchedGrowth).toBeLessThan(sequentialGrowth);
      for (const [key, value] of values) expect(batchedSettings.get(key)).toBe(value);
      const after = (await stat(batchedFile + '-wal')).size;
      batchedSettings.setMany(values);
      batchedSettings.setMany([]);
      expect((await stat(batchedFile + '-wal')).size).toBe(after);
    } finally {
      batched.close();
      sequential.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls back the complete batch on a failed write while preserving earlier values', () => {
    const database = new SqliteDatabase(':memory:');
    const settings = new SqliteSettingsRepository(database);
    try {
      settings.set('existing', 'keep');
      database.connection.exec(`
        CREATE TEMP TRIGGER reject_setting BEFORE INSERT ON settings
        WHEN NEW.key = 'rejected'
        BEGIN SELECT RAISE(ABORT, 'setting rejected'); END;
      `);
      expect(() => settings.setMany([
        ['existing', 'changed'],
        ['new', 'not-visible'],
        ['rejected', 'bad'],
      ])).toThrow(/setting rejected/);
      expect(settings.get('existing')).toBe('keep');
      expect(settings.get('new')).toBeNull();
      database.connection.exec('DROP TRIGGER reject_setting');
      settings.setMany([['new', 'success']]);
      expect(settings.get('new')).toBe('success');
    } finally {
      database.close();
    }
  });

  it('uses a nested savepoint without prematurely committing the caller transaction', () => {
    const database = new SqliteDatabase(':memory:');
    const settings = new SqliteSettingsRepository(database);
    try {
      database.connection.exec('BEGIN');
      settings.set('caller', 'outer-change');
      settings.setMany([['inside', 'one'], ['second', 'two']]);
      expect(settings.get('inside')).toBe('one');
      database.connection.exec('ROLLBACK');
      expect(settings.get('caller')).toBeNull();
      expect(settings.get('inside')).toBeNull();
      expect(settings.get('second')).toBeNull();
    } finally {
      database.close();
    }
  });

  it('does not append WAL frames or count updates when setting a value already stored', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-settings-noop-'));
    const filename = path.join(root, 'settings.sqlite');
    const database = new SqliteDatabase(filename);
    const settings = new SqliteSettingsRepository(database);
    const changes = (): number => {
      const row = database.connection.prepare('SELECT total_changes() AS count').get() as { count: number };
      return row.count;
    };
    const walBytes = async (): Promise<number> => (await stat(filename + '-wal')).size;
    try {
      settings.set('tunnel_desired_state', 'running');
      const initialChanges = changes();
      const initialWalBytes = await walBytes();
      for (let index = 0; index < 30; index += 1) {
        settings.set('tunnel_desired_state', 'running');
      }
      expect(changes()).toBe(initialChanges);
      expect(await walBytes()).toBe(initialWalBytes);
      expect(settings.get('tunnel_desired_state')).toBe('running');

      settings.set('tunnel_desired_state', 'stopped');
      expect(changes()).toBe(initialChanges + 1);
      expect(await walBytes()).toBeGreaterThan(initialWalBytes);
      const updatedWalBytes = await walBytes();

      settings.set('tunnel_desired_state', 'stopped');
      expect(changes()).toBe(initialChanges + 1);
      expect(await walBytes()).toBe(updatedWalBytes);

      settings.set('tunnel_desired_state', 'STOPPED');
      expect(changes()).toBe(initialChanges + 2);
      expect(settings.get('tunnel_desired_state')).toBe('STOPPED');
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
