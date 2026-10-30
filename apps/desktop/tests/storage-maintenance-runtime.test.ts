import { mkdtemp, readFile, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteAuditRepository, SqliteCheckpointRepository, SqliteDatabase, SqliteSettingsRepository } from '@lnwjing/storage';
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
        checkpointCreationMode: 'git-aware', sqliteHardLimitMiB: 4096, compressionEnabledOnNextStart: false, automaticCheckpointRetention: false,
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
      expect(() => runtime.storageMaintenance.configurePolicy({
        userConfirmed: true, compressionEnabledOnNextStart: true,
      })).toThrow(/older Portable builds corrupt v2/);
      expect(() => runtime.storageMaintenance.configurePolicy({
        userConfirmed: true, checkpointCreationMode: 'unsupported' as 'git-aware',
      })).toThrow(/Invalid checkpoint creation mode/);
      expect(runtime.storageMaintenance.configurePolicy({
        userConfirmed: true, checkpointCreationMode: 'git-aware',
      })).toEqual({ restartRequired: false });
      expect(runtime.storageMaintenance.getPolicy().checkpointCreationMode).toBe('git-aware');
      expect(() => runtime.storageMaintenance.configurePolicy({ userConfirmed: true, sqliteHardLimitMiB: 100 })).toThrow(/Invalid SQLite hard limit/);
      expect(runtime.storageMaintenance.configurePolicy({ userConfirmed: true, sqliteHardLimitMiB: 1024 })).toEqual({ restartRequired: false });
      expect(runtime.storageMaintenance.getPolicy().sqliteHardLimitMiB).toBe(1024);
      const limited = await runtime.services.getStorageOverview();
      expect(limited.sqliteEffectiveHardLimitBytes).toBe(1024 ** 3);
      expect(limited.sqliteOverBudget).toBe(false);
      expect(limited.sqlitePressureHigh).toBe(false);
      expect(limited.automaticBackupBudget).toMatchObject({ budgetBytes: 3 * 1024 ** 3, blocked: false });
      expect(limited.automaticBackupBudgetUnknown).toBeUndefined();
      expect(runtime.storageMaintenance.configurePolicy({
        userConfirmed: true, checkpointCreationMode: 'always',
      })).toEqual({ restartRequired: false });
      expect(runtime.storageMaintenance.getPolicy().checkpointCreationMode).toBe('always');
      expect(runtime.storageMaintenance.configurePolicy({
        userConfirmed: true, auditPruneWithoutBackup: true, routineAuditRetentionDays: 7,
      })).toEqual({ restartRequired: false });
      expect(runtime.storageMaintenance.getPolicy()).toMatchObject({
        compressionEnabledOnNextStart: false, auditPruneWithoutBackup: true,
        routineAuditRetentionDays: 7, automaticCheckpointRetention: false,
      });
      expect((await runtime.services.getStorageOverview()).policy.routineAuditRetentionDays).toBe(7);
      const updated = await runtime.services.setStoragePolicy({ userConfirmed: true, auditPruneWithoutBackup: false });
      expect(updated.overview.policy.auditPruneWithoutBackup).toBe(false);
      expect((await runtime.services.previewCheckpointCleanup({
        maxBytes: 0, deleteBefore: '2026-01-01T00:00:00.000Z',
      })).checkpointIds).toEqual([]);
      expect(await runtime.services.applyCheckpointCleanup({
        maxBytes: 0, deleteBefore: '2026-01-01T00:00:00.000Z', expectedPreviewToken: (await runtime.services.previewCheckpointCleanup({ maxBytes: 0, deleteBefore: '2026-01-01T00:00:00.000Z' })).previewToken, userConfirmed: true,
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

  it('protects referenced checkpoint IDs without blocking unrelated eligible history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-protected-'));
    try {
      const db = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
      for (const [id, when] of [
        ['protected', '2025-01-01T00:00:00.000Z'],
        ['free', '2025-01-02T00:00:00.000Z'],
        ['newest', '2025-02-01T00:00:00.000Z'],
      ]) {
        await new SqliteCheckpointRepository(db).insert(checkpoint(id, 'workspace-a', when));
      }
      await new SqliteAuditRepository(db).insert({
        id: 'ref', workspaceId: 'workspace-a', actorId: 'test', actorName: 'test',
        action: 'mcp_tool:edit_file', resultCode: 'SUCCESS', durationMs: 1,
        timestamp: '2025-03-01T00:00:00.000Z',
        metadata: { mutationReceipt: { checkpointId: 'protected', path: 'demo.txt', action: 'edit_file' } },
      });
      db.close();
      const runtime = createDesktopRuntime(root, {
        checkpointEncryptionKey: Buffer.alloc(32, 41),
        hostMutationApprovalProvider: async () => true,
      });
      try {
        const opts = { maxBytes: 0, deleteBefore: '2026-01-01T00:00:00.000Z' };
        const preview = await runtime.services.previewCheckpointCleanup(opts);
        expect(preview.checkpointIds).toEqual(['free']);
        const result = await runtime.services.applyCheckpointCleanup({
          ...opts, userConfirmed: true, expectedPreviewToken: preview.previewToken,
        });
        expect(result.deleted).toBe(1);
        const live = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
        try {
          const items = live.connection.prepare('SELECT id FROM checkpoints ORDER BY id').all() as { id: string }[];
          expect(items.map((item) => item.id)).toEqual(['newest', 'protected']);
        } finally { live.close(); }
      } finally { await runtime.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails closed without native approval before creating a destructive cleanup backup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-approval-guard-'));
    try {
      const db = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
      const repo = new SqliteCheckpointRepository(db);
      await repo.insert(checkpoint('old', 'ws-a', '2025-01-01T00:00:00.000Z'));
      await repo.insert(checkpoint('new', 'ws-a', '2025-02-01T00:00:00.000Z'));
      db.close();
      const runtime = createDesktopRuntime(root, { checkpointEncryptionKey: Buffer.alloc(32, 41) });
      try {
        const request = { maxBytes: 0, deleteBefore: '2026-01-01T00:00:00.000Z' };
        const preview = await runtime.services.previewCheckpointCleanup(request);
        await expect(runtime.services.applyCheckpointCleanup({
          ...request, userConfirmed: true, expectedPreviewToken: preview.previewToken,
        })).rejects.toThrow(/approval/);
        const observed = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
        try {
          expect(observed.connection.prepare('SELECT COUNT(*) AS n FROM checkpoints').get()).toMatchObject({ n: 2 });
        } finally { observed.close(); }
      } finally { await runtime.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('serializes checkpoint cleanup so simultaneous confirmations never create duplicate backups', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-cleanup-serial-'));
    try {
      const database = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
      const repo = new SqliteCheckpointRepository(database);
      await repo.insert(checkpoint('old', 'ws-a', '2025-01-01T00:00:00.000Z'));
      await repo.insert(checkpoint('new', 'ws-a', '2025-02-01T00:00:00.000Z'));
      database.close();
      let signalEntry: (() => void) | undefined;
      const enteredApproval = new Promise<void>((resolve) => { signalEntry = resolve; });
      let allowFirst: ((value: boolean) => void) | undefined;
      const approval = new Promise<boolean>((resolve) => { allowFirst = resolve; });
      const runtime = createDesktopRuntime(root, {
        checkpointEncryptionKey: Buffer.alloc(32, 41),
        hostMutationApprovalProvider: async () => {
          signalEntry?.();
          return approval;
        },
      });
      try {
        const opts = { maxBytes: 0, deleteBefore: '2026-01-01T00:00:00.000Z' };
        const preview = await runtime.services.previewCheckpointCleanup(opts);
        const request = { ...opts, userConfirmed: true as const, expectedPreviewToken: preview.previewToken };
        const first = runtime.services.applyCheckpointCleanup(request);
        await enteredApproval;
        await expect(runtime.services.applyCheckpointCleanup(request)).rejects.toThrow(/already running/);
        allowFirst?.(true);
        expect((await first).deleted).toBe(1);
      } finally { allowFirst?.(false); await runtime.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('only manually cleans checkpoints after creating a verified backup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-storage-manual-'));
    try {
      const db = new SqliteDatabase(path.join(root, 'lnwjing.sqlite'));
      const repo = new SqliteCheckpointRepository(db);
      await repo.insert(checkpoint('old', 'ws-a', '2025-01-01T00:00:00.000Z'));
      await repo.insert(checkpoint('new', 'ws-a', '2025-02-01T00:00:00.000Z'));
      db.close();
      const runtime = createDesktopRuntime(root, { checkpointEncryptionKey: Buffer.alloc(32, 41), hostMutationApprovalProvider: async () => true });
      try {
        const opts = { maxBytes: 0, deleteBefore: '2026-01-01T00:00:00.000Z' };
        const beforeManual = (await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite')).length;
        await expect(runtime.storageMaintenance.applyCheckpointBudget({ ...opts, userConfirmed: false }))
          .rejects.toThrow(/confirmation/);
        expect((await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite'))).toHaveLength(beforeManual);
        const result = await runtime.storageMaintenance.applyCheckpointBudget({ ...opts, expectedPreviewToken: runtime.storageMaintenance.previewCheckpointBudget(opts).previewToken, userConfirmed: true });
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
    const runtime = createDesktopRuntime(root, { checkpointEncryptionKey: Buffer.alloc(32, 41), hostMutationApprovalProvider: async () => true });
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
