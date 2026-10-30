import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StorageManagementPanel } from '../src/renderer/features/settings/StorageManagementPanel.js';
import { parseApplyCheckpointCleanup, parseCheckpointCleanupPreview, parseNativeStorageCleanup, parseSetStoragePolicyRequest } from '../src/main/storage-ipc-parser.js';

describe('Storage Management UI', () => {
  it('shows offline compaction guidance and requires explicit cleanup preview', () => {
    const markup = renderToStaticMarkup(createElement(StorageManagementPanel, { locale: 'en', autoBackupEnabled: false }));
    expect(markup).toContain('Storage Management');
    expect(markup).toContain('SQLite Database');
    expect(markup).toContain('Preview cleanup');
    expect(markup).toContain('Verified native launcher cleanup');
    expect(markup).not.toContain('VACUUM now');
  });

  it('renders Thai labels and never auto-runs destructive operations in server render', () => {
    const markup = renderToStaticMarkup(createElement(StorageManagementPanel, { locale: 'th', autoBackupEnabled: false }));
    expect(markup).toContain('จัดการพื้นที่จัดเก็บ');
    expect(markup).toContain('ประเมินก่อนลบ');
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
    expect(() => parseSetStoragePolicyRequest({ userConfirmed: true, sqliteHardLimitMiB: 128 })).toThrow(/Invalid SQLite/);
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
