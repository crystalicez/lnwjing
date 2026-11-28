import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { GlobalStorageQuotaReservations } from './global-storage-quota.js';
import { inspectProfileStorageOffMain } from './profile-storage-inventory.js';

const MIB = 1024 * 1024;
async function fixture(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-quota-v2-'));
  return { root, dispose: async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

function departedOwner(ledger: string, bytes: number): Promise<void> {
  // A separate real Node process reserves space then exits without releasing
  // it. The parent cannot assume a stale reservation is reclaimable until the
  // child's PID is verifiably dead.
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    "const { randomUUID,createHash } = require('node:crypto');",
    "const db = new DatabaseSync(process.argv[1],{timeout:3000});",
    "db.exec('BEGIN IMMEDIATE');",
    "try {",
    " const token=randomUUID();",
    " db.prepare('INSERT INTO quota_reservations (id,token_hash,owner_pid,bytes) VALUES (?,?,?,?)')",
    "  .run(randomUUID(),createHash('sha256').update(token).digest('hex'),process.pid,Number(process.argv[2]));",
    " db.prepare('UPDATE quota_state SET revision=revision+1 WHERE id=1').run();",
    " db.exec('COMMIT');",
    "} catch(e) {db.exec('ROLLBACK');throw e;} finally {db.close();}",
  ].join('\n');
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ledger, String(bytes)],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errors = '';
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Departed owner timed out')); }, 10_000);
    child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (code === 0) resolve();
      else reject(new Error('Departed owner failed: ' + errors.slice(0, 1000)));
    });
  });
}

