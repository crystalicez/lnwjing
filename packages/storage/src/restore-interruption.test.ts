import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPendingSqliteRestoreSync, SqliteBackupService } from './backup-service.js';
import { SqliteDatabase } from './database.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('interrupted database restore recovery', () => {
  it('recovers the original database if the process dies between renaming old and installing new', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-restore-crash-before-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('original');
    const service = new SqliteBackupService(db, { databaseFilename: filename, backupDirectory });
    const snapshot = await service.create('manual');
    await service.scheduleRestore(snapshot.id);
    db.close();
    await writeFile(path.join(backupDirectory, 'restore-swap.json'), JSON.stringify({
      schemaVersion: 1, backupId: snapshot.id, stagedFile: 'lnwjing.sqlite.restore-missing.tmp',
      hadOriginal: true, crossHost: false, phase: 'staged',
    }));
    await rename(filename, filename + '.pre-restore');
    const result = applyPendingSqliteRestoreSync(filename, backupDirectory);
    expect(result).toMatchObject({ applied: false, error: expect.stringMatching(/interrupted/i) });
    const reopened = new SqliteDatabase(filename, { backupDirectory });
    expect(reopened.connection.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'original' });
    reopened.close();
    const marker = await readFile(path.join(backupDirectory, 'restore-pending.json'), 'utf8').catch(() => null);
    expect(marker).toBeNull();
  });

  it('finalizes a verified canonical snapshot after a crash between install and cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-restore-crash-after-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('from-backup');
    const service = new SqliteBackupService(db, { databaseFilename: filename, backupDirectory });
    const snapshot = await service.create('manual');
    db.connection.prepare('UPDATE sentinel SET value = ?').run('after-backup');
    await service.scheduleRestore(snapshot.id);
    db.close();
    await writeFile(path.join(backupDirectory, 'restore-swap.json'), JSON.stringify({
      schemaVersion: 1, backupId: snapshot.id, stagedFile: 'lnwjing.sqlite.restore-missing.tmp',
      hadOriginal: true, crossHost: false, phase: 'staged',
    }));
    await rename(filename, filename + '.pre-restore');
    await copyFile(path.join(backupDirectory, snapshot.id + '.sqlite'), filename);
    expect(applyPendingSqliteRestoreSync(filename, backupDirectory)).toMatchObject({ applied: true, backupId: snapshot.id });
    const reopened = new SqliteDatabase(filename, { backupDirectory });
    expect(reopened.connection.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'from-backup' });
    reopened.close();
  });

  it('rolls back a corrupted replacement while retaining the original database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-restore-crash-corrupt-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('safe');
    const backup = new SqliteBackupService(db, { databaseFilename: filename, backupDirectory });
    const snapshot = await backup.create('manual');
    await backup.scheduleRestore(snapshot.id);
    db.close();
    await writeFile(path.join(backupDirectory, 'restore-swap.json'), JSON.stringify({
      schemaVersion: 1, backupId: snapshot.id, stagedFile: 'lnwjing.sqlite.restore-missing.tmp',
      hadOriginal: true, crossHost: false, phase: 'staged',
    }));
    await rename(filename, filename + '.pre-restore');
    await writeFile(filename, 'corrupted-new-image');
    expect(applyPendingSqliteRestoreSync(filename, backupDirectory)).toMatchObject({
      applied: false, error: expect.stringMatching(/interrupted/i),
    });
    const restored = new SqliteDatabase(filename, { backupDirectory });
    expect(restored.connection.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'safe' });
    restored.close();
  });

  it('publishes a validated staged image when there was no prior canonical database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-restore-crash-new-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('staged');
    const backup = new SqliteBackupService(db, { databaseFilename: filename, backupDirectory });
    const snapshot = await backup.create('manual');
    await backup.scheduleRestore(snapshot.id);
    db.close();
    const stagedFile = 'lnwjing.sqlite.restore-fixture.tmp';
    await copyFile(path.join(backupDirectory, snapshot.id + '.sqlite'), path.join(root, stagedFile));
    await rm(filename);
    await writeFile(path.join(backupDirectory, 'restore-swap.json'), JSON.stringify({
      schemaVersion: 1, backupId: snapshot.id, stagedFile, hadOriginal: false, crossHost: false, phase: 'staged',
    }));
    expect(applyPendingSqliteRestoreSync(filename, backupDirectory)).toMatchObject({ applied: true, backupId: snapshot.id });
    const recovered = new SqliteDatabase(filename, { backupDirectory });
    expect(recovered.connection.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'staged' });
    recovered.close();
  });

  it('retires an abandoned restore claim before the swap while retaining canonical data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-restore-claim-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('unchanged');
    const backup = new SqliteBackupService(db, { databaseFilename: filename, backupDirectory });
    const snapshot = await backup.create('manual');
    await backup.scheduleRestore(snapshot.id);
    db.close();
    await rename(path.join(backupDirectory, 'restore-pending.json'), path.join(backupDirectory, 'restore-pending.json.claim-stale'));
    expect(applyPendingSqliteRestoreSync(filename, backupDirectory)).toMatchObject({
      applied: false, error: expect.stringMatching(/abandoned restore claim/i),
    });
    const reopened = new SqliteDatabase(filename, { backupDirectory });
    expect(reopened.connection.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'unchanged' });
    reopened.close();
  });

  it('recovers a legacy pre-journal interrupted swap without creating an empty database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-restore-legacy-crash-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('legacy');
    db.close();
    await rename(filename, filename + '.pre-restore');
    expect(applyPendingSqliteRestoreSync(filename, backupDirectory)).toMatchObject({
      applied: false, error: expect.stringMatching(/interrupted/i),
    });
    const reopened = new SqliteDatabase(filename, { backupDirectory });
    expect(reopened.connection.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'legacy' });
    reopened.close();
  });
});
