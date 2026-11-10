import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectProfileStorageOffMain, type ProfileStorageInventory } from './profile-storage-inventory.js';
import { coalesceQuotaInventory } from './global-quota-inventory-coalescer.js';
import { reclaimExpiredDisposableFiles, type DisposableReclaimResult } from './global-storage-reclaim.js';
import { probeQuotaProcessIdentities, probeQuotaProcessIdentity, validQuotaProcessStart, type QuotaProcessIdentity } from './quota-process-identity.js';

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
  /** Volume-level OS free bytes, not bytes attributed to this application's files. */
  readonly volumeFreeBytes: number;
  /** Free bytes after other cooperative reservations and critical safety margin. */
  readonly volumeUnreservedBytes: number;
}

export interface GlobalQuotaSnapshot {
  readonly policy: GlobalQuotaPolicy;
  readonly logicalUsedBytes: number;
  readonly reservedBytes: number;
  readonly ordinaryAvailableBytes: number;
  readonly volumeFreeBytes: number;
  readonly volumeUnreservedBytes: number;
  readonly inventory: ProfileStorageInventory;
}

interface QuotaStateRow { revision: number; limit_bytes: number; reserve_bytes: number }
interface ReservationRow { id: string; token_hash: string; owner_pid: number; bytes: number; owner_started_at: string | null }
const MAX_RESERVATIONS = 2048;
const MAX_IDENTITY_PROBES_PER_ADMISSION = 8;
let cachedOwnProcessIdentity: Promise<QuotaProcessIdentity> | null = null;
const MAX_SCAN_ATTEMPTS = 4;
/** Maximum 8 × 128 verified old disposable files per pressure event. */
const MAX_PRESSURE_RECLAIM_BATCHES = 8;
const RECLAIM_USAGE_RATIO = 0.75;
const LEDGER_FILE = 'global-quota-reservations-v2.sqlite';
/** Space other software, SQLite journaling and native helpers may still need. */
const MIN_VOLUME_RESERVE_BYTES = 64 * 1024 * 1024;

/** For deterministic fake-volume tests; production always reads the real OS volume. */
export interface GlobalQuotaVolumeOptions {
  readonly availableVolumeBytes?: () => bigint;
  /** Test seam. Production uses verified OS process creation identity on Windows. */
  readonly probeProcessIdentity?: (pid: number) => Promise<QuotaProcessIdentity>;
  /** Deterministic test seam. Production always uses the off-main bounded profile inventory worker. */
  readonly scanProfileInventory?: () => Promise<ProfileStorageInventory>;
  /** Test-only liveness seam; production never assumes a PID is dead without ESRCH. */
  readonly ownerDefinitelyDead?: (pid: number) => boolean;
}

function realVolumeFreeBytes(root: string): bigint {
  const fs = statfsSync(root, { bigint: true });
  if (fs.bsize <= 0n || fs.bavail < 0n) throw new Error('Global quota volume capacity is invalid');
  return fs.bsize * fs.bavail;
}

function safeVolumeFreeBytes(freeBytes: bigint): bigint {
  if (typeof freeBytes !== 'bigint' || freeBytes < 0n) {
    throw new Error('Global quota physical free space is unavailable');
  }
  return freeBytes;
}

function displayBytes(bytes: bigint): number {
  return Number(bytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bytes);
}

