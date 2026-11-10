import { describe, expect, it } from 'vitest';
import { SqliteAuditRepository } from './audit-repository.js';
import { SqliteDatabase } from './database.js';
import { inspectSqliteHardLimit } from './sqlite-hard-limit.js';
import { hardLimitRecoveryNeeded, awaitBoundedStorageRecovery, recoverOldestRoutineAuditUnderHardLimit } from './hard-limit-recovery.js';

const nowMs = Date.parse('2026-11-02T08:00:00.000Z');

describe('automatic hard-limit recovery', () => {
  it('does not make an MCP admission wait for a slow background sweep', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const elapsed = Date.now();
    expect(await awaitBoundedStorageRecovery(pending, 12)).toBe(false);
    expect(Date.now() - elapsed).toBeLessThan(500);
    release();
    expect(await awaitBoundedStorageRecovery(Promise.resolve(), 12)).toBe(true);
  });

  it('propagates a completed recovery error but validates timeout bounds', async () => {
    await expect(awaitBoundedStorageRecovery(Promise.reject(new Error('SQLITE_BUSY')), 50))
      .rejects.toThrow('SQLITE_BUSY');
    await expect(awaitBoundedStorageRecovery(Promise.resolve(), 0))
      .rejects.toThrow('Invalid SQLite recovery admission wait');
  });

  it('triggers for legacy databases above a newly lowered cap, but rejects invalid accounting', () => {
    expect(hardLimitRecoveryNeeded({ allocatedBytes: 1050, freeBytes: 0, requestedBytes: 1000 })).toBe(true);
    expect(hardLimitRecoveryNeeded({ allocatedBytes: 1050, freeBytes: 240, requestedBytes: 1000 })).toBe(false);
    expect(hardLimitRecoveryNeeded({ allocatedBytes: 940, freeBytes: 0, requestedBytes: 1000 })).toBe(true);
    expect(hardLimitRecoveryNeeded({ allocatedBytes: 840, freeBytes: 0, requestedBytes: 1000 })).toBe(false);
    // Begin reclaiming before hitting the five-percent MCP admission reserve,
    // independent of the physical WAL file size.
    const mib = 1024 * 1024;
    expect(hardLimitRecoveryNeeded({ allocatedBytes: 486 * mib, freeBytes: 0,
      requestedBytes: 512 * mib, walBytes: 2 * mib })).toBe(true);
    // A very large WAL must not authorize deleting old audit when the main
    // database itself is not near its cap.
    expect(hardLimitRecoveryNeeded({ allocatedBytes: 100 * mib, freeBytes: 0,
      requestedBytes: 512 * mib, walBytes: 450 * mib })).toBe(false);
    expect(hardLimitRecoveryNeeded({ allocatedBytes: 486 * mib, freeBytes: 0,
      requestedBytes: 512 * mib, walBytes: -1 })).toBe(false);
    expect(hardLimitRecoveryNeeded({ allocatedBytes: 1000, freeBytes: -1, requestedBytes: 1000 })).toBe(false);
    expect(hardLimitRecoveryNeeded({ allocatedBytes: 1000, freeBytes: 1001, requestedBytes: 1000 })).toBe(false);
    expect(hardLimitRecoveryNeeded({ allocatedBytes: 1000, freeBytes: 0, requestedBytes: NaN })).toBe(false);
  });

  it('reclaims ahead of the admission reserve without excessive deletes', async () => {
    const mib = 1024 * 1024;
    let freed = 0;
    let batchCalls = 0;
    const audit = {
      hasExpiredRoutineReadCandidates: (): boolean => true,
      purgeExpiredRoutineReads: async (_cutoff: string, limit: number): Promise<number> => {
        batchCalls += 1;
        freed += 80 * mib;
        return limit;
      },
    };
    const footprint = (): { allocatedBytes: number; freeBytes: number; requestedBytes: number; walBytes: number } =>
      ({ allocatedBytes: 486 * mib, freeBytes: freed, requestedBytes: 512 * mib, walBytes: 2 * mib });
    const result = await recoverOldestRoutineAuditUnderHardLimit(audit, footprint, { nowMs });
    expect(result.deleted).toBe(128);
    expect(result.reclaimedBytes).toBe(80 * mib);
    expect(result.remainsPressured).toBe(false);
    expect(result.moreWorkLikely).toBe(false);
    expect(batchCalls).toBe(1);
  });

  it('deletes oldest eligible records in small batches and stops before unnecessary extra writes', async () => {
    let freeBytes = 0;
    const batchSizes: number[] = [];
    const fake = {
      hasExpiredRoutineReadCandidates: (): boolean => true,
      purgeExpiredRoutineReads: async (_cutoff: string, size: number): Promise<number> => {
        batchSizes.push(size);
        freeBytes += size * 4;
        return size;
      },
    };
    const footprint = (): { allocatedBytes: number; freeBytes: number; requestedBytes: number } => ({ allocatedBytes: 1100, freeBytes, requestedBytes: 1000 });
    const result = await recoverOldestRoutineAuditUnderHardLimit(fake, footprint, { nowMs });
    expect(batchSizes).toEqual([128]);
    expect(result).toEqual({
      deleted: 128, reclaimedBytes: 512, remainsPressured: false,
      candidatesExhausted: false, moreWorkLikely: false,
    });
  });

  it('never prunes protected Goal, mutation, failed or recent read audit events', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repo = new SqliteAuditRepository(database);
      const add = (id: string, action: string, metadata: Record<string, unknown> = {},
        resultCode = 'SUCCESS', timestamp = '2026-01-01T00:00:00.000Z'): Promise<void> => repo.insert({
        id, action, timestamp, actorId: 'test', actorName: 'test',
        workspaceId: 'ws', sessionId: 'session',
        resultCode, durationMs: 1, metadata,
      });
      await add('old-read-a', 'mcp_tool:search_text');
      await add('old-read-b', 'mcp_tool:read_file');
      await add('goal', 'mcp_tool:read_file', { goalId: 'important' });
      await add('mutation', 'mcp_tool:edit_file', { mutationReceipt: { path: 'a.ts' } });
      await add('failed', 'mcp_tool:read_file', {}, 'ERROR');
      await add('recent', 'mcp_tool:read_file', {}, 'SUCCESS', '2026-11-02T07:59:00.000Z');
      const footprint = (): { allocatedBytes: number; requestedBytes: number; freeBytes: number } => ({
        allocatedBytes: 1000, requestedBytes: 900,
        freeBytes: 100 * (6 - database.connection.prepare('SELECT COUNT(*) AS total FROM audit_events').get()!.total as number),
      });
      const result = await recoverOldestRoutineAuditUnderHardLimit(repo, footprint, { nowMs });
      expect(result.deleted).toBe(2);
      expect(result.candidatesExhausted).toBe(true);
      expect((await repo.list(20)).map((event) => event.id).sort())
        .toEqual(['failed', 'goal', 'mutation', 'recent']);
    } finally { database.close(); }
  });

  it('at 95%+ recycles only completed recent reads after older candidates run out', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repo = new SqliteAuditRepository(database);
      const add = (id: string, resultCode: string, timestamp: string, metadata: Record<string, unknown> = {}): Promise<void> =>
        repo.insert({ id, action: 'mcp_tool:read_file', timestamp,
          actorId: 'test', actorName: 'test', resultCode, durationMs: 1, metadata });
      await add('recent-completed', 'SUCCESS', '2026-11-02T07:50:00.000Z');
      await add('in-flight-start', 'STARTED', '2026-11-02T07:50:00.000Z', { callId: 'still-active' });
      await add('newest-completed', 'SUCCESS', '2026-11-02T07:59:00.000Z');
      await add('protected-goal', 'SUCCESS', '2026-11-02T07:50:00.000Z', { goalId: 'keep' });
      await add('protected-error', 'ERROR', '2026-11-02T07:50:00.000Z');
      const footprint = (): { allocatedBytes: number; requestedBytes: number; freeBytes: number } => ({
        allocatedBytes: 1000, requestedBytes: 900,
        freeBytes: 200 * (5 - (database.connection.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count),
      });
      const result = await recoverOldestRoutineAuditUnderHardLimit(repo, footprint, { nowMs });
      expect(result.deleted).toBe(1);
      expect((await repo.list(20)).map((event) => event.id).sort())
        .toEqual(['in-flight-start', 'newest-completed', 'protected-error', 'protected-goal']);
    } finally { database.close(); }
  });

  it('reaches the last-resort tier in one urgent batch without evicting in-flight or current-second audit', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repo = new SqliteAuditRepository(database);
      const create = (id: string, timestamp: string, resultCode: string): Promise<void> => repo.insert({
        id, timestamp, resultCode, action: 'mcp_tool:search_text',
        actorId: 'test', actorName: 'test', durationMs: 1, metadata: { callId: id },
      });
      await create('just-completed', '2026-11-02T07:59:30.000Z', 'SUCCESS');
      await create('recent-started', '2026-11-02T07:59:00.000Z', 'STARTED');
      await create('current-second', '2026-11-02T07:59:59.500Z', 'SUCCESS');
      const result = await recoverOldestRoutineAuditUnderHardLimit(repo, () => ({
        allocatedBytes: 1_000, requestedBytes: 900,
        freeBytes: 200 * (3 - (database.connection.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count),
      }), { nowMs, maxBatches: 1 });
      expect(result.deleted).toBe(1);
      expect((await repo.list(10)).map((event) => event.id).sort())
        .toEqual(['current-second', 'recent-started']);
    } finally { database.close(); }
  });

  it('does not delete reads under 24 hours old before admission becomes critical', async () => {
    const calls: Array<{ completedOnly: boolean; cutoff: string }> = [];
    const result = await recoverOldestRoutineAuditUnderHardLimit({
      purgeExpiredRoutineReads: async (cutoff, _limit, completedOnly = false): Promise<number> => {
        calls.push({ completedOnly, cutoff });
        return 0;
      },
    }, () => ({ allocatedBytes: 900, freeBytes: 0, requestedBytes: 1000 }), { nowMs });
    expect(result.candidatesExhausted).toBe(true);
    expect(calls).toEqual([{ completedOnly: false, cutoff: '2026-11-01T08:00:00.000Z' }]);
  });

  it('reclaims real SQLite freelist pages without VACUUM or a large fixture', async () => {
    const database = new SqliteDatabase(':memory:');
    const repo = new SqliteAuditRepository(database);
    try {
      for (let i = 0; i < 48; i += 1) {
        await repo.insert({
          id: `old-${String(i).padStart(3, '0')}`,
          timestamp: '2025-01-01T00:00:00.000Z',
          action: 'mcp_tool:search_text',
          actorId: 'test', actorName: 'test',
          resultCode: 'SUCCESS', durationMs: 1,
          metadata: { query: 'x'.repeat(3072) },
        });
      }
      await repo.insert({
        id: 'protected-goal', timestamp: '2025-01-01T00:00:00.000Z',
        action: 'mcp_tool:search_text', actorId: 'test', actorName: 'test',
        resultCode: 'SUCCESS', durationMs: 1,
        metadata: { goalId: 'keep', query: 'x'.repeat(3072) },
      });
      const initial = inspectSqliteHardLimit(database.connection, 512);
      const requestedBytes = Math.floor((initial.allocatedBytes - initial.freeBytes) * 0.9);
      const footprint = (): { allocatedBytes: number; freeBytes: number; requestedBytes: number } => {
        const current = inspectSqliteHardLimit(database.connection, 512);
        return { allocatedBytes: current.allocatedBytes, freeBytes: current.freeBytes, requestedBytes };
      };
      const result = await recoverOldestRoutineAuditUnderHardLimit(repo, footprint, { nowMs });
      const after = footprint();
      expect(result.deleted).toBeGreaterThan(0);
      expect(after.freeBytes).toBeGreaterThan(initial.freeBytes);
      expect(result.reclaimedBytes).toBe(after.freeBytes - initial.freeBytes
        + initial.allocatedBytes - after.allocatedBytes);
      expect((await repo.list(50)).map((event) => event.id)).toContain('protected-goal');
    } finally { database.close(); }
  });

  it('keeps in-flight and newest evidence even after all emergency tiers are exhausted', async () => {
    const observed: Array<{ cutoff: string; completedOnly: boolean }> = [];
    const audit = {
      purgeExpiredRoutineReads: async (cutoff: string, _limit: number, completedOnly = false): Promise<number> => {
        observed.push({ cutoff, completedOnly });
        return 0;
      },
    };
    const result = await recoverOldestRoutineAuditUnderHardLimit(audit,
      (): { allocatedBytes: number; freeBytes: number; requestedBytes: number } => ({ allocatedBytes: 1200, freeBytes: 0, requestedBytes: 1000 }), { nowMs });
    expect(result).toMatchObject({ deleted: 0, candidatesExhausted: true, remainsPressured: true });
    expect(observed).toEqual([
      { cutoff: '2026-11-01T08:00:00.000Z', completedOnly: false },
      { cutoff: '2026-11-02T07:55:00.000Z', completedOnly: true },
      { cutoff: '2026-11-02T07:59:59.000Z', completedOnly: true },
    ]);
  });

  it('does not queue endless continuation after clearing mutation-admission pressure', async () => {
    let deleted = 0;
    const audit = {
      hasExpiredRoutineReadCandidates: (): boolean => true,
      purgeExpiredRoutineReads: async (_cutoff: string, limit: number): Promise<number> => {
        deleted += limit;
        return limit;
      },
    };
    // Each sweep stops after reaching 80% used, without starting another slice.
    const footprint = (): { allocatedBytes: number; freeBytes: number; requestedBytes: number } => ({
      allocatedBytes: 1000, freeBytes: Math.floor(deleted * 0.4), requestedBytes: 1000,
    });
    const result = await recoverOldestRoutineAuditUnderHardLimit(audit, footprint, { nowMs });
    expect(result.deleted).toBe(512);
    expect(result.remainsPressured).toBe(false);
    expect(result.moreWorkLikely).toBe(false);
  });

  it('reclaims repeated historical bursts without touching orphaned starts or goal evidence', async () => {
    const database = new SqliteDatabase(':memory:');
    const audit = new SqliteAuditRepository(database);
    try {
      // Synthetic multi-day history entirely in memory. This catches a cleanup
      // loop that never reaches headroom or erases protected evidence, without
      // creating a multi-GiB fixture on the user's SSD.
      for (let index = 0; index < 2_000; index += 1) {
        await audit.insert({
          id: `routine-${index}`, timestamp: '2025-01-01T00:00:00.000Z',
          actorId: 'fixture', actorName: 'fixture',
          action: 'mcp_tool:search_text', resultCode: 'SUCCESS',
          durationMs: 1, metadata: { query: 'x'.repeat(1_024) },
        });
      }
      await audit.insert({
        id: 'orphaned-start', timestamp: '2024-01-01T00:00:00.000Z',
        actorId: 'fixture', actorName: 'fixture', action: 'mcp_tool:search_text',
        resultCode: 'STARTED', durationMs: 0, metadata: { callId: 'never-finished', query: 'x'.repeat(1_024) },
      });
      await audit.insert({
        id: 'goal-read', timestamp: '2024-01-01T00:00:00.000Z',
        actorId: 'fixture', actorName: 'fixture', action: 'mcp_tool:search_text',
        resultCode: 'SUCCESS', durationMs: 1, metadata: { goalId: 'protected', query: 'x'.repeat(1_024) },
      });
      const before = inspectSqliteHardLimit(database.connection, 512);
      const requestedBytes = Math.floor((before.allocatedBytes - before.freeBytes) * 0.95);
      const footprint = (): { allocatedBytes: number; freeBytes: number; requestedBytes: number } => {
        const pages = inspectSqliteHardLimit(database.connection, 512);
        return { allocatedBytes: pages.allocatedBytes, freeBytes: pages.freeBytes, requestedBytes };
      };
      let removed = 0;
      for (let iteration = 0; iteration < 10 && hardLimitRecoveryNeeded(footprint()); iteration += 1) {
        const result = await recoverOldestRoutineAuditUnderHardLimit(audit, footprint, { nowMs });
        removed += result.deleted;
        if (result.candidatesExhausted) break;
      }
      expect(removed).toBeGreaterThan(500);
      expect(hardLimitRecoveryNeeded(footprint())).toBe(false);
      // list() intentionally caps a page, so look up the protected IDs by
      // their primary keys rather than assuming they occur in the first page.
      const protectedRows = database.connection.prepare(
        "SELECT id FROM audit_events WHERE id IN ('goal-read', 'orphaned-start') ORDER BY id",
      ).all() as { id: string }[];
      expect(protectedRows.map((row) => row.id)).toEqual(['goal-read', 'orphaned-start']);
      expect(database.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { database.close(); }
  });

  it('bounds each sweep and supports cancellation between batches', async () => {
    let rows = 0;
    const audit = {
      hasExpiredRoutineReadCandidates: (): boolean => true,
      purgeExpiredRoutineReads: async (_cutoff: string, size: number): Promise<number> => {
        rows += size;
        return size;
      },
    };
    const footprint = (): { allocatedBytes: number; freeBytes: number; requestedBytes: number } => ({ allocatedBytes: 20_000, freeBytes: rows, requestedBytes: 1000 });
    const first = await recoverOldestRoutineAuditUnderHardLimit(audit, footprint, { nowMs });
    expect(first.deleted).toBe(512);
    expect(first.moreWorkLikely).toBe(true);
    const second = await recoverOldestRoutineAuditUnderHardLimit(audit, footprint, {
      nowMs, shouldStop: (): boolean => rows >= 640,
    });
    expect(second.deleted).toBe(128);
    expect(second.moreWorkLikely).toBe(false);
  });
});
