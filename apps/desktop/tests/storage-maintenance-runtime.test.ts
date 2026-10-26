import { mkdtemp, readFile, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteCheckpointRepository, SqliteDatabase, SqliteSettingsRepository } from '@lnwjing/storage';
import type { Checkpoint } from '@lnwjing/workspace';
import { createDesktopRuntime } from '../src/main/desktop-services.js';

const checkpoint = (id: string, workspaceId: string, date: string): Checkpoint => ({
  id, workspaceId, createdAt: date,
  files: [{ path: 'demo.txt', content: id, contentSha256: 'a'.repeat(64), size: id.length }],
});

describe('Desktop storage-maintenance backend', () => {
  it('exposes validated backend policy toggles without changing user settings implicitly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-storage-policy-'));
    const runtime = createDesktopRuntime(root, { checkpointEncryptionKey: Buffer.alloc(32, 41) });
    try {
      expect(runtime.storageMaintenance.getPolicy()).toEqual({
        compressionEnabledOnNextStart: false, automaticCheckpointRetention: false,
        auditPruneWithoutBackup: false, routineAuditRetentionDays: 90,
      });
      expect(() => runtime.storageMaintenance.configurePolicy({
        userConfirmed: false, compressionEnabledOnNextStart: true,
      })).toThrow(/confirmation/);
      expect(() => runtime.storageMaintenance.configurePolicy({
        userConfirmed: true, automaticCheckpointRetention: true,
      })).toThrow(/automatic SQLite backups/);
      expect(() => runtime.storageMaintenance.configurePolicy({
        userConfirmed: true, routineAuditRetentionDays: -1,
      })).toThrow(/Invalid audit retention/);
      expect(runtime.storageMaintenance.configurePolicy({
        userConfirmed: true, compressionEnabledOnNextStart: true,
        auditPruneWithoutBackup: true, routineAuditRetentionDays: 7,
      })).toEqual({ restartRequired: true });
      expect(runtime.storageMaintenance.getPolicy()).toMatchObject({
        compressionEnabledOnNextStart: true, auditPruneWithoutBackup: true,
        routineAuditRetentionDays: 7, automaticCheckpointRetention: false,
      });
      expect((await runtime.services.getStorageOverview()).policy.routineAuditRetentionDays).toBe(7);
      const updated = await runtime.services.setStoragePolicy({ userConfirmed: true, auditPruneWithoutBackup: false });
      expect(updated.overview.policy.auditPruneWithoutBackup).toBe(false);
      expect((await runtime.services.previewCheckpointCleanup({
        maxBytes: 0, deleteBefore: '2026-01-01T00:00:00.000Z',
      })).checkpointIds).toEqual([]);
      expect(await runtime.services.applyCheckpointCleanup({
        maxBytes: 0, deleteBefore: '2026-01-01T00:00:00.000Z', userConfirmed: true,
      })).toEqual({ deleted: 0, plannedBytes: 0, backupId: null });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never automatically purges last-in-workspace checkpoints with backup disabled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-storage-safe-age-'));
    try {
      const database = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
      const repo = new SqliteCheckpointRepository(database);
      await repo.insert(checkpoint('only', 'ws-a', '2025-01-01T00:00:00.000Z'));
      await repo.insert(checkpoint('older', 'ws-b', '2025-01-01T00:00:00.000Z'));
      await repo.insert(checkpoint('latest', 'ws-b', '2025-02-01T00:00:00.000Z'));
      new SqliteSettingsRepository(database).set('recovery_retention_days', '1');
      database.close();

      const runtime = createDesktopRuntime(root, { checkpointEncryptionKey: Buffer.alloc(32, 41) });
      try {
        await runtime.services.getDashboard();
        const plan = runtime.storageMaintenance.previewCheckpointBudget({
          maxBytes: 0, deleteBefore: '2026-01-01T00:00:00.000Z',
        });
        expect(plan.checkpointIds).toEqual(['older']);
        const inspected = runtime.storageMaintenance.inspect();
        expect(inspected.sqliteAllocatedBytes).toBeGreaterThan(0);
        const observed = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
        try {
          const rows = observed.connection.prepare('SELECT id FROM checkpoints ORDER BY id').all() as { id: string }[];
          expect(rows.map((row) => row.id)).toEqual(['latest', 'older', 'only']);
        } finally {
          observed.close();
        }
      } finally {
        await runtime.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('opted-in automatic retention writes a daily backup and keeps the newest per project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-storage-auto-opt-in-'));
    try {
      const db = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
      const repo = new SqliteCheckpointRepository(db);
      await repo.insert(checkpoint('old', 'ws-a', '2025-01-01T00:00:00.000Z'));
      await repo.insert(checkpoint('new', 'ws-a', '2025-02-01T00:00:00.000Z'));
      await repo.insert(checkpoint('only', 'ws-b', '2025-01-01T00:00:00.000Z'));
      const settings = new SqliteSettingsRepository(db);
      settings.set('recovery_retention_days', '1');
      settings.set('auto_backup_enabled', 'true');
      settings.set('checkpoint_auto_retention_v1', 'true');
      db.close();
      const runtime = createDesktopRuntime(root, { checkpointEncryptionKey: Buffer.alloc(32, 41) });
      try {
        await runtime.services.getDashboard();
        const observer = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
        try {
          const rows = observer.connection.prepare('SELECT id FROM checkpoints ORDER BY id').all() as { id: string }[];
          expect(rows.map((x) => x.id)).toEqual(['new', 'only']);
        } finally {
          observer.close();
        }
        expect((await readdir(path.join(root, 'backups'))).some((name) => name.endsWith('.sqlite'))).toBe(true);
      } finally {
        await runtime.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('only manually cleans checkpoints after creating a verified backup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-storage-manual-'));
    try {
      const db = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
      const repo = new SqliteCheckpointRepository(db);
      await repo.insert(checkpoint('old', 'ws-a', '2025-01-01T00:00:00.000Z'));
      await repo.insert(checkpoint('new', 'ws-a', '2025-02-01T00:00:00.000Z'));
      db.close();
      const runtime = createDesktopRuntime(root, { checkpointEncryptionKey: Buffer.alloc(32, 41) });
      try {
        const opts = { maxBytes: 0, deleteBefore: '2026-01-01T00:00:00.000Z' };
        await expect(runtime.storageMaintenance.applyCheckpointBudget({ ...opts, userConfirmed: false }))
          .rejects.toThrow(/confirmation/);
        expect((await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite'))).toHaveLength(0);
        const result = await runtime.storageMaintenance.applyCheckpointBudget({ ...opts, userConfirmed: true });
        expect(result).toMatchObject({ deleted: 1, backupId: expect.any(String) });
        expect((await readdir(path.join(root, 'backups'))).some((name) => name.endsWith('.sqlite'))).toBe(true);
      } finally {
        await runtime.close();
      }
      const observed = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
      try {
        const rows = observed.connection.prepare('SELECT id FROM checkpoints ORDER BY id').all() as { id: string }[];
        expect(rows.map((row) => row.id)).toEqual(['new']);
      } finally {
        observed.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scopes manual native cleanup to trusted storage and verified receipts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-storage-native-'));
    const runtime = createDesktopRuntime(root, { checkpointEncryptionKey: Buffer.alloc(32, 41) });
    try {
      const directory = path.join(root, 'background-tasks', '00000000-0000-4000-8000-000000000001');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'containment.cs'), 'one-use');
      await writeFile(path.join(directory, 'stdout.log'), 'keep');
      await writeFile(path.join(directory, 'containment.receipt.json'), JSON.stringify({
        kind: 'windows_job_v1', outcome: 'completed', activeProcesses: 0, exitCode: 0,
      }));
      await expect(runtime.storageMaintenance.pruneNativeLaunchInputs({ category: 'tasks', userConfirmed: false }))
        .rejects.toThrow(/confirmation/);
      const cleaned = await runtime.storageMaintenance.pruneNativeLaunchInputs({
        category: 'tasks', userConfirmed: true, maxDirectories: 1,
      });
      expect(cleaned).toMatchObject({ inspected: 1, removedFiles: 1, nextCursor: null });
      expect(await readFile(path.join(directory, 'stdout.log'), 'utf8')).toBe('keep');
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
