import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '@lnwjing/audit';
import { SqliteAuditRepository, ROUTINE_READ_RECOVERY_PROBE_SQL, ROUTINE_READ_RECOVERY_DELETE_SQL } from './audit-repository.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteAuditRepository', () => {
  it('keeps paired-call protection on the existing indexed workspace/callId lookup at scale', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      const plans = [ROUTINE_READ_RECOVERY_PROBE_SQL, ROUTINE_READ_RECOVERY_DELETE_SQL]
        .map((sql) => db.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
          ...sql.includes('ORDER BY candidate.timestamp')
            ? ['2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 128]
            : ['2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
        ).map((row) => String(row.detail)).join('\n'));
      for (const plan of plans) {
        expect(plan).toContain('idx_audit_calls_workspace_correlation');
      }
    } finally { db.close(); }
  });
  it('paginates grouped session history without reading every session into JS', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-session-pages-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    try {
      for (let index = 0; index < 6; index += 1) {
        await repository.insert({
          id: `event-${index}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
          actorId: 'client', actorName: 'test', sessionId: `session-${index}`,
          action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1, metadata: {},
        });
      }
      const first = await repository.listActivitySessions('mcp_tool:', 2, 0);
      const second = await repository.listActivitySessions('mcp_tool:', 2, 2);
      expect(first.map((entry) => entry.sessionId)).toEqual(['session-5', 'session-4']);
      expect(second.map((entry) => entry.sessionId)).toEqual(['session-3', 'session-2']);
    } finally {
      database.close();
    }
  });


  it('retains both phases of goal-linked, failed and recently completed calls during routine pruning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-retention-pairs-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const old = '2026-01-01T00:00:00.000Z';
    const recent = '2026-10-20T00:00:00.000Z';
    const add = (id: string, callId: string, phase: 'started' | 'completed', options: {
      sessionId?: string; timestamp?: string; resultCode?: string; goalId?: string;
    } = {}): Promise<void> => repository.insert({
      id, timestamp: options.timestamp ?? old, actorId: 'client', actorName: 'test',
      workspaceId: 'ws', sessionId: options.sessionId ?? 'session-a',
      action: 'mcp_tool:read_file', resultCode: options.resultCode ?? (phase === 'started' ? 'STARTED' : 'SUCCESS'),
      durationMs: 1,
      metadata: { callId, toolName: 'read_file', phase, ...(options.goalId === undefined ? {} : { goalId: options.goalId }) },
    });
    try {
      await add('goal-start', 'goal-call', 'started');
      await add('goal-done', 'goal-call', 'completed', { goalId: 'goal' });
      await add('denied-start', 'denied-call', 'started');
      await add('denied-done', 'denied-call', 'completed', { resultCode: 'PERMISSION_DENIED' });
      await add('recent-start', 'recent-call', 'started');
      await add('recent-done', 'recent-call', 'completed', { timestamp: recent });
      await add('routine-start', 'routine-call', 'started');
      await add('routine-done', 'routine-call', 'completed');
      await add('other-scope-start', 'reused', 'started');
      await add('other-scope-goal', 'reused', 'completed', { sessionId: 'session-b', goalId: 'different-goal' });

      expect(await repository.purgeExpiredRoutineReads('2026-09-01T00:00:00.000Z')).toBe(2);
      const ids = (await repository.list(50)).map((event) => event.id);
      expect(ids).toEqual(expect.arrayContaining([
        'goal-start', 'goal-done', 'denied-start', 'denied-done',
        'recent-start', 'recent-done', 'other-scope-goal', 'other-scope-start',
      ]));
      expect(ids).not.toEqual(expect.arrayContaining(['routine-start', 'routine-done']));
      const page = await repository.listCallHistory({ workspaceId: 'ws', goalId: 'goal', limit: 10 });
      expect(page.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ callId: 'goal-call', startedAt: old }),
      ]));
    } finally {
      database.close();
    }
  });

  it('also ages out exact read-only context tools without treating mixed-action tool audit as disposable', async () => {
    const db = new SqliteDatabase(':memory:');
    const repo = new SqliteAuditRepository(db);
    const actions = [
      'read_many_files', 'search_all', 'git_diff', 'workspace_tree',
      'workspace_context', 'workspace_context_continue',
      'workspace_full_scan', 'workspace_full_scan_continue',
      'workspace_snapshot', 'project_snapshot', 'read_file_page_continue',
    ];
    try {
      for (const action of [...actions, 'tool_batch', 'git', 'computer_use']) {
        await repo.insert({ id: action, action: `mcp_tool:${action}`,
          timestamp: '2025-01-01T00:00:00.000Z', actorId: 'test',
          actorName: 'test', resultCode: 'SUCCESS', durationMs: 0, metadata: {} });
      }
      expect(await repo.purgeExpiredRoutineReads('2026-01-01T00:00:00.000Z')).toBe(actions.length);
      expect((await repo.list(30)).map((row) => row.id).sort())
        .toEqual(['computer_use', 'git', 'tool_batch']);
    } finally { db.close(); }
  });

  it('probes exactly the purgeable rows without changing audit evidence', async () => {
    const database = new SqliteDatabase(':memory:');
    const repository = new SqliteAuditRepository(database);
    const cutoff = '2026-09-01T00:00:00.000Z';
    const add = (id: string, action: string, metadata: AuditEvent['metadata'] = {}, resultCode = 'SUCCESS',
      timestamp = '2026-01-01T00:00:00.000Z'): Promise<void> => repository.insert({
      id, timestamp, actorId: 'test', actorName: 'test', workspaceId: 'ws', sessionId: 'session',
      action, resultCode, durationMs: 1, metadata,
    });
    try {
      expect(repository.hasExpiredRoutineReadCandidates(cutoff)).toBe(false);
      await add('mutation', 'mcp_tool:edit_file');
      await add('goal', 'mcp_tool:read_file', { goalId: 'protected' });
      await add('receipt', 'mcp_tool:search_text', { mutationReceipt: { action: 'edit_file', path: 'a.ts' } });
      await add('start-failed', 'mcp_tool:read_files', { callId: 'failed' }, 'STARTED');
      await add('failed', 'mcp_tool:read_files', { callId: 'failed' }, 'CONFLICT');
      await add('start-recent', 'mcp_tool:read_file_page', { callId: 'recent' }, 'STARTED');
      await add('recent', 'mcp_tool:read_file_page', { callId: 'recent' }, 'SUCCESS', '2026-10-20T00:00:00.000Z');
      expect(repository.hasExpiredRoutineReadCandidates(cutoff)).toBe(false);
      expect((await repository.list(100))).toHaveLength(7);
      expect(await repository.purgeExpiredRoutineReads(cutoff)).toBe(0);
      await add('orphaned-start', 'mcp_tool:read_file', { callId: 'never-completed' }, 'STARTED');
      expect(repository.hasExpiredRoutineReadCandidates(cutoff)).toBe(false);
      await add('routine', 'mcp_tool:search_files');
      expect(repository.hasExpiredRoutineReadCandidates(cutoff)).toBe(true);
      expect((await repository.list(100))).toHaveLength(9);
      expect(await repository.purgeExpiredRoutineReads(cutoff)).toBe(1);
      expect(repository.hasExpiredRoutineReadCandidates(cutoff)).toBe(false);
      expect((await repository.list(100)).map((event) => event.id)).not.toContain('routine');
      expect((await repository.list(100)).map((event) => event.id)).toContain('orphaned-start');
      expect(() => repository.hasExpiredRoutineReadCandidates('invalid')).toThrow('Invalid audit retention cutoff');
    } finally {
      database.close();
    }
  });

  it('prunes expired routine reads in batches but preserves goal, mutation and recent evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-retention-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const before = '2026-07-01T00:00:00.000Z';
    const after = '2026-10-20T00:00:00.000Z';
    const write = (id: string, action: string, timestamp: string, metadata: AuditEvent['metadata'] = {}): Promise<void> =>
      repository.insert({
        id, timestamp, actorId: 'client', actorName: 'test', action,
        resultCode: 'SUCCESS', durationMs: 1, metadata,
      });
    try {
      await write('read-1', 'mcp_tool:read_file', before);
      await write('read-2', 'mcp_tool:read_file', before);
      await write('read-3', 'mcp_tool:search_files', before);
      await write('recent', 'mcp_tool:read_file', after);
      await write('goal', 'mcp_tool:read_file', before, { goalId: 'important' });
      await write('receipt', 'mcp_tool:read_file', before, { mutationReceipt: { path: 'a.ts', action: 'edit_file' } });
      await write('mutation', 'mcp_tool:edit_file', before);
      await write('external', 'codex_run', before);
      await write('old-search', 'mcp_tool:search_text', before);
      await write('old-git-status', 'mcp_tool:git_status', before);

      expect(await repository.purgeExpiredRoutineReads('2026-09-01T00:00:00.000Z', 2)).toBe(2);
      expect(await repository.purgeExpiredRoutineReads('2026-09-01T00:00:00.000Z', 2)).toBe(2);
      expect(await repository.purgeExpiredRoutineReads('2026-09-01T00:00:00.000Z', 2)).toBe(1);
      expect(await repository.purgeExpiredRoutineReads('2026-09-01T00:00:00.000Z', 2)).toBe(0);
      expect((await repository.list(50)).map((entry) => entry.id).sort())
        .toEqual(['recent', 'goal', 'receipt', 'mutation', 'external'].sort());
      await expect(repository.purgeExpiredRoutineReads('not a date')).rejects.toThrow('Invalid audit retention cutoff');
    } finally {
      database.close();
    }
  });

  it('pairs started/completed calls by workspace and session with goal attribution, missing timings and stable keyset pages', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-call-history-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    try {
    const at = (n: number): string => new Date(Date.parse('2026-10-08T00:00:00.000Z') + n * 1000).toISOString();
    const record = (id: string, callId: string, phase: 'started' | 'completed', tick: number, props: Partial<AuditEvent> = {}): Promise<void> =>
      repository.insert({
        id, timestamp: at(tick), actorId: 'client', actorName: 'Tester',
        workspaceId: 'ws-a', sessionId: 'sess-a',
        action: 'mcp_tool:read_file', resultCode: phase === 'started' ? 'STARTED' : 'SUCCESS',
        durationMs: phase === 'started' ? 0 : 11,
        metadata: { callId, toolName: 'read_file', phase, ...(phase === 'completed' ? { goalId: 'goal-verified' } : {}) },
        ...props,
      });
    await record('start-1','call-1','started',1);
    await record('done-1','call-1','completed',5);
    await record('start-2','call-2','started',3);
    await record('done-3','call-3','completed',2, { resultCode: 'CONFLICT', durationMs: 0 });
    await record('other-workspace','call-1','completed',6,{ workspaceId: 'ws-b', sessionId:'sess-b' });
    await record('other-session','call-1','completed',7,{ sessionId:'sess-b' });
    const first = await repository.listCallHistory({ workspaceId: 'ws-a', limit: 1 });
    expect(first.items).toEqual([expect.objectContaining({ eventId:'other-session', callId:'call-1', goalId:'goal-verified', durationMs:11, startedAt:null })]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await repository.listCallHistory({ workspaceId: 'ws-a', limit: 2, cursor: first.nextCursor! });
    expect(second.items).toEqual([
      expect.objectContaining({ eventId:'done-1', callId:'call-1', phase:'completed', durationMs:11, startedAt:at(1) }),
      expect.objectContaining({ callId:'call-2', phase:'started', durationMs:null }),
    ]);
    expect(second.nextCursor).toEqual(expect.any(String));
    const third = await repository.listCallHistory({ workspaceId:'ws-a', limit:2, cursor: second.nextCursor! });
    expect(third.items).toEqual([expect.objectContaining({ callId:'call-3', phase:'completed', durationMs:0, startedAt:null })]);
    expect(third.nextCursor).toBeNull();
    const filtered = await repository.listCallHistory({ workspaceId:'ws-a', goalId:'goal-verified', limit:10 });
    expect(filtered.items.map((item)=>item.callId)).toEqual(['call-1','call-1','call-3']);
    expect([...await repository.listWorkspaceGoalIdsWithEvidence('ws-a', 'calls')]).toEqual(['goal-verified']);
    expect([...await repository.listWorkspaceGoalIdsWithEvidence('ws-b', 'calls')]).toEqual(['goal-verified']);
    expect([...await repository.listWorkspaceGoalIdsWithEvidence('ws-a', 'receipts')]).toEqual([]);
    await repository.insert({
      id:'receipt-1', timestamp:at(9), actorId:'client', actorName:'Tester', workspaceId:'ws-a',sessionId:'sess-a',
      action:'mcp_tool:edit_file', resultCode:'SUCCESS', durationMs:4,
      metadata:{goalId:'goal-receipt',phase:'completed',mutationReceipt:{path:'src/a.ts',action:'edit_file'}},
    });
    expect([...await repository.listWorkspaceGoalIdsWithEvidence('ws-a','receipts')]).toEqual(['goal-receipt']);
    expect([...await repository.listWorkspaceGoalIdsWithEvidence('ws-b','receipts')]).toEqual([]);
    await repository.insert({
      id:'invalid-call',timestamp:at(10),actorId:'client',actorName:'Tester',workspaceId:'ws-a',sessionId:'sess-a',
      action:'mcp_tool:read_file',resultCode:'SUCCESS',durationMs:3,
      metadata:{callId:123,toolName:'read_file',phase:'completed',goalId:'phantom-call'},
    });
    await repository.insert({
      id:'invalid-receipt',timestamp:at(11),actorId:'client',actorName:'Tester',workspaceId:'ws-a',sessionId:'sess-a',
      action:'mcp_tool:edit_file',resultCode:'SUCCESS',durationMs:3,
      metadata:{phase:'completed',goalId:'phantom-receipt',mutationReceipt:{wrongField:true}},
    });
    expect([...await repository.listWorkspaceGoalIdsWithEvidence('ws-a','calls')]).toEqual(['goal-verified']);
    expect([...await repository.listWorkspaceGoalIdsWithEvidence('ws-a','receipts')]).toEqual(['goal-receipt']);
    await expect(repository.listCallHistory({ workspaceId:'ws-a', limit:10,cursor:'bad!cursor' })).rejects.toThrow('Invalid audit cursor');
    } finally { database.close(); }
  });


  it('persists sanitized audit metadata through the audit migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const event: AuditEvent = {
      id: 'event-1',
      timestamp: new Date(0).toISOString(),
      actorId: 'client-1',
      actorName: 'test',
      workspaceId: 'workspace-1',
      action: 'read_file',
      resultCode: 'SUCCESS',
      durationMs: 4,
      metadata: { path: 'src/index.ts' },
    };

    await repository.insert(event);

    await expect(repository.list(10)).resolves.toEqual([event]);
    database.close();
  });

  it('round-trips session scope and applies workspace/session filters before LIMIT', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-scope-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);

    const targetEvents: AuditEvent[] = [
      scopedEvent('target-1', '2026-08-20T00:00:01.000Z', 'workspace-target', 'session-a'),
      scopedEvent('target-2', '2026-08-20T00:00:02.000Z', 'workspace-target', 'session-a'),
      scopedEvent('target-b', '2026-08-20T00:00:03.000Z', 'workspace-target', 'session-b'),
    ];
    for (const event of targetEvents) await repository.insert(event);
    for (let index = 0; index < 25; index += 1) {
      await repository.insert(scopedEvent(
        `noise-${index}`,
        `2026-08-21T00:00:${String(index).padStart(2, '0')}.000Z`,
        'workspace-noise',
        'session-noise',
      ));
    }

    await expect(repository.listScoped({
      actionPrefix: 'mcp_tool:',
      workspaceId: 'workspace-target',
      sessionId: 'session-a',
    }, 2)).resolves.toEqual([targetEvents[1], targetEvents[0]]);
    await expect(repository.listScoped({ workspaceId: 'workspace-target', sessionId: 'session-b' }, 10))
      .resolves.toEqual([targetEvents[2]]);
    database.close();
  }, 20_000);

  it('lists historical activity sessions independently of the 500-row event window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-session-catalog-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const base = Date.parse('2026-08-21T00:00:00.000Z');
    database.connection.exec('BEGIN');
    try {
      await repository.insert(scopedEvent('old-session-event', '2026-08-20T00:00:00.000Z', 'workspace-old', 'session-old'));
      for (let index = 0; index < 520; index += 1) {
        await repository.insert(scopedEvent(
          `noise-${index}`,
          new Date(base + index * 1_000).toISOString(),
          'workspace-new',
          'session-new',
        ));
      }
      database.connection.exec('COMMIT');
    } catch (error) {
      database.connection.exec('ROLLBACK');
      throw error;
    }

    const sessions = await repository.listActivitySessions('mcp_tool:');
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'session-old', workspaceId: 'workspace-old', startedAt: '2026-08-20T00:00:00.000Z' }),
      expect.objectContaining({ sessionId: 'session-new', workspaceId: 'workspace-new' }),
    ]));
    database.close();
  }, 20_000);

  it('preserves legacy null session scope during migration and can query it explicitly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-legacy-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const legacy: AuditEvent = {
      id: 'legacy-event', timestamp: '2026-08-20T00:00:00.000Z', actorId: 'legacy', actorName: 'legacy',
      action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1, metadata: {},
    };
    const scoped = scopedEvent('scoped-event', '2026-08-20T00:00:01.000Z', 'workspace-1', 'session-1');
    await repository.insert(legacy);
    await repository.insert(scoped);

    await expect(repository.listScoped({ workspaceId: null, sessionId: null }, 10)).resolves.toEqual([legacy]);
    database.close();
  });

  it('uses indexed event IDs and the existing workspace-call index to search Work Log details', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-index-search-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    try {
      const repository = new SqliteAuditRepository(database);
      const base = {
        actorId: 'test', actorName: 'test', workspaceId: 'workspace-a',
        action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 0,
      } as const;
      await repository.insert({
        ...base, id: 'started-indexed', timestamp: '2026-08-20T00:00:00.000Z',
        metadata: { callId: 'same-call', phase: 'started',
          activityTargetDetail: { kind: 'files', items: ['secret-index-needle.ts'] } },
      });
      await repository.insert({
        ...base, id: 'completed-indexed', timestamp: '2026-08-20T00:00:01.000Z',
        metadata: { callId: 'same-call', phase: 'completed' },
      });
      const scoped = await repository.activityTargetScopedRefsMatching([
        { id: 'inflight:scoped-a', detailRef: 'same-call', workspaceId: 'workspace-a' },
        { id: 'inflight:wrong-scope', detailRef: 'same-call', workspaceId: 'workspace-b' },
      ], 'secret-index');
      expect(scoped).toEqual(new Set(['inflight:scoped-a']));
      const matches = await repository.activityTargetEventIdsMatching([
        { id: 'started-indexed', detailRef: 'same-call' },
        { id: 'completed-indexed', detailRef: 'same-call' },
        { id: 'not-present', detailRef: 'missing' },
      ], 'secret-index');
      expect(matches.checked).toEqual(new Set(['started-indexed', 'completed-indexed']));
      expect(matches.matched).toEqual(new Set(['started-indexed', 'completed-indexed']));
      const plan = database.connection.prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM audit_events WHERE id IN (SELECT value FROM json_each(?))",
      ).all(JSON.stringify(['started-indexed'])) as { detail: string }[];
      expect(plan.some((row) => /SEARCH audit_events USING INDEX|SEARCH audit_events USING COVERING INDEX/.test(row.detail))).toBe(true);
      const secondaryPlan = database.connection.prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM audit_events INDEXED BY idx_audit_calls_workspace_correlation WHERE workspace_id IS ? AND json_extract(metadata_json, '$.callId') = ?",
      ).all('workspace-a', 'same-call') as { detail: string }[];
      expect(secondaryPlan.some((row) => row.detail.includes('idx_audit_calls_workspace_correlation'))).toBe(true);
    } finally { database.close(); }
  });

  it('batches real scoped SQLite detail searches without mixing workspace or phase', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteAuditRepository(database);
      const candidates: { id: string; detailRef: string; workspaceId: string | null }[] = [];
      const expected = new Set<string>();
      for (let i = 0; i < 65; i += 1) {
        const callId = 'batch-' + i;
        for (const workspaceId of ['workspace-a', 'workspace-b', null]) {
          for (const phase of ['started', 'completed']) {
            const id = [workspaceId, callId, phase].join(':');
            const match = i % 3 === 0 && workspaceId !== 'workspace-b' && phase === 'completed';
            await repository.insert({
              id, timestamp: '2026-08-20T00:00:00.000Z',
              actorId: 'test', actorName: 'test', ...(workspaceId === null ? {} : { workspaceId }),
              action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 0,
              metadata: { callId, phase, activityTargetDetail: { kind: 'files', items: [match ? 'Needle.ts' : 'other.ts'] } },
            });
            candidates.push({ id, workspaceId, detailRef: callId + (phase === 'completed' ? ':completed' : '') });
            if (match) expected.add(id);
          }
        }
      }
      candidates.push({ id: 'missing', detailRef: 'missing', workspaceId: null },
        { id: 'empty', detailRef: ':completed', workspaceId: null },
        { id: 'duplicate-ref', detailRef: 'batch-0:completed', workspaceId: null });
      expected.add('duplicate-ref');
      const before = database.connection.prepare('SELECT total_changes() AS changes').get()?.changes;
      const prototype = Object.getPrototypeOf(database.connection.prepare('SELECT 1'));
      const get = vi.spyOn(prototype, 'get');
      const all = vi.spyOn(prototype, 'all');
      let sql = '';
      let parameters: unknown[] = [];
      try {
        const actual = await repository.activityTargetScopedRefsMatching(candidates, ' NEEDLE ');
        expect(actual).toEqual(expected);
        // Count actual native SQLite executions; no mocked query results.
        expect(get.mock.calls.length + all.mock.calls.length).toBeLessThanOrEqual(Math.ceil(candidates.length / 32));
        sql = (all.mock.contexts[0] as { sourceSQL: string }).sourceSQL;
        parameters = all.mock.calls[0] ?? [];
      } finally {
        get.mockRestore();
        all.mockRestore();
      }
      const plan = database.connection.prepare('EXPLAIN QUERY PLAN ' + sql)
        .all(...parameters as [string, string]).map((row) => String(row.detail)).join('\n');
      expect(plan).toMatch(/SEARCH audit_events (?:EXISTS )?USING INDEX idx_audit_calls_workspace_correlation .*workspace_id=\?.*<expr>=\?/);
      expect(database.connection.prepare('SELECT total_changes() AS changes').get()?.changes).toBe(before);
    } finally { database.close(); }
  });

  it('uses primary-key and workspace-call indexed seeks to resolve full detail and in-flight export', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-indexed-resolve-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    try {
      const repo = new SqliteAuditRepository(database);
      for (const [workspaceId, suffix] of [['workspace-a', 'one'], ['workspace-b', 'two']] as const) {
        await repo.insert({
          id: `start-${suffix}`, timestamp: `2026-08-20T00:00:0${suffix === 'one' ? 1 : 2}.000Z`,
          actorId: 'test', actorName: 'test', workspaceId,
          action: 'mcp_tool:read_file', resultCode: 'STARTED', durationMs: 0,
          metadata: {
            callId: 'shared-id', phase: 'started', toolName: 'read_file',
            activityTargetDetail: { kind: 'files', items: [`${suffix}.ts`] },
          },
        });
      }
      await expect(repo.resolveActivityTargetDetail('shared-id', 'workspace-a'))
        .resolves.toEqual({ kind: 'files', items: ['one.ts'] });
      await expect(repo.resolveActivityTargetDetail('shared-id', 'workspace-b'))
        .resolves.toEqual({ kind: 'files', items: ['two.ts'] });
      await expect(repo.resolveActivityTargetDetail('start-one'))
        .resolves.toEqual({ kind: 'files', items: ['one.ts'] });
      expect((await repo.resolveActivityEvent('shared-id', 'started-call', 'workspace-a'))?.id).toBe('start-one');
      expect((await repo.resolveActivityEvent('shared-id', 'started-call', 'workspace-b'))?.id).toBe('start-two');
      expect((await repo.resolveActivityEvent('start-two'))?.id).toBe('start-two');

      // Exact event IDs must never override an explicitly requested workspace.
      // A colliding event ID belongs to B, but A has a call with that same ID.
      await repo.insert({
        id: 'collision-id', timestamp: '2026-08-20T00:00:03.000Z',
        actorId: 'test', actorName: 'test', workspaceId: 'workspace-b',
        action: 'mcp_tool:read_file', resultCode: 'STARTED', durationMs: 0,
        metadata: {
          callId: 'different-call', phase: 'started', toolName: 'read_file',
          activityTargetDetail: { kind: 'files', items: ['wrong-workspace.txt'] },
        },
      });
      await repo.insert({
        id: 'event-a', timestamp: '2026-08-20T00:00:04.000Z',
        actorId: 'test', actorName: 'test', workspaceId: 'workspace-a',
        action: 'mcp_tool:read_file', resultCode: 'STARTED', durationMs: 0,
        metadata: {
          callId: 'collision-id', phase: 'started', toolName: 'read_file',
          activityTargetDetail: { kind: 'files', items: ['correct-workspace.txt'] },
        },
      });
      await expect(repo.resolveActivityTargetDetail('collision-id', 'workspace-a')).resolves.toEqual({
        kind: 'files', items: ['correct-workspace.txt'],
      });
      await expect(repo.resolveActivityTargetDetail('collision-id', 'workspace-b')).resolves.toEqual({
        kind: 'files', items: ['wrong-workspace.txt'],
      });
      await expect(repo.resolveActivityEvent('collision-id', 'event', 'workspace-a')).resolves.toBeNull();
      expect((await repo.resolveActivityEvent('collision-id', 'started-call', 'workspace-a'))?.id).toBe('event-a');

      const plans = [
        database.connection.prepare('EXPLAIN QUERY PLAN SELECT id FROM audit_events WHERE id = ? LIMIT 1').all('start-one'),
        database.connection.prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM audit_events INDEXED BY idx_audit_calls_workspace_correlation WHERE workspace_id IS ? AND json_extract(metadata_json, '$.callId') = ? AND json_extract(metadata_json, '$.phase') = 'started' ORDER BY timestamp DESC, id DESC LIMIT 1",
        ).all('workspace-a', 'shared-id'),
        database.connection.prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM audit_events INDEXED BY idx_audit_calls_workspace_correlation WHERE workspace_id IS ? AND json_extract(metadata_json, '$.callId') IN (SELECT value FROM json_each(?))",
        ).all('workspace-b', JSON.stringify(['shared-id'])),
      ] as { detail: string }[][];
      for (const plan of plans) {
        expect(plan.some((row) => row.detail.includes('SEARCH audit_events'))).toBe(true);
        expect(plan.some((row) => row.detail.includes('SCAN audit_events'))).toBe(false);
      }
    } finally {
      database.close();
    }
  });

  it('finds recent activity for a quiet workspace even after 550 newer events elsewhere', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-recent-projects-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    try {
      const repo = new SqliteAuditRepository(database);
      const baseline = Date.parse('2026-11-02T04:19:00.000Z');
      database.connection.exec('BEGIN');
      try {
        await repo.insert({
          id: 'quiet-recent', timestamp: '2026-11-02T04:18:00.000Z',
          actorId: 'test', actorName: 'test', workspaceId: 'quiet',
          action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1,
          metadata: { phase: 'completed', toolName: 'read_file', callId: 'quiet-call' },
        });
        for (let index = 0; index < 550; index += 1) {
          await repo.insert({
            id: `loud-${index}`, timestamp: new Date(baseline + index).toISOString(),
            actorId: 'test', actorName: 'test', workspaceId: 'loud',
            action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1,
            metadata: { phase: 'completed', toolName: 'read_file', callId: `loud-${index}` },
          });
        }
        database.connection.exec('COMMIT');
      } catch (error) { database.connection.exec('ROLLBACK'); throw error; }
      const globalPage = await repo.listActivityScoped({ actionPrefix: 'mcp_tool:' }, 500);
      expect(globalPage.some((entry) => entry.id === 'quiet-recent')).toBe(false);
      expect(repo.listRecentMcpWorkspaceActivity('2026-11-02T04:15:00.000Z', '2026-11-02T04:21:00.000Z'))
        .toEqual([
          { workspaceId: 'loud', timestamp: new Date(baseline + 549).toISOString() },
          { workspaceId: 'quiet', timestamp: '2026-11-02T04:18:00.000Z' },
        ]);
      const plan = database.connection.prepare(
        "EXPLAIN QUERY PLAN SELECT workspace_id, MAX(timestamp) FROM audit_events INDEXED BY idx_audit_events_timestamp WHERE timestamp >= ? AND timestamp <= ? AND workspace_id IS NOT NULL AND action LIKE 'mcp_tool:%' GROUP BY workspace_id",
      ).all('2026-11-02T04:15:00.000Z', '2026-11-02T04:21:00.000Z') as { detail: string }[];
      expect(plan.some((entry) => entry.detail.includes('SEARCH audit_events USING INDEX idx_audit_events_timestamp'))).toBe(true);
    } finally { database.close(); }
  });

  it('resolves legacy unscoped references in registered workspaces beyond the old 512 limit', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repo = new SqliteAuditRepository(database);
      database.connection.exec('BEGIN');
      try {
        const addWorkspace = database.connection.prepare(
          'INSERT INTO workspaces(id, display_name, root_path, real_root_path, created_at) VALUES(?,?,?,?,?)',
        );
        for (let i = 0; i < 513; i += 1) {
          const id = `workspace-${String(i).padStart(3, '0')}`;
          addWorkspace.run(id, id, `E:\\\\fixture\\\\${id}`, `E:\\\\fixture\\\\${id}`, '2026-01-01T00:00:00.000Z');
        }
        await repo.insert({
          id: 'legacy-beyond-512', timestamp: '2026-01-01T00:00:00.000Z',
          actorId: 'test', actorName: 'test', workspaceId: 'workspace-512',
          action: 'mcp_tool:read_file', resultCode: 'STARTED', durationMs: 0,
          metadata: { callId: 'old-call-id', phase: 'started', toolName: 'read_file',
            activityTargetDetail: { kind: 'files', items: ['beyond-limit.ts'] } },
        });
        // Hide it from the bounded recent fallback to verify actual scope enumeration.
        for (let i = 0; i < 1030; i += 1) {
          await repo.insert({
            id: `new-${i}`, timestamp: new Date(Date.parse('2026-11-02T04:20:00Z') + i).toISOString(),
            actorId: 'test', actorName: 'test', workspaceId: 'workspace-000',
            action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1,
            metadata: { callId: `new-${i}`, phase: 'completed', toolName: 'read_file' },
          });
        }
        database.connection.exec('COMMIT');
      } catch (error) { database.connection.exec('ROLLBACK'); throw error; }
      await expect(repo.resolveActivityTargetDetail('old-call-id')).resolves.toEqual({
        kind: 'files', items: ['beyond-limit.ts'],
      });
      expect((await repo.resolveActivityEvent('old-call-id', 'started-call'))?.id).toBe('legacy-beyond-512');
    } finally { database.close(); }
  });

  it('batch-searches retained target detail by call id, event id, and completed reference', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-detail-search-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const base = {
      actorId: 'client-1', actorName: 'test', action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1,
    } as const;
    await repository.insert({
      ...base,
      id: 'started-a',
      timestamp: '2026-08-20T00:00:00.000Z',
      metadata: {
        callId: 'call-a', phase: 'started', toolName: 'read_file',
        activityTargetDetail: { kind: 'files', items: ['visible.ts', 'hidden-needle.ts'] },
      },
    });
    await repository.insert({
      ...base,
      id: 'completed-a',
      timestamp: '2026-08-20T00:00:01.000Z',
      metadata: {
        callId: 'call-a', phase: 'completed', toolName: 'read_file',
        activityTargetDetail: { kind: 'details', items: ['completed-needle'] },
      },
    });

    await expect(repository.activityTargetDetailsMatching(
      ['call-a', 'started-a', 'call-a:completed', 'missing-ref'],
      'needle',
    )).resolves.toEqual(new Set(['call-a', 'started-a', 'call-a:completed']));
    await expect(repository.activityTargetDetailsMatching(['call-a'], 'absent')).resolves.toEqual(new Set());
    database.close();
  });

});


function scopedEvent(id: string, timestamp: string, workspaceId: string, sessionId: string): AuditEvent {
  return {
    id, timestamp, actorId: 'client-1', actorName: 'test', workspaceId, sessionId,
    action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1, metadata: { callId: id },
  };
}
