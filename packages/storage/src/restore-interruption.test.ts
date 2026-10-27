import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPendingSqliteRestoreSync, SqliteBackupService } from './backup-service.js';
import { SqliteDatabase } from './database.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('interrupted database restore recovery', () => {
  it.skipIf(process.platform !== 'win32')('recovers the original SQLite file after a real subprocess kill at the swap boundary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-real-restore-kill-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('backup-state');
    const backup = new SqliteBackupService(db, { databaseFilename: filename, backupDirectory });
    const saved = await backup.create('manual');
    db.connection.prepare('UPDATE sentinel SET value = ?').run('newer-committed-state');
    await backup.scheduleRestore(saved.id);
    db.close();
    const moduleUrl = new URL('../dist/backup-service.js', import.meta.url).href;
    const childSource = [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      `const filename = ${JSON.stringify(filename)};`,
      'const renameOriginal = fs.renameSync;',
      'fs.renameSync = (from, to) => {',
      '  renameOriginal(from, to);',
      "  if (from === filename && to === filename + '.pre-restore') process.kill(process.pid, 'SIGKILL');",
      '};',
      'syncBuiltinESMExports();',
      `const { applyPendingSqliteRestoreSync } = await import(${JSON.stringify(moduleUrl)});`,
      `applyPendingSqliteRestoreSync(filename, ${JSON.stringify(backupDirectory)});`,
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    let diagnostics = '';
    child.stderr.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
    const result = await new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    expect(result, diagnostics).not.toBe(0);
    expect(await stat(filename + '.pre-restore').then(st => st.isFile(), () => false), diagnostics).toBe(true);
    expect((await stat(path.join(backupDirectory, 'restore-swap.json'))).isFile()).toBe(true);
    expect(applyPendingSqliteRestoreSync(filename, backupDirectory))
      .toMatchObject({ applied: false, error: expect.stringMatching(/interrupted/i) });
    const reopened = new SqliteDatabase(filename, { backupDirectory });
    expect(reopened.connection.prepare('SELECT value FROM sentinel').get())
      .toEqual({ value: 'newer-committed-state' });
    reopened.close();
  }, 20_000);

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

  it('puts partially renamed WAL and SHM sidecars back before discarding a staged journal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-restore-partial-wal-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('retained');
    const service = new SqliteBackupService(db, { databaseFilename: filename, backupDirectory });
    const saved = await service.create('manual');
    db.close();
    await mkdir(backupDirectory, { recursive: true });
    await writeFile(path.join(backupDirectory, 'restore-swap.json'), JSON.stringify({
      schemaVersion: 1, backupId: saved.id, stagedFile: 'lnwjing.sqlite.restore-not-created.tmp',
      hadOriginal: true, crossHost: false, phase: 'staged',
    }));
    // The old implementation moved SQLite sidecars BEFORE the canonical file.
    // Simulate a crash at precisely that point, keeping original DB untouched.
    await writeFile(filename + '.pre-restore-shm', 'saved-sidecar');
    const result = applyPendingSqliteRestoreSync(filename, backupDirectory);
    expect(result).toMatchObject({ applied: false, error: expect.stringMatching(/interrupted/i) });
    await expect(readFile(filename + '.pre-restore-shm')).rejects.toMatchObject({ code: 'ENOENT' });
    const recovered = new SqliteDatabase(filename, { backupDirectory });
    expect(recovered.connection.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'retained' });
    recovered.close();
  });

  it('replays real committed WAL frames when the crash occurs before canonical rename', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-restore-wal-commit-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('before-wal');
    const service = new SqliteBackupService(db, { databaseFilename: filename, backupDirectory });
    const snapshot = await service.create('manual');
    db.close();
    // Keep a pre-transaction canonical image, then capture committed frames
    // before closing the WAL writer (which may checkpoint on close).
    const canonicalBefore = await readFile(filename);
    const writer = new DatabaseSync(filename);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.prepare('INSERT INTO sentinel VALUES (?)').run('committed-in-wal');
    const walBytes = await readFile(filename + '-wal');
    expect(walBytes.length).toBeGreaterThan(32);
    writer.close();
    await writeFile(filename, canonicalBefore);
    await writeFile(filename + '.pre-restore-wal', walBytes);
    await writeFile(path.join(backupDirectory, 'restore-swap.json'), JSON.stringify({
      schemaVersion: 1, backupId: snapshot.id, stagedFile: 'lnwjing.sqlite.restore-missing.tmp',
      hadOriginal: true, crossHost: false, phase: 'staged',
    }));
    expect(applyPendingSqliteRestoreSync(filename, backupDirectory)).toMatchObject({
      applied: false, error: expect.stringMatching(/interrupted/i),
    });
    const reopened = new SqliteDatabase(filename, { backupDirectory });
    const rows = reopened.connection.prepare('SELECT value FROM sentinel ORDER BY value').all() as { value: string }[];
    expect(rows.map(r => r.value)).toEqual(['before-wal', 'committed-in-wal']);
    reopened.close();
  });

  it('does not publish cross-host restore if an existing credential candidate cannot be quarantined', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-restore-quarantine-error-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('original');
    const service = new SqliteBackupService(db, {
      databaseFilename: filename, backupDirectory, platform: 'win32', arch: 'x64',
    });
    const snapshot = await service.create('manual');
    db.connection.prepare('UPDATE sentinel SET value = ?').run('newer');
    await service.scheduleRestore(snapshot.id);
    db.close();
    const protectedDirectory = path.join(root, 'host-secret-dir', 'lnwjing.runtime.secret');
    await mkdir(protectedDirectory, { recursive: true });
    const first = applyPendingSqliteRestoreSync(filename, backupDirectory, { platform: 'linux', arch: 'x64', hostBoundPaths: [protectedDirectory] });
    expect(first.applied).toBe(false);
    expect(first.error).toMatch(/quarantin/i);
    expect(await readFile(path.join(backupDirectory, 'restore-swap.json'), 'utf8')).toContain(snapshot.id);
    const second = applyPendingSqliteRestoreSync(filename, backupDirectory, { platform: 'linux', arch: 'x64', hostBoundPaths: [protectedDirectory] });
    expect(second.applied).toBe(false);
    expect(second.error).toMatch(/quarantin/i);
    expect(() => new SqliteDatabase(filename, { backupDirectory })).toThrow(/restore is in progress/);
    // Keep the original image until all host-bound credentials are isolated.
    expect((await stat(filename + '.pre-restore')).isFile()).toBe(true);
    expect((await stat(protectedDirectory)).isDirectory()).toBe(true);
  });

  it('preserves partial credential quarantine evidence through a failed restore and retry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-partial-quarantine-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('from-backup');
    const service = new SqliteBackupService(db, { databaseFilename: filename, backupDirectory, platform: 'win32' });
    const snapshot = await service.create('manual');
    await service.scheduleRestore(snapshot.id);
    db.close();
    const firstCredential = path.join(root, 'custom', 'first.secret');
    const blockedCredential = path.join(root, 'custom', 'second.secret');
    await mkdir(path.dirname(firstCredential), { recursive: true });
    await writeFile(firstCredential, 'safe-content-1');
    await mkdir(blockedCredential);
    const paths = [firstCredential, blockedCredential];
    const blocked = applyPendingSqliteRestoreSync(filename, backupDirectory, {
      platform: 'linux', hostBoundPaths: paths,
    });
    expect(blocked).toMatchObject({ applied: false, error: expect.stringMatching(/quarantin/i) });
    await expect(readFile(firstCredential)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(backupDirectory, 'restore-swap.json'))).isFile()).toBe(true);
    await rm(blockedCredential, { recursive: true });
    await writeFile(blockedCredential, 'safe-content-2');
    const result = applyPendingSqliteRestoreSync(filename, backupDirectory, {
      platform: 'linux', hostBoundPaths: paths,
    });
    expect(result).toMatchObject({ applied: true, crossHost: true });
    expect(result.quarantinedItems).toEqual(expect.arrayContaining([
      'file:custom/first.secret', 'file:custom/second.secret',
    ]));
    const quarantine = path.join(root, 'restore-quarantine', snapshot.id);
    const files = await (await import('node:fs/promises')).readdir(quarantine);
    expect(files).toEqual(expect.arrayContaining([expect.stringContaining('first.secret'), expect.stringContaining('second.secret')]));
    const reopened = new SqliteDatabase(filename, { backupDirectory });
    const notice = reopened.connection.prepare('SELECT value FROM settings WHERE key = ?').get('cross_host_restore_notice') as { value: string } | undefined;
    const record = JSON.parse(notice?.value ?? '{}') as { quarantinedItems?: string[] };
    expect(record.quarantinedItems).toEqual(expect.arrayContaining([
      'file:custom/first.secret', 'file:custom/second.secret',
    ]));
    reopened.close();
  });

  it('keeps separate quarantine evidence when the same backup is restored twice', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-repeat-cross-host-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const key = path.join(root, 'checkpoint-master.key');
    const original = new SqliteDatabase(filename, { backupDirectory });
    const snapshots = new SqliteBackupService(original, {
      databaseFilename: filename, backupDirectory, platform: 'win32',
    });
    const backup = await snapshots.create('manual');
    original.close();
    for (let i = 1; i <= 2; i += 1) {
      await writeFile(key, `local-secret-${i}`, { flag: 'wx' });
      const database = new SqliteDatabase(filename, { backupDirectory });
      const service = new SqliteBackupService(database, {
        databaseFilename: filename, backupDirectory, platform: 'win32',
      });
      await service.scheduleRestore(backup.id);
      database.close();
      expect(applyPendingSqliteRestoreSync(filename, backupDirectory, { platform: 'linux' }))
        .toMatchObject({ applied: true, crossHost: true });
      await expect(readFile(key)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const quarantine = path.join(root, 'restore-quarantine', backup.id);
    const names = (await (await import('node:fs/promises')).readdir(quarantine))
      .filter(name => name.endsWith('-checkpoint-master.key'));
    expect(names).toHaveLength(2);
    const values = await Promise.all(names.map(name => readFile(path.join(quarantine, name), 'utf8')));
    expect(values.sort()).toEqual(['local-secret-1', 'local-secret-2']);
  });

  it('refuses a scheduled restore while a registered SQLite runtime still has the profile open', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-live-runtime-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const runtime = new SqliteDatabase(filename, { backupDirectory });
    runtime.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    runtime.connection.prepare('INSERT INTO sentinel VALUES (?)').run('still-open');
    const service = new SqliteBackupService(runtime, { databaseFilename: filename, backupDirectory });
    const saved = await service.create('manual');
    await service.scheduleRestore(saved.id);
    const blocked = applyPendingSqliteRestoreSync(filename, backupDirectory);
    expect(blocked).toMatchObject({ applied: false, error: expect.stringMatching(/active SQLite.*connection/i) });
    expect(runtime.connection.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'still-open' });
    runtime.close();
    expect(applyPendingSqliteRestoreSync(filename, backupDirectory)).toMatchObject({ applied: true, backupId: saved.id });
  });

  it.skipIf(process.platform !== 'win32')('blocks restore with an unregistered legacy SQLite writer holding a transaction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-legacy-writer-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('old-committed');
    const service = new SqliteBackupService(db, { databaseFilename: filename, backupDirectory });
    const saved = await service.create('manual');
    db.connection.prepare('UPDATE sentinel SET value = ?').run('new-committed');
    await service.scheduleRestore(saved.id);
    db.close();
    const source = [
      "const { DatabaseSync } = require('node:sqlite');",
      'const db = new DatabaseSync(process.argv[1]);',
      "db.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;');",
      "db.prepare('UPDATE sentinel SET value = ?').run('uncommitted-legacy');",
      "process.stdout.write('ready\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', source, filename], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-2000); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Legacy writer was not ready: ' + errors)), 7000);
        child.stdout.on('data', (chunk: Buffer) => {
          if (!chunk.toString().includes('ready')) return;
          clearTimeout(timer); resolve();
        });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Legacy writer exited unexpectedly: ' + code + errors)); });
      });
      const blocked = applyPendingSqliteRestoreSync(filename, backupDirectory);
      expect(blocked).toMatchObject({ applied: false, error: expect.any(String) });
      expect((await stat(path.join(backupDirectory, 'restore-pending.json'))).isFile()).toBe(true);
      const reader = new DatabaseSync(filename, { readOnly: true });
      expect(reader.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'new-committed' });
      reader.close();
    } finally {
      if (child.exitCode === null) child.kill();
      await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
    }
    expect(applyPendingSqliteRestoreSync(filename, backupDirectory)).toMatchObject({
      applied: true, backupId: saved.id,
    });
    const reopened = new SqliteDatabase(filename, { backupDirectory });
    expect(reopened.connection.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'old-committed' });
    reopened.close();
  }, 25000);

  it('detects a separate live SQLite process and recovers its stale lease after termination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-db-process-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const db = new SqliteDatabase(filename, { backupDirectory });
    db.connection.exec('CREATE TABLE sentinel(value TEXT NOT NULL)');
    db.connection.prepare('INSERT INTO sentinel VALUES (?)').run('unchanged');
    const service = new SqliteBackupService(db, { databaseFilename: filename, backupDirectory });
    const saved = await service.create('manual');
    await service.scheduleRestore(saved.id);
    db.close();

    const moduleUrl = new URL('./sqlite-client-lease.ts', import.meta.url).href;
    const lockUrl = new URL('./sqlite-lifecycle-lock.ts', import.meta.url).href;
    const script = `import { DatabaseSync } from 'node:sqlite';
      import { registerSqliteClientSync } from ${JSON.stringify(moduleUrl)};
      import { withSqliteLifecycleLockSync } from ${JSON.stringify(lockUrl)};
      const db = new DatabaseSync(process.argv[1]);
      withSqliteLifecycleLockSync(process.argv[2], () => registerSqliteClientSync(process.argv[2]));
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, filename, backupDirectory], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve); child.once('error', reject);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const until = setTimeout(() => reject(new Error('SQLite child startup timed out: ' + errors)), 7_000);
        const onData = (): void => {
          if (!output.includes('ready')) return;
          clearTimeout(until);
          child.stdout.off('data', onData);
          resolve();
        };
        child.stdout.on('data', onData);
        onData();
      });
      expect(applyPendingSqliteRestoreSync(filename, backupDirectory)).toMatchObject({
        applied: false, error: expect.stringMatching(/active SQLite.*connection/i),
      });
    } finally {
      child.kill();
      await exited;
    }
    expect(applyPendingSqliteRestoreSync(filename, backupDirectory)).toMatchObject({
      applied: true, backupId: saved.id,
    });
  }, 15_000);

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
