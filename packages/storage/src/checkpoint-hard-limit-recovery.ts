import { Worker } from 'node:worker_threads';
import { hardLimitRecoveryNeeded, type HardLimitRecoveryFootprint } from './hard-limit-recovery.js';

/** Old one-click Undo snapshots are disposable history under SQLite pressure.
 * Goal checkpoints and mutation audit rows are stored separately and never
 * deleted by this worker. The newest 3 file checkpoints per workspace remain.
 * No VACUUM, whole-file backup or checkpoint payload reads are performed. */
export const HARD_LIMIT_CHECKPOINT_BATCH = 64;
const KEEP_PER_WORKSPACE = 3;
const WORKER_TIMEOUT_MS = 15_000;
const WORKER_SOURCE = [
"const { parentPort, workerData } = require('node:worker_threads');",
"const { DatabaseSync } = require('node:sqlite');",
"const { statSync } = require('node:fs');",
"const { pathToFileURL } = require('node:url');",
"let db, result, failure;",
"try {",
" const before = statSync(workerData.filename, { bigint: true });",
" if (!before.isFile() || before.size < 100n) throw new Error('Canonical SQLite file unavailable');",
" const url = pathToFileURL(workerData.filename);",
" url.searchParams.set('mode', 'rw');",
" db = new DatabaseSync(url.href, { timeout: 350 });",
" // The disposable writer must honor the same configured page cap as Desktop/STDIO.",
" const limitSetting = db.prepare(\"SELECT value FROM settings WHERE key='sqlite_main_hard_limit_mib_v1'\").get();",
" const requestedLimit = limitSetting ? Number(limitSetting.value) : 4096;",
" const limitMiB = Number.isSafeInteger(requestedLimit) && requestedLimit >= 512 && requestedLimit <= 16384 ? requestedLimit : 4096;",
" const pageSize = db.prepare('PRAGMA page_size').get().page_size;",
" db.exec('PRAGMA max_page_count = ' + Math.floor(limitMiB * 1024 * 1024 / pageSize));",
" const after = statSync(workerData.filename, { bigint: true });",
" if (before.dev !== after.dev || before.ino !== after.ino ||",
"     before.birthtimeNs !== after.birthtimeNs) throw new Error('Canonical SQLite file replaced');",
" db.exec('BEGIN IMMEDIATE');",
" try {",
"  const meta = db.prepare('SELECT indexed_count AS indexed FROM checkpoint_storage_totals WHERE id=1').get();",
"  const checkpointCount = db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get().n;",
"  // Legacy profiles intentionally skipped the metadata backfill at startup.",
"  // Never strand such a profile at SQLITE_FULL: fall back to ranking the",
"  // canonical checkpoint primary keys. Only fetch payload lengths for the",
"  // selected small batch, never load Undo contents into JavaScript.",
"  if (!meta || !Number.isSafeInteger(meta.indexed) || !Number.isSafeInteger(checkpointCount))",
"   throw new Error('Checkpoint storage rollup invalid');",
"  const ready = meta.indexed === checkpointCount;",
"  const canonicalSql = 'SELECT c.id AS id, length(CAST(c.files_json AS BLOB)) AS bytes' +",
"   ' FROM checkpoints c WHERE c.created_at < ? AND EXISTS (' +",
"   ' SELECT 1 FROM checkpoints newer INDEXED BY idx_checkpoints_workspace_created' +",
"   ' WHERE newer.workspace_id = c.workspace_id AND (' +",
"   ' newer.created_at > c.created_at OR' +",
"   ' (newer.created_at = c.created_at AND newer.id > c.id))' +",
"   ' LIMIT 1 OFFSET ?' +",
"   ' ) ORDER BY c.created_at ASC,c.id ASC LIMIT ?';",
"  const canonicalSelect = db.prepare(canonicalSql);",
"  const select = ready ? db.prepare(",
"   'SELECT c.id AS id, length(CAST(c.files_json AS BLOB)) AS bytes FROM (' +",
"   ' SELECT checkpoint_id,created_at,ROW_NUMBER() OVER (' +",
"   ' PARTITION BY workspace_id ORDER BY created_at DESC,checkpoint_id DESC' +",
"   ' ) AS newest_rank FROM checkpoint_storage_meta' +",
"   ' ) ranked JOIN checkpoints c ON c.id = ranked.checkpoint_id' +",
"   ' WHERE ranked.newest_rank > ? AND ranked.created_at < ?' +",
"   ' ORDER BY ranked.created_at ASC,ranked.checkpoint_id ASC LIMIT ?'",
"  ) : canonicalSelect;",
"  // Re-check the canonical row before EVERY DELETE. Even if a legacy",
"  // metadata rollup reports a matching count but stale timestamps, it must",
"  // never authorize deletion of the true newest three or a recent Undo.",
"  const remove = db.prepare(",
"   'DELETE FROM checkpoints WHERE id = ? AND created_at < ? AND EXISTS (' +",
"   ' SELECT 1 FROM checkpoints newer INDEXED BY idx_checkpoints_workspace_created' +",
"   ' WHERE newer.workspace_id = checkpoints.workspace_id AND (' +",
"   ' newer.created_at > checkpoints.created_at OR' +",
"   ' (newer.created_at = checkpoints.created_at AND newer.id > checkpoints.id))' +",
"   ' LIMIT 1 OFFSET ?)'",
"  );",
"  const rows = ready ? select.all(workerData.keep, workerData.cutoffIso, workerData.batch)",
"   : select.all(workerData.cutoffIso, workerData.keep - 1, workerData.batch);",
"  result = 0;",
"  let selectedBytes = 0;",
"  const applyCandidates = (candidates) => {",
"   for (const row of candidates) {",
"    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error('Invalid checkpoint payload metadata');",
"    if (result > 0 && selectedBytes + row.bytes > 16 * 1024 * 1024) break;",
"    const changes = Number(remove.run(row.id, workerData.cutoffIso, workerData.keep - 1).changes);",
"    result += changes;",
"    if (changes > 0) selectedBytes += row.bytes;",
"   }",
"  };",
"  applyCandidates(rows);",
"  if (ready && result === 0) {",
"   // A count-complete but timestamp-stale metadata table may point only to",
"   // protected rows. Recover from canonical data instead of endlessly",
"   // returning zero while expired history still occupies reusable pages.",
"   applyCandidates(canonicalSelect.all(workerData.cutoffIso, workerData.keep - 1, workerData.batch));",
"  }",
"  db.exec('COMMIT');",
" } catch (error) {",
"  if (db.isTransaction) { try { db.exec('ROLLBACK'); } catch {} }",
"  throw error;",
" }",
"} catch (error) { failure = error instanceof Error ? error.message : String(error); }",
"finally { if (db) { try { db.close(); } catch(error) {",
" failure = error instanceof Error ? error.message : String(error);",
"} } }",
"parentPort.postMessage(failure === undefined ? { ok: true, count: result } : { ok: false, message: failure });",
].join('\n');

