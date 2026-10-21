/** Repeatable local benchmark; never touches user data or production logs. */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import console from 'node:console';
import process from 'node:process';
import { createFileActivitySink, formatActivityLogLine } from '../packages/mcp-server/dist/activity-log-file.js';

const count = Number.parseInt(process.argv[2] ?? '1000', 10);
if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) throw new Error('Count must be 1..100000');
const root = mkdtempSync(path.join(os.tmpdir(), 'lnwjing-activity-benchmark-'));
const events = Array.from({ length: count }, () => ({
  callId: randomUUID(), toolName: 'read_file', phase: 'completed',
  resultCode: 'SUCCESS', durationMs: 1, timestamp: '2026-10-21T00:00:00.000Z',
  targetSummary: 'src/file.ts',
}));
try {
  const legacyPath = path.join(root, 'legacy.log');
  const legacyStart = performance.now();
  // Previous writer's per-event SQLite lock/open, stat, synchronous append and close.
  for (const event of events) {
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    const mutex = new DatabaseSync(`${legacyPath}.lock.sqlite`, { timeout: 0 });
    try {
      mutex.exec('BEGIN IMMEDIATE');
      try { statSync(legacyPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      appendFileSync(legacyPath, formatActivityLogLine(event), 'utf8');
      mutex.exec('ROLLBACK');
    } finally {
      mutex.close();
    }
  }
  const legacyMs = performance.now() - legacyStart;

  const batchedPath = path.join(root, 'batched.log');
  const sink = createFileActivitySink(batchedPath);
  const batchedStart = performance.now();
  await Promise.all(events.map((event) => sink.record(event)));
  const batchedMs = performance.now() - batchedStart;
  const oldLines = readFileSync(legacyPath, 'utf8').trim().split('\n');
  const newLines = readFileSync(batchedPath, 'utf8').trim().split('\n');
  if (oldLines.length !== count || newLines.length !== count) throw new Error('Log entries lost');
  console.log(JSON.stringify({
    events: count,
    legacyMs: Number(legacyMs.toFixed(2)),
    batchedMs: Number(batchedMs.toFixed(2)),
    relativeSpeedup: Number((legacyMs / batchedMs).toFixed(2)),
    outputBytesMatch: statSync(legacyPath).size === statSync(batchedPath).size,
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
