import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { coalesceQuotaInventory } from './global-quota-inventory-coalescer.js';
import { GlobalStorageQuotaReservations } from './global-storage-quota.js';
import { inspectProfileStorageOffMain, type ProfileStorageInventory } from './profile-storage-inventory.js';

const MIB = 1024 * 1024;
const emptyInventory: ProfileStorageInventory = {
  scope: 'profile', scannedAt: '2026-11-10T00:00:00.000Z',
  logicalBytes: 0, allocatedBytes: null, files: 0, directories: 0,
  visitedEntries: 0, skippedLinks: 0, unreadableEntries: 0,
  incomplete: false, reason: 'complete', categories: [],
  potentiallyReclaimableLogicalBytes: 0, rebuildableLogicalBytes: 0,
};

describe('revision-fenced, in-flight-only quota inventory coalescing', () => {
  it('shares one active scan at the same revision but never caches the completed result', async () => {
    const root = path.join(os.tmpdir(), 'lnwjing-quota-scan-' + randomUUID());
    const gate = Promise.withResolvers<ProfileStorageInventory>();
    let started = 0;
    const scan = (): Promise<ProfileStorageInventory> => { started++; return gate.promise; };
    const first = coalesceQuotaInventory(root, 7, scan);
    const second = coalesceQuotaInventory(root, 7, scan);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(started).toBe(1);
    gate.resolve(emptyInventory);
    expect(await first).toBe(emptyInventory);
    expect(await second).toBe(emptyInventory);
    const third = coalesceQuotaInventory(root, 7, async () => { started++; return emptyInventory; });
    expect(third).not.toBe(first);
    expect(await third).toBe(emptyInventory);
    expect(started).toBe(2);
  });

  it('never reuses a scan across a writer revision change, even when an older scan is still active', async () => {
    const root = path.join(os.tmpdir(), 'lnwjing-quota-scan-' + randomUUID());
    const oldGate = Promise.withResolvers<ProfileStorageInventory>();
    const newGate = Promise.withResolvers<ProfileStorageInventory>();
    let started = 0;
    const old = coalesceQuotaInventory(root, 8, () => { started++; return oldGate.promise; });
    const fresh = coalesceQuotaInventory(root, 9, () => { started++; return newGate.promise; });
    await Promise.resolve();
    expect(started).toBe(2);
    const changed = { ...emptyInventory, logicalBytes: 777 };
    newGate.resolve(changed);
    expect(await fresh).toBe(changed);
    oldGate.resolve(emptyInventory);
    expect(await old).toBe(emptyInventory);
  });

  it('fails closed and evicts rejected scans instead of caching their error or invented inventory', async () => {
    const root = path.join(os.tmpdir(), 'lnwjing-quota-scan-' + randomUUID());
    let scans = 0;
    const run = (): Promise<ProfileStorageInventory> => {
      scans++;
      return Promise.reject(new Error('Profile scan failed'));
    };
    const first = coalesceQuotaInventory(root, 2, run);
    const second = coalesceQuotaInventory(root, 2, run);
    expect(first).toBe(second);
    await expect(first).rejects.toThrow('Profile scan failed');
    await expect(second).rejects.toThrow('Profile scan failed');
    expect(scans).toBe(1);
    expect(await coalesceQuotaInventory(root, 2, async () => {
      scans++;
      return emptyInventory;
    })).toBe(emptyInventory);
    expect(scans).toBe(2);
  });

  it('coalesces two real competing admissions and still never overcommits the ledger', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-quota-shared-admission-'));
    const entered = Promise.withResolvers<void>();
    const finishFirstScan = Promise.withResolvers<void>();
    let scans = 0;
    const scan = async (): Promise<ProfileStorageInventory> => {
      scans++;
      const snapshot = await inspectProfileStorageOffMain(root);
      if (scans === 1) {
        entered.resolve();
        await finishFirstScan.promise;
      }
      return snapshot;
    };
    const identity = async (): Promise<{ state: 'live'; startedAt: string }> =>
      ({ state: 'live', startedAt: '639037120000000000' });
    try {
      const options = { scanProfileInventory: scan, probeProcessIdentity: identity };
      const first = new GlobalStorageQuotaReservations(root, options);
      const second = new GlobalStorageQuotaReservations(root, options);
      first.configure({ limitBytes: 560 * 1024, criticalReserveBytes: 64 * 1024 });
      const pendingA = first.reserve(300 * 1024);
      const pendingB = second.reserve(300 * 1024);
      try {
        await entered.promise;
        // Both admission paths have observed the same ledger revision. The
        // second must join the first in-flight Worker rather than start a
        // second profile walk. No waiting on the database write lock here.
        await new Promise((resolve) => setTimeout(resolve, 125));
        expect(scans).toBe(1);
      } finally {
        finishFirstScan.resolve();
      }
      const results = await Promise.allSettled([pendingA, pendingB]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      // One post-commit retry is required, and must scan under a NEW revision.
      expect(scans).toBe(2);
      expect(first.status()?.reservedBytes).toBe(300 * 1024);
      const admitted = results.find((result): result is PromiseFulfilledResult<{
        id: string; token: string; bytes: number;
      }> => result.status === 'fulfilled');
      expect(admitted).toBeDefined();
      if (admitted !== undefined) first.release(admitted.value);
      expect(second.status()?.activeReservations).toBe(0);
    } finally {
      finishFirstScan.resolve();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);

  it('preserves quota revision across disable/re-enable, rejecting a stale scan after policy ABA', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-quota-aba-'));
    const beforeCommit = Promise.withResolvers<void>();
    const continueScan = Promise.withResolvers<void>();
    let calls = 0;
    const scan = async (): Promise<ProfileStorageInventory> => {
      calls++;
      const result = await inspectProfileStorageOffMain(root);
      if (calls === 1) {
        beforeCommit.resolve();
        await continueScan.promise;
      }
      return result;
    };
    try {
      const quota = new GlobalStorageQuotaReservations(root, { scanProfileInventory: scan });
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 64 * 1024 });
      const dbFile = path.join(root, 'global-quota-reservations-v2.sqlite');
      const revision = (): number => {
        const db = new DatabaseSync(dbFile, { readOnly: true });
        try {
          return (db.prepare('SELECT revision FROM quota_state WHERE id=1').get() as { revision: number }).revision;
        } finally { db.close(); }
      };
      const initial = revision();
      const inFlight = quota.reserve(160 * 1024);
      try {
        await beforeCommit.promise;
        quota.disable();
        expect(quota.status()).toBeNull();
        expect(revision()).toBe(initial + 1);
        quota.configure({ limitBytes: MIB, criticalReserveBytes: 64 * 1024 });
        expect(revision()).toBe(initial + 2);
        await writeFile(path.join(root, 'protected-large.bin'), Buffer.alloc(880 * 1024, 3));
      } finally {
        continueScan.resolve();
      }
      // The old scan predates the new 880-KiB file: revision fencing
      // must re-scan, not admit the requested 160-KiB allocation.
      await expect(inFlight).rejects.toThrow(/insufficient unreserved/);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(quota.status()?.activeReservations).toBe(0);
    } finally {
      continueScan.resolve();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);
});
