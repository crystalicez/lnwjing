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
      ...opts, userConfirmed: false, createVerifiedBackup: verifiedBackup,
    })).rejects.toThrow('confirmation');
    expect(backupCount).toBe(0);
    await expect(repository.applyStorageBudget({
      ...opts, userConfirmed: true, createVerifiedBackup: async () => { throw new Error('backup unavailable'); },
    })).rejects.toThrow('backup unavailable');
    await expect(repository.get('a-old')).resolves.toEqual(first);
    const applied = await repository.applyStorageBudget({
      ...opts, userConfirmed: true, createVerifiedBackup: verifiedBackup,
    });
    expect(applied.deleted).toBe(1);
    expect(backupCount).toBe(1);
    await expect(repository.get('a-old')).resolves.toBeNull();
    await expect(repository.get('b-protected')).resolves.toEqual(protectedRow);
    await expect(repository.get('c-new')).resolves.toEqual(newest);
    await expect(repository.get('d-other')).resolves.toEqual(separateWorkspace);
    database.close();
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
