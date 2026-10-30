import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteSettingsRepository } from './settings-repository.js';

describe('SqliteSettingsRepository disk writes', () => {
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