export interface HardLimitFileCheckpointResult {
  readonly deleted: number;
  readonly reclaimedBytes: number;
  readonly remainsPressured: boolean;
  readonly candidatesExhausted: boolean;
  readonly moreWorkLikely: boolean;
}

export async function recoverOldFileCheckpointsUnderHardLimit(
  checkpoints: { pruneExpired(cutoffIso: string, batch: number): Promise<number> },
  footprint: () => HardLimitRecoveryFootprint,
  options: {
    readonly nowMs?: number;
    readonly shouldStop?: () => boolean;
    readonly yieldToRuntime?: () => Promise<void>;
    /** Admission recovery can run more small transactions before rejecting a write. */
    readonly maxBatches?: number;
    /** Only a blocked mutation may expire >1h and, last-resort, >5min Undo. */
    readonly emergency?: boolean;
  } = {},
): Promise<HardLimitFileCheckpointResult> {
  const now = options.nowMs ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('Invalid automatic checkpoint recovery clock');
  const maxBatches = options.maxBatches ?? 4;
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 32) {
    throw new Error('Invalid checkpoint recovery batch budget');
  }
  const initial = footprint();
  if (!hardLimitRecoveryNeeded(initial) || options.shouldStop?.() === true) {
    return { deleted: 0, reclaimedBytes: 0, remainsPressured: hardLimitRecoveryNeeded(initial),
      candidatesExhausted: false, moreWorkLikely: false };
  }
  const weekCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const dayCutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const hourCutoff = new Date(now - 60 * 60 * 1000).toISOString();
  const recentCutoff = new Date(now - 5 * 60 * 1000).toISOString();
  const tierCutoffs = options.emergency === true
    ? [weekCutoff, dayCutoff, hourCutoff, recentCutoff]
    : [weekCutoff, dayCutoff];
  const shouldStop = options.shouldStop ?? ((): boolean => false);
  const yieldToRuntime = options.yieldToRuntime
    ?? ((): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve)));
  let deleted = 0;
  let candidatesExhausted = false;
  let tier = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    if (shouldStop()) break;
    const before = footprint();
    const used = before.allocatedBytes - before.freeBytes;
    if (used < before.requestedBytes * 0.80) break;
    const count = await checkpoints.pruneExpired(tierCutoffs[tier]!, HARD_LIMIT_CHECKPOINT_BATCH);
    if (!Number.isSafeInteger(count) || count < 0 || count > HARD_LIMIT_CHECKPOINT_BATCH) {
      throw new Error('Invalid automatic checkpoint cleanup count');
    }
    if (count === 0) {
      // Keep recent Undo during normal pressure. Only an actively blocked
      // mutation can advance from 24h to 1h and finally 5min, while the
      // newest three per workspace are always retained by the worker SQL.
      if (tier + 1 < tierCutoffs.length && used >= before.requestedBytes * 0.95
        && batch + 1 < maxBatches) {
        tier += 1;
        continue;
      }
      candidatesExhausted = true;
      break;
    }
    deleted += count;
    await yieldToRuntime();
  }
  const after = footprint();
  const remainsPressured = hardLimitRecoveryNeeded(after);
  return {
    deleted,
    reclaimedBytes: Math.max(0, (after.freeBytes - initial.freeBytes)
      + (initial.allocatedBytes - after.allocatedBytes)),
    remainsPressured,
    candidatesExhausted,
    moreWorkLikely: deleted > 0 && remainsPressured && !candidatesExhausted && !shouldStop(),
  };
}

