import { Worker } from 'node:worker_threads';
import { ROUTINE_READ_RECOVERY_DELETE_SQL, ROUTINE_READ_RECOVERY_DELETE_COMPLETED_SQL, ROUTINE_READ_RECOVERY_PROBE_SQL } from './audit-repository.js';

/**
 * Emergency DELETE is executed on an isolated SQLite connection and worker,
 * never on Electron Main's synchronous DatabaseSync connection.
 * The same protected-row SQL is used by ordinary retention.
 *
 * A worker performs one read-only probe or one bounded DELETE. SQLite atomically
 * commits or rolls back the statement; no VACUUM, backups, or file copies.
 */
// A SQL query can take arbitrarily long even with SQLite busy_timeout:
// that setting only covers waiting for DB locks, not a costly index scan.
// Bound worker lifetime so an MCP mutation cannot await a cleanup forever.
const AUDIT_WORKER_TIMEOUT_MS = 15_000;
const AUDIT_WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  const { statSync } = require('node:fs');
  const { pathToFileURL } = require('node:url');
  let db;
  let resultValue;
  let failure;
  try {
    // Restore/swap may temporarily remove the canonical file. Do not create
    // an empty replacement database while an emergency worker starts.
    const before = statSync(workerData.filename, { bigint: true });
    if (!before.isFile() || before.size < 100n) throw new Error('Canonical SQLite database is unavailable');
    const url = pathToFileURL(workerData.filename);
    url.searchParams.set('mode', workerData.operation === 'probe' ? 'ro' : 'rw');
    db = new DatabaseSync(url.href, {
      readOnly: workerData.operation === 'probe', timeout: 350,
    });
    const after = statSync(workerData.filename, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Canonical SQLite database changed');
    if (workerData.operation !== 'probe') {
      const stored = db.prepare("SELECT value FROM settings WHERE key='sqlite_main_hard_limit_mib_v1'").get();
      const requested = stored ? Number(stored.value) : 4096;
      const capMiB = Number.isSafeInteger(requested) && requested >= 512 && requested <= 16384 ? requested : 4096;
      const pageSize = db.prepare('PRAGMA page_size').get().page_size;
      db.exec('PRAGMA max_page_count = ' + Math.floor(capMiB * 1024 * 1024 / pageSize));
    }
    // Do not spin for minutes if another SQLite writer owns the WAL lock.
    const statement = db.prepare(workerData.sql);
    if (workerData.operation === 'probe') {
      resultValue = statement.get(workerData.cutoffIso, workerData.cutoffIso) !== undefined;
    } else {
      const result = statement.run(workerData.cutoffIso, workerData.cutoffIso, workerData.limit);
      resultValue = Number(result.changes);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (db !== undefined) {
      try { db.close(); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); }
    }
  }
  parentPort.postMessage(failure === undefined ? { ok: true, value: resultValue } : { ok: false, message: failure });
`;

function executeAuditWorker(
  filename: string,
  cutoffIso: string,
  operation: 'delete' | 'probe',
  limit: number,
  completedOnly = false,
  timeoutMs = AUDIT_WORKER_TIMEOUT_MS,
): Promise<number | boolean> {
  if (!filename || filename === ':memory:') {
    return Promise.reject(new Error('Emergency worker requires an on-disk SQLite database'));
  }
  if (!Number.isFinite(Date.parse(cutoffIso)) || !Number.isSafeInteger(limit)
    || (operation === 'delete' && (limit < 1 || limit > 500))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AUDIT_WORKER_TIMEOUT_MS) {
    return Promise.reject(new Error('Invalid emergency audit cleanup batch'));
  }
  return new Promise<number | boolean>((resolve, reject) => {
    const worker = new Worker(AUDIT_WORKER_SOURCE, {
      eval: true,
      workerData: { filename, cutoffIso, operation, limit,
        sql: operation === 'probe' ? ROUTINE_READ_RECOVERY_PROBE_SQL
          : completedOnly ? ROUTINE_READ_RECOVERY_DELETE_COMPLETED_SQL : ROUTINE_READ_RECOVERY_DELETE_SQL },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const clearDeadline = (): void => {
      if (deadline !== null) clearTimeout(deadline);
      deadline = null;
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
    };
    worker.once('message', (message: unknown) => {
      if (settled) return;
      if (typeof message !== 'object' || message === null
        || !('ok' in message) || message.ok !== true || !('value' in message)
        || (operation === 'probe' ? typeof message.value !== 'boolean'
          : typeof message.value !== 'number' || !Number.isSafeInteger(message.value)
            || message.value < 0 || message.value > limit)) {
        fail(new Error('Emergency SQLite cleanup worker failed or returned an invalid result'));
        return;
      }
      if (typeof message.value !== 'number' && typeof message.value !== 'boolean') {
        fail(new Error('Invalid SQLite audit worker value'));
        return;
      }
      settled = true;
      clearDeadline();
      resolve(message.value);
    });
    worker.once('error', fail);
    worker.once('exit', (code) => {
      if (!settled) fail(new Error(`Emergency SQLite cleanup worker exited before completion (code ${code})`));
    });
    deadline = setTimeout(() => {
      if (settled) return;
      fail(new Error('Emergency SQLite cleanup worker timed out; operation was cancelled'));
      // The worker is the only owner of its disposable connection. Terminating
      // it rolls back an incomplete DELETE instead of keeping MCP blocked.
      void worker.terminate().catch(() => undefined);
    }, timeoutMs);
    deadline.unref?.();
  });
}

export async function purgeExpiredRoutineReadsOffMain(
  filename: string,
  cutoffIso: string,
  limit: number,
  completedOnly = false,
  timeoutMs = AUDIT_WORKER_TIMEOUT_MS,
): Promise<number> {
  const result = await executeAuditWorker(filename, cutoffIso, 'delete', limit, completedOnly, timeoutMs);
  if (typeof result !== 'number') throw new Error('Unexpected audit cleanup result');
  return result;
}

export async function hasExpiredRoutineReadCandidatesOffMain(
  filename: string,
  cutoffIso: string,
  timeoutMs = AUDIT_WORKER_TIMEOUT_MS,
): Promise<boolean> {
  const result = await executeAuditWorker(filename, cutoffIso, 'probe', 0, false, timeoutMs);
  if (typeof result !== 'boolean') throw new Error('Unexpected audit probe result');
  return result;
}
