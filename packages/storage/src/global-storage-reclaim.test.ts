import { link, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reclaimExpiredDisposableFiles } from './global-storage-reclaim.js';

describe('global quota disposable-only physical unlink', () => {
  it('removes only old allowed diagnostics and leaves protected, current and unknown files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-reclaim-'));
    try {
      for (const folder of ['logs', 'diagnostics', 'backups', 'workspace-index', 'crash-dumps']) {
        await mkdir(path.join(root, folder));
      }
      const old = new Date('2025-01-01T00:00:00Z');
      const now = new Date('2026-11-10T00:00:00Z');
      await writeFile(path.join(root, 'logs', 'archived.log'), Buffer.alloc(17));
      await utimes(path.join(root, 'logs', 'archived.log'), old, old);
      await writeFile(path.join(root, 'diagnostics', 'stale.trace'), Buffer.alloc(23));
      await utimes(path.join(root, 'diagnostics', 'stale.trace'), old, old);
      for (const [folder, name] of [
        ['logs', 'current.log'], ['logs', 'important.sqlite'],
        ['backups', 'old.log'], ['workspace-index', 'old.log'],
        ['crash-dumps', 'unknown.data'],
      ]) {
        await writeFile(path.join(root, folder, name), 'PRESERVE');
        await utimes(path.join(root, folder, name), folder === 'logs' && name === 'current.log' ? now : old,
          folder === 'logs' && name === 'current.log' ? now : old);
      }
      const result = await reclaimExpiredDisposableFiles(root, { nowMs: now.getTime() });
      expect(result).toMatchObject({ removed: 2, removedLogicalBytes: 40, truncated: false });
      await expect(readFile(path.join(root, 'logs', 'archived.log'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(root, 'diagnostics', 'stale.trace'))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const [folder, name] of [
        ['logs', 'current.log'], ['logs', 'important.sqlite'],
        ['backups', 'old.log'], ['workspace-index', 'old.log'],
        ['crash-dumps', 'unknown.data'],
      ]) expect(await readFile(path.join(root, folder, name), 'utf8')).toBe('PRESERVE');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses symlink or junction trees, and never unlinks hardlinked user files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-reclaim-protected-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-reclaim-user-'));
    try {
      const old = new Date('2020-01-01T00:00:00Z');
      await writeFile(path.join(outside, 'protected.log'), 'DO NOT TOUCH');
      await utimes(path.join(outside, 'protected.log'), old, old);
      await mkdir(path.join(root, 'logs'));
      await link(path.join(outside, 'protected.log'), path.join(root, 'logs', 'hardlink.log'));
      try { await symlink(outside, path.join(root, 'diagnostics'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) {
        if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      const summary = await reclaimExpiredDisposableFiles(root);
      expect(summary.removed).toBe(0);
      expect(await readFile(path.join(outside, 'protected.log'), 'utf8')).toBe('DO NOT TOUCH');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('enforces a bounded batch and rejects aggressive younger-than-seven-day cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-reclaim-batch-'));
    try {
      await mkdir(path.join(root, 'logs'));
      const old = new Date('2020-01-01T00:00:00Z');
      for (let i = 0; i < 5; i++) {
        const file = path.join(root, 'logs', 'old-' + i + '.log');
        await writeFile(file, 'x');
        await utimes(file, old, old);
      }
      await expect(reclaimExpiredDisposableFiles(root, { minimumAgeMs: 500 })).rejects.toThrow(/Invalid/);
      const result = await reclaimExpiredDisposableFiles(root, { maxRemovals: 2 });
      expect(result).toMatchObject({ removed: 2, removedLogicalBytes: 2, truncated: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
