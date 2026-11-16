import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteAuditRepository } from './audit-repository.js';
import { SqliteDatabase } from './database.js';
import { hardLimitRecoveryNeeded, recoverOldestRoutineAuditUnderHardLimit } from './hard-limit-recovery.js';
import { inspectSqliteHardLimit } from './sqlite-hard-limit.js';

const mib = 1024 * 1024;

/**
 * Accelerated 40-cycle soak simulation. It exercises repeated inserts,
 * low-headroom recovery, freelist reuse and protected rows using a virtual
 * quota. It intentionally does not create a full 2-GiB fixture or claim that
 * simulated cycles substitute for a multi-day soak of the packaged app.
 */
describe('accelerated SQLite retention soak', () => {
  it('keeps a repeatedly recycled audit footprint bounded over 40 write/reclaim cycles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-soak-'));
    const file = path.join(root, 'soak.sqlite');
    const db = new SqliteDatabase(file);
    const repo = new SqliteAuditRepository(db);
    const nowMs = Date.parse('2026-11-06T12:00:00.000Z');
    const quota = 3 * mib;
    try {
      for (const [id, resultCode, metadata] of [
        ['goal-protected', 'SUCCESS', { goalId: 'retain' }],
        ['orphaned-protected', 'STARTED', { callId: 'uncompleted' }],
      ] as const) {
        await repo.insert({
          id, timestamp: new Date(nowMs - 3 * 86400_000).toISOString(),
          actorId: 'test', actorName: 'test', action: 'mcp_tool:search_text',
          resultCode, durationMs: 1, metadata,
        });
      }
      const readFootprint = (): { allocatedBytes: number; freeBytes: number; requestedBytes: number } => {
        const snapshot = inspectSqliteHardLimit(db.connection, 512);
        return { allocatedBytes: snapshot.allocatedBytes, freeBytes: snapshot.freeBytes, requestedBytes: quota };
      };
      let deleted = 0;
      for (let cycle = 0; cycle < 40; cycle += 1) {
        for (let index = 0; index < 250; index += 1) {
          await repo.insert({
            id: 'cycle-' + cycle + '-read-' + index,
            timestamp: new Date(nowMs - 2 * 86400_000).toISOString(),
            actorId: 'test', actorName: 'test', action: 'mcp_tool:search_text',
            resultCode: 'SUCCESS', durationMs: 1,
            metadata: { query: 'long-lived-audit-' + 'x'.repeat(600) },
          });
        }
        for (let attempt = 0; attempt < 6 && hardLimitRecoveryNeeded(readFootprint()); attempt += 1) {
          const result = await recoverOldestRoutineAuditUnderHardLimit(repo, readFootprint, { nowMs });
          deleted += result.deleted;
          if (result.candidatesExhausted) break;
        }
      }
      expect(deleted).toBeGreaterThan(2_000);
      expect(hardLimitRecoveryNeeded(readFootprint())).toBe(false);
      const protectedIds = db.connection.prepare(
        "SELECT id FROM audit_events WHERE id IN ('goal-protected', 'orphaned-protected') ORDER BY id",
      ).all() as { id: string }[];
      expect(protectedIds.map((row) => row.id)).toEqual(['goal-protected', 'orphaned-protected']);
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(statSync(file).size).toBeLessThan(16 * mib);
      const wal = statSync(file + '-wal');
      expect(wal.size).toBeLessThan(16 * mib);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});
