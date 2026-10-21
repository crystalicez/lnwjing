import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditService, redactActivityTargetDetail } from '@lnwjing/audit';
import { SqliteAuditRepository, SqliteDatabase } from '@lnwjing/storage';
import * as desktopServices from '../src/main/desktop-services.js';

const temporaryRoots: string[] = [];
const openDatabases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    try { database.close(); } catch { /* already closed by the test */ }
  }
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type SearchTargetDetails = (
  repository: SqliteAuditRepository,
  candidates: readonly { readonly id: string; readonly detailRef: string | null }[],
  query: string,
) => Promise<readonly string[]>;

type ResolveWorkLogExportRows = (
  repository: SqliteAuditRepository,
  identities: readonly string[],
) => Promise<readonly string[]>;

type WriteSerializedLogRows = (filePath: string, rows: readonly string[]) => Promise<void>;

type StreamWorkLogExportRows = (
  repository: SqliteAuditRepository,
  identities: readonly string[],
) => AsyncIterable<string>;

describe('complete log detail resolution and export', () => {
  it('searches hidden SQLite detail and returns matching row identities only', async () => {
    const fixture = await createAuditFixture('search-call', ['visible-a.ts', 'visible-b.ts', 'visible-c.ts', 'hidden-needle.ts', 'e.ts', 'f.ts', 'g.ts']);
    const search = (desktopServices as unknown as { searchActivityTargetDetails?: SearchTargetDetails }).searchActivityTargetDetails;
    expect(typeof search).toBe('function');
    const matches = await search!(fixture.repository, [
      { id: 'audit:matching-event', detailRef: 'search-call' },
      { id: 'audit:unrelated-event', detailRef: null },
    ], 'hidden-needle');
    expect(matches).toEqual(['audit:matching-event']);
    fixture.database.close();
  });

  it('searches a large candidate set with one batched repository operation instead of one SQLite lookup per row', async () => {
    const search = (desktopServices as unknown as { searchActivityTargetDetails?: SearchTargetDetails }).searchActivityTargetDetails;
    expect(typeof search).toBe('function');
    const calls: { readonly detailRefs: readonly string[]; readonly query: string }[] = [];
    const repository = {
      activityTargetDetailsMatching: async (detailRefs: readonly string[], query: string): Promise<ReadonlySet<string>> => {
        calls.push({ detailRefs: [...detailRefs], query });
        return new Set(['call-499']);
      },
    } as unknown as SqliteAuditRepository;
    const candidates = Array.from({ length: 500 }, (_, index) => ({ id: `audit:${index}`, detailRef: `call-${index}` }));

    await expect(search!(repository, candidates, 'needle')).resolves.toEqual(['audit:499']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.detailRefs).toHaveLength(500);
    expect(calls[0]?.query).toBe('needle');
  });

  it('exports all seven items from a persisted audit row in captured order', async () => {
    const items = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    const fixture = await createAuditFixture('persisted-call', items);
    const events = await fixture.repository.listActivityScoped({ actionPrefix: 'mcp_tool:' }, 10);
    const started = events.find((event) => event.phase === 'started')!;
    const resolveRows = (desktopServices as unknown as { resolveWorkLogExportRows?: ResolveWorkLogExportRows }).resolveWorkLogExportRows;
    expect(typeof resolveRows).toBe('function');
    const rows = await resolveRows!(fixture.repository, [`audit:${started.id}`]);
    expect(rows).toHaveLength(1);
    for (const item of items) expect(rows[0]).toContain(item);
    fixture.database.close();
  });

  it('exports completed structured diagnostics with full identifiers and result metadata', async () => {
    const workspaceId = '372e9384-9628-43be-b766-661cdb591383';
    const goalId = 'e27da685-745f-484c-86c8-235eb8cb42e5';
    const fixture = await createAuditFixture('completed-detail-call', ['input.ts'], false);
    await fixture.audit.recordMcpTool({
      actorId: 'test', actorName: 'test', workspaceId, sessionId: 'session-complete',
      toolName: 'run_goal', callId: 'completed-detail-call', phase: 'completed',
      targetSummary: `goalKey=activity-log-full-detail-no-truncation workspace=${workspaceId}`,
      targetDetail: { detailRef: 'completed-detail-call:completed', itemCount: 4, preview: [], legacyIncomplete: false },
      activityTargetDetail: { kind: 'details', items: [`goalId=${goalId}`, `workspaceId=${workspaceId}`, 'status=active', 'revision=12'] },
      resultCode: 'SUCCESS', durationMs: 9, timestamp: '2026-08-30T00:00:01.000Z',
    });
    expect(await fixture.repository.resolveActivityTargetDetail('completed-detail-call:completed')).toEqual({
      kind: 'details', items: [`goalId=${goalId}`, `workspaceId=${workspaceId}`, 'status=active', 'revision=12'],
    });
    const events = await fixture.repository.listActivityScoped({ actionPrefix: 'mcp_tool:' }, 10);
    const completed = events.find((event) => event.phase === 'completed')!;
    const resolveRows = (desktopServices as unknown as { resolveWorkLogExportRows?: ResolveWorkLogExportRows }).resolveWorkLogExportRows;
    const rows = await resolveRows!(fixture.repository, [`audit:${completed.id}`]);
    expect(rows).toHaveLength(1);
    for (const expected of [
      'เวลา:', 'ประเภท: RESULT', 'เครื่องมือ: run_goal', 'ผลลัพธ์: SUCCESS', 'ระยะเวลา: 9 ms', 'ข้อมูลทางเทคนิค:',
      `eventId=${completed.id}`, 'callId=completed-detail-call', `workspaceId=${workspaceId}`, 'sessionId=session-complete',
      'toolName=run_goal', 'phase=completed', 'resultCode=SUCCESS', 'durationMs=9', `goalId=${goalId}`, 'status=active', 'revision=12',
    ]) expect(rows[0]).toContain(expected);
    expect(rows[0]).not.toContain('…');
    fixture.database.close();
  });

  it('resolves an in-flight identity through its started audit event after completion races export', async () => {
    const items = ['one.ts', 'two.ts', 'three.ts', 'four.ts', 'five.ts', 'six.ts', 'seven.ts', 'eight.ts', 'nine.ts'];
    const fixture = await createAuditFixture('race-call', items, false);
    await fixture.audit.recordMcpTool({
      actorId: 'test', actorName: 'test', toolName: 'read_files', callId: 'race-call', phase: 'completed',
      targetDetail: { detailRef: 'race-call', itemCount: 9, preview: items.slice(0, 3), legacyIncomplete: false },
      resultCode: 'SUCCESS', durationMs: 8, timestamp: '2026-08-30T00:00:01.000Z',
    });
    const resolveRows = (desktopServices as unknown as { resolveWorkLogExportRows?: ResolveWorkLogExportRows }).resolveWorkLogExportRows;
    expect(typeof resolveRows).toBe('function');
    const rows = await resolveRows!(fixture.repository, ['inflight:race-call']);
    expect(rows).toHaveLength(1);
    for (const item of items) expect(rows[0]).toContain(item);
    fixture.database.close();
  });

  it('reports unavailable detail when the referenced audit event has been evicted', async () => {
    const fixture = await createAuditFixture('evicted-call', ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    fixture.database.connection.prepare('DELETE FROM audit_events').run();
    const resolveRows = (desktopServices as unknown as { resolveWorkLogExportRows?: ResolveWorkLogExportRows }).resolveWorkLogExportRows;
    expect(typeof resolveRows).toBe('function');
    const rows = await resolveRows!(fixture.repository, ['inflight:evicted-call']);
    expect(rows).toEqual(['Detail unavailable: the retained audit event no longer exists.']);
    fixture.database.close();
  });

  it('marks retained rows incomplete when their referenced full detail is unavailable', async () => {
    const fixture = await createAuditFixture('missing-detail-call', ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    fixture.database.connection.prepare(
      "UPDATE audit_events SET metadata_json = json_remove(metadata_json, '$.activityTargetDetail') WHERE json_extract(metadata_json, '$.phase') = 'started'",
    ).run();
    const events = await fixture.repository.listActivityScoped({ actionPrefix: 'mcp_tool:' }, 10);
    const started = events.find((event) => event.phase === 'started')!;
    const resolveRows = (desktopServices as unknown as { resolveWorkLogExportRows?: ResolveWorkLogExportRows }).resolveWorkLogExportRows;
    const rows = await resolveRows!(fixture.repository, [`audit:${started.id}`]);
    expect(rows[0]).toContain('รายละเอียดเป้าหมายฉบับเต็มไม่พร้อมใช้งาน รายการนี้อาจไม่ครบ');
    fixture.database.close();
  });

  it('serializes all nine Live Log items through the shared main formatter', () => {
    const formatter = (desktopServices as unknown as {
      formatCompleteTargetDetail?: (base: string, detail: { readonly kind: 'files'; readonly items: readonly string[] } | null, expected: boolean) => string;
    }).formatCompleteTargetDetail;
    expect(typeof formatter).toBe('function');
    const items = ['one.ts', 'two.ts', 'three.ts', 'four.ts', 'five.ts', 'six.ts', 'seven.ts', 'eight.ts', 'nine.ts'];
    const row = formatter!('live row', { kind: 'files', items }, true);
    for (const item of items) expect(row).toContain(item);
  });

  it('streams complete rows to the exported txt file without renderer-formatted content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-log-export-file-'));
    temporaryRoots.push(root);
    const writeRows = (desktopServices as unknown as { writeSerializedLogRows?: WriteSerializedLogRows }).writeSerializedLogRows;
    expect(typeof writeRows).toBe('function');
    const filePath = path.join(root, 'complete-log.txt');
    await writeRows!(filePath, ['row\r\nFiles:\r\n- a.ts\r\n- hidden-nine.ts']);
    expect(await readFile(filePath, 'utf8')).toBe('row\r\nFiles:\r\n- a.ts\r\n- hidden-nine.ts\r\n');
  });

  it('writes to the selected txt path while streaming instead of exposing a tmp-suffixed export', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-log-export-visible-path-'));
    temporaryRoots.push(root);
    const writeRows = (desktopServices as unknown as { writeSerializedLogRows?: (filePath: string, rows: AsyncIterable<string>) => Promise<void> }).writeSerializedLogRows;
    expect(typeof writeRows).toBe('function');
    const filePath = path.join(root, 'lnwjing-process-logs.txt');
    let releaseSecondRow!: () => void;
    const waitForSecondRow = new Promise<void>((resolve) => { releaseSecondRow = resolve; });
    let firstRowYielded!: () => void;
    const firstRowWritten = new Promise<void>((resolve) => { firstRowYielded = resolve; });
    async function* rows(): AsyncIterable<string> {
      yield 'first';
      firstRowYielded();
      await waitForSecondRow;
      yield 'second';
    }
    const writing = writeRows!(filePath, rows());
    await firstRowWritten;
    expect(await readdir(root)).toEqual(['lnwjing-process-logs.txt']);
    releaseSecondRow();
    await writing;
    expect(await readFile(filePath, 'utf8')).toBe('first\r\nsecond\r\n');
  });

  it('resolves the next Work Log detail only after the writer consumes the previous yield', async () => {
    const fixture = await createAuditFixture('backpressure-call', ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    const events = await fixture.repository.listActivityScoped({ actionPrefix: 'mcp_tool:' }, 10);
    const started = events.find((event) => event.phase === 'started')!;
    const streamRows = (desktopServices as unknown as { streamWorkLogExportRows?: StreamWorkLogExportRows }).streamWorkLogExportRows;
    const writeRows = (desktopServices as unknown as { writeSerializedLogRows?: (filePath: string, rows: AsyncIterable<string>) => Promise<void> }).writeSerializedLogRows;
    expect(typeof streamRows).toBe('function');
    let detailResolutions = 0;
    let consumedRows = 0;
    const repository = {
      resolveActivityEvent: (...args: Parameters<SqliteAuditRepository['resolveActivityEvent']>) => fixture.repository.resolveActivityEvent(...args),
      resolveActivityTargetDetail: async (...args: Parameters<SqliteAuditRepository['resolveActivityTargetDetail']>) => {
        detailResolutions += 1;
        if (detailResolutions > 1 && consumedRows === 0) throw new Error('second detail resolved before writer backpressure');
        return fixture.repository.resolveActivityTargetDetail(...args);
      },
    } as SqliteAuditRepository;
    async function* observeConsumption(): AsyncIterable<string> {
      for await (const row of streamRows!(repository, [`audit:${started.id}`, `audit:${started.id}`])) {
        yield row;
        consumedRows += 1;
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-log-export-backpressure-'));
    temporaryRoots.push(root);
    await writeRows!(path.join(root, 'streamed.txt'), observeConsumption());
    expect(detailResolutions).toBe(2);
    expect(consumedRows).toBe(2);
    fixture.database.close();
  });

  it('marks a legacy (+N) export incomplete without mislabeling a complete compact legacy row', async () => {
    const fixture = await createAuditFixture('legacy-export-call', ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    const started = (await fixture.repository.listActivityScoped({ actionPrefix: 'mcp_tool:' }, 10)).find((event) => event.phase === 'started')!;
    fixture.database.connection.prepare(
      "UPDATE audit_events SET target_summary = ?, metadata_json = json_set(json_remove(metadata_json, '$.activityTargetDetail'), '$.targetDetail', json(?)) WHERE id = ?",
    ).run('a.ts, b.ts, c.ts (+1)', JSON.stringify({ detailRef: null, itemCount: 4, preview: ['a.ts', 'b.ts', 'c.ts'], legacyIncomplete: true }), started.id);
    const resolveRows = (desktopServices as unknown as { resolveWorkLogExportRows?: ResolveWorkLogExportRows }).resolveWorkLogExportRows;
    const legacyRows = await resolveRows!(fixture.repository, [`audit:${started.id}`]);
    expect(legacyRows[0]).toContain('Incomplete legacy history');

    fixture.database.connection.prepare(
      "UPDATE audit_events SET target_summary = ?, metadata_json = json_set(metadata_json, '$.targetDetail', json(?)) WHERE id = ?",
    ).run('only.ts', JSON.stringify({ detailRef: null, itemCount: 1, preview: ['only.ts'], legacyIncomplete: true }), started.id);
    const completeRows = await resolveRows!(fixture.repository, [`audit:${started.id}`]);
    expect(completeRows[0]).not.toContain('Incomplete legacy history');
    fixture.database.close();
  });
});

async function createAuditFixture(callId: string, items: readonly string[], complete = true): Promise<{
  readonly database: SqliteDatabase;
  readonly repository: SqliteAuditRepository;
  readonly audit: AuditService;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-log-detail-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.db'));
  openDatabases.push(database);
  const repository = new SqliteAuditRepository(database);
  const audit = new AuditService(repository);
  const detail = redactActivityTargetDetail({ kind: 'files', items });
  await audit.recordMcpTool({
    actorId: 'test', actorName: 'test', toolName: 'read_files', callId, phase: 'started',
    targetSummary: `${items.slice(0, 3).join(', ')} (+${Math.max(0, items.length - 3)})`,
    targetDetail: { detailRef: callId, itemCount: items.length, preview: items.slice(0, 3), legacyIncomplete: false },
    activityTargetDetail: detail, resultCode: 'STARTED', durationMs: 0, timestamp: '2026-08-30T00:00:00.000Z',
  });
  if (complete) {
    await audit.recordMcpTool({
      actorId: 'test', actorName: 'test', toolName: 'read_files', callId, phase: 'completed',
      targetDetail: { detailRef: callId, itemCount: items.length, preview: items.slice(0, 3), legacyIncomplete: false },
      resultCode: 'SUCCESS', durationMs: 4, timestamp: '2026-08-30T00:00:01.000Z',
    });
  }
  return { database, repository, audit };
}
