import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectProfileStorageOffMain, type ProfileStorageInventory } from './profile-storage-inventory.js';
import { reclaimExpiredDisposableFiles, type DisposableReclaimResult } from './global-storage-reclaim.js';

/**
 * Opt-in foundation for a future app-managed quota. This ledger serializes
 * cooperating reservations across processes. It does NOT enforce a physical
 * filesystem limit or govern writers which have not been integrated.
 */
export interface GlobalQuotaPolicy {
  readonly limitBytes: number;
  /** Kept unavailable to ordinary (non-critical) reservations. */
  readonly criticalReserveBytes: number;
}

export interface GlobalQuotaReservation {
  readonly id: string;
  /** Bearer proof; never log or persist outside the caller. */
  readonly token: string;
  readonly bytes: number;
}

export interface GlobalQuotaLedgerStatus {
  readonly policy: GlobalQuotaPolicy;
  readonly reservedBytes: number;
  readonly activeReservations: number;
}

export interface GlobalQuotaSnapshot {
  readonly policy: GlobalQuotaPolicy;
  readonly logicalUsedBytes: number;
  readonly reservedBytes: number;
  readonly ordinaryAvailableBytes: number;
  readonly inventory: ProfileStorageInventory;
}

interface QuotaStateRow { revision: number; limit_bytes: number; reserve_bytes: number }
interface ReservationRow { id: string; token_hash: string; owner_pid: number; bytes: number }
const MAX_RESERVATIONS = 2048;
const MAX_SCAN_ATTEMPTS = 4;
const LEDGER_FILE = 'global-quota-reservations-v2.sqlite';

function safeBytes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertPolicy(policy: GlobalQuotaPolicy): void {
  if (!safeBytes(policy.limitBytes) || policy.limitBytes === 0
    || !safeBytes(policy.criticalReserveBytes) || policy.criticalReserveBytes >= policy.limitBytes) {
    throw new Error('Invalid global storage quota policy');
  }
}

function ownerDefinitelyDead(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sameToken(storedHash: string, token: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(hashToken(token), 'hex'));
}

export class GlobalStorageQuotaReservations {
  private readonly root: string;
  private readonly ledgerFilename: string;

  public constructor(profileRoot: string) {
    if (!path.isAbsolute(profileRoot)) throw new Error('Global quota profile root must be absolute');
    this.root = path.resolve(profileRoot);
    this.ledgerFilename = path.join(this.root, LEDGER_FILE);
    this.assertRoot();
  }

  /** Cheap metadata-only status. No profile scan and no file creation while disabled. */
  public status(): GlobalQuotaLedgerStatus | null {
    this.assertRoot();
    if (!existsSync(this.ledgerFilename)) return null;
    // A Settings refresh must not open a writer or run CREATE TABLE statements.
    const db = new DatabaseSync(this.ledgerFilename, { readOnly: true, timeout: 250 });
    try {
      const state = this.state(db);
      if (state === undefined) return null;
      const totals = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM quota_reservations')
        .get() as { count: number; bytes: number };
      if (!safeBytes(totals.bytes) || !safeBytes(totals.count)) throw new Error('Invalid quota ledger totals');
      return {
        policy: { limitBytes: state.limit_bytes, criticalReserveBytes: state.reserve_bytes },
        reservedBytes: totals.bytes,
        activeReservations: totals.count,
      };
    } finally { db.close(); }
  }

  /**
   * Bounded proactive maintenance: only old diagnostic/log files are eligible.
   * Never delete on an incomplete scan or after another process changes policy.
   * Removing a file only reports logical size; NTFS physical savings remain unknown.
   */
  public async reclaimIfPressured(): Promise<DisposableReclaimResult | null> {
    const before = this.status();
    if (before === null) return null;
    const inventory = await this.completeInventory();
    const current = this.status();
    if (current === null || current.policy.limitBytes !== before.policy.limitBytes
      || current.policy.criticalReserveBytes !== before.policy.criticalReserveBytes) return null;
    if (inventory.logicalBytes + current.reservedBytes < current.policy.limitBytes * 0.75) return null;
    return reclaimExpiredDisposableFiles(this.root);
  }

