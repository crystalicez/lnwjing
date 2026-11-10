import { statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

export interface WalTrimResult {
  readonly busy: boolean;
  readonly logFrames: number;
  readonly checkpointedFrames: number;
}

const MIB = 1024 * 1024;
const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_RETRY_MS = 30 * 60_000;
const WORKER_TIMEOUT_MS = 10_000;

/**
 * WAL is outside SQLite max_page_count. Never run a blocking checkpoint on
 * Electron Main, and never make routine audit deletion responsible for WAL.
 * This only trims a large WAL after it has stopped changing; active readers
 * and writers remain governed by SQLite's locking protocol.
 */
export function walTrimThresholdBytes(limitMiB: number): number {
  if (!Number.isSafeInteger(limitMiB) || limitMiB <= 0) throw new Error('Invalid WAL limit basis');
  return Math.max(128 * MIB, Math.min(512 * MIB, Math.floor(limitMiB * MIB / 8)));
}

const WAL_WORKER_SOURCE = [
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const { statSync } = require('node:fs');",
  "const { DatabaseSync } = require('node:sqlite');",
  "const { pathToFileURL } = require('node:url');",
  "let db;",
  "let result;",
  "let failure;",
  "try {",
  "  const before = statSync(workerData.filename, { bigint: true });",
  "  if (!before.isFile() || before.size < 100n) throw new Error('Canonical SQLite file unavailable');",
  "  const url = pathToFileURL(workerData.filename);",
  "  url.searchParams.set('mode', 'rw');",
  "  db = new DatabaseSync(url.href, { timeout: 200 });",
  "  const after = statSync(workerData.filename, { bigint: true });",
  "  if (after.dev !== before.dev || after.ino !== before.ino || after.birthtimeNs !== before.birthtimeNs)",
  "    throw new Error('Canonical SQLite file changed during checkpoint open');",
  "  db.exec('PRAGMA busy_timeout=200');",
  "  const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();",
  "  if (!row || ![row.busy, row.log, row.checkpointed].every(Number.isSafeInteger))",
  "    throw new Error('Invalid SQLite checkpoint status');",
  "  result = { busy: row.busy !== 0, logFrames: row.log, checkpointedFrames: row.checkpointed };",
  "} catch (error) {",
  "  failure = error instanceof Error ? error.message : String(error);",
  "} finally {",
  "  if (db) { try { db.close(); } catch (error) {",
  "    failure = error instanceof Error ? error.message : String(error);",
  "  } }",
  "}",
  "parentPort.postMessage(failure === undefined ? { ok: true, result } : { ok: false, message: failure });",
].join('\n');

/** One bounded checkpoint attempt on a disposable connection. */
export function trimIdleSqliteWalOffMain(filename: string): Promise<WalTrimResult> {
  if (!filename || filename === ':memory:') return Promise.reject(new Error('WAL trim requires an on-disk SQLite file'));
  return new Promise<WalTrimResult>((resolve, reject) => {
    const worker = new Worker(WAL_WORKER_SOURCE, {
      eval: true,
      workerData: { filename },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    const finish = (error?: Error, result?: WalTrimResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
      else reject(new Error('WAL checkpoint returned no result'));
    };
    worker.once('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('ok' in message) || message.ok !== true
        || !('result' in message) || typeof message.result !== 'object' || message.result === null
        || !('busy' in message.result) || typeof message.result.busy !== 'boolean'
        || !('logFrames' in message.result) || !Number.isSafeInteger(message.result.logFrames)
        || !('checkpointedFrames' in message.result) || !Number.isSafeInteger(message.result.checkpointedFrames)) {
        finish(new Error('WAL checkpoint worker failed or returned invalid status'));
        return;
      }
      finish(undefined, message.result as WalTrimResult);
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled) finish(new Error('WAL checkpoint worker exited before completion: ' + code));
    });
    const deadline = setTimeout(() => {
      finish(new Error('WAL checkpoint worker timed out'));
      // Terminate only this worker. SQLite still owns locking/rollback safety;
      // never unlink or manipulate active -wal/-shm files from JavaScript.
      void worker.terminate().catch(() => undefined);
    }, WORKER_TIMEOUT_MS);
    deadline.unref?.();
  });
}

export interface IdleWalMaintenanceOptions {
  readonly nowMs?: () => number;
  readonly idleMs?: number;
  readonly retryMs?: number;
  readonly minWalBytes?: number;
  readonly checkpoint?: (filename: string) => Promise<WalTrimResult>;
}

type WalObservation = { readonly signature: string; readonly firstSeenMs: number };

/**
 * A huge WAL that is still receiving writes should NOT cause periodic
 * synchronous checkpoints or a disk-I/O storm. Sample metadata only at the
 * existing 2-minute storage interval, wait for a quiet period, and cap retries.
 */
export class IdleWalMaintenance {
  private lastObservation: WalObservation | null = null;
  private lastAttemptMs: number | null = null;
  private active: Promise<WalTrimResult> | null = null;
  private closed = false;

  public constructor(private readonly filename: string, private readonly options: IdleWalMaintenanceOptions = {}) {}

  public inspect(limitMiB: number): Promise<WalTrimResult | null> {
    if (this.closed || this.active !== null || this.filename === ':memory:') return Promise.resolve(null);
    const now = (this.options.nowMs ?? Date.now)();
    if (!Number.isFinite(now)) return Promise.resolve(null);
    const threshold = this.options.minWalBytes ?? walTrimThresholdBytes(limitMiB);
    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
    const retryMs = this.options.retryMs ?? DEFAULT_RETRY_MS;
    if (![threshold, idleMs, retryMs].every(Number.isSafeInteger)
      || threshold < 1 || idleMs < 1 || retryMs < 1) {
      return Promise.reject(new Error('Invalid idle WAL maintenance settings'));
    }

    try {
      const main = statSync(this.filename, { bigint: true });
      const wal = statSync(this.filename + '-wal', { bigint: true });
      if (!main.isFile() || !wal.isFile() || main.size < 100n || wal.size < BigInt(threshold)) {
        this.lastObservation = null;
        return Promise.resolve(null);
      }
      const signature = [main.dev, main.ino, main.birthtimeNs,
        wal.dev, wal.ino, wal.size, wal.mtimeNs].join(':');
      if (this.lastObservation?.signature !== signature || now < this.lastObservation.firstSeenMs) {
        this.lastObservation = { signature, firstSeenMs: now };
        return Promise.resolve(null);
      }
      if (now - this.lastObservation.firstSeenMs < idleMs) return Promise.resolve(null);
      if (this.lastAttemptMs !== null && now >= this.lastAttemptMs
        && now - this.lastAttemptMs < retryMs) return Promise.resolve(null);

      this.lastAttemptMs = now;
      this.lastObservation = null;
      const task = (this.options.checkpoint ?? trimIdleSqliteWalOffMain)(this.filename);
      this.active = task;
      return task.finally(() => { if (this.active === task) this.active = null; });
    } catch (error: unknown) {
      // WAL may disappear during a normal checkpoint or final reader close.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        this.lastObservation = null;
        return Promise.resolve(null);
      }
      return Promise.reject(error);
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.active !== null) await this.active.catch(() => undefined);
  }
}
