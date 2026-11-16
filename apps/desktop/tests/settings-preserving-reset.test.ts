import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { GlobalStorageQuotaReservations, assertNoPendingProfileResetSync } from '@lnwjing/storage';
import { applyPendingFactoryResetSync, cancelBlockedFactoryResetSync, clearFactoryResetStageSync, factoryResetMarkerPath, stageFactoryResetSync } from '../src/main/factory-reset.js';
import { preflightSettingsPreservingResetSync, ProtectedProjectInsideProfileError } from '../src/main/settings-preserving-reset.js';

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

  it('preserves registered nested project files during reset and protects them again on the next reset', async () => {
    const { profile, tunnel, dispose } = await fixture();
    try {
      const protectedProject = path.join(profile, 'projects', 'user-owned-project');
      const nested = path.join(protectedProject, 'src');
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, 'source.ts'), 'important source');
      await mkdir(path.join(profile, 'cache'));
      await writeFile(path.join(profile, 'cache', 'old.dat'), 'stale cache');
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
      db.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)')
        .run('protected', protectedProject, protectedProject);
      db.prepare('INSERT INTO audit_events(id) VALUES (?)').run('old');
      db.close();

      expect(() => preflightSettingsPreservingResetSync(profile)).not.toThrow();
      const marker = stageFactoryResetSync(profile, 'preserve-settings');
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      expect(await readFile(path.join(nested, 'source.ts'), 'utf8')).toBe('important source');
      await expect(readFile(path.join(profile, 'cache', 'old.dat'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });

      const restored = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'));
      try {
        expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='workspaces'").get()).toBeUndefined();
        expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='audit_events'").get()).toBeUndefined();
        expect(restored.prepare("SELECT value FROM settings WHERE key='ui_locale'").get()).toMatchObject({ value: 'th' });
        expect(JSON.parse((restored.prepare("SELECT value FROM settings WHERE key='reset_protected_project_roots_v1'").get() as { value: string }).value))
          .toEqual([path.join('projects', 'user-owned-project')]);
        // Simulate the fresh runtime's normal schema initialization before a second reset.
        restored.exec('CREATE TABLE workspaces(id TEXT PRIMARY KEY,root_path TEXT NOT NULL,real_root_path TEXT NOT NULL)');
      } finally { restored.close(); }
      await writeFile(path.join(profile, 'delete-me.log'), 'ephemeral');
      preflightSettingsPreservingResetSync(profile);
      stageFactoryResetSync(profile, 'preserve-settings');
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      expect(await readFile(path.join(nested, 'source.ts'), 'utf8')).toBe('important source');
      await expect(readFile(path.join(profile, 'delete-me.log'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await dispose(); }
  });

  it('blocks reset when the registered user project is the profile itself', async () => {
    const { profile, tunnel, dispose } = await fixture();
    try {
      const nested = path.join(profile, 'valuable-code');
      await mkdir(nested);
      await writeFile(path.join(nested, 'keep.ts'), 'keep');
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)')
        .run('profile-root', profile, profile);
      db.close();
      expect(() => preflightSettingsPreservingResetSync(profile))
        .toThrow(ProtectedProjectInsideProfileError);
      expect(() => preflightSettingsPreservingResetSync(profile))
        .toThrow(`Project: ${profile}`);
      stageFactoryResetSync(profile, 'preserve-settings');
      expect(() => applyPendingFactoryResetSync(profile, tunnel)).toThrow(ProtectedProjectInsideProfileError);
      expect(await readFile(path.join(nested, 'keep.ts'), 'utf8')).toBe('keep');
    } finally { await dispose(); }
  });

  it('refuses cancellation when a settings reset snapshot has a different owner', async () => {
    const { profile, dispose } = await fixture();
    try {
      const protectedProject = path.join(profile, 'project');
      await mkdir(protectedProject);
      await writeFile(path.join(protectedProject, 'keep.txt'), 'keep');
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)')
        .run('unsafe', profile, profile);
      db.close();
      const marker = stageFactoryResetSync(profile, 'preserve-settings');
      const stage = path.join(path.dirname(profile), '.data.factory-reset-settings');
      await mkdir(stage);
      await writeFile(path.join(stage, 'owner.txt'), 'not-this-request');
      expect(() => cancelBlockedFactoryResetSync(profile)).toThrow(/ownership is unverified/);
      expect(await readFile(marker, 'utf8')).toContain('preserve-settings');
      expect(await readFile(path.join(stage, 'owner.txt'), 'utf8')).toBe('not-this-request');
      expect(await readFile(path.join(protectedProject, 'keep.txt'), 'utf8')).toBe('keep');
    } finally { await dispose(); }
  });

  it('never discards a settings snapshot after destructive cleanup has started', async () => {
    const { profile, parent, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)')
        .run('profile-root', profile, profile);
      db.close();
      const marker = stageFactoryResetSync(profile, 'preserve-settings');
      const { nonce } = JSON.parse(await readFile(marker, 'utf8')) as { nonce: string };
      const stage = path.join(parent, '.data.factory-reset-settings');
      await mkdir(stage);
      await writeFile(path.join(stage, 'owner.txt'), nonce);
      await writeFile(path.join(stage, 'cleanup-started'), nonce);
      await writeFile(path.join(stage, 'settings.sqlite'), 'irreplaceable snapshot placeholder');
      expect(() => cancelBlockedFactoryResetSync(profile))
        .toThrow(/Cannot cancel a partially applied settings reset/);
      expect(await readFile(path.join(stage, 'settings.sqlite'), 'utf8'))
        .toBe('irreplaceable snapshot placeholder');
      expect(await readFile(marker, 'utf8')).toContain('preserve-settings');
    } finally { await dispose(); }
  });

  it('does not cancel a pending reset without a protected project', async () => {
    const { profile, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.close();
      preflightSettingsPreservingResetSync(profile);
      const marker = stageFactoryResetSync(profile, 'preserve-settings');
      expect(cancelBlockedFactoryResetSync(profile)).toBe(false);
      expect(await readFile(marker, 'utf8')).toContain('preserve-settings');
    } finally { await dispose(); }
  });

  it('recovers an interrupted nested-project wipe even when the source database has already been removed', async () => {
    const { profile, tunnel, parent, dispose } = await fixture();
    try {
      const project = path.join(profile, 'repositories', 'important');
      await mkdir(project, { recursive: true });
      await writeFile(path.join(project, 'keep.ts'), 'critical data');
      const original = settingsDatabase(profile);
      original.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
      original.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)')
        .run('keep', project, project);
      original.close();
      const marker = stageFactoryResetSync(profile, 'preserve-settings');
      const { nonce } = JSON.parse(await readFile(marker, 'utf8')) as { nonce: string };
      const stage = path.join(parent, '.data.factory-reset-settings');
      await mkdir(stage);
      const staged = path.join(stage, 'settings.sqlite');
      const saved = new DatabaseSync(staged);
      try {
        saved.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);'
          + 'CREATE TABLE reset_meta(nonce TEXT NOT NULL);'
          + 'CREATE TABLE quota_policy(limit_bytes INTEGER NOT NULL,reserve_bytes INTEGER NOT NULL);');
        saved.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('ui_locale', 'th');
        saved.prepare('INSERT INTO settings(key,value) VALUES (?,?)')
          .run('reset_protected_project_roots_v1', JSON.stringify([path.join('repositories', 'important')]));
        saved.prepare('INSERT INTO reset_meta(nonce) VALUES (?)').run(nonce);
      } finally { saved.close(); }
      await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
        version: 2, nonce, databaseSha256: createHash('sha256').update(await readFile(staged)).digest('hex'),
        files: [], protectedProjects: [path.join('repositories', 'important')],
      }));
      await writeFile(path.join(stage, 'cleanup-started'), nonce);
      // Simulate power loss after destructive cleanup has removed the source DB.
      await rm(path.join(profile, 'lnwjing.sqlite'));
      await writeFile(path.join(profile, 'cache.tmp'), 'partial cleanup');
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      expect(await readFile(path.join(project, 'keep.ts'), 'utf8')).toBe('critical data');
      await expect(readFile(path.join(profile, 'cache.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
      const after = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'), { readOnly: true });
      try {
        expect(after.prepare("SELECT value FROM settings WHERE key='ui_locale'").get()).toMatchObject({ value: 'th' });
        expect(JSON.parse((after.prepare("SELECT value FROM settings WHERE key='reset_protected_project_roots_v1'").get() as { value: string }).value))
          .toEqual([path.join('repositories', 'important')]);
      } finally { after.close(); }
    } finally { await dispose(); }
  });

  it('restarts a partially restored Settings database without losing preserved project files', async () => {
    const { profile, tunnel, parent, dispose } = await fixture();
    try {
      const protectedProject = path.join(profile, 'projects', 'important');
      await mkdir(protectedProject, { recursive: true });
      await writeFile(path.join(protectedProject, 'important.ts'), 'keep across repeated crashes');
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)')
        .run('important', protectedProject, protectedProject);
      db.close();
      const marker = stageFactoryResetSync(profile, 'preserve-settings');
      const { nonce } = JSON.parse(await readFile(marker, 'utf8')) as { nonce: string };
      const stage = path.join(parent, '.data.factory-reset-settings');
      await mkdir(stage);
      const stagedDb = path.join(stage, 'settings.sqlite');
      const saved = new DatabaseSync(stagedDb);
      try {
        saved.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);'
          + 'CREATE TABLE reset_meta(nonce TEXT NOT NULL);'
          + 'CREATE TABLE quota_policy(limit_bytes INTEGER NOT NULL,reserve_bytes INTEGER NOT NULL);');
        saved.prepare('INSERT INTO settings(key,value) VALUES (?,?)')
          .run('reset_protected_project_roots_v1', JSON.stringify([path.join('projects', 'important')]));
        saved.prepare('INSERT INTO reset_meta(nonce) VALUES (?)').run(nonce);
      } finally { saved.close(); }
      await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
        version: 2, nonce, files: [], protectedProjects: [path.join('projects', 'important')],
        databaseSha256: createHash('sha256').update(await readFile(stagedDb)).digest('hex'),
      }));
      await writeFile(path.join(stage, 'cleanup-started'), nonce);
      await rm(path.join(profile, 'lnwjing.sqlite'));
      // The first restore attempt created an empty Settings table and crashed
      // before copying back the persistent project-protection record.
      const partiallyRestored = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'));
      partiallyRestored.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      partiallyRestored.close();
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      expect(await readFile(path.join(protectedProject, 'important.ts'), 'utf8')).toBe('keep across repeated crashes');
      const restored = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'), { readOnly: true });
      try {
        expect(restored.prepare("SELECT value FROM settings WHERE key='reset_protected_project_roots_v1'").get()).toMatchObject({
          value: JSON.stringify([path.join('projects', 'important')]),
        });
      } finally { restored.close(); }
    } finally { await dispose(); }
  });

  it('preserves a registered junction to an external project without traversing its target', async () => {
    const { profile, tunnel, external, dispose } = await fixture();
    try {
      await writeFile(path.join(external, 'keep.ts'), 'external project');
      const alias = path.join(profile, 'linked-project');
      await symlink(external, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)').run('alias', alias, external);
      db.close();
      preflightSettingsPreservingResetSync(profile);
      stageFactoryResetSync(profile, 'preserve-settings');
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      expect(await readFile(path.join(alias, 'keep.ts'), 'utf8')).toBe('external project');
      expect(await readFile(path.join(external, 'keep.ts'), 'utf8')).toBe('external project');
    } finally { await dispose(); }
  });

  it('refuses to retain project roots inside automatically managed cache and log directories', async () => {
    const { profile, tunnel, dispose } = await fixture();
    try {
      const project = path.join(profile, 'workspace-index', 'user-code');
      await mkdir(project, { recursive: true });
      await writeFile(path.join(project, 'source.ts'), 'protected');
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO workspaces(id,root_path,real_root_path) VALUES (?,?,?)').run('unsafe', project, project);
      db.close();
      expect(() => preflightSettingsPreservingResetSync(profile)).toThrow(/automatically managed/);
      stageFactoryResetSync(profile, 'preserve-settings');
      expect(() => applyPendingFactoryResetSync(profile, tunnel)).toThrow(/automatically managed/);
      expect(await readFile(path.join(project, 'source.ts'), 'utf8')).toBe('protected');
    } finally { await dispose(); }
  });

  it('refuses corrupted persisted project safeguards before deleting any data', async () => {
    const { profile, tunnel, dispose } = await fixture();
    try {
      const db = settingsDatabase(profile);
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?)')
        .run('reset_protected_project_roots_v1', JSON.stringify(['..' + path.sep + 'outside']));
      db.close();
      await writeFile(path.join(profile, 'important.txt'), 'keep');
      expect(() => preflightSettingsPreservingResetSync(profile)).toThrow(/Invalid protected project path/);
      stageFactoryResetSync(profile, 'preserve-settings');
      expect(() => applyPendingFactoryResetSync(profile, tunnel)).toThrow(/Invalid protected project path/);
      expect(await readFile(path.join(profile, 'important.txt'), 'utf8')).toBe('keep');
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

  it('clears lnwjing state but leaves a registered nested user project in place', async () => {
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
      expect(applyPendingFactoryResetSync(profile, tunnel)).toBe(true);
      expect(await readFile(path.join(project, 'important-code.ts'), 'utf8')).toBe('export const userData = true;');
      const restored = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'), { readOnly: true });
      try {
        expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='workspaces'").get()).toBeUndefined();
      } finally { restored.close(); }
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
        .toThrow('A new protected project was registered after snapshot');
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
