/**
 * Cooperative hard-limit recovery for legacy profiles and newly lowered caps.
 *
 * Only routine read audit rows already proven unreferenced by the repository's
 * paired-call/goal/receipt predicate are eligible. No checkpoints, goals,
 * mutation evidence, files, WAL or backup snapshots are ever removed here.
 *
 * SQLite DELETE reclaims reusable pages; physical file truncation requires a
 * separately approved, offline compaction after a verified backup.
 */
export interface HardLimitRecoveryFootprint {
  readonly allocatedBytes: number;
  readonly freeBytes: number;
  readonly requestedBytes: number;
  /** WAL is separately accounted for in diagnostics, never against main DB max_page_count. */
  readonly walBytes?: number;
}

export interface HardLimitRecoveryAudit {
  // One bounded DELETE is the existence probe. Avoid scanning protected
  // historical rows twice for every recovery batch.
  purgeExpiredRoutineReads(cutoffIso: string, limit: number, completedOnly?: boolean): Promise<number>;
}

export interface HardLimitRecoveryResult {
  readonly deleted: number;
  readonly reclaimedBytes: number;
  readonly remainsPressured: boolean;
  readonly candidatesExhausted: boolean;
  readonly moreWorkLikely: boolean;
}

// Align with the MCP mutation-admission guard's 5% reserve. Recovery
// must begin before the guard runs out of room for audit receipts.
const START_RATIO = 0.85;
const STOP_RATIO = 0.80;
const RECENT_PROTECTION_MS = 24 * 60 * 60 * 1000;
const EMERGENCY_COMPLETED_PROTECTION_MS = 5 * 60 * 1000;
const CRITICAL_COMPLETED_PROTECTION_MS = 1_000;
// Larger bounded statements halve worker startup/churn without allocating a
// persistent index or scanning unbounded audit history on Electron Main.
const BATCH_LIMIT = 128;
const MAX_BATCHES = 4;

/** Read live page metadata; zero new SQLite indices or retained disk caches. */
export function hardLimitRecoveryNeeded(footprint: HardLimitRecoveryFootprint): boolean {
  const walBytes = footprint.walBytes ?? 0;
  if (!Number.isSafeInteger(footprint.allocatedBytes) || !Number.isSafeInteger(footprint.freeBytes)
    || !Number.isSafeInteger(footprint.requestedBytes) || footprint.requestedBytes <= 0
    || footprint.allocatedBytes < 0 || footprint.freeBytes < 0 || footprint.freeBytes > footprint.allocatedBytes
    || !Number.isSafeInteger(walBytes) || walBytes < 0) {
    return false; // malformed metadata must never authorize deletion
  }
  const used = footprint.allocatedBytes - footprint.freeBytes;
  // Begin early enough to avoid the MCP 5% admission reserve; a WAL-only
  // spike cannot be fixed by deleting main-database audit rows.
  return used >= footprint.requestedBytes * START_RATIO;
}

/** Wait briefly for recovery during MCP admission without cancelling the separate
 * background worker. A slow legacy cleanup must never stall every MCP mutation
 * for the worker's full (potentially multi-batch) lifetime. The mutation still
 * fails closed if the post-wait SQLite headroom check is insufficient. */
export async function awaitBoundedStorageRecovery(recovery: Promise<void>, maxWaitMs = 3_000): Promise<boolean> {
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 30_000) {
    throw new Error('Invalid SQLite recovery admission wait');
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      recovery.then(() => true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), maxWaitMs); }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function recoverOldestRoutineAuditUnderHardLimit(
  audit: HardLimitRecoveryAudit,
  footprint: () => HardLimitRecoveryFootprint,
  options: { readonly nowMs?: number; readonly shouldStop?: () => boolean; readonly yieldToRuntime?: () => Promise<void>; readonly maxBatches?: number } = {},
): Promise<HardLimitRecoveryResult> {
  const now = options.nowMs ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('Invalid recovery clock');
  const maxBatches = options.maxBatches ?? MAX_BATCHES;
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_BATCHES) throw new Error('Invalid SQLite audit batch budget');
  const cutoff = new Date(now - RECENT_PROTECTION_MS).toISOString();
  const emergencyCompletedCutoff = new Date(now - EMERGENCY_COMPLETED_PROTECTION_MS).toISOString();
  const criticalCompletedCutoff = new Date(now - CRITICAL_COMPLETED_PROTECTION_MS).toISOString();
  const shouldStop = options.shouldStop ?? ((): boolean => false);
  const yieldToRuntime = options.yieldToRuntime ?? ((): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve)));
  const start = footprint();
  if (!hardLimitRecoveryNeeded(start) || shouldStop()) {
    return { deleted: 0, reclaimedBytes: 0, remainsPressured: hardLimitRecoveryNeeded(start),
      candidatesExhausted: false, moreWorkLikely: false };
  }

  let deleted = 0;
  let candidatesExhausted = false;
  let reachedTarget = false;
  let batches = 0;
  let recoveryTier = 0; // 0: >24h; 1: completed >5min; 2: completed >1s (last resort)
  while (batches < maxBatches) {
    if (shouldStop()) break;
    const current = footprint();
    if (current.allocatedBytes - current.freeBytes < current.requestedBytes * STOP_RATIO) {
      reachedTarget = true;
      break;
    }
    const tierCutoff = recoveryTier === 0 ? cutoff
      : recoveryTier === 1 ? emergencyCompletedCutoff : criticalCompletedCutoff;
    const count = await audit.purgeExpiredRoutineReads(tierCutoff, BATCH_LIMIT, recoveryTier > 0);
    if (!Number.isSafeInteger(count) || count < 0 || count > BATCH_LIMIT) {
      throw new Error('Invalid SQLite recovery delete count');
    }
    if (count === 0) {
      // When the configured cap would block future writes, progressively
      // recycle completed reads even from recent history. The final tier
      // protects the latest second. STARTED, failed, Goal and mutation rows
      // are never eligible for these last-resort deletes.
      if (recoveryTier < 2 && current.allocatedBytes - current.freeBytes >= current.requestedBytes * 0.95) {
        recoveryTier += 1;
        continue;
      }
      candidatesExhausted = true;
      break;
    }
    deleted += count;
    batches += 1;
    await yieldToRuntime();
  }
  const after = footprint();
  if (after.allocatedBytes - after.freeBytes < after.requestedBytes * STOP_RATIO) reachedTarget = true;
  // A decreased allocation may not be visible as smaller file size until an
  // explicit offline compaction; only freed reusable pages count as recovery.
  return {
    deleted,
    reclaimedBytes: Math.max(0, (after.freeBytes - start.freeBytes)
      + (start.allocatedBytes - after.allocatedBytes)),
    remainsPressured: hardLimitRecoveryNeeded(after),
    candidatesExhausted,
    moreWorkLikely: deleted > 0 && !candidatesExhausted && !reachedTarget
      && hardLimitRecoveryNeeded(after) && !shouldStop(),
  };
}
