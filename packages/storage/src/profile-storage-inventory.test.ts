import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectProfileStorageOffMain } from './profile-storage-inventory.js';

describe('read-only global quota inventory groundwork', () => {
  it('counts nested profile files without reading contents or scanning user projects', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-inventory-'));
    const root = path.join(parent, 'profile');
    try {
      await mkdir(path.join(root, 'backups', 'archive'), { recursive: true });
      await mkdir(path.join(root, 'workspace-index'), { recursive: true });
      await mkdir(path.join(root, 'native-managed-processes', 'one'), { recursive: true });
      await writeFile(path.join(root, 'lnwjing.sqlite'), Buffer.alloc(11, 0));
      await writeFile(path.join(root, 'lnwjing.sqlite-wal'), Buffer.alloc(7, 1));
      await writeFile(path.join(root, 'checkpoint-master.key'), 'SECRET');
      await writeFile(path.join(root, 'backups', 'archive', 'old.sqlite'), Buffer.alloc(23, 2));
      await writeFile(path.join(root, 'workspace-index', 'w.json'), Buffer.alloc(31, 3));
      await writeFile(path.join(root, 'native-managed-processes', 'one', 'task.json'), Buffer.alloc(19, 4));
      await writeFile(path.join(root, 'unknown-state.dat'), Buffer.alloc(5, 5));
      // Adjacent user-owned data must never become part of an AppData inventory.
      await writeFile(path.join(parent, 'project-source.txt'), Buffer.alloc(1024 * 256, 6));
      const before = await readFile(path.join(root, 'checkpoint-master.key'), 'utf8');
      const result = await inspectProfileStorageOffMain(root);
      expect(result).toMatchObject({
        scope: 'profile', incomplete: false, reason: 'complete',
        files: 7, logicalBytes: 11 + 7 + 6 + 23 + 31 + 19 + 5,
      });
      expect(result.categories.map((item) => [item.id, item.logicalBytes])).toEqual([
        ['workspace-index', 31], ['backups', 23], ['native-managed-processes', 19],
        ['database', 18], ['secrets', 6], ['other', 5],
      ]);
      expect(result.rebuildableLogicalBytes).toBe(31);
      expect(result.potentiallyReclaimableLogicalBytes).toBe(31 + 23 + 19);
      expect(await readFile(path.join(root, 'checkpoint-master.key'), 'utf8')).toBe(before);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('gives explicitly incomplete results when the scanning budget is exhausted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-inventory-budget-'));
    try {
      for (let n = 0; n < 100; n++) {
        await writeFile(path.join(root, 'file-' + n + '.dat'), Buffer.alloc(10));
      }
      const result = await inspectProfileStorageOffMain(root, { maxEntries: 6 });
      expect(result).toMatchObject({
        incomplete: true, reason: 'entry-limit', visitedEntries: 6, files: 6, logicalBytes: 60,
      });
      expect(result.categories[0]).toMatchObject({ id: 'other', retention: 'unknown', logicalBytes: 60 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never walks directory junctions outside the owned profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-inventory-links-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-inventory-outside-'));
    try {
      await writeFile(path.join(outside, 'private-content'), Buffer.alloc(1024 * 1024));
      await writeFile(path.join(root, 'owned-file'), 'x');
      try {
        await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (error instanceof Error && /EPERM|EACCES|privilege/i.test(error.message)) return;
        throw error;
      }
      const result = await inspectProfileStorageOffMain(root);
      expect(result).toMatchObject({ files: 1, logicalBytes: 1, skippedLinks: 1,
        incomplete: true, reason: 'links-or-mounts' });
      expect(result.logicalBytes).toBeLessThan(1024 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects unsafe budgets and does not create a missing profile', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-inventory-missing-'));
    try {
      await expect(inspectProfileStorageOffMain(path.join(parent, 'missing'))).rejects.toThrow();
      await expect(inspectProfileStorageOffMain(parent, { maxEntries: 200_001 })).rejects.toThrow(/Invalid/);
      await expect(inspectProfileStorageOffMain(parent, { maxDurationMs: 1 })).rejects.toThrow(/Invalid/);
      expect((await inspectProfileStorageOffMain(parent)).logicalBytes).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