  /** Disabling is explicit and cannot orphan live reservations. */
  public disable(): void {
    if (!existsSync(this.ledgerFilename)) return;
    this.transaction((db) => {
      this.reapDeadOwners(db);
      const count = (db.prepare('SELECT COUNT(*) AS count FROM quota_reservations').get() as { count: number }).count;
      if (count > 0) throw new Error('Active global quota reservations must finish before disabling');
      db.prepare('DELETE FROM quota_state WHERE id=1').run();
    });
  }

  /** Explicit opt-in; not wired to the normal SQLite limit or user settings. */
  public configure(policy: GlobalQuotaPolicy): void {
    assertPolicy(policy);
    this.transaction((db) => {
      const previous = this.state(db);
      db.prepare(`INSERT INTO quota_state (id,revision,limit_bytes,reserve_bytes)
        VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET
        revision=excluded.revision,limit_bytes=excluded.limit_bytes,reserve_bytes=excluded.reserve_bytes`)
        .run((previous?.revision ?? 0) + 1, policy.limitBytes, policy.criticalReserveBytes);
    });
  }

  /**
   * Reserve against a COMPLETE metadata inventory. A ledger revision change
   * while scanning forces a fresh scan; incomplete scans fail closed.
   *
   * This is deliberately a low-frequency API: a full profile walk per
   * admission is not acceptable for per-line logs or hot SQLite writes.
   * Future production integration requires incremental accounting.
   */
  public async reserve(bytes: number): Promise<GlobalQuotaReservation> {
    if (!safeBytes(bytes) || bytes === 0) throw new Error('Invalid quota reservation size');
    let reclaimAttempted = false;
    for (let attempt = 0; attempt < MAX_SCAN_ATTEMPTS; attempt++) {
      const initial = this.transaction((db) => {
        this.reapDeadOwners(db);
        const state = this.state(db);
        if (state === undefined) throw new Error('Global quota not configured');
        const reserved = (db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM quota_reservations')
          .get() as { total: number }).total;
        if (!safeBytes(reserved)) throw new Error('Invalid global quota reserved size');
        return { ...state, reserved };
      });
      const inventory = await this.completeInventory();
      // Only after a complete inventory, and only for old disposable logs.
      // A second inventory is required if any file is actually removed.
      if (!reclaimAttempted && inventory.logicalBytes + initial.reserved + bytes >= initial.limit_bytes * 0.75) {
        reclaimAttempted = true;
        const reclaimed = await reclaimExpiredDisposableFiles(this.root);
        if (reclaimed.removed > 0) continue;
      }
      const token = randomUUID() + randomUUID();
      const id = randomUUID();
      const decision = this.transaction((db): 'retry' | 'admitted' => {
        if (this.reapDeadOwners(db)) return 'retry';
        const state = this.state(db);
        if (state?.revision !== initial.revision) return 'retry';
        const rows = db.prepare('SELECT id,token_hash,owner_pid,bytes FROM quota_reservations').all() as unknown as ReservationRow[];
        if (rows.length >= MAX_RESERVATIONS) throw new Error('Global quota has too many active reservations');
        const reserved = rows.reduce((sum, row) => sum + row.bytes, 0);
        const planned = inventory.logicalBytes + reserved + bytes + state.reserve_bytes;
        if (!Number.isSafeInteger(planned) || planned > state.limit_bytes) {
          throw new Error('Global storage quota has insufficient unreserved space');
        }
        db.prepare('INSERT INTO quota_reservations (id,token_hash,owner_pid,bytes) VALUES (?,?,?,?)')
          .run(id, hashToken(token), process.pid, bytes);
        db.prepare('UPDATE quota_state SET revision=revision+1 WHERE id=1').run();
        return 'admitted';
      });
      if (decision === 'admitted') return { id, token, bytes };
    }
    throw new Error('Global quota admission changed during inventory; retry when writers are idle');
  }

