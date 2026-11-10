import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteCheckpointRepository } from './checkpoint-repository.js';
import { inspectSqliteHardLimit } from './sqlite-hard-limit.js';
import { HARD_LIMIT_CHECKPOINT_BATCH, pruneExpiredFileCheckpointsOffMain, recoverOldFileCheckpointsUnderHardLimit } from './checkpoint-hard-limit-recovery.js';

describe('bounded old file-checkpoint expiry under SQLite pressure', () => {
  it('uses seven-day retention first and 24 hours only if storage is critical', async () => {
    const now = Date.parse('2026-11-06T12:00:00.000Z');
    const seen: string[] = [];
    let used = 970;
    const result = await recoverOldFileCheckpointsUnderHardLimit({
      pruneExpired: async (cutoff: string): Promise<number> => {
        seen.push(cutoff);
        if (cutoff === new Date(now - 7 * 86400_000).toISOString()) return 0;
        used -= 200;
        return 2;
      },
    }, () => ({ allocatedBytes: used, freeBytes: 0, requestedBytes: 1000 }), { nowMs: now });
    expect(seen).toEqual([
      new Date(now - 7 * 86400_000).toISOString(),
      new Date(now - 86400_000).toISOString(),
    ]);
    expect(result).toMatchObject({ deleted: 2, remainsPressured: false, moreWorkLikely: false });
    seen.length = 0;
    used = 900;
    const noncritical = await recoverOldFileCheckpointsUnderHardLimit({
      pruneExpired: async (cutoff: string): Promise<number> => { seen.push(cutoff); return 0; },
    }, () => ({ allocatedBytes: used, freeBytes: 0, requestedBytes: 1000 }), { nowMs: now });
    expect(seen).toEqual([new Date(now - 7 * 86400_000).toISOString()]);
    expect(noncritical).toMatchObject({ deleted: 0, candidatesExhausted: true });
  });

  it('under blocked admission expires one-hour then five-minute Undo only after older tiers are exhausted', async () => {
    const now = Date.parse('2026-11-09T01:00:00.000Z');
    const seen: string[] = [];
    let used = 980;
    const result = await recoverOldFileCheckpointsUnderHardLimit({
      pruneExpired: async (cutoff: string): Promise<number> => {
        seen.push(cutoff);
        if (cutoff !== new Date(now - 300_000).toISOString()) return 0;
        used = 790;
        return 3;
      },
    }, () => ({ allocatedBytes: used, freeBytes: 0, requestedBytes: 1000 }),
    { nowMs: now, emergency: true, maxBatches: 8 });
    expect(seen).toEqual([7 * 86_400_000, 86_400_000, 3_600_000, 300_000]
      .map((ageMs) => new Date(now - ageMs).toISOString()));
    expect(result).toMatchObject({ deleted: 3, remainsPressured: false });
    await expect(recoverOldFileCheckpointsUnderHardLimit({
      pruneExpired: async (): Promise<number> => 0,
    }, () => ({ allocatedBytes: 980, freeBytes: 0, requestedBytes: 1000 }),
    { maxBatches: 33 })).rejects.toThrow(/batch budget/);
  });

  it('does not delete when recovery is unnecessary, disabled or stopped', async () => {
    let calls = 0;
    const pruneExpired = async (): Promise<number> => { calls += 1; return 2; };
    const fine = (): { allocatedBytes: number; freeBytes: number; requestedBytes: number } =>
      ({ allocatedBytes: 600, freeBytes: 0, requestedBytes: 1000 });
    const pressured = (): { allocatedBytes: number; freeBytes: number; requestedBytes: number } =>
      ({ allocatedBytes: 980, freeBytes: 0, requestedBytes: 1000 });
    expect((await recoverOldFileCheckpointsUnderHardLimit({ pruneExpired }, fine)).deleted).toBe(0);
    expect((await recoverOldFileCheckpointsUnderHardLimit({ pruneExpired }, pressured,
      { shouldStop: (): boolean => true })).deleted).toBe(0);
    expect(calls).toBe(0);
  });

  it('keeps the newest three per workspace and unexpired snapshots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-old-checkpoints-'));
    const filename = path.join(root, 'test.sqlite');
    const db = new SqliteDatabase(filename);
    try {
      const repo = new SqliteCheckpointRepository(db);
      for (let w = 1; w <= 2; w++) {
        for (let n = 0; n < 8; n++) {
          await repo.insert({ id: 'w' + w + '-' + n, workspaceId: 'workspace-' + w,
            createdAt: n === 7 ? '2026-11-06T00:00:00.000Z' : '2026-10-01T00:00:00.000Z',
            files: [] });
        }
      }
      db.connection.prepare(
        "INSERT INTO audit_events (id,timestamp,actor_id,actor_name,action,result_code,duration_ms,metadata_json) VALUES (?,?,?,?,?,?,?,?)",
      ).run('receipt', '2026-10-01T00:00:00.000Z', 'actor', 'Actor', 'mcp_tool:edit_file',
        'SUCCESS', 0, JSON.stringify({ mutationReceipt: { checkpointId: 'w1-0' } }));
      expect(await pruneExpiredFileCheckpointsOffMain(filename, '2026-11-01T00:00:00.000Z')).toBe(10);
      expect((await repo.list('workspace-1')).map((r) => r.id))
        .toEqual(['w1-7', 'w1-6', 'w1-5']);
      expect((await repo.list('workspace-2')).map((r) => r.id))
        .toEqual(['w2-7', 'w2-6', 'w2-5']);
      expect(db.connection.prepare("SELECT id FROM audit_events WHERE id='receipt'").get()).toEqual({ id: 'receipt' });
      expect(repo.storageMetadataStatus()).toMatchObject({ indexed: 6, total: 6, complete: true });
      expect(db.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('caps each transaction by canonical payload bytes even if indexed sizes are stale', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-checkpoint-bytes-'));
    const file = path.join(root, 'test.sqlite');
    const db = new SqliteDatabase(file);
    try {
      const repo = new SqliteCheckpointRepository(db);
      for (let n = 0; n < 6; n++) {
        await repo.insert({ id: 'snapshot-' + n, workspaceId: 'workspace',
          createdAt: n === 5 ? '2026-11-06T00:00:00.000Z' : '2025-01-01T00:00:00.000Z',
          files: [] });
      }
      // Simulate a legacy writer that changed encrypted checkpoint blobs without
      // refreshing metadata. Each old blob is 9 MiB but the index still reports
      // only the initial tiny JSON payload. No user file is involved.
      db.connection.prepare('UPDATE checkpoints SET files_json = zeroblob(?) WHERE id IN (?, ?)')
        .run(9 * 1024 * 1024, 'snapshot-0', 'snapshot-1');
      expect(repo.storageMetadataStatus().complete).toBe(true);
      expect(await pruneExpiredFileCheckpointsOffMain(file, '2026-11-01T00:00:00.000Z')).toBe(1);
      const ids = (db.connection.prepare('SELECT id FROM checkpoints ORDER BY id').all() as { id: string }[])
        .map((row) => row.id);
      expect(ids).toEqual(['snapshot-1', 'snapshot-2', 'snapshot-3', 'snapshot-4', 'snapshot-5']);
      expect(db.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the latest snapshots intact when two worker processes compete to prune', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-checkpoint-race-'));
    const file = path.join(root, 'test.sqlite');
    const db = new SqliteDatabase(file);
    try {
      const repo = new SqliteCheckpointRepository(db);
      for (let n = 0; n < 120; n++) {
        await repo.insert({ id: 'row-' + String(n).padStart(3, '0'), workspaceId: 'workspace',
          createdAt: n >= 117 ? '2026-11-06T00:00:00.000Z' : '2025-01-01T00:00:00.000Z',
          files: [] });
      }
      const outcomes = await Promise.allSettled([
        pruneExpiredFileCheckpointsOffMain(file, '2026-11-01T00:00:00.000Z'),
        pruneExpiredFileCheckpointsOffMain(file, '2026-11-01T00:00:00.000Z'),
      ]);
      const removed = outcomes.reduce((sum, outcome) =>
        sum + (outcome.status === 'fulfilled' ? outcome.value : 0), 0);
      const remaining = (db.connection.prepare('SELECT id FROM checkpoints ORDER BY id').all() as { id: string }[]);
      expect(removed).toBe(120 - remaining.length);
      expect(remaining.map((row) => row.id)).toEqual(['row-117', 'row-118', 'row-119']);
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses SQLite pages after exhausting a small real max_page_count without VACUUM', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-checkpoint-actual-cap-'));
    const file = path.join(root, 'test.sqlite');
    const db = new SqliteDatabase(file);
    try {
      db.connection.exec('PRAGMA max_page_count = 512');
      // This fixture deliberately tests SQLITE_FULL without automatic trimming.
      db.connection.prepare('INSERT INTO settings(key,value) VALUES (?,?)')
        .run('sqlite_auto_safe_trim_on_limit_v1', 'false');
      const repo = new SqliteCheckpointRepository(db);
      let inserted = 0;
      let full = false;
      for (let n = 0; n < 160; n++) {
        try {
          await repo.insert({ id: 'old-' + n, workspaceId: 'w',
            createdAt: '2025-01-01T00:00:00.000Z',
            files: [{ path: 'large.txt', content: 'x'.repeat(32 * 1024),
              contentSha256: 'a'.repeat(64), size: 32 * 1024 }] });
          inserted += 1;
        } catch (error) {
          if (!/SQLITE_FULL|database or disk is full/i.test(String(error))) throw error;
          full = true;
          break;
        }
      }
      expect(full).toBe(true);
      expect(inserted).toBeGreaterThan(10);
      const before = db.connection.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
      let deleted = 0;
      for (let round = 0; round < 5; round++) {
        const count = await pruneExpiredFileCheckpointsOffMain(file, '2026-11-01T00:00:00.000Z');
        deleted += count;
        if (count === 0) break;
      }
      expect(deleted).toBe(inserted - 3);
      expect(repo.storageMetadataStatus()).toMatchObject({ indexed: 3, total: 3, complete: true });
      const after = db.connection.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
      expect(after.freelist_count).toBeGreaterThan(before.freelist_count);
      await repo.insert({ id: 'new-after-recovery', workspaceId: 'w',
        createdAt: '2026-11-06T00:00:00.000Z', files: [] });
      expect(await repo.get('new-after-recovery')).not.toBeNull();
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reclaims old Undo during the SAME oversized checkpoint insert before SQLITE_FULL', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-checkpoint-insert-recovery-'));
    const file = path.join(root, 'test.sqlite');
    const db = new SqliteDatabase(file);
    try {
      db.connection.exec('PRAGMA max_page_count = 512');
      db.connection.prepare('INSERT INTO settings(key,value) VALUES (?,?)')
        .run('sqlite_auto_safe_trim_on_limit_v1', 'false');
      const repo = new SqliteCheckpointRepository(db);
      const cap = (db.connection.prepare('PRAGMA max_page_count').get() as { max_page_count: number }).max_page_count
        * (db.connection.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
      let oldCount = 0;
      for (let n = 0; n < 100; n += 1) {
        await repo.insert({ id: 'old-' + String(n).padStart(3, '0'), workspaceId: 'w',
          createdAt: '2025-01-01T00:00:00.000Z',
          files: [{ path: 'file.txt', content: 'x'.repeat(32 * 1024),
            contentSha256: 'a'.repeat(64), size: 32 * 1024 }] });
        oldCount += 1;
        const pages = (db.connection.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
        const freelist = (db.connection.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
        const size = (db.connection.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
        if ((pages - freelist) * size > cap * 0.86) break;
      }
      expect(oldCount).toBeGreaterThan(12);
      // A profile upgraded from an older release may have no checkpoint
      // metadata at all. The actual next file checkpoint must still succeed.
      db.connection.prepare("DELETE FROM checkpoint_storage_meta WHERE checkpoint_id LIKE 'old-%'").run();
      expect(repo.storageMetadataStatus().complete).toBe(false);
      db.connection.prepare('UPDATE settings SET value=? WHERE key=?')
        .run('true', 'sqlite_auto_safe_trim_on_limit_v1');
      const earlier = (db.connection.prepare('SELECT COUNT(*) AS n FROM checkpoints').get() as { n: number }).n;
      await repo.insert({ id: 'new-live-write', workspaceId: 'w',
        createdAt: '2026-11-09T00:00:00.000Z',
        files: [{ path: 'large.txt', content: 'z'.repeat(64 * 1024),
          contentSha256: 'b'.repeat(64), size: 64 * 1024 }] });
      const after = (db.connection.prepare('SELECT COUNT(*) AS n FROM checkpoints').get() as { n: number }).n;
      expect(after).toBeLessThan(earlier);
      expect(await repo.get('new-live-write')).not.toBeNull();
      expect((await repo.list('w', 10)).map((item) => item.id))
        .toEqual(expect.arrayContaining(['new-live-write', 'old-' + String(oldCount - 1).padStart(3, '0')]));
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(db.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never destroys old history for a single checkpoint larger than the whole SQLite cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-too-large-checkpoint-'));
    const file = path.join(root, 'test.sqlite');
    const db = new SqliteDatabase(file);
    try {
      db.connection.exec('PRAGMA max_page_count = 512');
      const repo = new SqliteCheckpointRepository(db);
      for (let n = 0; n < 8; n += 1) {
        await repo.insert({ id: 'preserve-' + n, workspaceId: 'w',
          createdAt: '2025-01-01T00:00:00.000Z', files: [] });
      }
      const before = (db.connection.prepare('SELECT COUNT(*) AS n FROM checkpoints').get() as { n: number }).n;
      await expect(repo.insert({ id: 'cannot-fit', workspaceId: 'w',
        createdAt: '2026-11-09T00:00:00.000Z',
        files: [{ path: 'huge.txt', content: 'x'.repeat(3 * 1024 * 1024),
          contentSha256: 'a'.repeat(64), size: 3 * 1024 * 1024 }] }))
        .rejects.toThrow(/exceeds SQLite Hard Limit/);
      expect(db.connection.prepare('SELECT COUNT(*) AS n FROM checkpoints').get()).toMatchObject({ n: before });
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it('survives a real transient SQLITE_BUSY writer and safely resumes expired Undo cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-checkpoint-lock-retry-'));
    const filename = path.join(root, 'test.sqlite');
    const db = new SqliteDatabase(filename);
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const repo = new SqliteCheckpointRepository(db);
      for (let n = 0; n < 8; n++) {
        await repo.insert({ id: 'locked-' + n, workspaceId: 'w',
          createdAt: n >= 5 ? '2026-11-06T00:00:00.000Z' : '2025-01-01T00:00:00.000Z',
          files: [] });
      }
      db.connection.exec('BEGIN IMMEDIATE');
      releaseTimer = setTimeout(() => {
        if (db.connection.isTransaction) db.connection.exec('ROLLBACK');
      }, 650);
      // The first disposable connection has a 350ms busy timeout.
      // Retry must outlast that lock without an unbounded busy-spin.
      expect(await pruneExpiredFileCheckpointsOffMain(filename, '2026-11-01T00:00:00.000Z')).toBe(5);
      expect((await repo.list('w')).map((item) => item.id)).toEqual(['locked-7', 'locked-6', 'locked-5']);
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      if (releaseTimer !== null) clearTimeout(releaseTimer);
      if (db.connection.isTransaction) db.connection.exec('ROLLBACK');
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps reusing SQLite pages across 12 checkpoint-heavy write/recovery cycles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-checkpoint-soak-'));
    const file = path.join(root, 'test.sqlite');
    const db = new SqliteDatabase(file);
    try {
      db.connection.exec('PRAGMA max_page_count = 512');
      const pageSize = (db.connection.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
      const cap = 512 * pageSize;
      const footprint = (): ReturnType<typeof inspectSqliteHardLimit> => ({
        ...inspectSqliteHardLimit(db.connection, 512),
        requestedBytes: cap, // Use a small equivalent page budget to spare disk I/O.
      });
      const insert = db.connection.prepare(
        'INSERT INTO checkpoints(id,workspace_id,created_at,files_json) VALUES (?,?,?,zeroblob(?))',
      );
      let next = 0;
      let totalDeleted = 0;
      let minPageCount = Number.POSITIVE_INFINITY;
      let maxPageCount = 0;
      for (let cycle = 0; cycle < 12; cycle++) {
        let writes = 0;
        while (footprint().allocatedBytes - footprint().freeBytes < cap * 0.90) {
          insert.run('soak-' + String(next).padStart(6, '0'), 'w',
            '2025-01-01T00:00:00.000Z', 24 * 1024);
          next += 1;
          writes += 1;
          if (writes > 140) throw new Error('Checkpoint soak unexpectedly failed to fill SQLite');
        }
        const result = await recoverOldFileCheckpointsUnderHardLimit({
          pruneExpired: (cutoff: string, batch: number) =>
            pruneExpiredFileCheckpointsOffMain(file, cutoff, batch),
        }, footprint, { nowMs: Date.parse('2026-11-09T00:00:00.000Z'), maxBatches: 4 });
        expect(result.deleted).toBeGreaterThan(0);
        totalDeleted += result.deleted;
        expect(result.remainsPressured).toBe(false);
        const snapshot = footprint();
        maxPageCount = Math.max(maxPageCount, snapshot.allocatedBytes / pageSize);
        minPageCount = Math.min(minPageCount, snapshot.allocatedBytes / pageSize);
        expect(snapshot.allocatedBytes).toBeLessThanOrEqual(cap);
        expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      }
      expect(totalDeleted).toBeGreaterThan(100);
      expect(maxPageCount - minPageCount).toBeLessThan(150);
      const remaining = db.connection.prepare(
        'SELECT id FROM checkpoints ORDER BY created_at DESC,id DESC LIMIT 3',
      ).all() as { id: string }[];
      expect(remaining.map((row) => row.id)).toEqual([
        'soak-' + String(next - 1).padStart(6, '0'),
        'soak-' + String(next - 2).padStart(6, '0'),
        'soak-' + String(next - 3).padStart(6, '0'),
      ]);
      expect(db.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('never creates a canonical database when the file is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-old-checkpoints-missing-'));
    const filename = path.join(root, 'missing.sqlite');
    try {
      await expect(pruneExpiredFileCheckpointsOffMain(filename, '2026-01-01T00:00:00.000Z'))
        .rejects.toThrow(/ENOENT|Canonical SQLite file unavailable/);
      expect(existsSync(filename)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reclaims legacy Undo without complete metadata and keeps the true newest three', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-old-checkpoints-meta-'));
    const filename = path.join(root, 'test.sqlite');
    const db = new SqliteDatabase(filename);
    try {
      const repo = new SqliteCheckpointRepository(db);
      for (let w = 0; w < 2; w++) {
        for (let n = 0; n < 10; n++) {
          await repo.insert({
            id: 'w' + w + '-' + String(n).padStart(2, '0'), workspaceId: 'w' + w,
            createdAt: n >= 7 ? '2026-11-06T00:00:00.000Z' : '2025-01-01T00:00:00.000Z',
            files: [],
          });
        }
      }
      await expect(pruneExpiredFileCheckpointsOffMain(filename, '2026-11-01T00:00:00.000Z', HARD_LIMIT_CHECKPOINT_BATCH + 1))
        .rejects.toThrow(/Invalid automatic/);
      // Simulate old profiles upgraded from before the metadata migration.
      // Leave mixed indexed/unindexed rows, including the newest protected row.
      db.connection.prepare("DELETE FROM checkpoint_storage_meta WHERE checkpoint_id IN ('w0-00', 'w0-01', 'w0-09', 'w1-00', 'w1-09')").run();
      expect(repo.storageMetadataStatus().complete).toBe(false);
      expect(await pruneExpiredFileCheckpointsOffMain(filename, '2026-11-01T00:00:00.000Z')).toBe(14);
      for (let w = 0; w < 2; w++) {
        expect((await repo.list('w' + w)).map((row) => row.id))
          .toEqual(['w' + w + '-09', 'w' + w + '-08', 'w' + w + '-07']);
      }
      // Cleanup must not rewrite or synthesize the preexisting Undo metadata.
      expect(db.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never deletes real newest three when complete metadata has stale timestamps', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-corrupt-checkpoint-meta-'));
    const filename = path.join(root, 'test.sqlite');
    const db = new SqliteDatabase(filename);
    try {
      const repo = new SqliteCheckpointRepository(db);
      for (let n = 0; n < 8; n++) {
        await repo.insert({ id: 'c-' + n, workspaceId: 'w',
          createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, n)).toISOString(), files: [] });
      }
      // Count still matches, so the metadata fast path would trust these rows.
      db.connection.prepare('UPDATE checkpoint_storage_meta SET created_at = ? WHERE checkpoint_id = ?')
        .run('2024-01-01T00:00:00.000Z', 'c-7');
      expect(repo.storageMetadataStatus().complete).toBe(true);
      expect(await pruneExpiredFileCheckpointsOffMain(filename, '2026-01-01T00:00:00.000Z')).toBe(4);
      // A stale metadata row can hide one more eligible old checkpoint.
      // The next recovery pass must not be stranded at zero forever.
      expect(await pruneExpiredFileCheckpointsOffMain(filename, '2026-01-01T00:00:00.000Z')).toBe(1);
      expect((await repo.list('w')).map((row) => row.id)).toEqual(['c-7', 'c-6', 'c-5']);
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds a legacy multi-thousand-row candidate scan without reading Undo content into JS', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-legacy-candidate-scan-'));
    const filename = path.join(root, 'test.sqlite');
    const db = new SqliteDatabase(filename);
    try {
      const insert = db.connection.prepare(
        'INSERT INTO checkpoints (id, workspace_id, created_at, files_json) VALUES (?, ?, ?, ?)',
      );
      db.connection.exec('BEGIN IMMEDIATE');
      try {
        for (let n = 0; n < 30_000; n++) {
          insert.run('legacy-' + String(n).padStart(5, '0'), 'legacy-w',
            n >= 29_997 ? '2026-11-06T00:00:00.000Z' : '2025-01-01T00:00:00.000Z',
            JSON.stringify([{ path: 'old.txt', content: 'x'.repeat(200), size: 200, contentSha256: 'a'.repeat(64) }]));
        }
        db.connection.exec('DELETE FROM checkpoint_storage_meta');
        db.connection.exec('COMMIT');
      } catch (error) {
        if (db.connection.isTransaction) db.connection.exec('ROLLBACK');
        throw error;
      }
      expect((db.connection.prepare('SELECT COUNT(*) AS n FROM checkpoints').get() as { n: number }).n).toBe(30_000);
      const started = Date.now();
      for (let batch = 0; batch < 8; batch++) {
        expect(await pruneExpiredFileCheckpointsOffMain(filename, '2026-11-01T00:00:00.000Z')).toBe(64);
      }
      expect(Date.now() - started).toBeLessThan(20_000);
      expect((db.connection.prepare('SELECT COUNT(*) AS n FROM checkpoints').get() as { n: number }).n)
        .toBe(30_000 - 8 * 64);
      const keep = db.connection.prepare("SELECT id FROM checkpoints WHERE id >= 'legacy-29997' ORDER BY id").all();
      expect(keep).toEqual([{ id: 'legacy-29997' }, { id: 'legacy-29998' }, { id: 'legacy-29999' }]);
      expect(db.connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
