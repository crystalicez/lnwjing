import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectProfileStorageOffMain, inspectProfileStorageWithPhysicalOffMain } from './profile-storage-inventory.js';
import { inspectWindowsProfileAllocatedBytes } from './windows-profile-allocation.js';

describe('on-demand Windows profile physical allocation', () => {
  it('measures NTFS allocated bytes separately from logical bytes on a small owned profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-physical-inventory-'));
    try {
      await mkdir(path.join(root, 'logs'));
      await writeFile(path.join(root, 'logs', 'sample.log'), Buffer.alloc(70 * 1024, 7));
      await writeFile(path.join(root, 'empty.dat'), '');
      const logical = await inspectProfileStorageOffMain(root);
      expect(logical.files).toBe(2);
      expect(logical.logicalBytes).toBe(70 * 1024);
      const physical = await inspectProfileStorageWithPhysicalOffMain(root);
      expect(physical.files).toBe(2);
      expect(physical.logicalBytes).toBe(logical.logicalBytes);
      if (process.platform === 'win32') {
        expect(physical.allocatedBytes).not.toBeNull();
        expect(physical.allocatedBytes).toBeGreaterThanOrEqual(0);
      } else expect(physical.allocatedBytes).toBe(logical.allocatedBytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 25_000);

  it('counts multiple hardlinks within the same owned profile only once in physical bytes', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-physical-internal-link-'));
    try {
      const original = path.join(root, 'original.log');
      await writeFile(original, Buffer.alloc(128 * 1024, 3));
      const before = await inspectProfileStorageWithPhysicalOffMain(root);
      expect(before.allocatedBytes).not.toBeNull();
      await link(original, path.join(root, 'second-name.log'));
      const after = await inspectProfileStorageWithPhysicalOffMain(root);
      expect(after.files).toBe(2);
      expect(after.logicalBytes).toBe(256 * 1024);
      expect(after.allocatedBytes).toBe(before.allocatedBytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 25_000);

  it('refuses attribution when a hardlink crosses the profile boundary', async () => {
    if (process.platform !== 'win32') return;
    const parent = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-physical-hardlink-'));
    const root = path.join(parent, 'profile');
    try {
      await mkdir(root);
      const owned = path.join(root, 'shared.dat');
      await writeFile(owned, 'SHARED');
      await link(owned, path.join(parent, 'outside-hardlink.dat'));
      const logical = await inspectProfileStorageOffMain(root);
      expect(logical.incomplete).toBe(false);
      expect(await inspectWindowsProfileAllocatedBytes(root, logical)).toBeNull();
      const physical = await inspectProfileStorageWithPhysicalOffMain(root);
      expect(physical.allocatedBytes).toBeNull();
      expect(physical.files).toBe(1);
    } finally { await rm(parent, { recursive: true, force: true }); }
  }, 25_000);

  it('does not run an expensive Windows helper for a known oversized inventory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-physical-skip-'));
    try {
      expect(await inspectWindowsProfileAllocatedBytes(root, {
        files: 5_001, visitedEntries: 5_001, logicalBytes: 0,
      })).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
