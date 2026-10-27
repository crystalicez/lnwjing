import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPendingSqliteRestoreSync, SqliteBackupService } from './backup-service.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('recoverable backup retention', () => {
  it('rotates an expired backup out of the active list without destroying its restore path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-retention-recovery-'));
    temporaryRoots.push(root);
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    database.connection.exec('CREATE TABLE retention_fixture (value TEXT NOT NULL);');
    database.connection.prepare('INSERT INTO retention_fixture (value) VALUES (?)').run('first');
    let now = new Date('2026-08-01T00:00:00.000Z');
    const service = new SqliteBackupService(database, {
      backupDirectory,
      databaseFilename: databaseFile,
      manualRetention: 1,
      now: (): Date => now,
    });

    const first = await service.create('manual');
    database.connection.prepare('UPDATE retention_fixture SET value = ?').run('second');
    now = new Date('2026-08-02T00:00:00.000Z');
    const second = await service.create('manual');

    expect((await service.list()).map((entry) => entry.id)).toEqual([second.id]);
    await expect(service.scheduleRestore(first.id)).resolves.toBeUndefined();
    database.close();

    expect(applyPendingSqliteRestoreSync(databaseFile, backupDirectory)).toMatchObject({ applied: true, backupId: first.id });
    const restored = new SqliteDatabase(databaseFile);
    const row = restored.connection.prepare('SELECT value FROM retention_fixture').get() as { value?: string } | undefined;
    expect(row?.value).toBe('first');
    restored.close();
  });

  it('keeps an archived backup pinned by a pending restore through retention and purge-all', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-retention-pinned-'));
    temporaryRoots.push(root);
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    database.connection.exec('CREATE TABLE restore_fixture (value TEXT NOT NULL);');
    database.connection.prepare('INSERT INTO restore_fixture VALUES (?)').run('old');
    let now = new Date('2026-08-01T00:00:00.000Z');
    const backup = new SqliteBackupService(database, {
      databaseFilename: databaseFile, backupDirectory, manualRetention: 1, now: (): Date => now,
    });
    const original = await backup.create('manual');
    database.connection.prepare('UPDATE restore_fixture SET value = ?').run('new');
    now = new Date('2026-08-02T00:00:00.000Z');
    await backup.create('manual');
    await backup.scheduleRestore(original.id);
    expect(await backup.purgeArchivedOlderThan('2026-09-01T00:00:00.000Z')).toBe(0);
    await expect(backup.purgeAll()).rejects.toThrow(/pending restore/i);
    database.close();
    expect(applyPendingSqliteRestoreSync(databaseFile, backupDirectory)).toMatchObject({ applied: true, backupId: original.id });
    const restored = new SqliteDatabase(databaseFile);
    expect(restored.connection.prepare('SELECT value FROM restore_fixture').get()).toEqual({ value: 'old' });
    restored.close();
  });

  it('expires archived backups and purge-all removes only validated backup artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-retention-purge-'));
    temporaryRoots.push(root);
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    let now = new Date('2026-08-01T00:00:00.000Z');
    const service = new SqliteBackupService(database, {
      backupDirectory,
      databaseFilename: databaseFile,
      manualRetention: 1,
      now: (): Date => now,
    });

    const first = await service.create('manual');
    now = new Date('2026-08-02T00:00:00.000Z');
    const second = await service.create('manual');
    const unknownActive = path.join(backupDirectory, 'keep-me.txt');
    const unknownArchive = path.join(backupDirectory, 'retention-archive', 'keep-me-too.txt');
    await writeFile(unknownActive, 'owned by someone else');
    await writeFile(unknownArchive, 'not a backup artifact');

    await expect(service.purgeArchivedOlderThan('2026-08-15T00:00:00.000Z')).resolves.toBe(1);
    await expect(service.scheduleRestore(first.id)).rejects.toThrow('Backup was not found');
    await expect(service.purgeAll()).resolves.toBe(1);
    expect(await service.list()).toEqual([]);
    await expect(access(unknownActive)).resolves.toBeUndefined();
    await expect(access(unknownArchive)).resolves.toBeUndefined();
    database.close();
    expect(second.id).not.toBe(first.id);
  });
});