  /** Release only AFTER the associated write has stopped and reached a terminal state. */
  public release(reservation: GlobalQuotaReservation): void {
    if (!reservation || typeof reservation.id !== 'string' || typeof reservation.token !== 'string'
      || !safeBytes(reservation.bytes)) throw new Error('Invalid global quota reservation proof');
    this.transaction((db) => {
      const row = db.prepare('SELECT id,token_hash,owner_pid,bytes FROM quota_reservations WHERE id=?')
        .get(reservation.id) as ReservationRow | undefined;
      if (row === undefined || row.owner_pid !== process.pid || row.bytes !== reservation.bytes
        || !sameToken(row.token_hash, reservation.token)) {
        throw new Error('Global quota reservation is missing or has invalid ownership');
      }
      db.prepare('DELETE FROM quota_reservations WHERE id=?').run(row.id);
      db.prepare('UPDATE quota_state SET revision=revision+1 WHERE id=1').run();
    });
  }

  public async inspect(): Promise<GlobalQuotaSnapshot> {
    for (let attempt = 0; attempt < MAX_SCAN_ATTEMPTS; attempt++) {
      const initial = this.transaction((db) => {
        this.reapDeadOwners(db);
        const state = this.state(db);
        if (state === undefined) throw new Error('Global quota not configured');
        return state;
      });
      const inventory = await this.completeInventory();
      const result = this.transaction((db) => {
        if (this.reapDeadOwners(db)) return null;
        const state = this.state(db);
        if (state?.revision !== initial.revision) return null;
        const reserved = (db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM quota_reservations')
          .get() as { total: number }).total;
        if (!safeBytes(reserved)) throw new Error('Invalid global quota reservation ledger');
        return {
          policy: { limitBytes: state.limit_bytes, criticalReserveBytes: state.reserve_bytes },
          logicalUsedBytes: inventory.logicalBytes,
          reservedBytes: reserved,
          ordinaryAvailableBytes: Math.max(0,
            state.limit_bytes - state.reserve_bytes - inventory.logicalBytes - reserved),
          inventory,
        };
      });
      if (result !== null) return result;
    }
    throw new Error('Global quota inventory changed during inspection');
  }

  private async completeInventory(): Promise<ProfileStorageInventory> {
    const inventory = await inspectProfileStorageOffMain(this.root, {
      maxEntries: 200_000, maxDurationMs: 15_000,
    });
    if (inventory.incomplete || inventory.allocatedBytes !== null && !safeBytes(inventory.allocatedBytes)) {
      throw new Error('Global quota cannot admit writes without a complete profile inventory');
    }
    return inventory;
  }

  private assertRoot(): void {
    const info = lstatSync(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform === 'win32'
      ? realpathSync(this.root).toLowerCase() !== this.root.toLowerCase()
      : realpathSync(this.root) !== this.root)) {
      throw new Error('Global quota requires a direct, non-redirected profile root');
    }
    try {
      const ledger = lstatSync(this.ledgerFilename);
      if (!ledger.isFile() || ledger.isSymbolicLink()) throw new Error('Quota ledger path is redirected');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private withDatabase<T>(callback: (db: DatabaseSync) => T): T {
    this.assertRoot();
    const db = new DatabaseSync(this.ledgerFilename, { timeout: 3000 });
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS quota_state (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
        limit_bytes INTEGER NOT NULL, reserve_bytes INTEGER NOT NULL
      ); CREATE TABLE IF NOT EXISTS quota_reservations (
        id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL,
        owner_pid INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0)
      );`);
      return callback(db);
    } finally { db.close(); }
  }

  private transaction<T>(callback: (db: DatabaseSync) => T): T {
    return this.withDatabase((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = callback(db);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* preserve the earlier error */ }
        throw error;
      }
    });
  }

  private state(db: DatabaseSync): QuotaStateRow | undefined {
    return db.prepare('SELECT revision,limit_bytes,reserve_bytes FROM quota_state WHERE id=1')
      .get() as QuotaStateRow | undefined;
  }

  private reapDeadOwners(db: DatabaseSync): boolean {
    const rows = db.prepare('SELECT id,owner_pid FROM quota_reservations').all() as Array<{ id: string; owner_pid: number }>;
    const dead = rows.filter((row) => ownerDefinitelyDead(row.owner_pid));
    if (dead.length === 0) return false;
    const remove = db.prepare('DELETE FROM quota_reservations WHERE id=? AND owner_pid=?');
    for (const row of dead) remove.run(row.id, row.owner_pid);
    db.prepare('UPDATE quota_state SET revision=revision+1 WHERE id=1').run();
    return true;
  }
}
