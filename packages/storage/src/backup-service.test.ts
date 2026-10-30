import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPendingSqliteRestoreSync, assertBackupCapacity, SqliteBackupService } from './backup-service.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SQLite backup disk preflight', () => {
  it('rejects insufficient space before any snapshot write, including on large profiles', () => {
    const mib = 1024n * 1024n;
    expect(() => assertBackupCapacity(64n * mib, 1n * mib)).toThrow(/Insufficient free disk space/);
    expect(() => assertBackupCapacity(65n * mib, 1n * mib)).not.toThrow();
    // For large profiles reserve the greater of 64 MiB or 10% of allocation.
    expect(() => assertBackupCapacity(1099n * mib, 1000n * mib)).toThrow(/Insufficient free disk space/);
    expect(() => assertBackupCapacity(1100n * mib, 1000n * mib)).not.toThrow();
    expect(() => assertBackupCapacity(-1n, 1n)).toThrow(/Invalid SQLite backup disk capacity/);
  });
});

describe('SqliteBackupService', { timeout: 30_000 }, () => {
  it('fails closed on an automatic backup budget without deleting older copies or blocking explicit manual recovery', async () => {
    const root = await temporaryRoot();
    const filename = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(filename);
    try {
      const service = new SqliteBackupService(database, {
        databaseFilename: filename, backupDirectory, automaticBackupBudgetBytes: 1,
      });
      const budget = await service.inspectAutomaticBackupBudget();
      expect(budget.blocked).toBe(true);
      expect(budget.usedBytes).toBeGreaterThan(1);
      expect(budget.projectedNextBytes).toBeGreaterThan(0);
      await expect(service.create('daily')).rejects.toThrow(/Automatic SQLite backup budget exhausted/);
      expect((await readdir(backupDirectory)).filter((entry) => entry.endsWith('.sqlite'))).toEqual([]);
      const manual = await service.create('manual');
      expect(await service.verifyBackupForCleanup(manual.id)).toBe(true);
      // The automatic daily path remains fail-closed and never deletes manual backups.
      await expect(service.create('daily')).rejects.toThrow(/budget exhausted/);
      expect(await service.verifyBackupForCleanup(manual.id)).toBe(true);
    } finally {
      database.close();
    }
  });


  it.each([null, '2026-09-01'])('treats foreign workspace paths as runtime authority only when not archived (%s)', async (archivedAt) => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile);
    database.connection.prepare('INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('history', 'Imported history', 'C:\\old-project', 'C:\\old-project', '2026-01-01', archivedAt);
    const secretPath = path.join(root, 'checkpoint-master.key');
    await writeFile(secretPath, 'local-key-must-survive', 'utf8');
    const service = new SqliteBackupService(database, { databaseFilename: databaseFile, backupDirectory, platform: 'linux', arch: 'x64' });
    const snapshot = await service.create('manual');
    await service.scheduleRestore(snapshot.id);
    database.close();
    const result = applyPendingSqliteRestoreSync(databaseFile, backupDirectory, { platform: 'linux', arch: 'x64' });
    if (archivedAt === null) {
      expect(result).toMatchObject({ applied: true, crossHost: true });
      await expect(readFile(secretPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      return;
    }
    expect(result)
      .toMatchObject({ applied: true, crossHost: false, hostCompatibility: 'same_host', quarantinedItems: [] });
    expect(await readFile(secretPath, 'utf8')).toBe('local-key-must-survive');
  });

  it('checks backup bytes before allowing destructive cleanup', async () => {
    const root = await temporaryRoot();
    const filename = path.join(root, 'lnwjing.sqlite');
    const database = new SqliteDatabase(filename);
    try {
      const service = new SqliteBackupService(database, {
        databaseFilename: filename, backupDirectory: path.join(root, 'backups'),
      });
      const saved = await service.create('manual');
      expect(await service.verifyBackupForCleanup(saved.id)).toBe(true);
      expect(await service.verifyBackupForCleanup('not-a-backup')).toBe(false);
      await writeFile(path.join(root, 'backups', saved.id + '.sqlite'), 'corrupt', 'utf8');
      expect(await service.verifyBackupForCleanup(saved.id)).toBe(false);
    } finally {
      database.close();
    }
  });

  it('quarantines Remote MCP and external tunnel OAuth credentials on a cross-host restore', async () => {
    const root = await temporaryRoot();
    const dataPath = path.join(root, 'data');
    const tunnelPath = path.join(root, 'external-tunnel-profile');
    await mkdir(dataPath);
    await mkdir(tunnelPath);
    await mkdir(path.join(dataPath, 'remote-mcp'));
    const databaseFile = path.join(dataPath, 'lnwjing.sqlite');
    const backupDirectory = path.join(dataPath, 'backups');
    const files = [
      path.join(dataPath, 'remote-mcp', 'oauth-state.secret'),
      path.join(dataPath, 'remote-mcp', 'ngrok-authtoken.secret'),
      path.join(tunnelPath, 'lnwjing.oauth.session.secret'),
    ];
    for (const filename of files) await writeFile(filename, 'host-bound-ciphertext', 'utf8');
    const database = new SqliteDatabase(databaseFile);
    const service = new SqliteBackupService(database, { databaseFilename: databaseFile, backupDirectory, platform: 'win32', arch: 'x64' });
    const snapshot = await service.create('manual');
    await service.scheduleRestore(snapshot.id);
    database.close();
    const result = applyPendingSqliteRestoreSync(databaseFile, backupDirectory, {
      platform: 'linux', arch: 'x64', hostBoundPaths: [path.join(tunnelPath, 'lnwjing.runtime.secret')],
    });
    expect(result).toMatchObject({ applied: true, crossHost: true });
    const quarantineDirectory = path.join(dataPath, 'restore-quarantine', snapshot.id);
    const movedNames = await readdir(quarantineDirectory);
    for (const filename of files) {
      await expect(readFile(filename, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const matches = movedNames.filter(name => name.endsWith('-' + path.basename(filename)));
      expect(matches).toHaveLength(1);
      expect(await readFile(path.join(quarantineDirectory, matches[0]!), 'utf8')).toBe('host-bound-ciphertext');
    }
    expect(result.quarantinedItems).toHaveLength(3);
  });

  it('records the source host and data schema in every new manifest', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    const service = new SqliteBackupService(database, {
      backupDirectory,
      databaseFilename: databaseFile,
      platform: 'darwin',
      arch: 'arm64',
    });

    const snapshot = await service.create('manual');
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(backupDirectory, snapshot.id + '.json'), 'utf8')) as Record<string, unknown>;

    expect(manifest).toMatchObject({ platform: 'darwin', arch: 'arm64', dataSchemaVersion: expect.any(Number) });
    expect(snapshot).toMatchObject({ platform: 'darwin', arch: 'arm64', dataSchemaVersion: expect.any(Number) });
    database.close();
  });

  it('quarantines host-bound state and preserves foreign workspace paths during cross-host restore', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    database.connection.prepare('INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run('foreign-workspace', 'Foreign project', 'C:\\Users\\alice\\project', 'C:\\Users\\alice\\project', '2026-08-01T00:00:00.000Z');
    database.connection.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('portable_setting', 'keep-me');
    database.connection.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('pdf_provider_path', 'C:\\tools\\pdftotext.exe');
    database.connection.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('secret_receipt', 'safe:v1:not-transplanted');
    database.connection.prepare(`
      INSERT INTO goals (
        id, workspace_id, goal_key, owner_client_id, objective, plan_json, status, revision,
        current_phase, next_action, blockers_json, active_task_ids_json, created_at, updated_at
      ) VALUES ('foreign-goal', 'foreign-workspace', 'goal', 'client', 'objective', '{}', 'active', 0, 'phase', 'next', '[]', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `).run();
    database.connection.prepare(`
      INSERT INTO goal_scheduled_continuations (
        id, goal_id, source_session_id, generation, source_goal_revision, status, occurrence, destination,
        execution_preference, confirmed_runs_on, due_at, native_task_id, request_fingerprint, version,
        created_at, updated_at
      ) VALUES ('foreign-continuation', 'foreign-goal', 'session', 1, 0, 'scheduled', 'once', 'current_chat',
        'auto', 'local', '2026-08-02T00:00:00.000Z', 'native-task-1', 'fingerprint', 0,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `).run();
    database.connection.prepare(`
      INSERT INTO automation_runs (id, goal_id, workspace_id, owner_client_id, status, revision, created_at, updated_at)
      VALUES ('foreign-run', 'foreign-goal', 'foreign-workspace', 'client', 'active', 0,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `).run();
    database.connection.prepare(`
      INSERT INTO automation_milestones (
        run_id, milestone_id, position, title, goal_step_id, depends_on_json, provider, role, cancel_with_goal,
        dispatch_json, dispatch_digest, verification_json, status, attempt_count, created_at, updated_at
      ) VALUES ('foreign-run', 'build', 0, 'Build', 'build', '[]', 'shell', 'blocking_job', 1,
        '{"executable":"node","arguments":["--version"],"cwd":"C:\\\\Users\\\\alice\\\\project","timeoutSeconds":60,"maxOutputBytes":1024,"includeStdout":true,"includeStderr":true}',
        ?, '[{"id":"exit","kind":"command_exit","expectedExitCode":0}]', 'running', 1,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `).run('a'.repeat(64));
    database.connection.prepare(`
      INSERT INTO automation_attempts (
        id, run_id, milestone_id, ordinal, provider, dispatch_status, durable_task_id, request_digest,
        evidence_json, terminal_state, created_at, updated_at
      ) VALUES ('foreign-attempt', 'foreign-run', 'build', 1, 'shell', 'launched', 'foreign-task', ?,
        '[]', NULL, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `).run('b'.repeat(64));
    database.connection.prepare(`
      INSERT INTO automation_events (run_id, sequence, kind, milestone_id, attempt_id, payload_json, created_at)
      VALUES ('foreign-run', 0, 'run_created', NULL, NULL, '{}', '2026-08-01T00:00:00.000Z')
    `).run();
    expect(database.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'goal_scheduled%'").all()).toEqual([
      { name: 'goal_scheduled_continuations' },
      { name: 'goal_scheduled_continuation_runs' },
    ]);
    expect(database.connection.prepare('SELECT id, status, native_task_id FROM goal_scheduled_continuations').all()).toEqual([
      expect.objectContaining({ id: 'foreign-continuation', status: 'scheduled', native_task_id: 'native-task-1' }),
    ]);
    await (await import('node:fs/promises')).writeFile(path.join(root, 'checkpoint-master.key'), 'safe:v1:host-bound', 'utf8');
    const service = new SqliteBackupService(database, { backupDirectory, databaseFilename: databaseFile, platform: 'win32', arch: 'x64' });
    const snapshot = await service.create('manual');
    await service.scheduleRestore(snapshot.id);
    database.close();

    expect(applyPendingSqliteRestoreSync(databaseFile, backupDirectory, { platform: 'linux', arch: 'x64' })).toMatchObject({
      applied: true,
      backupId: snapshot.id,
      crossHost: true,
      quarantinedItems: expect.arrayContaining([
        'workspace:foreign-workspace',
        'setting:pdf_provider_path',
        'setting:secret_receipt',
        'continuation:foreign-continuation',
        'automation:foreign-run',
      ]),
    });

    const restored = new SqliteDatabase(databaseFile);
    const workspace = restored.connection.prepare('SELECT root_path, real_root_path, archived_at FROM workspaces WHERE id = ?').get('foreign-workspace') as { root_path?: string; real_root_path?: string; archived_at?: string | null } | undefined;
    expect(workspace).toMatchObject({ root_path: 'C:\\Users\\alice\\project', real_root_path: 'C:\\Users\\alice\\project' });
    expect(workspace?.archived_at).toEqual(expect.any(String));
    expect(restored.connection.prepare('SELECT value FROM settings WHERE key = ?').get('portable_setting')).toEqual({ value: 'keep-me' });
    expect(restored.connection.prepare('SELECT value FROM settings WHERE key = ?').get('pdf_provider_path')).toBeUndefined();
    expect(restored.connection.prepare('SELECT value FROM settings WHERE key = ?').get('secret_receipt')).toBeUndefined();
    expect(restored.connection.prepare('SELECT status, native_task_id FROM goal_scheduled_continuations WHERE id = ?').get('foreign-continuation')).toMatchObject({ status: 'cancelled', native_task_id: null });
    expect(restored.connection.prepare('SELECT status, revision FROM automation_runs WHERE id = ?').get('foreign-run'))
      .toEqual({ status: 'blocked', revision: 1 });
    expect(restored.connection.prepare('SELECT status FROM automation_milestones WHERE run_id = ?').get('foreign-run'))
      .toEqual({ status: 'blocked' });
    expect(restored.connection.prepare('SELECT dispatch_status, terminal_state FROM automation_attempts WHERE run_id = ?').get('foreign-run'))
      .toEqual({ dispatch_status: 'dispatched_unresolved', terminal_state: null });
    expect(restored.connection.prepare('SELECT sequence, kind FROM automation_events WHERE run_id = ? ORDER BY sequence').all('foreign-run'))
      .toEqual([{ sequence: 0, kind: 'run_created' }, { sequence: 1, kind: 'cross_host_restore_quarantined' }]);
    const notice = restored.connection.prepare('SELECT value FROM settings WHERE key = ?').get('cross_host_restore_notice') as { value?: string } | undefined;
    expect(notice?.value).toContain(snapshot.id);
    expect(restored.connection.prepare('SELECT COUNT(*) AS count FROM restore_quarantine').get()).toMatchObject({ count: expect.any(Number) });
    restored.close();
    await expect((await import('node:fs/promises')).stat(path.join(root, 'checkpoint-master.key')).catch(() => null)).resolves.toBeNull();
    const quarantineRoot = path.join(root, 'restore-quarantine');
    const quarantineEntries = await readdir(path.join(quarantineRoot, snapshot.id));
    expect(quarantineEntries.some((name) => name.includes('checkpoint-master.key'))).toBe(true);
  });

  it('creates a WAL-consistent snapshot and restores it on the next startup', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    database.connection.exec('CREATE TABLE restore_fixture (value TEXT NOT NULL);');
    database.connection.prepare('INSERT INTO restore_fixture (value) VALUES (?)').run('before-backup');
    const service = new SqliteBackupService(database, { backupDirectory, databaseFilename: databaseFile });

    const snapshot = await service.create('manual');
    database.connection.prepare('UPDATE restore_fixture SET value = ?').run('after-backup');
    await service.scheduleRestore(snapshot.id);
    database.close();

    expect(applyPendingSqliteRestoreSync(databaseFile, backupDirectory)).toMatchObject({ applied: true, backupId: snapshot.id });
    expect(applyPendingSqliteRestoreSync(databaseFile, backupDirectory)).toEqual({ applied: false });

    const restored = new SqliteDatabase(databaseFile);
    const row = restored.connection.prepare('SELECT value FROM restore_fixture').get() as { value?: string } | undefined;
    expect(row?.value).toBe('before-backup');
    restored.close();
    expect((await readdir(backupDirectory)).some((name) => name.endsWith('.sqlite'))).toBe(true);
  });

  it('never reclaims an aged automatic-backup lock while the owner process remains alive', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    try {
      const service = new SqliteBackupService(database, { databaseFilename: databaseFile, backupDirectory });
      const lock = path.join(backupDirectory, 'automatic-backup.lock');
      await writeFile(lock, JSON.stringify({ pid: process.pid, acquiredAt: '2020-01-01T00:00:00.000Z' }));
      const aged = new Date(Date.now() - 65 * 60_000);
      await utimes(lock, aged, aged);
      expect(await service.ensureRecent()).toBeNull();
      expect(await readFile(lock, 'utf8')).toContain(String(process.pid));
      expect(await service.list()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('does not duplicate the automatic daily backup inside the 24-hour window', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    let now = new Date('2026-08-01T00:00:00.000Z');
    const service = new SqliteBackupService(database, { backupDirectory, databaseFilename: databaseFile, now: (): Date => now });

    const first = await service.ensureRecent();
    expect(first?.reason).toBe('daily');
    await expect(service.ensureRecent()).resolves.toBeNull();
    now = new Date('2026-08-02T00:00:01.000Z');
    await expect(service.ensureRecent()).resolves.toMatchObject({ reason: 'daily' });
    database.close();
  });

  it('replaces a recent daily manifest whose SQLite snapshot size no longer matches', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    try {
      const service = new SqliteBackupService(database, {
        backupDirectory, databaseFilename: databaseFile,
        now: (): Date => new Date('2026-08-01T00:00:00.000Z'),
      });
      const first = await service.ensureRecent();
      expect(first?.reason).toBe('daily');
      if (first === null) throw new Error('Initial daily backup is unavailable');
      await writeFile(path.join(backupDirectory, `${first.id}.sqlite`), 'damaged snapshot', 'utf8');
      const replacement = await service.ensureRecent();
      expect(replacement?.id).not.toBe(first.id);
      if (replacement === null) throw new Error('Damaged snapshot was treated as a usable backup');
      expect(await service.verifyBackupForCleanup(replacement.id)).toBe(true);
    } finally {
      database.close();
    }
  });

  it('coordinates the daily backup lease across concurrent database runtimes', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const firstDatabase = new SqliteDatabase(databaseFile, { backupDirectory });
    const secondDatabase = new SqliteDatabase(databaseFile, { backupDirectory });
    const now = new Date('2026-08-01T00:00:00.000Z');
    const firstService = new SqliteBackupService(firstDatabase, { backupDirectory, databaseFilename: databaseFile, now: (): Date => now });
    const secondService = new SqliteBackupService(secondDatabase, { backupDirectory, databaseFilename: databaseFile, now: (): Date => now });

    const results = await Promise.all([firstService.ensureRecent(), secondService.ensureRecent()]);

    expect(results.filter((value) => value !== null)).toHaveLength(1);
    expect((await firstService.list()).filter((value) => value.reason === 'daily')).toHaveLength(1);
    firstDatabase.close();
    secondDatabase.close();
  });

  it('creates a pre-migration snapshot before upgrading an existing database schema', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'legacy.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const legacy = new DatabaseSync(databaseFile);
    legacy.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, real_root_path TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_migrations (id) VALUES ('001_initial');
      INSERT INTO settings (key, value) VALUES ('legacy-marker', 'before-migration');
    `);
    legacy.close();

    const upgraded = new SqliteDatabase(databaseFile, { backupDirectory });
    upgraded.close();

    const manifests = await readdir(backupDirectory);
    const manifestName = manifests.find((name) => name.endsWith('.json'));
    expect(manifestName).toBeDefined();
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(backupDirectory, manifestName!), 'utf8')) as { reason?: string; databaseFile?: string };
    expect(manifest.reason).toBe('pre-migration');
    const snapshot = new DatabaseSync(path.join(backupDirectory, manifest.databaseFile!), { readOnly: true });
    const marker = snapshot.prepare('SELECT value FROM settings WHERE key = ?').get('legacy-marker') as { value?: string } | undefined;
    expect(marker?.value).toBe('before-migration');
    const migrationRows = snapshot.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id?: string }>;
    expect(migrationRows.map((row) => row.id)).toEqual(['001_initial']);
    snapshot.close();
  });

  it('retains seven recent daily snapshots plus four older weekly representatives', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    try {
      let now = new Date('2026-01-01T00:00:00.000Z');
      const service = new SqliteBackupService(database, { backupDirectory, databaseFilename: databaseFile, now: (): Date => now });

      for (let index = 0; index < 15; index += 1) {
        now = new Date(Date.UTC(2026, 0, 1 + index * 8));
        await service.create('daily');
      }

      const listed = (await service.list()).filter((entry) => entry.reason === 'daily');
      expect(listed).toHaveLength(11);
    } finally {
      database.close();
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-backup-'));
  temporaryRoots.push(root);
  return root;
}