function volumeHeadroom(freeBytes: bigint, reservedBytes: number, criticalReserveBytes: number): bigint {
  const safety = BigInt(Math.max(criticalReserveBytes, MIN_VOLUME_RESERVE_BYTES));
  const headroom = freeBytes - BigInt(reservedBytes) - safety;
  return headroom > 0n ? headroom : 0n;
}

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
  private readonly getAvailableVolumeBytes: () => bigint;
  private readonly probeProcessIdentity: (pid: number) => Promise<QuotaProcessIdentity>;
  private readonly scanProfileInventory: () => Promise<ProfileStorageInventory>;
  private readonly isOwnerDefinitelyDead: (pid: number) => boolean;
  /** Advances past verified live owners so later recycled PID leases cannot starve. */
  private identityProbeCursor: { readonly owner_pid: number; readonly owner_started_at: string } | null = null;
  private ownerIdentityPromise: Promise<string | null> | null = null;

  public constructor(profileRoot: string, options: GlobalQuotaVolumeOptions = {}) {
    if (!path.isAbsolute(profileRoot)) throw new Error('Global quota profile root must be absolute');
    this.root = path.resolve(profileRoot);
    this.ledgerFilename = path.join(this.root, LEDGER_FILE);
    this.getAvailableVolumeBytes = options.availableVolumeBytes ?? ((): bigint => realVolumeFreeBytes(this.root));
    this.probeProcessIdentity = options.probeProcessIdentity ?? probeQuotaProcessIdentity;
    this.isOwnerDefinitelyDead = options.ownerDefinitelyDead ?? ownerDefinitelyDead;
    this.scanProfileInventory = options.scanProfileInventory ?? ((): Promise<ProfileStorageInventory> => inspectProfileStorageOffMain(this.root, {
      maxEntries: 200_000, maxDurationMs: 15_000,
    }));
    // Never reject legacy or redirected profile paths merely because the
    // optional quota feature has not been enabled. Validate before any ledger I/O.
  }

  /** Cheap metadata-only status. No profile scan and no file creation while disabled. */
  public status(): GlobalQuotaLedgerStatus | null {
    if (!existsSync(this.ledgerFilename)) return null;
    this.assertRoot();
    // A Settings refresh must not open a writer or run CREATE TABLE statements.
    const db = new DatabaseSync(this.ledgerFilename, { readOnly: true, timeout: 250 });
    try {
      const state = this.state(db);
      if (state === undefined) return null;
      const totals = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM quota_reservations')
        .get() as { count: number; bytes: number };
      if (!safeBytes(totals.bytes) || !safeBytes(totals.count)) throw new Error('Invalid quota ledger totals');
      const freeBytes = safeVolumeFreeBytes(this.getAvailableVolumeBytes());
      return {
        policy: { limitBytes: state.limit_bytes, criticalReserveBytes: state.reserve_bytes },
        reservedBytes: totals.bytes,
        activeReservations: totals.count,
        volumeFreeBytes: displayBytes(freeBytes),
        volumeUnreservedBytes: displayBytes(volumeHeadroom(freeBytes, totals.bytes, state.reserve_bytes)),
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
    const reclaimThreshold = (current.policy.limitBytes - current.policy.criticalReserveBytes) * RECLAIM_USAGE_RATIO;
    const lowVolumeSpace = volumeHeadroom(
      safeVolumeFreeBytes(this.getAvailableVolumeBytes()),
      current.reservedBytes, current.policy.criticalReserveBytes,
    ) < BigInt(MIN_VOLUME_RESERVE_BYTES);
    if (inventory.logicalBytes + current.reservedBytes < reclaimThreshold
      && !lowVolumeSpace) return null;
    let removedLogicalBytes = 0;
    let inspected = 0;
    let removed = 0;
    let truncated = false;
    for (let batch = 0; batch < MAX_PRESSURE_RECLAIM_BATCHES; batch++) {
      // Re-read the live policy and actual volume capacity between bounded
      // batches: disabling quota or reaching the target stops deletion.
      const currentStatus = this.status();
      if (currentStatus === null || currentStatus.policy.limitBytes !== before.policy.limitBytes
        || currentStatus.policy.criticalReserveBytes !== before.policy.criticalReserveBytes) break;
      const physicalPressure = volumeHeadroom(
        safeVolumeFreeBytes(this.getAvailableVolumeBytes()),
        currentStatus.reservedBytes, currentStatus.policy.criticalReserveBytes,
      ) < BigInt(MIN_VOLUME_RESERVE_BYTES);
      if (inventory.logicalBytes - removedLogicalBytes + currentStatus.reservedBytes
          < reclaimThreshold && !physicalPressure) break;
      const result = await reclaimExpiredDisposableFiles(this.root);
      inspected += result.inspected;
      removed += result.removed;
      removedLogicalBytes += result.removedLogicalBytes;
      truncated ||= result.truncated;
      if (result.removed === 0 || !result.truncated) break;
    }
    return { inspected, removed, removedLogicalBytes, truncated };
  }

  /** Disabling is explicit and cannot orphan live reservations. */
  public disable(): void {
    if (!existsSync(this.ledgerFilename)) return;
    this.transaction((db) => {
      this.reapDeadOwners(db);
      const count = (db.prepare('SELECT COUNT(*) AS count FROM quota_reservations').get() as { count: number }).count;
      if (count > 0) throw new Error('Active global quota reservations must finish before disabling');
      // Preserve the monotonic generation across OFF -> ON transitions.
      // Deleting this row allowed a concurrent admission to observe revision
      // N before and after a disable/re-enable, falsely accepting a stale scan.
      db.prepare('UPDATE quota_state SET revision=revision+1,limit_bytes=0,reserve_bytes=0 WHERE id=1').run();
    });
  }

  /** Explicit opt-in; not wired to the normal SQLite limit or user settings. */
  public configure(policy: GlobalQuotaPolicy): void {
    assertPolicy(policy);
    this.transaction((db) => {
      const previous = this.rawState(db);
      if (previous !== undefined && (!safeBytes(previous.revision)
        || previous.revision >= Number.MAX_SAFE_INTEGER)) {
        throw new Error('Global quota revision is invalid');
      }
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
    // Probe outside SQLite transactions. Never block the ledger write lock on PowerShell.
    await this.reconcileStaleIdentities();
    const ownerStart = await this.currentOwnerStart();
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
      // Shared only while a revision-matched scan is actively running.
      // Never reuse across a release, a new writer, or a policy change.
      const inventory = await this.completeInventory(initial.revision);
      const ordinaryBudget = initial.limit_bytes - initial.reserve_bytes;
      const reclaimThreshold = ordinaryBudget * RECLAIM_USAGE_RATIO;
      // Only after a complete inventory, and only for old disposable logs.
      // A second inventory is required if any file is actually removed.
      const physicalPressure = volumeHeadroom(
        safeVolumeFreeBytes(this.getAvailableVolumeBytes()),
        initial.reserved, initial.reserve_bytes,
      ) < BigInt(bytes) + BigInt(MIN_VOLUME_RESERVE_BYTES);
      if (!reclaimAttempted && (inventory.logicalBytes + initial.reserved + bytes >= reclaimThreshold
        || physicalPressure)) {
        reclaimAttempted = true;
        let removedLogicalBytes = 0;
        for (let batch = 0; batch < MAX_PRESSURE_RECLAIM_BATCHES; batch++) {
          // Delete only as much verified old disposable data as necessary to
          // recover the proactive threshold and requested volume headroom.
          const volumeAvailable = volumeHeadroom(
            safeVolumeFreeBytes(this.getAvailableVolumeBytes()),
            initial.reserved, initial.reserve_bytes,
          );
          if (inventory.logicalBytes - removedLogicalBytes + initial.reserved + bytes
            < reclaimThreshold
            && volumeAvailable >= BigInt(bytes) + BigInt(MIN_VOLUME_RESERVE_BYTES)) break;
          const reclaimed = await reclaimExpiredDisposableFiles(this.root);
          removedLogicalBytes += reclaimed.removedLogicalBytes;
          if (reclaimed.removed === 0 || !reclaimed.truncated) break;
        }
        if (removedLogicalBytes > 0) continue;
      }
      const token = randomUUID() + randomUUID();
      const id = randomUUID();
      const decision = this.transaction((db): 'retry' | 'admitted' => {
        if (this.reapDeadOwners(db)) return 'retry';
        const state = this.state(db);
        if (state?.revision !== initial.revision) return 'retry';
        const rows = db.prepare('SELECT id,token_hash,owner_pid,bytes,owner_started_at FROM quota_reservations').all() as unknown as ReservationRow[];
        if (rows.length >= MAX_RESERVATIONS) throw new Error('Global quota has too many active reservations');
        const reserved = rows.reduce((sum, row) => sum + row.bytes, 0);
        const planned = inventory.logicalBytes + reserved + bytes + state.reserve_bytes;
        if (!Number.isSafeInteger(planned) || planned > state.limit_bytes) {
          throw new Error('Global storage quota has insufficient unreserved space');
        }
        // Reserve actual volume headroom against competing *cooperative*
        // writers as well as the profile budget. This does not constrain
        // arbitrary external writers or OS disk allocations during a copy.
        const freeBytes = safeVolumeFreeBytes(this.getAvailableVolumeBytes());
        if (BigInt(bytes) > volumeHeadroom(freeBytes, reserved, state.reserve_bytes)) {
          throw new Error('Global storage quota has insufficient physical volume headroom');
        }
        db.prepare('INSERT INTO quota_reservations (id,token_hash,owner_pid,bytes,owner_started_at) VALUES (?,?,?,?,?)')
          .run(id, hashToken(token), process.pid, bytes, ownerStart);
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
      const row = db.prepare('SELECT id,token_hash,owner_pid,bytes,owner_started_at FROM quota_reservations WHERE id=?')
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
        const freeBytes = safeVolumeFreeBytes(this.getAvailableVolumeBytes());
        return {
          policy: { limitBytes: state.limit_bytes, criticalReserveBytes: state.reserve_bytes },
          logicalUsedBytes: inventory.logicalBytes,
          reservedBytes: reserved,
          volumeFreeBytes: displayBytes(freeBytes),
          volumeUnreservedBytes: displayBytes(volumeHeadroom(freeBytes, reserved, state.reserve_bytes)),
          ordinaryAvailableBytes: Math.max(0,
            state.limit_bytes - state.reserve_bytes - inventory.logicalBytes - reserved),
          inventory,
        };
      });
      if (result !== null) return result;
    }
    throw new Error('Global quota inventory changed during inspection');
  }

  /**
   * Probe identities *outside* the SQLite write transaction, then delete
   * only unchanged, verified-stale owner generations under BEGIN IMMEDIATE.
   * A failed/slow probe must not delete a live or unverifiable writer lease.
   *
   * The cap avoids launching an unbounded number of Windows process probes
   * during one backup admission.
   */
  private async reconcileStaleIdentities(): Promise<void> {
    type OwnerGeneration = { owner_pid: number; owner_started_at: string };
    const cursor = this.identityProbeCursor;
    const rows = this.withDatabase((db): OwnerGeneration[] => {
      const prefix = 'SELECT DISTINCT owner_pid, owner_started_at FROM quota_reservations WHERE owner_started_at IS NOT NULL';
      const order = ' ORDER BY owner_started_at ASC, owner_pid ASC LIMIT ?';
      if (cursor === null) {
        return db.prepare(prefix + order).all(MAX_IDENTITY_PROBES_PER_ADMISSION) as OwnerGeneration[];
      }
      // Keyset pagination rather than repeatedly taking the oldest eight:
      // if those owners are alive, later recycled PID generations must still
      // be probed on a subsequent admission. The wrap query cannot overlap.
      const after = db.prepare(prefix
        + ' AND (owner_started_at > ? OR (owner_started_at = ? AND owner_pid > ?))'
        + order).all(cursor.owner_started_at, cursor.owner_started_at, cursor.owner_pid,
        MAX_IDENTITY_PROBES_PER_ADMISSION) as OwnerGeneration[];
      if (after.length >= MAX_IDENTITY_PROBES_PER_ADMISSION) return after;
      const wrapped = db.prepare(prefix
        + ' AND (owner_started_at < ? OR (owner_started_at = ? AND owner_pid <= ?))'
        + order).all(cursor.owner_started_at, cursor.owner_started_at, cursor.owner_pid,
        MAX_IDENTITY_PROBES_PER_ADMISSION - after.length) as OwnerGeneration[];
      return [...after, ...wrapped];
    });
    const last = rows.at(-1);
    this.identityProbeCursor = last === undefined ? null : last;
    for (const row of rows) {
      if (!validQuotaProcessStart(row.owner_started_at)) {
        throw new Error('Global quota reservation has an invalid process identity');
      }
    }
    // A single PowerShell launch can probe all eight selected PIDs. Custom
    // probes remain per-PID for deterministic tests and alternate hosts.
    // ESRCH owners are left for the existing atomic transaction reaper.
    const foreign = rows.filter((row) => row.owner_pid !== process.pid
      && !this.isOwnerDefinitelyDead(row.owner_pid));
    const observedBatch = this.probeProcessIdentity === probeQuotaProcessIdentity
      ? await probeQuotaProcessIdentities(foreign.map((row) => row.owner_pid))
      : null;
    const stale: OwnerGeneration[] = [];
    for (const row of rows) {
      if (this.isOwnerDefinitelyDead(row.owner_pid)) continue;
      const observed = row.owner_pid === process.pid
        ? await this.currentOwnerStart().then((startedAt): QuotaProcessIdentity => startedAt === null
          ? { state: 'unverifiable' } : { state: 'live', startedAt })
        : observedBatch !== null
          ? observedBatch.get(row.owner_pid) ?? { state: 'unverifiable' }
          : await this.probeProcessIdentity(row.owner_pid);
      if (observed.state === 'gone'
        || observed.state === 'live' && observed.startedAt !== row.owner_started_at) {
        stale.push(row);
      }
    }
    if (stale.length === 0) return;
    this.transaction((db) => {
      const remove = db.prepare('DELETE FROM quota_reservations WHERE owner_pid=? AND owner_started_at=?');
      let deleted = 0;
      for (const row of stale) {
        const result = remove.run(row.owner_pid, row.owner_started_at);
        deleted += Number(result.changes);
      }
      if (deleted > 0) db.prepare('UPDATE quota_state SET revision=revision+1 WHERE id=1').run();
    });
  }

  private async currentOwnerStart(): Promise<string | null> {
    if (this.ownerIdentityPromise === null) {
      const probe = this.probeProcessIdentity === probeQuotaProcessIdentity
        ? (cachedOwnProcessIdentity ??= probeQuotaProcessIdentity(process.pid))
        : this.probeProcessIdentity(process.pid);
      this.ownerIdentityPromise = probe.then((observed) =>
        observed.state === 'live' && validQuotaProcessStart(observed.startedAt)
          ? observed.startedAt : null,
      );
    }
    return this.ownerIdentityPromise;
  }

  private async completeInventory(revision?: number): Promise<ProfileStorageInventory> {
    const inventory = revision === undefined
      ? await this.scanProfileInventory()
      : await coalesceQuotaInventory(this.root, revision, this.scanProfileInventory);
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
        owner_pid INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0),
        owner_started_at TEXT
      );`);
      // Online additive migration: legacy reservations remain valid and are
      // reaped only by definitely-dead PID, never guessed from a timestamp.
      const columns = db.prepare('PRAGMA table_info(quota_reservations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'owner_started_at')) {
        try { db.exec('ALTER TABLE quota_reservations ADD COLUMN owner_started_at TEXT'); }
        catch (error) {
          // Another process may have performed the same additive upgrade.
          const after = db.prepare('PRAGMA table_info(quota_reservations)').all() as Array<{ name: string }>;
          if (!after.some((column) => column.name === 'owner_started_at')) throw error;
        }
      }
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

  private rawState(db: DatabaseSync): QuotaStateRow | undefined {
    return db.prepare('SELECT revision,limit_bytes,reserve_bytes FROM quota_state WHERE id=1')
      .get() as QuotaStateRow | undefined;
  }

  private state(db: DatabaseSync): QuotaStateRow | undefined {
    const state = this.rawState(db);
    return state !== undefined && state.limit_bytes > 0 ? state : undefined;
  }

  private reapDeadOwners(db: DatabaseSync): boolean {
    const rows = db.prepare('SELECT id,owner_pid FROM quota_reservations').all() as Array<{ id: string; owner_pid: number }>;
    const dead = rows.filter((row) => this.isOwnerDefinitelyDead(row.owner_pid));
    if (dead.length === 0) return false;
    const remove = db.prepare('DELETE FROM quota_reservations WHERE id=? AND owner_pid=?');
    for (const row of dead) remove.run(row.id, row.owner_pid);
    db.prepare('UPDATE quota_state SET revision=revision+1 WHERE id=1').run();
    return true;
  }
}