describe('opt-in cross-process Global Storage Quota V2 reservations', () => {
  it('admits simultaneous MCP calls with one inventory scan and independent release proofs', async () => {
    const { root, dispose } = await fixture();
    try {
      let scans = 0;
      const quota = new GlobalStorageQuotaReservations(root, {
        availableVolumeBytes: (): bigint => BigInt(512 * MIB),
        scanProfileInventory: async (): ReturnType<typeof inspectProfileStorageOffMain> => { scans++; return inspectProfileStorageOffMain(root); },
      });
      quota.configure({ limitBytes: 64 * MIB, criticalReserveBytes: MIB });
      const releases = await Promise.all(Array.from({ length: 8 }, () => quota.reserveMcpActivityAudit(() => 1024)));
      const bytesPerCall = 2 * MIB + 2048;
      expect(scans).toBe(1);
      expect(quota.status()).toMatchObject({ activeReservations: 8, reservedBytes: 8 * bytesPerCall });
      releases[0]!();
      expect(quota.status()).toMatchObject({ activeReservations: 7, reservedBytes: 7 * bytesPerCall });
      expect(() => releases[0]!()).toThrow(/missing or has invalid ownership/);
      for (const release of releases.slice(1)) release!();
      expect(quota.status()).toMatchObject({ activeReservations: 0, reservedBytes: 0 });
      await writeFile(path.join(root, 'new-data.bin'), Buffer.alloc(128 * 1024));
      const next = await quota.reserveMcpActivityAudit(() => 1024);
      expect(scans).toBe(2);
      next!();
    } finally { await dispose(); }
  });

  it('falls back to independent admission when the combined MCP request is too large', async () => {
    const { root, dispose } = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root, { availableVolumeBytes: (): bigint => BigInt(512 * MIB) });
      quota.configure({ limitBytes: 8 * MIB, criticalReserveBytes: MIB });
      const results = await Promise.allSettled([
        quota.reserveMcpActivityAudit(() => 6 * MIB),
        quota.reserveMcpActivityAudit(() => 1024),
      ]);
      expect(results[0]?.status).toBe('rejected');
      expect(results[1]?.status).toBe('fulfilled');
      expect(quota.status()).toMatchObject({ activeReservations: 1, reservedBytes: 2 * MIB + 2048 });
      if (results[1]?.status === 'fulfilled') results[1].value!();
      expect(quota.status()).toMatchObject({ activeReservations: 0 });
    } finally { await dispose(); }
  });


  it('does not re-run schema DDL or table introspection on each reservation and release', async () => {
    const { root, dispose } = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root, { availableVolumeBytes: (): bigint => BigInt(512 * MIB) });
      quota.configure({ limitBytes: 32 * MIB, criticalReserveBytes: MIB });
      const ledger = new DatabaseSync(path.join(root, 'global-quota-reservations-v2.sqlite'));
      try {
        expect(ledger.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      } finally { ledger.close(); }
      const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
      const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
      try {
        for (let i = 0; i < 3; i++) {
          const proof = await quota.reserve(4096);
          quota.release(proof);
        }
        expect(exec.mock.calls.filter(([sql]) => /CREATE TABLE|ALTER TABLE|user_version\s*=/i.test(sql))).toHaveLength(0);
        expect(prepare.mock.calls.filter(([sql]) => /PRAGMA table_info/i.test(sql))).toHaveLength(0);
        expect(quota.status()?.activeReservations).toBe(0);
      } finally { exec.mockRestore(); prepare.mockRestore(); }
    } finally { await dispose(); }
  });

  it('queries quota configuration without probing the physical volume', async () => {
    const { root, dispose } = await fixture();
    try {
      let probes = 0;
      const quota = new GlobalStorageQuotaReservations(root, { availableVolumeBytes: (): bigint => { probes++; return BigInt(512 * MIB); } });
      expect(quota.isConfigured()).toBe(false);
      expect(existsSync(path.join(root, 'global-quota-reservations-v2.sqlite'))).toBe(false);
      quota.configure({ limitBytes: 32 * MIB, criticalReserveBytes: MIB });
      for (let i = 0; i < 20; i++) expect(quota.isConfigured()).toBe(true);
      expect(probes).toBe(0);
      expect(quota.status()?.activeReservations).toBe(0);
      expect(probes).toBe(1);
      quota.disable();
      expect(quota.isConfigured()).toBe(false);
    } finally { await dispose(); }
  });


  it('shares simultaneous inspection scans but never reuses a settled inventory', async () => {
    const { root, dispose } = await fixture();
    try {
      let scans = 0;
      const quota = new GlobalStorageQuotaReservations(root, {
        availableVolumeBytes: (): bigint => BigInt(512 * MIB),
        scanProfileInventory: async (): ReturnType<typeof inspectProfileStorageOffMain> => { scans++; return inspectProfileStorageOffMain(root); },
      });
      quota.configure({ limitBytes: 32 * MIB, criticalReserveBytes: MIB });
      const [a, b] = await Promise.all([quota.inspect(), quota.inspect()]);
      expect(scans).toBe(1);
      expect(a.logicalUsedBytes).toBe(b.logicalUsedBytes);
      await writeFile(path.join(root, 'new.bin'), Buffer.alloc(128 * 1024));
      const next = await quota.inspect();
      expect(scans).toBe(2);
      expect(next.logicalUsedBytes).toBeGreaterThanOrEqual(a.logicalUsedBytes + 128 * 1024);
    } finally { await dispose(); }
  });

  it('checks actual volume only during authoritative audit reservation admission', async () => {
    const { root, dispose } = await fixture();
    try {
      let volumeChecks = 0;
      let estimates = 0;
      const quota = new GlobalStorageQuotaReservations(root, {
        availableVolumeBytes: (): bigint => { volumeChecks++; return BigInt(512 * MIB); },
      });
      const estimate = (): number => { estimates++; return 1024; };
      expect(await quota.reserveMcpActivityAudit(estimate)).toBeNull();
      expect([volumeChecks, estimates]).toEqual([0, 0]);
      quota.configure({ limitBytes: 32 * MIB, criticalReserveBytes: MIB });
      const release = await quota.reserveMcpActivityAudit(estimate);
      expect(release).toBeTypeOf('function');
      expect(estimates).toBe(1);
      expect(volumeChecks).toBe(2);
      expect(quota.status()?.activeReservations).toBe(1);
      release?.();
      expect(quota.status()?.activeReservations).toBe(0);
    } finally { await dispose(); }
  });

  it('rejects an impossible reservation before inventory or disposable reclaim', async () => {
    const { root, dispose } = await fixture();
    try {
      let scans = 0;
      const quota = new GlobalStorageQuotaReservations(root, {
        availableVolumeBytes: (): bigint => BigInt(256 * MIB),
        scanProfileInventory: async (): ReturnType<typeof inspectProfileStorageOffMain> => {
          scans++;
          return inspectProfileStorageOffMain(root);
        },
      });
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 128 * 1024 });
      await expect(quota.reserve(MIB)).rejects.toThrow(/insufficient unreserved space/);
      expect(scans).toBe(0);
      expect(quota.status()?.activeReservations).toBe(0);
    } finally { await dispose(); }
  });

  it('does not reclaim from a stale policy after a concurrent quota increase', async () => {
    const { root, dispose } = await fixture();
    try {
      let scans = 0;
      const quota = new GlobalStorageQuotaReservations(root, {
        availableVolumeBytes: (): bigint => BigInt(256 * MIB),
        scanProfileInventory: async (): ReturnType<typeof inspectProfileStorageOffMain> => {
          const inventory = await inspectProfileStorageOffMain(root);
          if (++scans === 1) quota.configure({ limitBytes: 8 * MIB, criticalReserveBytes: 128 * 1024 });
          return inventory;
        },
      });
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 128 * 1024 });
      await mkdir(path.join(root, 'logs'));
      const oldLog = path.join(root, 'logs', 'old.log');
      await writeFile(oldLog, Buffer.alloc(690 * 1024));
      const old = new Date('2020-01-01T00:00:00Z');
      await utimes(oldLog, old, old);
      const proof = await quota.reserve(64 * 1024);
      quota.release(proof);
      expect(scans).toBeGreaterThanOrEqual(2);
      expect(existsSync(oldLog)).toBe(true);
    } finally { await dispose(); }
  });

  it('reclaims proactively before the ordinary budget runs out', async () => {
    const { root, dispose } = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root, { availableVolumeBytes: (): bigint => BigInt(256 * MIB) });
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 128 * 1024 });
      await mkdir(path.join(root, 'logs'));
      const oldLog = path.join(root, 'logs', 'old.log');
      await writeFile(oldLog, Buffer.alloc(690 * 1024));
      const old = new Date('2020-01-01T00:00:00Z');
      await utimes(oldLog, old, old);

      await expect(quota.reclaimIfPressured()).resolves.toMatchObject({ removed: 1 });
      await expect(readFile(oldLog)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await dispose(); }
  });

  it('reclaims for an incoming write while preserving an active reservation', async () => {
    const { root, dispose } = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root, { availableVolumeBytes: (): bigint => BigInt(256 * MIB) });
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 400 * 1024 });
      const active = await quota.reserve(32 * 1024);
      await mkdir(path.join(root, 'logs'));
      const oldLog = path.join(root, 'logs', 'old.log');
      await writeFile(oldLog, Buffer.alloc(300 * 1024));
      const old = new Date('2020-01-01T00:00:00Z');
      await utimes(oldLog, old, old);
      const protectedFile = path.join(root, 'protected.bin');
      await writeFile(protectedFile, Buffer.alloc(200 * 1024));

      const proof = await quota.reserve(160 * 1024);
      quota.release(proof);
      expect(quota.status()).toMatchObject({ activeReservations: 1, reservedBytes: active.bytes });
      await writeFile(path.join(root, 'active-output.bin'), Buffer.alloc(active.bytes));
      quota.release(active);
      await expect(readFile(oldLog)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readFile(protectedFile)).byteLength).toBe(200 * 1024);
    } finally { await dispose(); }
  });

  it('atomically honors actual volume free space across competing cooperative reservations', async () => {
    const { root, dispose } = await fixture();
    try {
      const free = BigInt(64 * MIB + 700 * 1024);
      const options = { availableVolumeBytes: (): bigint => free };
      const first = new GlobalStorageQuotaReservations(root, options);
      const second = new GlobalStorageQuotaReservations(root, options);
      first.configure({ limitBytes: 8 * MIB, criticalReserveBytes: 128 * 1024 });
      const proof = await first.reserve(450 * 1024);
      const snapshot = second.status();
      expect(snapshot?.volumeFreeBytes).toBe(Number(free));
      expect(snapshot?.volumeUnreservedBytes).toBe(250 * 1024);
      expect(snapshot?.reservedBytes).toBe(450 * 1024);
      await expect(second.reserve(300 * 1024)).rejects.toThrow(/physical volume headroom/);
      first.release(proof);
      const later = await second.reserve(300 * 1024);
      second.release(later);
    } finally { await dispose(); }
  });

  it('rechecks volume free space inside the atomic admission transaction after the inventory', async () => {
    const { root, dispose } = await fixture();
    try {
      let volumeChecks = 0;
      const quota = new GlobalStorageQuotaReservations(root, {
        availableVolumeBytes: (): bigint => {
          volumeChecks++;
          return volumeChecks === 1 ? BigInt(256 * MIB) : BigInt(64 * MIB);
        },
      });
      quota.configure({ limitBytes: 8 * MIB, criticalReserveBytes: 128 * 1024 });
      await expect(quota.reserve(200 * 1024)).rejects.toThrow(/physical volume headroom/);
      expect(volumeChecks).toBeGreaterThanOrEqual(2);
      expect(quota.status()?.activeReservations).toBe(0);
    } finally { await dispose(); }
  });

  it('refuses a missing or invalid physical space measurement while the quota is enabled', async () => {
    const { root, dispose } = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root, { availableVolumeBytes: (): bigint => -1n });
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 1024 });
      expect(() => quota.status()).toThrow(/physical free space/);
      await expect(quota.reserve(1024)).rejects.toThrow(/physical free space/);
      expect(() => quota.disable()).not.toThrow();
    } finally { await dispose(); }
  });

  it('reclaims eligible old diagnostics even when logical quota is low but volume headroom is tight', async () => {
    const { root, dispose } = await fixture();
    try {
      await mkdir(path.join(root, 'logs'));
      const file = path.join(root, 'logs', 'old.log');
      await writeFile(file, Buffer.alloc(700 * 1024));
      const old = new Date('2020-01-01T00:00:00Z');
      await utimes(file, old, old);
      const quota = new GlobalStorageQuotaReservations(root, {
        availableVolumeBytes: (): bigint => BigInt(64 * MIB + 350 * 1024
          + (existsSync(file) ? 0 : 700 * 1024)),
      });
      quota.configure({ limitBytes: 8 * MIB, criticalReserveBytes: 1024 });
      const proof = await quota.reserve(400 * 1024);
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
      quota.release(proof);
    } finally { await dispose(); }
  });

  it('reclaims more than one bounded batch of old diagnostics when a lowered cap still has pressure', async () => {
    const { root, dispose } = await fixture();
    try {
      await mkdir(path.join(root, 'logs'));
      const old = new Date('2020-01-01T00:00:00Z');
      for (let i = 0; i < 260; i++) {
        const file = path.join(root, 'logs', 'historical-' + i + '.log');
        await writeFile(file, Buffer.alloc(8 * 1024));
        await utimes(file, old, old);
      }
      await mkdir(path.join(root, 'backups'));
      const important = path.join(root, 'backups', 'recovery.sqlite');
      await writeFile(important, 'PROTECTED');
      const quota = new GlobalStorageQuotaReservations(root);
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 64 * 1024 });
      const result = await quota.reclaimIfPressured();
      expect(result?.removed).toBeGreaterThan(128);
      expect(result?.removed).toBeLessThanOrEqual(8 * 128);
      expect((await quota.inspect()).logicalUsedBytes).toBeLessThan(MIB * 0.75);
      expect(await readFile(important, 'utf8')).toBe('PROTECTED');
    } finally { await dispose(); }
  }, 20_000);

  it('retries a blocked reservation after multiple bounded old-log reclaim batches', async () => {
    const { root, dispose } = await fixture();
    try {
      await mkdir(path.join(root, 'diagnostics'));
      const old = new Date('2020-01-01T00:00:00Z');
      for (let i = 0; i < 260; i++) {
        const file = path.join(root, 'diagnostics', 'historical-' + i + '.trace');
        await writeFile(file, Buffer.alloc(8 * 1024));
        await utimes(file, old, old);
      }
      const quota = new GlobalStorageQuotaReservations(root);
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 64 * 1024 });
      const proof = await quota.reserve(200 * 1024);
      expect(proof.bytes).toBe(200 * 1024);
      expect((await quota.inspect()).logicalUsedBytes).toBeLessThan(MIB * 0.75);
      quota.release(proof);
    } finally { await dispose(); }
  }, 20_000);

  it('allows an unconfigured redirected legacy profile to start without enabling its unsafe ledger', async () => {
    const { root, dispose } = await fixture();
    const outer = await fixture();
    try {
      const linked = path.join(outer.root, 'profile-link');
      try { await symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) {
        if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
        throw error;
      }
      const optional = new GlobalStorageQuotaReservations(linked);
      expect(optional.status()).toBeNull();
      expect(() => optional.configure({ limitBytes: MIB, criticalReserveBytes: 1024 }))
        .toThrow(/non-redirected profile root/);
    } finally { await outer.dispose(); await dispose(); }
  });

  it('enables and disables explicitly, rejecting disable while a live writer owns a reservation', async () => {
    const { root, dispose } = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root);
      expect(quota.status()).toBeNull();
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 128 * 1024 });
      expect(quota.status()?.policy.limitBytes).toBe(MIB);
      const lease = await quota.reserve(12 * 1024);
      expect(quota.status()?.activeReservations).toBe(1);
      expect(() => quota.disable()).toThrow(/Active global quota reservations/);
      quota.release(lease);
      quota.disable();
      expect(quota.status()).toBeNull();
      await expect(quota.reserve(1)).rejects.toThrow(/not configured/);
    } finally { await dispose(); }
  });

  it('automatically reclaims only verified old diagnostics when a reservation nears the cap', async () => {
    const { root, dispose } = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root);
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 96 * 1024 });
      await mkdir(path.join(root, 'logs'));
      const oldLog = path.join(root, 'logs', 'old-diagnostic.log');
      await writeFile(oldLog, Buffer.alloc(720 * 1024));
      const old = new Date('2020-01-01T00:00:00Z');
      await utimes(oldLog, old, old);
      await mkdir(path.join(root, 'backups'));
      const protectedFile = path.join(root, 'backups', 'keep.sqlite');
      await writeFile(protectedFile, Buffer.alloc(10 * 1024));
      const proof = await quota.reserve(350 * 1024);
      expect(proof.bytes).toBe(350 * 1024);
      await expect(readFile(oldLog)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readFile(protectedFile)).byteLength).toBe(10 * 1024);
      quota.release(proof);
    } finally { await dispose(); }
  });

  it('admits only within a verified complete logical inventory and preserves a critical reserve', async () => {
    const { root, dispose } = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root);
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 128 * 1024 });
      await mkdir(path.join(root, 'workspace-index'));
      await writeFile(path.join(root, 'workspace-index', 'cache.dat'), Buffer.alloc(200 * 1024));
      const first = await quota.reserve(400 * 1024);
      const snapshot = await quota.inspect();
      expect(snapshot.policy.limitBytes).toBe(MIB);
      expect(snapshot.logicalUsedBytes).toBeGreaterThanOrEqual(200 * 1024);
      expect(snapshot.reservedBytes).toBe(400 * 1024);
      expect(snapshot.ordinaryAvailableBytes).toBeLessThan(400 * 1024);
      await expect(quota.reserve(400 * 1024)).rejects.toThrow(/insufficient unreserved/);
      quota.release(first);
      await expect(quota.reserve(400 * 1024)).resolves.toMatchObject({ bytes: 400 * 1024 });
      expect((await readFile(path.join(root, 'workspace-index', 'cache.dat'))).length).toBe(200 * 1024);
    } finally { await dispose(); }
  });

  it('serializes independent clients sharing a ledger so reservations cannot overcommit', async () => {
    const { root, dispose } = await fixture();
    try {
      const first = new GlobalStorageQuotaReservations(root);
      const second = new GlobalStorageQuotaReservations(root);
      first.configure({ limitBytes: 600 * 1024, criticalReserveBytes: 50 * 1024 });
      const results = await Promise.allSettled([first.reserve(350 * 1024), second.reserve(350 * 1024)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const proof = results.find((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof first.reserve>>> => r.status === 'fulfilled')!.value;
      expect((await second.inspect()).reservedBytes).toBe(350 * 1024);
      second.release(proof);
      expect((await first.inspect()).reservedBytes).toBe(0);
    } finally { await dispose(); }
  });

  it('reclaims only reservations held by a definitely terminated process', async () => {
    const { root, dispose } = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root);
      quota.configure({ limitBytes: 500 * 1024, criticalReserveBytes: 50 * 1024 });
      const proof = await quota.reserve(128 * 1024);
      const ledger = path.join(root, 'global-quota-reservations-v2.sqlite');
      await departedOwner(ledger, 160 * 1024);
      expect((await quota.inspect()).reservedBytes).toBe(128 * 1024);
      expect(() => quota.release({ ...proof, token: randomUUID() })).toThrow(/invalid ownership/);
      expect((await quota.inspect()).reservedBytes).toBe(128 * 1024);
      quota.release(proof);
    } finally { await dispose(); }
  });

  it('fails closed on incomplete inventories, without following a junction or deleting the outside file', async () => {
    const { root, dispose } = await fixture();
    const outside = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root);
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 16 * 1024 });
      await writeFile(path.join(outside.root, 'private.dat'), 'user-data');
      try { await symlink(outside.root, path.join(root, 'outside'),
        process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) {
        if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
        throw error;
      }
      await expect(quota.reserve(16 * 1024)).rejects.toThrow(/complete profile inventory/);
      expect(await readFile(path.join(outside.root, 'private.dat'), 'utf8')).toBe('user-data');
    } finally { await dispose(); await outside.dispose(); }
  });

  it('rejects malformed policies, unsafe roots, and large impossible reservations', async () => {
    const { root, dispose } = await fixture();
    try {
      expect(() => new GlobalStorageQuotaReservations('relative-profile')).toThrow(/absolute/);
      const quota = new GlobalStorageQuotaReservations(root);
      expect(() => quota.configure({ limitBytes: 200, criticalReserveBytes: 200 })).toThrow(/Invalid/);
      await expect(quota.reserve(1)).rejects.toThrow(/not configured/);
      quota.configure({ limitBytes: 16 * 1024, criticalReserveBytes: 1024 });
      await expect(quota.reserve(MIB)).rejects.toThrow(/insufficient unreserved/);
      await expect(quota.reserve(0)).rejects.toThrow(/Invalid/);
    } finally { await dispose(); }
  });
});