export async function pruneExpiredFileCheckpointsOffMain(
  filename: string,
  cutoffIso: string,
  batch = HARD_LIMIT_CHECKPOINT_BATCH,
  timeoutMs = WORKER_TIMEOUT_MS,
): Promise<number> {
  if (!filename || filename === ':memory:' || !Number.isFinite(Date.parse(cutoffIso))
    || !Number.isSafeInteger(batch) || batch < 1 || batch > HARD_LIMIT_CHECKPOINT_BATCH
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORKER_TIMEOUT_MS) {
    throw new Error('Invalid automatic checkpoint cleanup request');
  }
  // Busy writers are common while AI tools are editing. A single transient
  // SQLITE_BUSY must not permanently block emergency cleanup. Keep retries
  // bounded and retry only genuine lock-contention errors, never malformed
  // metadata, canonical-file replacements or worker timeouts.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await executeCheckpointCleanupWorker(filename, cutoffIso, batch, timeoutMs);
    } catch (error) {
      if (attempt === 2 || !/SQLITE_BUSY|database (?:table )?is locked/i.test(String(error))) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, (attempt + 1) * 75));
    }
  }
  throw new Error('Automatic checkpoint cleanup retry budget exhausted');
}

function executeCheckpointCleanupWorker(filename: string, cutoffIso: string,
  batch: number, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { filename, cutoffIso, batch, keep: KEEP_PER_WORKSPACE },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settle = (error?: Error, count?: number): void => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      if (error !== undefined) reject(error);
      else if (count !== undefined) resolve(count);
      else reject(new Error('Automatic checkpoint cleanup produced no result'));
    };
    worker.once('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('ok' in message) || message.ok !== true
        || !('count' in message) || typeof message.count !== 'number'
        || !Number.isSafeInteger(message.count) || message.count < 0 || message.count > batch) {
        const reason = typeof message === 'object' && message !== null && 'message' in message
          ? String(message.message) : 'invalid result';
        settle(new Error('Automatic checkpoint cleanup failed: ' + reason));
        return;
      }
      settle(undefined, message.count);
    });
    worker.once('error', (error) => settle(error));
    worker.once('exit', (code) => {
      if (!settled) settle(new Error('Automatic checkpoint cleanup worker exited: ' + code));
    });
    timeout = setTimeout(() => {
      settle(new Error('Automatic checkpoint cleanup worker timed out'));
      void worker.terminate().catch(() => undefined);
    }, timeoutMs);
    timeout.unref?.();
  });
}
