import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { GlobalStorageQuotaReservations } from './global-storage-quota.js';
import { probeQuotaProcessIdentity } from './quota-process-identity.js';

const MIB = 1024 * 1024;
const CURRENT_START = '639037120000000000';
const STALE_START = '639000000000000000';

async function fixture(): Promise<{ root: string; ledger: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-owner-proof-'));
  return {
    root,
    ledger: path.join(root, 'global-quota-reservations-v2.sqlite'),
    dispose: async (): Promise<void> => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

function injectReservation(ledger: string, ownerStart: string | null, bytes = 100 * 1024, pid = process.pid): {
  id: string; token: string; bytes: number;
} {
  const db = new DatabaseSync(ledger);
  const id = randomUUID();
  const token = randomUUID();
  try {
    db.prepare('INSERT INTO quota_reservations (id,token_hash,owner_pid,bytes,owner_started_at) VALUES (?,?,?,?,?)')
      .run(id, createHash('sha256').update(token).digest('hex'), pid, bytes, ownerStart);
    db.prepare('UPDATE quota_state SET revision=revision+1 WHERE id=1').run();
    return { id, token, bytes };
  } finally { db.close(); }
}

describe('quota reservation process-generation crash reconciliation', () => {
  it('reaps a stale owner when the PID was recycled, even if that PID is currently alive', async () => {
    const { root, ledger, dispose } = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root, {
        probeProcessIdentity: async (): Promise<{ state: 'live'; startedAt: string }> =>
          ({ state: 'live', startedAt: CURRENT_START }),
      });
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 64 * 1024 });
      injectReservation(ledger, STALE_START, 500 * 1024);
      expect(quota.status()?.reservedBytes).toBe(500 * 1024);
      const proof = await quota.reserve(500 * 1024);
      const persisted = new DatabaseSync(ledger, { readOnly: true });
      try {
        const row = persisted.prepare('SELECT owner_started_at FROM quota_reservations WHERE id=?')
          .get(proof.id) as { owner_started_at: string } | undefined;
        expect(row?.owner_started_at).toBe(CURRENT_START);
      } finally { persisted.close(); }
      expect(quota.status()).toMatchObject({ reservedBytes: 500 * 1024, activeReservations: 1 });
      quota.release(proof);
    } finally { await dispose(); }
  });

  it('retains a live matching owner and an unverifiable owner, never deleting either by age alone', async () => {
    const { root, ledger, dispose } = await fixture();
    try {
      const quota = new GlobalStorageQuotaReservations(root, {
        probeProcessIdentity: async (): Promise<{ state: 'live'; startedAt: string }> =>
          ({ state: 'live', startedAt: CURRENT_START }),
      });
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 64 * 1024 });
      const live = injectReservation(ledger, CURRENT_START, 80 * 1024);
      const proof = await quota.reserve(120 * 1024);
      expect(quota.status()?.reservedBytes).toBe(200 * 1024);
      quota.release(proof);
      quota.release(live);

      const conservative = new GlobalStorageQuotaReservations(root, {
        probeProcessIdentity: async (): Promise<{ state: 'unverifiable' }> => ({ state: 'unverifiable' }),
      });
      const unknown = injectReservation(ledger, STALE_START, 100 * 1024);
      const kept = await conservative.reserve(50 * 1024);
      expect(conservative.status()?.reservedBytes).toBe(150 * 1024);
      conservative.release(kept);
      conservative.release(unknown);
    } finally { await dispose(); }
  });

  it('upgrades a legacy ledger without dropping existing reservations or changing their proofs', async () => {
    const { root, ledger, dispose } = await fixture();
    try {
      const db = new DatabaseSync(ledger);
      const id = randomUUID();
      const token = randomUUID();
      try {
        db.exec(`CREATE TABLE quota_state (
          id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
          limit_bytes INTEGER NOT NULL, reserve_bytes INTEGER NOT NULL
        ); CREATE TABLE quota_reservations (
          id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL,
          owner_pid INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0)
        );`);
        db.prepare('INSERT INTO quota_reservations (id,token_hash,owner_pid,bytes) VALUES (?,?,?,?)')
          .run(id, createHash('sha256').update(token).digest('hex'), process.pid, 88 * 1024);
      } finally { db.close(); }

      const quota = new GlobalStorageQuotaReservations(root, {
        probeProcessIdentity: async (): Promise<{ state: 'live'; startedAt: string }> =>
          ({ state: 'live', startedAt: CURRENT_START }),
      });
      quota.configure({ limitBytes: MIB, criticalReserveBytes: 64 * 1024 });
      expect(quota.status()?.reservedBytes).toBe(88 * 1024);
      const lease = await quota.reserve(130 * 1024);
      expect(quota.status()?.reservedBytes).toBe(218 * 1024);
      quota.release(lease);
      quota.release({ id, token, bytes: 88 * 1024 });
      expect(quota.status()?.reservedBytes).toBe(0);
      const verify = new DatabaseSync(ledger, { readOnly: true });
      try {
        const columns = verify.prepare('PRAGMA table_info(quota_reservations)').all() as Array<{ name: string }>;
        expect(columns.some((item) => item.name === 'owner_started_at')).toBe(true);
      } finally { verify.close(); }
    } finally { await dispose(); }
  });

  it('holds a real live child reservation, then frees its claim after the child crashes', async () => {
    if (process.platform !== 'win32') return;
    const { root, ledger, dispose } = await fixture();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      const observed = await probeQuotaProcessIdentity(child.pid!);
      expect(observed.state).toBe('live');
      if (observed.state !== 'live') return;
      const quota = new GlobalStorageQuotaReservations(root);
      quota.configure({ limitBytes: 700 * 1024, criticalReserveBytes: 64 * 1024 });
      injectReservation(ledger, observed.startedAt, 430 * 1024, child.pid!);
      const active = await quota.reserve(60 * 1024);
      expect(quota.status()?.reservedBytes).toBe(490 * 1024);
      quota.release(active);
      child.kill();
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
      const recovered = await quota.reserve(300 * 1024);
      expect(quota.status()?.reservedBytes).toBe(300 * 1024);
      quota.release(recovered);
    } finally {
      if (child.exitCode === null) child.kill();
      await dispose();
    }
  }, 25_000);

  it('probes the current Windows process creation identity without guessing a wall clock', async () => {
    expect(await probeQuotaProcessIdentity(0)).toEqual({ state: 'unverifiable' });
    if (process.platform !== 'win32') return;
    const proof = await probeQuotaProcessIdentity(process.pid);
    expect(proof.state).toBe('live');
    if (proof.state === 'live') expect(proof.startedAt).toMatch(/^\d{15,19}$/);
  }, 15_000);
});
