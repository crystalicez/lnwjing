import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { GlobalStorageQuotaReservations, assertNoPendingProfileResetSync } from '@lnwjing/storage';
import { applyPendingFactoryResetSync, clearFactoryResetStageSync, factoryResetMarkerPath, stageFactoryResetSync } from '../src/main/factory-reset.js';

async function fixture(): Promise<{ parent: string; profile: string; tunnel: string; external: string; dispose: () => Promise<void> }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-keep-settings-'));
  const profile = path.join(parent, 'data');
  const tunnel = path.join(parent, 'tunnel-client');
  const external = path.join(parent, 'user-project');
  await Promise.all([profile, tunnel, external].map((directory) => mkdir(directory)));
  return { parent, profile, tunnel, external, dispose: () => rm(parent, { recursive: true, force: true }) };
}

function settingsDatabase(profile: string): DatabaseSync {
  const db = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'));
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);'
    + 'CREATE TABLE workspaces(id TEXT PRIMARY KEY, root_path TEXT NOT NULL, real_root_path TEXT NOT NULL);'
    + 'CREATE TABLE audit_events(id TEXT PRIMARY KEY);');
  return db;
}

describe('settings-preserving reset (isolated offline profile only)', () => {
  it('clears all profile history and caches while retaining preferences, authentication and quota', async () => {
    const { profile, tunnel, external, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('permission_profile', 'full');
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('selected_workspace_id', 'old-project');
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('active_workspace_ids', '["old-project"]');
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('mcp_http_port', '19999');
      db.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)').run('old-project', external, external);
      db.prepare('INSERT INTO audit_events(id) VALUES (?)').run('historical-call');
      db.close();
      const quota = new GlobalStorageQuotaReservations(profile);
      quota.configure({ limitBytes: 512 * 1024 ** 2, criticalReserveBytes: 32 * 1024 ** 2 });
      await mkdir(path.join(profile, 'remote-mcp'));
      await mkdir(path.join(profile, 'backups'));
      await mkdir(path.join(profile, 'cache'));
      await writeFile(path.join(profile, 'Local State'), '{"os_crypt":{"encrypted_key":"sample"}}');
      await writeFile(path.join(profile, 'checkpoint-master.key'), 'encrypted-checkpoint-key');
      await writeFile(path.join(profile, '.stdio-profile-ready.v1'), '1');
      await writeFile(path.join(profile, 'remote-mcp', 'oauth-state.secret'), 'encrypted-oauth');
      await writeFile(path.join(profile, 'remote-mcp', 'ngrok-authtoken.secret'), 'encrypted-ngrok-token');
      await writeFile(path.join(profile, 'backups', 'old.sqlite'), 'backup');
      await writeFile(path.join(profile, 'cache', 'old.dat'), 'cache');
      await writeFile(path.join(profile, 'mcp-activity.log'), 'historical audit');
      await writeFile(path.join(tunnel, 'lnwjing.runtime.secret'), 'external-tunnel-settings');
      await writeFile(path.join(external, 'important.md'), 'keep my code');
      const marker = stageFactoryResetSync(profile, 'preserve-settings');
      expect(marker).toBe(factoryResetMarkerPath(profile));
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      const result = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'), { readOnly: true });
      try {
        const all = result.prepare('SELECT key,value FROM settings ORDER BY key').all();
        expect(all).toEqual([
          { key: 'mcp_http_port', value: '19999' },
          { key: 'permission_profile', value: 'full' },
          { key: 'ui_locale', value: 'th' },
        ]);
        expect(result.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'").get()).toBeUndefined();
        expect(result.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").get()).toBeUndefined();
      } finally { result.close(); }
      expect(quota.status()).toMatchObject({
        policy: { limitBytes: 512 * 1024 ** 2, criticalReserveBytes: 32 * 1024 ** 2 },
        activeReservations: 0,
      });
      expect(await readFile(path.join(profile, 'Local State'), 'utf8')).toContain('encrypted_key');
      expect(await readFile(path.join(profile, 'checkpoint-master.key'), 'utf8')).toBe('encrypted-checkpoint-key');
      expect(await readFile(path.join(profile, 'remote-mcp', 'oauth-state.secret'), 'utf8')).toBe('encrypted-oauth');
      expect(await readFile(path.join(profile, 'remote-mcp', 'ngrok-authtoken.secret'), 'utf8')).toBe('encrypted-ngrok-token');
      expect(await readFile(path.join(tunnel, 'lnwjing.runtime.secret'), 'utf8')).toBe('external-tunnel-settings');
      expect(await readFile(path.join(external, 'important.md'), 'utf8')).toBe('keep my code');
      expect((await readdir(profile)).sort()).toEqual([
        '.stdio-profile-ready.v1', 'Local State', 'checkpoint-master.key',
        'global-quota-reservations-v2.sqlite', 'lnwjing.sqlite', 'remote-mcp',
      ].sort());
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(false);
    } finally { await dispose(); }
  });

  it('refuses missing or unreadable settings without erasing protected data', async () => {
    const { profile, tunnel, dispose } = await fixture();
    try {
      await writeFile(path.join(profile, 'important.txt'), 'do-not-delete');
      const marker = stageFactoryResetSync(profile, 'preserve-settings');
      expect(() => applyPendingFactoryResetSync(profile, tunnel)).toThrow(/database does not exist/);
      expect(await readFile(path.join(profile, 'important.txt'), 'utf8')).toBe('do-not-delete');
      expect(await readFile(marker, 'utf8')).toContain('preserve-settings');
      expect(() => stageFactoryResetSync(profile, 'all')).toThrow(/different reset mode/);
      clearFactoryResetStageSync(profile);
    } finally { await dispose(); }
  });

  it('refuses to clear a profile while another command holds a quota reservation', async () => {
    const { profile, tunnel, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'en');
      db.close();
      const quota = new GlobalStorageQuotaReservations(profile);
      quota.configure({ limitBytes: 512 * 1024 ** 2, criticalReserveBytes: 8 * 1024 ** 2 });
      const proof = await quota.reserve(4096);
      try {
        stageFactoryResetSync(profile, 'preserve-settings');
        expect(() => applyPendingFactoryResetSync(profile, tunnel)).toThrow(/active profile quota/i);
        expect(quota.status()?.activeReservations).toBe(1);
        const activeDatabase = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'), { readOnly: true });
        try {
          expect(activeDatabase.prepare("SELECT value FROM settings WHERE key='ui_locale'").get())
            .toMatchObject({ value: 'en' });
        } finally { activeDatabase.close(); }
      } finally {
        quota.release(proof);
        // Reset can now complete after the in-flight writer settles.
      }
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      expect(quota.status()?.activeReservations).toBe(0);
    } finally { await dispose(); }
  }, 25_000);

  it('replays a verified settings snapshot after an interrupted profile removal', async () => {
    const { profile, tunnel, parent, external, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
      db.close();
      await writeFile(path.join(external, 'project.ts'), 'export const untouched = true;');
      const pending = stageFactoryResetSync(profile, 'preserve-settings');
      const marker = JSON.parse(await readFile(pending, 'utf8')) as { nonce: string };
      const stage = path.join(parent, '.data.factory-reset-settings');
      await mkdir(stage);
      const persisted = path.join(stage, 'settings.sqlite');
      const snapshot = new DatabaseSync(persisted);
      snapshot.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);'
        + 'CREATE TABLE reset_meta(nonce TEXT NOT NULL);'
        + 'CREATE TABLE quota_policy(limit_bytes INTEGER NOT NULL,reserve_bytes INTEGER NOT NULL);');
      snapshot.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
      snapshot.prepare('INSERT INTO reset_meta(nonce) VALUES (?)').run(marker.nonce);
      snapshot.close();
      const sha256 = createHash('sha256').update(await readFile(persisted)).digest('hex');
      await writeFile(path.join(stage, 'manifest.json'),
        JSON.stringify({ version: 1, nonce: marker.nonce, databaseSha256: sha256, files: [] }));
      await rm(profile, { recursive: true, force: true });
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      const restored = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'), { readOnly: true });
      try {
        expect(restored.prepare("SELECT value FROM settings WHERE key='ui_locale'").get()).toMatchObject({ value: 'th' });
      } finally { restored.close(); }
      expect(await readFile(path.join(external, 'project.ts'), 'utf8')).toBe('export const untouched = true;');
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(false);
    } finally { await dispose(); }
  });

  it('refuses a corrupted staged snapshot without deleting the original database', async () => {
    const { profile, tunnel, parent, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
      db.close();
      const pending = stageFactoryResetSync(profile, 'preserve-settings');
      const marker = JSON.parse(await readFile(pending, 'utf8')) as { nonce: string };
      const stage = path.join(parent, '.data.factory-reset-settings');
      await mkdir(stage);
      await writeFile(path.join(stage, 'settings.sqlite'), 'corrupted');
      await writeFile(path.join(stage, 'manifest.json'),
        JSON.stringify({ version: 1, nonce: marker.nonce, databaseSha256: 'f'.repeat(64), files: [] }));
      expect(() => applyPendingFactoryResetSync(profile, tunnel)).toThrow(/snapshot integrity/);
      const original = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'), { readOnly: true });
      try {
        expect(original.prepare("SELECT value FROM settings WHERE key='ui_locale'").get()).toMatchObject({ value: 'th' });
      } finally { original.close(); }
    } finally { await dispose(); }
  });

  it('never erases a registered user project stored inside a custom profile location', async () => {
    const { profile, tunnel, dispose } = await fixture();
    try {
      const project = path.join(profile, 'nested-user-project');
      await mkdir(project);
      await writeFile(path.join(project, 'important-code.ts'), 'export const userData = true;');
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'en');
      db.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)')
        .run('nested-project', project, project);
      db.close();
      stageFactoryResetSync(profile, 'preserve-settings');
      expect(() => applyPendingFactoryResetSync(profile, tunnel)).toThrow(/registered project|inside.*profile/i);
      expect(await readFile(path.join(project, 'important-code.ts'), 'utf8')).toBe('export const userData = true;');
    } finally { await dispose(); }
  });

  it('rejects a newly registered nested project when replaying an already completed snapshot', async () => {
    const { profile, tunnel, parent, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'en');
      db.close();

      // Simulate a crash after the immutable snapshot was committed but before
      // the old profile was removed. Another writer may have added a project
      // despite the pending marker: the replay must not erase that project.
      const pending = stageFactoryResetSync(profile, 'preserve-settings');
      const marker = JSON.parse(await readFile(pending, 'utf8')) as { nonce: string };
      const stage = path.join(parent, '.data.factory-reset-settings');
      await mkdir(stage);
      const savedDb = path.join(stage, 'settings.sqlite');
      const snapshot = new DatabaseSync(savedDb);
      try {
        snapshot.exec('CREATE TABLE settings(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);'
          + 'CREATE TABLE reset_meta(nonce TEXT NOT NULL);'
          + 'CREATE TABLE quota_policy(limit_bytes INTEGER NOT NULL,reserve_bytes INTEGER NOT NULL);');
        snapshot.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'en');
        snapshot.prepare('INSERT INTO reset_meta(nonce) VALUES (?)').run(marker.nonce);
      } finally { snapshot.close(); }
      const sha256 = createHash('sha256').update(await readFile(savedDb)).digest('hex');
      await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
        version: 1, nonce: marker.nonce, databaseSha256: sha256, files: [],
      }));

      const project = path.join(profile, 'late-registered-project');
      await mkdir(project);
      await writeFile(path.join(project, 'keep-source.ts'), 'export const keep = true;');
      const changed = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'));
      try {
        changed.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)')
          .run('late-project', project, project);
      } finally { changed.close(); }

      expect(() => applyPendingFactoryResetSync(profile, tunnel))
        .toThrow('Cannot clear profile: a registered project directory is inside the profile');
      expect(await readFile(path.join(project, 'keep-source.ts'), 'utf8')).toBe('export const keep = true;');
      expect(await readFile(pending, 'utf8')).toContain('preserve-settings');
    } finally { await dispose(); }
  });

  it('replays a verified snapshot after a failed restore wrote only the Settings table', async () => {
    const { profile, tunnel, parent, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
      db.close();
      const marker = stageFactoryResetSync(profile, 'preserve-settings');
      const { nonce } = JSON.parse(await readFile(marker, 'utf8')) as { nonce: string };
      const stage = path.join(parent, '.data.factory-reset-settings');
      await mkdir(stage);
      const stagedDb = path.join(stage, 'settings.sqlite');
      const snapshot = new DatabaseSync(stagedDb);
      try {
        snapshot.exec('CREATE TABLE settings(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);'
          + 'CREATE TABLE reset_meta(nonce TEXT NOT NULL);'
          + 'CREATE TABLE quota_policy(limit_bytes INTEGER NOT NULL,reserve_bytes INTEGER NOT NULL);');
        snapshot.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
        snapshot.prepare('INSERT INTO reset_meta(nonce) VALUES (?)').run(nonce);
      } finally { snapshot.close(); }
      const databaseSha256 = createHash('sha256').update(await readFile(stagedDb)).digest('hex');
      await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
        version: 1, nonce, databaseSha256, files: [],
      }));
      // The earlier process crashed after deleting the source and creating the
      // minimal Settings-only database but before clearing its pending marker.
      await rm(profile, { recursive: true });
      await mkdir(profile);
      const partial = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'));
      partial.exec('CREATE TABLE settings(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)');
      partial.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'wrong-partial-value');
      partial.close();

      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      const restored = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'), { readOnly: true });
      try {
        expect(restored.prepare("SELECT value FROM settings WHERE key = 'ui_locale'").get())
          .toMatchObject({ value: 'th' });
      } finally { restored.close(); }
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(false);
    } finally { await dispose(); }
  });

  it('refuses an incomplete profile with no current workspace database rather than deleting unknown files', async () => {
    const { profile, tunnel, parent, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
      db.close();
      const marker = stageFactoryResetSync(profile, 'preserve-settings');
      const { nonce } = JSON.parse(await readFile(marker, 'utf8')) as { nonce: string };
      const stage = path.join(parent, '.data.factory-reset-settings');
      await mkdir(stage);
      const stagedDb = path.join(stage, 'settings.sqlite');
      const snapshot = new DatabaseSync(stagedDb);
      try {
        snapshot.exec('CREATE TABLE settings(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);'
          + 'CREATE TABLE reset_meta(nonce TEXT NOT NULL);'
          + 'CREATE TABLE quota_policy(limit_bytes INTEGER NOT NULL,reserve_bytes INTEGER NOT NULL);');
        snapshot.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
        snapshot.prepare('INSERT INTO reset_meta(nonce) VALUES (?)').run(nonce);
      } finally { snapshot.close(); }
      const databaseSha256 = createHash('sha256').update(await readFile(stagedDb)).digest('hex');
      await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
        version: 1, nonce, databaseSha256, files: [],
      }));
      await rm(path.join(profile, 'lnwjing.sqlite'));
      await writeFile(path.join(profile, 'unrelated-user-code.ts'), 'export const doNotDelete = true;');
      expect(() => applyPendingFactoryResetSync(profile, tunnel))
        .toThrow('Cannot safely erase a profile with a missing workspace database');
      expect(await readFile(path.join(profile, 'unrelated-user-code.ts'), 'utf8'))
        .toBe('export const doNotDelete = true;');
      expect(await readFile(marker, 'utf8')).toContain('preserve-settings');
    } finally { await dispose(); }
  });

  it('does not trust a settings snapshot with unverified SQLite WAL sidecars', async () => {
    const { profile, tunnel, parent, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
      db.close();
      const pending = stageFactoryResetSync(profile, 'preserve-settings');
      const marker = JSON.parse(await readFile(pending, 'utf8')) as { nonce: string };
      const stage = path.join(parent, '.data.factory-reset-settings');
      await mkdir(stage);
      const stagingDb = path.join(stage, 'settings.sqlite');
      const snapshot = new DatabaseSync(stagingDb);
      snapshot.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);'
        + 'CREATE TABLE reset_meta(nonce TEXT NOT NULL);'
        + 'CREATE TABLE quota_policy(limit_bytes INTEGER NOT NULL,reserve_bytes INTEGER NOT NULL);');
      snapshot.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
      snapshot.prepare('INSERT INTO reset_meta(nonce) VALUES (?)').run(marker.nonce);
      snapshot.close();
      const hash = createHash('sha256').update(await readFile(stagingDb)).digest('hex');
      await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
        version: 1, nonce: marker.nonce, databaseSha256: hash, files: [],
      }));
      await writeFile(stagingDb + '-wal', 'untrusted-sidecar');
      expect(() => applyPendingFactoryResetSync(profile, tunnel)).toThrow(/unverified SQLite journal|snapshot integrity/i);
      const original = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'), { readOnly: true });
      try {
        expect(original.prepare("SELECT value FROM settings WHERE key='ui_locale'").get())
          .toMatchObject({ value: 'th' });
      } finally { original.close(); }
    } finally { await dispose(); }
  });

  it('blocks independent MCP/database startup while reset is pending, before creating secrets', async () => {
    const { profile, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.close();
      stageFactoryResetSync(profile, 'preserve-settings');
      expect(() => assertNoPendingProfileResetSync(profile)).toThrow(/profile reset is pending/i);
      expect(await readFile(factoryResetMarkerPath(profile), 'utf8')).toContain('preserve-settings');
      clearFactoryResetStageSync(profile);
      expect(() => assertNoPendingProfileResetSync(profile)).not.toThrow();
    } finally { await dispose(); }
  });

  it('never follows an unrelated cache junction into an external user project', async () => {
    const { profile, tunnel, external, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'en');
      db.close();
      await writeFile(path.join(external, 'source.ts'), 'keep-external-data');
      await symlink(external, path.join(profile, 'cache-link'), process.platform === 'win32' ? 'junction' : 'dir');
      stageFactoryResetSync(profile, 'preserve-settings');
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      expect(await readFile(path.join(external, 'source.ts'), 'utf8')).toBe('keep-external-data');
    } finally { await dispose(); }
  });

  it('rejects symlinked Settings dependency directories without deleting their targets', async () => {
    const { profile, tunnel, external, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'en');
      db.close();
      await writeFile(path.join(external, 'oauth-state.secret'), 'protected-external-secret');
      await symlink(external, path.join(profile, 'remote-mcp'), process.platform === 'win32' ? 'junction' : 'dir');
      stageFactoryResetSync(profile, 'preserve-settings');
      expect(() => applyPendingFactoryResetSync(profile, tunnel)).toThrow(/redirected|direct directory/);
      expect(await readFile(path.join(external, 'oauth-state.secret'), 'utf8')).toBe('protected-external-secret');
    } finally { await dispose(); }
  });

  it('keeps the original factory reset mode unchanged', async () => {
    const { profile, tunnel, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'en');
      db.close();
      stageFactoryResetSync(profile);
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      expect(await readdir(profile)).toEqual([]);
    } finally { await dispose(); }
  });
});
