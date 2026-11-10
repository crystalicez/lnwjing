import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAuditRepository } from './audit-repository.js';
import { SqliteDatabase } from './database.js';
import { hasExpiredRoutineReadCandidatesOffMain, purgeExpiredRoutineReadsOffMain } from './hard-limit-recovery-worker.js';

const temporaryRoots: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('emergency SQLite audit cleanup worker', () => {
  it('deletes only eligible old routine reads without blocking the calling event loop', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-worker-'));
    temporaryRoots.push(root);
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const database = new SqliteDatabase(databaseFile);
    try {
      const audit = new SqliteAuditRepository(database);
      for (let i = 0; i < 80; i += 1) {
        await audit.insert({
          id: `read-${i}`, timestamp: '2025-01-01T00:00:00.000Z',
          actorId: 'test', actorName: 'test', action: 'mcp_tool:read_file',
          resultCode: 'SUCCESS', durationMs: 1, metadata: { query: 'a'.repeat(200) },
        });
      }
      await audit.insert({
        id: 'goal', timestamp: '2025-01-01T00:00:00.000Z',
        actorId: 'test', actorName: 'test', action: 'mcp_tool:read_file',
        resultCode: 'SUCCESS', durationMs: 1, metadata: { goalId: 'protected' },
      });
      await audit.insert({
        id: 'mutation', timestamp: '2025-01-01T00:00:00.000Z',
        actorId: 'test', actorName: 'test', action: 'mcp_tool:edit_file',
        resultCode: 'SUCCESS', durationMs: 1, metadata: { mutationReceipt: { path: 'file.ts' } },
      });
      expect(await hasExpiredRoutineReadCandidatesOffMain(databaseFile, '2026-11-01T00:00:00.000Z')).toBe(true);
      let eventLoopResponded = false;
      const first = purgeExpiredRoutineReadsOffMain(databaseFile, '2026-11-01T00:00:00.000Z', 64);
      await new Promise<void>((resolve) => setImmediate(() => {
        eventLoopResponded = true;
        resolve();
      }));
      expect(eventLoopResponded).toBe(true);
      expect(await first).toBe(64);
      expect(await purgeExpiredRoutineReadsOffMain(databaseFile, '2026-11-01T00:00:00.000Z', 64)).toBe(16);
      expect(await purgeExpiredRoutineReadsOffMain(databaseFile, '2026-11-01T00:00:00.000Z', 64)).toBe(0);
      expect(await hasExpiredRoutineReadCandidatesOffMain(databaseFile, '2026-11-01T00:00:00.000Z')).toBe(false);
      const remaining = await audit.list(100);
      expect(remaining.map((event) => event.id).sort()).toEqual(['goal', 'mutation']);
    } finally {
      database.close();
    }
  });

  it('completed-only fallback never deletes an in-flight read audit row', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-worker-completed-'));
    temporaryRoots.push(root);
    const databaseFile = path.join(root, 'lnwjing.sqlite');
    const database = new SqliteDatabase(databaseFile);
    try {
      const audit = new SqliteAuditRepository(database);
      for (const [id, resultCode] of [['completed', 'SUCCESS'], ['in-flight', 'STARTED']] as const) {
        await audit.insert({ id, action: 'mcp_tool:read_file',
          timestamp: '2026-11-02T07:50:00.000Z', actorId: 'test', actorName: 'test',
          resultCode, durationMs: 1, metadata: { callId: id } });
      }
      expect(await purgeExpiredRoutineReadsOffMain(databaseFile, '2026-11-02T07:55:00.000Z', 64, true))
        .toBe(1);
      expect((await audit.list(10)).map((event) => event.id)).toEqual(['in-flight']);
    } finally { database.close(); }
  });

  it('keeps audit transactions atomic when two recovery workers race on one database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-worker-race-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'main.sqlite');
    const db = new SqliteDatabase(filename);
    const repo = new SqliteAuditRepository(db);
    try {
      for (let n = 0; n < 150; n += 1) {
        await repo.insert({ id: `old-${n}`, timestamp: '2025-01-01T00:00:00.000Z',
          actorId: 'test', actorName: 'test', action: 'mcp_tool:read_file',
          resultCode: 'SUCCESS', durationMs: 1, metadata: {} });
      }
      await repo.insert({ id: 'goal-keep', timestamp: '2025-01-01T00:00:00.000Z',
        actorId: 'test', actorName: 'test', action: 'mcp_tool:read_file',
        resultCode: 'SUCCESS', durationMs: 1, metadata: { goalId: 'keep' } });
      const results = await Promise.allSettled([
        purgeExpiredRoutineReadsOffMain(filename, '2026-01-01T00:00:00.000Z', 128),
        purgeExpiredRoutineReadsOffMain(filename, '2026-01-01T00:00:00.000Z', 128),
      ]);
      const successfulDeletes = results.reduce((sum, entry) =>
        sum + (entry.status === 'fulfilled' ? entry.value : 0), 0);
      const remaining = await repo.list(200);
      expect(successfulDeletes).toBe(151 - remaining.length);
      expect(remaining.some((entry) => entry.id === 'goal-keep')).toBe(true);
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { db.close(); }
  });

  it('does not create a new database when recovery races a missing canonical file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-worker-no-create-'));
    temporaryRoots.push(root);
    const missingFile = path.join(root, 'missing.sqlite');
    await expect(purgeExpiredRoutineReadsOffMain(missingFile, '2026-01-01T00:00:00.000Z', 64))
      .rejects.toThrow(/Emergency SQLite cleanup worker/);
    expect(existsSync(missingFile)).toBe(false);
    await expect(hasExpiredRoutineReadCandidatesOffMain(missingFile, '2026-01-01T00:00:00.000Z'))
      .rejects.toThrow(/Emergency SQLite cleanup worker/);
    expect(existsSync(missingFile)).toBe(false);
  });

  it('bounds a slow recovery worker and leaves the audited row intact on deadline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-worker-deadline-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'database.sqlite');
    const database = new SqliteDatabase(filename);
    try {
      const audit = new SqliteAuditRepository(database);
      await audit.insert({ id: 'keep', timestamp: '2025-01-01T00:00:00.000Z',
        actorId: 'test', actorName: 'test', action: 'mcp_tool:read_file',
        resultCode: 'SUCCESS', durationMs: 1, metadata: {} });
      await expect(purgeExpiredRoutineReadsOffMain(filename, '2026-01-01T00:00:00.000Z', 64, false, 1))
        .rejects.toThrow(/worker timed out/);
      // Give the terminated worker time to leave before checking the canonical
      // file; no detached worker may complete a DELETE after the deadline.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect((await audit.list(10)).map((event) => event.id)).toEqual(['keep']);
      await expect(hasExpiredRoutineReadCandidatesOffMain(filename, '2026-01-01T00:00:00.000Z', 0))
        .rejects.toThrow(/Invalid emergency audit cleanup batch/);
    } finally { database.close(); }
  });

  it('rejects invalid limits without touching a database file', async () => {
    await expect(purgeExpiredRoutineReadsOffMain('missing.sqlite', '2026-01-01', 0))
      .rejects.toThrow(/Invalid emergency audit/);
    await expect(purgeExpiredRoutineReadsOffMain(':memory:', '2026-01-01', 64))
      .rejects.toThrow(/on-disk SQLite/);
  });
});
