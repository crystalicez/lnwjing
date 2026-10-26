import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Checkpoint } from '@lnwjing/workspace';
import { AesGcmCheckpointCipher } from './checkpoint-cipher.js';
import { SqliteCheckpointRepository } from './checkpoint-repository.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteCheckpointRepository', () => {
  it('round-trips bounded checkpoint metadata and content', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteCheckpointRepository(database);
    const checkpoint = fixtureCheckpoint('before');

    await repository.insert(checkpoint);

    await expect(repository.get(checkpoint.id)).resolves.toEqual(checkpoint);
    database.close();
  });

  it('lists only one workspace newest-first without exposing another workspace', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteCheckpointRepository(database);
    const older = { ...fixtureCheckpoint('older'), id: 'checkpoint-a', createdAt: new Date(1).toISOString() };
    const newer = { ...fixtureCheckpoint('newer'), id: 'checkpoint-b', createdAt: new Date(2).toISOString() };
    const other = { ...fixtureCheckpoint('other'), id: 'checkpoint-c', workspaceId: 'workspace-2', createdAt: new Date(3).toISOString() };
    await repository.insert(older);
    await repository.insert(newer);
    await repository.insert(other);

    await expect(repository.list('workspace-1')).resolves.toEqual([newer, older]);
    await expect(repository.list('workspace-2')).resolves.toEqual([other]);
    database.close();
  });

  it('deletes every checkpoint without touching unrelated database state', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteCheckpointRepository(database);
    const first = { ...fixtureCheckpoint('first'), id: 'checkpoint-a' };
    const second = { ...fixtureCheckpoint('second'), id: 'checkpoint-b', workspaceId: 'workspace-2' };
    database.connection.exec('CREATE TABLE checkpoint_purge_sentinel (value TEXT NOT NULL);');
    database.connection.prepare('INSERT INTO checkpoint_purge_sentinel (value) VALUES (?)').run('keep-me');
    await repository.insert(first);
    await repository.insert(second);

    await expect(repository.deleteAll()).resolves.toBe(2);
    await expect(repository.list('workspace-1')).resolves.toEqual([]);
    await expect(repository.list('workspace-2')).resolves.toEqual([]);
    const sentinel = database.connection.prepare('SELECT value FROM checkpoint_purge_sentinel').get() as { value?: string } | undefined;
    expect(sentinel?.value).toBe('keep-me');
    database.close();
  });

  it('never age-prunes the only or latest checkpoint in any workspace', async () => {
    const root = await temporaryRoot();
    const db = new SqliteDatabase(path.join(root, 'state.db'));
    try {
      const repo = new SqliteCheckpointRepository(db);
      const rows = [
        { ...fixtureCheckpoint('solo'), id: 'solo', workspaceId: 'ws-solo', createdAt: '2026-01-01T00:00:00.000Z' },
        { ...fixtureCheckpoint('old'), id: 'old', workspaceId: 'ws-pair', createdAt: '2026-01-01T00:00:00.000Z' },
        { ...fixtureCheckpoint('recent'), id: 'recent', workspaceId: 'ws-pair', createdAt: '2026-02-01T00:00:00.000Z' },
      ];
      for (const row of rows) await repo.insert(row);
      expect(repo.hasExpiredCleanupCandidates('2026-03-01T00:00:00.000Z')).toBe(true);
      expect(await repo.deleteOlderThan('2026-03-01T00:00:00.000Z')).toBe(1);
      expect(await repo.get('solo')).toEqual(rows[0]);
      expect(await repo.get('recent')).toEqual(rows[2]);
      expect(await repo.get('old')).toBeNull();
      expect(repo.hasExpiredCleanupCandidates('2026-03-01T00:00:00.000Z')).toBe(false);
      expect(await repo.deleteOlderThan('2026-03-01T00:00:00.000Z')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('previews a soft budget and preserves newest/workflow-protected checkpoints', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteCheckpointRepository(database);
    const first = { ...fixtureCheckpoint('A'.repeat(10_000)), id: 'a-old', createdAt: '2026-01-01T00:00:00.000Z' };
    const protectedRow = { ...fixtureCheckpoint('B'.repeat(10_000)), id: 'b-protected', createdAt: '2026-01-02T00:00:00.000Z' };
    const newest = { ...fixtureCheckpoint('C'.repeat(10_000)), id: 'c-new', createdAt: '2026-10-26T00:00:00.000Z' };
    const separateWorkspace = { ...fixtureCheckpoint('D'.repeat(10_000)), id: 'd-other', workspaceId: 'workspace-2', createdAt: '2026-01-01T00:00:00.000Z' };
    for (const row of [first, protectedRow, newest, separateWorkspace]) await repository.insert(row);
    const opts = { maxBytes: 10_000, deleteBefore: '2026-10-01T00:00:00.000Z', protectedIds: new Set(['b-protected']) };
    const plan = repository.planStorageBudget(opts);
    expect(plan.checkpointIds).toEqual(['a-old']);
    expect(plan.candidateBytes).toBeGreaterThan(0);
    let backupCount = 0;
    const verifiedBackup = async (): Promise<{ readonly verified: true; readonly id: string }> => {
      backupCount += 1;
      const backupPath = path.join(root, 'checkpoint-recovery.sqlite').replaceAll("'", "''");
      database.connection.exec(`VACUUM INTO '${backupPath}';`);
      return { verified: true, id: 'verified-fixture-backup' };
    };
    await expect(repository.applyStorageBudget({
      ...opts, expectedPreviewToken: plan.previewToken, userConfirmed: false, createVerifiedBackup: verifiedBackup,
    })).rejects.toThrow('confirmation');
    expect(backupCount).toBe(0);
    await expect(repository.applyStorageBudget({
      ...opts, expectedPreviewToken: plan.previewToken, userConfirmed: true, createVerifiedBackup: async () => { throw new Error('backup unavailable'); },
    })).rejects.toThrow('backup unavailable');
    await expect(repository.get('a-old')).resolves.toEqual(first);
    const applied = await repository.applyStorageBudget({
      ...opts, expectedPreviewToken: plan.previewToken, userConfirmed: true, createVerifiedBackup: verifiedBackup,
    });
    expect(applied.deleted).toBe(1);
    expect(backupCount).toBe(1);
    await expect(repository.get('a-old')).resolves.toBeNull();
    await expect(repository.get('b-protected')).resolves.toEqual(protectedRow);
    await expect(repository.get('c-new')).resolves.toEqual(newest);
    await expect(repository.get('d-other')).resolves.toEqual(separateWorkspace);
    database.close();
  });

  it('upgrades pre-metadata profiles without reading or rewriting existing payloads at startup', async () => {
    const root = await temporaryRoot();
    const filename = path.join(root, 'state.db');
    const legacy = new SqliteDatabase(filename);
    try {
      const repo = new SqliteCheckpointRepository(legacy);
      await repo.insert({ ...fixtureCheckpoint('legacy-content'), id: 'legacy', createdAt: '2026-01-01T00:00:00.000Z' });
      legacy.connection.exec(`
        DROP TRIGGER checkpoint_meta_insert;
        DROP TRIGGER checkpoint_meta_update;
        DROP TRIGGER checkpoint_meta_delete;
        DROP INDEX idx_checkpoint_meta_created;
        DROP INDEX idx_checkpoint_meta_compressed;
        DROP TABLE checkpoint_storage_meta;
        DROP TABLE checkpoint_storage_totals;
        DELETE FROM schema_migrations WHERE id IN ('026_checkpoint_storage_metadata', '027_checkpoint_storage_rollup', '028_checkpoint_rollup_replace_fix');
      `);
    } finally { legacy.close(); }
    const restored = new SqliteDatabase(filename);
    try {
      const repo = new SqliteCheckpointRepository(restored);
      expect(restored.connection.prepare(
        "SELECT id FROM schema_migrations WHERE id = '026_checkpoint_storage_metadata'",
      ).get()).toEqual({ id: '026_checkpoint_storage_metadata' });
      expect(repo.storageMetadataStatus()).toMatchObject({ complete: false, indexed: 0, total: 1 });
      const unchanged = restored.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get('legacy') as { files_json: string };
      expect(unchanged.files_json).toContain('legacy-content');
      await repo.prepareStorageMetadata();
      expect(repo.storageMetadataStatus()).toMatchObject({ complete: true, indexed: 1, total: 1 });
      expect(restored.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get('legacy'))
        .toEqual(unchanged);
    } finally { restored.close(); }
  });

  it('upgrades existing v026 metadata into a durable rollup without touching checkpoint payloads', async () => {
    const root = await temporaryRoot();
    const filename = path.join(root, 'state.db');
    const old = new SqliteDatabase(filename);
    let originalPayload: string;
    try {
      const repo = new SqliteCheckpointRepository(old);
      await repo.insert({ ...fixtureCheckpoint('old-payload'), id: 'a', createdAt: '2026-01-01T00:00:00.000Z' });
      await repo.insert({ ...fixtureCheckpoint('new-payload'), id: 'b', createdAt: '2026-02-01T00:00:00.000Z' });
      originalPayload = (old.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?')
        .get('a') as { files_json: string }).files_json;
      // Simulate a database upgraded to 026 by the previous Portable. Retain
      // all checkpoint metadata, but remove only the unrecorded v027 rollup.
      old.connection.exec(`
        DROP TRIGGER checkpoint_meta_rollup_insert;
        DROP TRIGGER checkpoint_meta_rollup_update;
        DROP TRIGGER checkpoint_meta_rollup_delete;
        DROP TRIGGER IF EXISTS checkpoint_total_rollup_insert;
        DROP TRIGGER IF EXISTS checkpoint_total_rollup_delete;
        DROP TABLE checkpoint_storage_totals;
        DELETE FROM schema_migrations WHERE id IN ('027_checkpoint_storage_rollup', '028_checkpoint_rollup_replace_fix');
      `);
    } finally { old.close(); }

    const upgraded = new SqliteDatabase(filename);
    try {
      const repo = new SqliteCheckpointRepository(upgraded);
      expect(upgraded.connection.prepare(
        "SELECT id FROM schema_migrations WHERE id = '027_checkpoint_storage_rollup'",
      ).get()).toEqual({ id: '027_checkpoint_storage_rollup' });
      expect(repo.storageMetadataStatus()).toMatchObject({ complete: true, indexed: 2, total: 2 });
      expect((upgraded.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?')
        .get('a') as { files_json: string }).files_json).toBe(originalPayload);
      const expectedBytes = (upgraded.connection.prepare(
        'SELECT COALESCE(SUM(length(CAST(files_json AS BLOB))), 0) AS bytes FROM checkpoints',
      ).get() as { bytes: number }).bytes;
      expect(repo.planStorageBudget({ maxBytes: 0, deleteBefore: '2027-01-01T00:00:00.000Z' }).totalBytes)
        .toBe(expectedBytes);
      // Raw SQL, including format changes, must be accounted for without
      // rebuilding the rollup or opening checkpoint BLOBs during overview.
      upgraded.connection.prepare('UPDATE checkpoints SET files_json = ? WHERE id = ?')
        .run('lnwjing:checkpoint:v2:br:payload', 'a');
      expect(repo.storageMetadataStatus().hasCompressedV2).toBe(true);
      upgraded.connection.prepare('DELETE FROM checkpoints WHERE id = ?').run('b');
      expect(repo.storageMetadataStatus()).toMatchObject({ complete: true, indexed: 1, total: 1, hasCompressedV2: true });
      const rollup = upgraded.connection.prepare(
        'SELECT indexed_count, total_count, payload_bytes, compressed_v2_count FROM checkpoint_storage_totals WHERE id = 1',
      ).get();
      expect(rollup).toEqual({
        indexed_count: 1,
        total_count: 1,
        payload_bytes: Buffer.byteLength('lnwjing:checkpoint:v2:br:payload'),
        compressed_v2_count: 1,
      });
    } finally { upgraded.close(); }
  });

  it('repairs a v027 miscount at migration without rewriting checkpoint payloads', async () => {
    const root = await temporaryRoot();
    const filename = path.join(root, 'state.db');
    const older = new SqliteDatabase(filename);
    const raw = older.connection.prepare(
      'INSERT INTO checkpoints (id, workspace_id, created_at, files_json) VALUES (?, ?, ?, ?)',
    );
    raw.run('legacy-id', 'workspace-1', '2025-01-01', 'do-not-rewrite');
    // Recreate a v027 profile whose total_count already drifted due to
    // INSERT OR REPLACE while SQLite recursive_triggers was OFF.
    older.connection.prepare('UPDATE checkpoint_storage_totals SET total_count = ? WHERE id = 1').run(2);
    older.connection.prepare("DELETE FROM schema_migrations WHERE id = '028_checkpoint_rollup_replace_fix'").run();
    older.close();
    const repaired = new SqliteDatabase(filename);
    try {
      const repo = new SqliteCheckpointRepository(repaired);
      expect(repo.storageMetadataStatus()).toMatchObject({ complete: true, indexed: 1, total: 1 });
      expect(repaired.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get('legacy-id'))
        .toEqual({ files_json: 'do-not-rewrite' });
      expect(repaired.connection.prepare(
        "SELECT id FROM schema_migrations WHERE id = '028_checkpoint_rollup_replace_fix'",
      ).get()).toEqual({ id: '028_checkpoint_rollup_replace_fix' });
    } finally { repaired.close(); }
  });

  it('preserves rollup count across legacy INSERT OR REPLACE on the same checkpoint ID', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    try {
      const repository = new SqliteCheckpointRepository(database);
      const rawReplace = database.connection.prepare(
        'INSERT OR REPLACE INTO checkpoints (id, workspace_id, created_at, files_json) VALUES (?, ?, ?, ?)',
      );
      rawReplace.run('legacy-id', 'workspace-1', '2025-01-01', 'old-payload');
      expect(repository.storageMetadataStatus()).toMatchObject({ complete: true, total: 1 });
      const before = repository.planStorageBudget({ maxBytes: 0, deleteBefore: '2027-01-01T00:00:00.000Z' });
      rawReplace.run('legacy-id', 'workspace-1', '2025-01-02', 'different-and-longer');
      expect(repository.storageMetadataStatus()).toMatchObject({ complete: true, indexed: 1, total: 1 });
      const after = repository.planStorageBudget({ maxBytes: 0, deleteBefore: '2027-01-01T00:00:00.000Z' });
      expect(after.totalBytes).toBe(Buffer.byteLength('different-and-longer'));
      expect(after.previewToken).not.toBe(before.previewToken);
      expect(database.connection.prepare('SELECT COUNT(*) AS n FROM checkpoints').get()).toEqual({ n: 1 });
      // Other SQLite clients may explicitly enable recursive REPLACE deletes.
      // The paired delete/insert triggers must still preserve the count.
      database.connection.exec('PRAGMA recursive_triggers=ON;');
      rawReplace.run('legacy-id', 'workspace-1', '2025-01-03', 'new');
      expect(repository.storageMetadataStatus()).toMatchObject({ complete: true, indexed: 1, total: 1 });
      expect(repository.planStorageBudget({ maxBytes: 0, deleteBefore: '2027-01-01T00:00:00.000Z' }).totalBytes)
        .toBe(3);
      database.connection.exec('PRAGMA recursive_triggers=OFF;');
    } finally { database.close(); }
  });

  it('fills legacy metadata only on explicit request and uses an indexed budget plan', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    try {
      const repo = new SqliteCheckpointRepository(database);
      await repo.insert({ ...fixtureCheckpoint('old'), id: 'old', createdAt: '2026-01-01T00:00:00.000Z' });
      await repo.insert({ ...fixtureCheckpoint('new'), id: 'new', createdAt: '2026-02-01T00:00:00.000Z' });
      // Models a profile that existed before the additive metadata migration:
      // existing Checkpoint BLOBs are untouched and intentionally not backfilled at startup.
      database.connection.prepare('DELETE FROM checkpoint_storage_meta WHERE checkpoint_id = ?').run('old');
      expect(repo.storageMetadataStatus()).toMatchObject({ complete: false, indexed: 1, total: 2 });
      expect(() => repo.planStorageBudget({ maxBytes: 0, deleteBefore: '2026-12-01T00:00:00.000Z' }))
        .toThrow(/preparation/);
      await repo.prepareStorageMetadata();
      expect(repo.storageMetadataStatus()).toMatchObject({ complete: true, indexed: 2, total: 2 });
      const preview = repo.planStorageBudget({ maxBytes: 0, deleteBefore: '2026-12-01T00:00:00.000Z' });
      expect(preview.checkpointIds).toEqual(['old']);
      expect(database.connection.prepare(
        'SELECT indexed_count, total_count, payload_bytes, compressed_v2_count FROM checkpoint_storage_totals WHERE id = 1',
      ).get()).toEqual({ indexed_count: 2, total_count: 2, payload_bytes: preview.totalBytes, compressed_v2_count: 0 });
      const rollupPlan = database.connection.prepare(
        'EXPLAIN QUERY PLAN SELECT payload_bytes FROM checkpoint_storage_totals WHERE id = 1',
      ).all() as { detail: string }[];
      expect(rollupPlan.map((item) => item.detail).join(' ')).toMatch(/INTEGER PRIMARY KEY/);
      expect(rollupPlan.map((item) => item.detail).join(' ')).not.toContain('checkpoint_storage_meta');
      const explain = database.connection.prepare(`
        EXPLAIN QUERY PLAN SELECT older.checkpoint_id FROM checkpoint_storage_meta older
        INDEXED BY idx_checkpoint_meta_created
        WHERE older.created_at < ?
        AND EXISTS (
          SELECT 1 FROM checkpoints newer
          WHERE newer.workspace_id = older.workspace_id
            AND (newer.created_at > older.created_at
              OR (newer.created_at = older.created_at AND newer.id > older.checkpoint_id))
        )
        ORDER BY older.created_at ASC, older.checkpoint_id ASC LIMIT 256
      `).all('2026-12-01T00:00:00.000Z') as { detail: string }[];
      expect(explain.some((row) => row.detail.includes('idx_checkpoint_meta_created'))).toBe(true);
      expect(explain.some((row) => row.detail.includes('USE TEMP B-TREE'))).toBe(false);
      // The trigger sees same-length and raw writes, without requiring
      // application-level helpers to synchronize metadata.
      database.connection.prepare('UPDATE checkpoints SET files_json = ? WHERE id = ?')
        .run('lnwjing:checkpoint:v2:br:payload', 'old');
      expect(repo.storageMetadataStatus().hasCompressedV2).toBe(true);
    } finally {
      database.close();
    }
  });

  it('rejects stale cleanup previews even when a new checkpoint changes eligibility before confirmation', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    try {
      const repo = new SqliteCheckpointRepository(database);
      for (const [id, createdAt] of [['a', '2026-01-01T00:00:00.000Z'], ['b', '2026-02-01T00:00:00.000Z']]) {
        await repo.insert({ ...fixtureCheckpoint(id), id, createdAt });
      }
      const options = { maxBytes: 0, deleteBefore: '2026-12-01T00:00:00.000Z', protectedIds: new Set<string>() };
      const preview = repo.planStorageBudget(options);
      expect(preview.checkpointIds).toEqual(['a']);
      await repo.insert({ ...fixtureCheckpoint('c'), id: 'c', createdAt: '2026-03-01T00:00:00.000Z' });
      let backups = 0;
      await expect(repo.applyStorageBudget({
        ...options, expectedPreviewToken: preview.previewToken, userConfirmed: true,
        createVerifiedBackup: async () => { backups++; return { verified: true as const, id: 'unused' }; },
      })).rejects.toThrow(/stale|changed/);
      expect(backups).toBe(0);
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM checkpoints').get()).toMatchObject({ count: 3 });
      const current = repo.planStorageBudget(options);
      expect(current.checkpointIds).toEqual(['a', 'b']);
      const applied = await repo.applyStorageBudget({
        ...options, expectedPreviewToken: current.previewToken, userConfirmed: true,
        createVerifiedBackup: async () => { backups++; return { verified: true as const, id: 'mocked-verified' }; },
      });
      expect(applied.deleted).toBe(2);
      expect(backups).toBe(1);
    } finally {
      database.close();
    }
  });

  it('invalidates cached checkpoint sizes after direct SQL edits and external eligible-set changes', async () => {
    const root = await temporaryRoot();
    const filename = path.join(root, 'state.db');
    const database = new SqliteDatabase(filename);
    const repository = new SqliteCheckpointRepository(database);
    try {
      await repository.insert({ ...fixtureCheckpoint('first'), id: 'older', createdAt: '2026-01-01T00:00:00.000Z' });
      await repository.insert({ ...fixtureCheckpoint('next'), id: 'newer', createdAt: '2026-02-01T00:00:00.000Z' });
      const opts = { maxBytes: 0, deleteBefore: '2026-10-01T00:00:00.000Z' };
      const first = repository.planStorageBudget(opts);
      expect(repository.planStorageBudget(opts).previewToken).toBe(first.previewToken);
      const row = database.connection.prepare('SELECT files_json AS value FROM checkpoints WHERE id = ?').get('older') as { value: string };
      database.connection.prepare('UPDATE checkpoints SET files_json = ? WHERE id = ?')
        .run(row.value.replace('first', 'longer-content'), 'older');
      const second = repository.planStorageBudget(opts);
      expect(second.totalBytes).toBeGreaterThan(first.totalBytes);
      expect(second.previewToken).not.toBe(first.previewToken);
      const outsider = new SqliteDatabase(filename);
      try {
        outsider.connection.prepare('UPDATE checkpoints SET created_at = ? WHERE id = ?')
          .run('2025-12-01T00:00:00.000Z', 'newer');
      } finally { outsider.close(); }
      const third = repository.planStorageBudget(opts);
      expect(third.checkpointIds).not.toEqual(second.checkpointIds);
      expect(third.previewToken).not.toBe(second.previewToken);
    } finally { database.close(); }
  });

  it('versions same-size raw checkpoint updates but ignores unrelated settings writes', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    try {
      const repository = new SqliteCheckpointRepository(database);
      await repository.insert({ ...fixtureCheckpoint('first'), id: 'older', createdAt: '2026-01-01T00:00:00.000Z' });
      await repository.insert({ ...fixtureCheckpoint('newer'), id: 'newer', createdAt: '2026-02-01T00:00:00.000Z' });
      const options = { maxBytes: 0, deleteBefore: '2026-10-01T00:00:00.000Z' };
      const before = repository.planStorageBudget(options);
      const row = database.connection.prepare('SELECT files_json AS value FROM checkpoints WHERE id = ?').get('older') as { value: string };
      const changed = row.value.replace('first', 'other');
      expect(changed.length).toBe(row.value.length);
      database.connection.prepare('UPDATE checkpoints SET files_json = ? WHERE id = ?').run(changed, 'older');
      const after = repository.planStorageBudget(options);
      expect(after.totalBytes).toBe(before.totalBytes);
      expect(after.checkpointIds).toEqual(before.checkpointIds);
      expect(after.previewToken).not.toBe(before.previewToken);
      database.connection.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('unrelated-budget-setting', '1');
      expect(repository.planStorageBudget(options).previewToken).toBe(after.previewToken);
    } finally { database.close(); }
  });

  it('backfills legacy metadata only on explicit request using cooperative batches', async () => {
    const root = await temporaryRoot();
    const db = new SqliteDatabase(path.join(root, 'state.db'));
    try {
      const repo = new SqliteCheckpointRepository(db);
      for (let i = 0; i < 70; i += 1) {
        await repo.insert({
          ...fixtureCheckpoint('legacy-metadata-' + i),
          id: 'old-' + String(i).padStart(3, '0'),
          createdAt: '2026-01-01T00:00:00.000Z',
        });
      }
      // Simulate a profile created before the metadata migration. The
      // migration itself must not silently backfill old snapshots at startup.
      db.connection.exec('DELETE FROM checkpoint_storage_meta');
      const before = repo.storageMetadataStatus();
      expect(before).toMatchObject({ indexed: 0, total: 70, complete: false });
      expect(() => repo.planStorageBudget({ maxBytes: 0, deleteBefore: '2027-01-01T00:00:00.000Z' }))
        .toThrow(/preparation/);
      await repo.prepareStorageMetadata();
      expect(repo.storageMetadataStatus()).toMatchObject({ indexed: 70, total: 70, complete: true });
      const plan = repo.planStorageBudget({ maxBytes: 0, deleteBefore: '2027-01-01T00:00:00.000Z' });
      expect(plan.totalBytes).toBeGreaterThan(0);
      expect(plan.checkpointIds).toHaveLength(69);
      const query = db.connection.prepare(`
        EXPLAIN QUERY PLAN
        SELECT checkpoint_id, payload_bytes FROM checkpoint_storage_meta
        INDEXED BY idx_checkpoint_meta_created WHERE created_at < ?
        ORDER BY created_at ASC, checkpoint_id ASC LIMIT 256
      `).all('2027-01-01T00:00:00.000Z') as { detail: string }[];
      expect(query.map((row) => row.detail).join(' ')).toContain('idx_checkpoint_meta_created');
      expect(query.map((row) => row.detail).join(' ')).not.toContain('TEMP B-TREE');
    } finally { db.close(); }
  });

  it('encrypts checkpoint file content at rest with AES-256-GCM', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 7));
    const repository = new SqliteCheckpointRepository(database, cipher);
    const checkpoint = fixtureCheckpoint('sensitive-checkpoint-marker');

    await repository.insert(checkpoint);

    const row = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(checkpoint.id) as { files_json?: string } | undefined;
    expect(row?.files_json).toMatch(/^lnwjing:checkpoint:v1:/);
    expect(row?.files_json).not.toContain('sensitive-checkpoint-marker');
    await expect(repository.get(checkpoint.id)).resolves.toEqual(checkpoint);
    database.close();
  });

  it('upgrades a legacy plaintext checkpoint to ciphertext when the encrypted repository starts', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 9));
    const checkpoint = fixtureCheckpoint('legacy-plaintext-marker');
    const legacyPayload = JSON.stringify(checkpoint.files);
    database.connection.prepare(
      'INSERT INTO checkpoints (id, workspace_id, created_at, files_json) VALUES (?, ?, ?, ?)',
    ).run(checkpoint.id, checkpoint.workspaceId, checkpoint.createdAt, legacyPayload);
    const repository = new SqliteCheckpointRepository(database, cipher);

    await expect(repository.get(checkpoint.id)).resolves.toEqual(checkpoint);

    const row = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(checkpoint.id) as { files_json?: string } | undefined;
    expect(row?.files_json).toMatch(/^lnwjing:checkpoint:v1:/);
    expect(row?.files_json).not.toContain('legacy-plaintext-marker');
    database.close();
  });

  it('performs legacy migration once, then upgrades rare imported plaintext lazily', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 13));
    new SqliteCheckpointRepository(database, cipher);
    expect(database.connection.prepare(
      "SELECT 1 FROM schema_migrations WHERE id = 'checkpoint_cipher_legacy_encryption_v1'",
    ).get()).toBeTruthy();

    const legacy = { ...fixtureCheckpoint('later-imported-plaintext'), id: 'later-import' };
    database.connection.prepare(
      'INSERT INTO checkpoints (id, workspace_id, created_at, files_json) VALUES (?, ?, ?, ?)',
    ).run(legacy.id, legacy.workspaceId, legacy.createdAt, JSON.stringify(legacy.files));
    const restarted = new SqliteCheckpointRepository(database, cipher);
    const before = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(legacy.id) as { files_json: string };
    expect(before.files_json).toContain('later-imported-plaintext');
    await expect(restarted.get(legacy.id)).resolves.toEqual(legacy);
    const after = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(legacy.id) as { files_json: string };
    expect(after.files_json).toMatch(/^lnwjing:checkpoint:v1:/);
    database.close();
  });

  it('migrates legacy plaintext in bounded batches beyond one page', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 5));
    const insert = database.connection.prepare(
      'INSERT INTO checkpoints (id, workspace_id, created_at, files_json) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < 17; i += 1) {
      const checkpoint = { ...fixtureCheckpoint('legacy-' + i), id: 'old-' + String(i).padStart(2, '0') };
      insert.run(checkpoint.id, checkpoint.workspaceId, checkpoint.createdAt, JSON.stringify(checkpoint.files));
    }
    const repo = new SqliteCheckpointRepository(database, cipher);
    for (let i = 0; i < 17; i += 1) {
      const id = 'old-' + String(i).padStart(2, '0');
      const row = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(id) as { files_json: string };
      expect(cipher.isEncrypted(row.files_json)).toBe(true);
      const restored = await repo.get(id);
      expect(restored?.files[0]?.content).toBe('legacy-' + i);
    }
    database.close();
  });

  it('fails closed when an encrypted checkpoint payload is tampered with', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 11));
    const repository = new SqliteCheckpointRepository(database, cipher);
    const checkpoint = fixtureCheckpoint('tamper-marker');
    await repository.insert(checkpoint);
    const row = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(checkpoint.id) as { files_json: string };
    const tampered = row.files_json.slice(0, -1) + (row.files_json.endsWith('A') ? 'B' : 'A');
    database.connection.prepare('UPDATE checkpoints SET files_json = ? WHERE id = ?').run(tampered, checkpoint.id);

    await expect(repository.get(checkpoint.id)).resolves.toBeNull();
    database.close();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-checkpoint-db-'));
  temporaryRoots.push(root);
  return root;
}

function fixtureCheckpoint(content: string): Checkpoint {
  return {
    id: 'checkpoint-1',
    workspaceId: 'workspace-1',
    createdAt: new Date(0).toISOString(),
    files: [{ path: 'src/file.txt', content, contentSha256: 'hash', size: Buffer.byteLength(content) }],
  };
}
