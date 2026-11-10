import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StorageManagementPanel, storageAdmissionHeadroom } from '../src/renderer/features/settings/StorageManagementPanel.js';
import type { StorageOverview } from '@lnwjing/ipc-contracts';
import { parseApplyCheckpointCleanup, parseCheckpointCleanupPreview, parseNativeStorageCleanup, parseSetStoragePolicyRequest } from '../src/main/storage-ipc-parser.js';

describe('Storage Management UI', () => {
  it('quantifies near-cap MCP headroom and checkpoint dominance using metadata only', () => {
    const mib = 1024 ** 2;
    const overview: StorageOverview = {
      policy: {
        checkpointCreationMode: 'git-aware', sqliteHardLimitMiB: 1024,
        compressionEnabledOnNextStart: false, automaticCheckpointRetention: false,
        auditPruneWithoutBackup: false, automaticHardLimitRecovery: true,
        routineAuditRetentionDays: 90,
      },
      sqliteAllocatedBytes: 991 * mib,
      sqliteFreeBytes: 31.9 * mib,
      sqliteWalBytes: 5.2 * mib,
      sqliteEffectiveHardLimitBytes: 1024 * mib,
      sqliteOverBudget: false, sqlitePressureHigh: true,
      compactRecommended: false, compactionRequiresOffline: true,
      checkpointStorage: { indexed: 4645, total: 4645, payloadBytes: Math.round(792.7 * mib) },
    };
    const result = storageAdmissionHeadroom(overview);
    expect(result.usedBytes / mib).toBeCloseTo(959.1);
    expect(result.headroomBytes / mib).toBeCloseTo(13.7, 1);
    expect(result.checkpointSharePercent).toBe(83);
    expect(storageAdmissionHeadroom({
      ...overview, sqliteFreeBytes: 0, sqliteAllocatedBytes: 1024 * mib,
    }).headroomBytes).toBe(0);
    expect(storageAdmissionHeadroom({
      ...overview, checkpointStorage: { indexed: 1, total: 2 },
    }).checkpointSharePercent).toBeNull();
  });

  it('shows offline compaction guidance and requires explicit cleanup preview', () => {
    const markup = renderToStaticMarkup(createElement(StorageManagementPanel, { locale: 'en', autoBackupEnabled: false }));
    expect(markup).toContain('Storage Management');
    expect(markup).toContain('SQLite Database');
    expect(markup).toContain('Preview cleanup');
    expect(markup).toContain('Verified native launcher cleanup');
    expect(markup).toContain('Profile storage inventory');
    expect(markup).toContain('Scan entire profile');
    expect(markup).toContain('data-testid="preserve-settings-reset"');
    expect(markup).toContain('Clear all data except Settings</button>');
    expect(markup).toContain('Your actual project files are never deleted');
    expect(markup).not.toContain('VACUUM now');
  });

  it('renders Thai labels and never auto-runs destructive operations in server render', () => {
    const markup = renderToStaticMarkup(createElement(StorageManagementPanel, { locale: 'th', autoBackupEnabled: false }));
    expect(markup).toContain('จัดการพื้นที่จัดเก็บ');
    expect(markup).toContain('ประเมินก่อนลบ');
    expect(markup).toContain('ล้างข้อมูลทั้งหมด ยกเว้น Settings</button>');
    expect(markup).not.toContain('ยืนยันล้าง Checkpoints ที่ผ่านเงื่อนไข');
  });
});

describe('storage IPC guards', () => {
  const preview = { maxBytes: 256 * 1024 * 1024, deleteBefore: '2026-10-01T00:00:00.000Z' };
  it('rejects unknown policy fields and unconfirmed mutation commands', () => {
    expect(() => parseSetStoragePolicyRequest({ userConfirmed: false, auditPruneWithoutBackup: true })).toThrow();
    expect(() => parseSetStoragePolicyRequest({ userConfirmed: true, auditPruneWithoutBackup: true, hidden: 1 })).toThrow();
    expect(parseSetStoragePolicyRequest({ userConfirmed: true, checkpointCreationMode: 'git-aware' })).toEqual({ userConfirmed: true, checkpointCreationMode: 'git-aware' });
    expect(() => parseSetStoragePolicyRequest({ userConfirmed: true, checkpointCreationMode: 'off' })).toThrow(/Invalid checkpoint/);
    expect(() => parseSetStoragePolicyRequest({ userConfirmed: true, checkpointCreationMode: null })).toThrow(/Invalid checkpoint/);
    expect(parseSetStoragePolicyRequest({ userConfirmed: true, sqliteHardLimitMiB: 2048 })).toEqual({ userConfirmed: true, sqliteHardLimitMiB: 2048 });
    expect(parseSetStoragePolicyRequest({ userConfirmed: true, automaticHardLimitRecovery: false }))
      .toEqual({ userConfirmed: true, automaticHardLimitRecovery: false });
    expect(() => parseSetStoragePolicyRequest({ userConfirmed: true, automaticHardLimitRecovery: 'false' })).toThrow(/policy flag/);
    expect(() => parseSetStoragePolicyRequest({ userConfirmed: true, sqliteHardLimitMiB: 128 })).toThrow(/Invalid SQLite/);
    expect(parseSetStoragePolicyRequest({ userConfirmed: true, globalQuotaMiB: 512 }))
      .toEqual({ userConfirmed: true, globalQuotaMiB: 512 });
    expect(parseSetStoragePolicyRequest({ userConfirmed: true, globalQuotaMiB: 0 }))
      .toEqual({ userConfirmed: true, globalQuotaMiB: 0 });
    expect(() => parseSetStoragePolicyRequest({ userConfirmed: true, globalQuotaMiB: 256 })).toThrow(/Invalid global/);
    expect(() => parseSetStoragePolicyRequest({ userConfirmed: true, globalQuotaMiB: 65537 })).toThrow(/Invalid global/);
    expect(() => parseApplyCheckpointCleanup({ ...preview })).toThrow();
    expect(() => parseNativeStorageCleanup({ category: 'tasks', userConfirmed: false })).toThrow();
  });
  it('constrains budgets, dates and cursor lengths', () => {
    expect(parseCheckpointCleanupPreview(preview)).toEqual(preview);
    expect(() => parseCheckpointCleanupPreview({ ...preview, maxBytes: -1 })).toThrow();
    expect(() => parseCheckpointCleanupPreview({ ...preview, maxBytes: 2 ** 52 })).toThrow();
    expect(() => parseCheckpointCleanupPreview({ ...preview, deleteBefore: 'tomorrow' })).toThrow();
    expect(() => parseNativeStorageCleanup({ category: 'tasks', userConfirmed: true, maxDirectories: 1000 })).toThrow();
    expect(parseNativeStorageCleanup({ category: 'tasks', userConfirmed: true, maxDirectories: 32 }))
      .toMatchObject({ maxDirectories: 32 });
  });
});
