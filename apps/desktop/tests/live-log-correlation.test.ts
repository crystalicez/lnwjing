import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activityTargetReference, AuditService, redactActivityTargetDetail } from '@lnwjing/audit';
import { ActivityTracker, type ActivitySinkEvent } from '@lnwjing/mcp-server';
import { SqliteAuditRepository, SqliteDatabase } from '@lnwjing/storage';
import { LogHub } from '../src/main/log-hub.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('live log activity target correlation', () => {
  it('projects 500 dashboard rows without deserializing one event with 500 maximum-length paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-projection-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const maximumLengthPath = `E:\\${'x'.repeat(4_093)}`;
    const detail = redactActivityTargetDetail({ kind: 'files', items: Array.from({ length: 500 }, () => maximumLengthPath) });
    const targetDetail = activityTargetReference('call-large', detail, maximumLengthPath);

    // Keep this regression focused on the storage/dashboard projection. The
    // AuditService redaction path has separate coverage below; running the 2 MB
    // fixture through it again only benchmarks fixture setup on slower CI disks.
    database.connection.exec('BEGIN;');
    try {
      await repository.insert({
        id: 'event-large',
        timestamp: '2026-08-30T00:00:00.000Z',
        actorId: 'test',
        actorName: 'test',
        action: 'mcp_tool:read_files',
        targetSummary: maximumLengthPath,
        resultCode: 'STARTED',
        durationMs: 0,
        metadata: {
          toolName: 'read_files',
          callId: 'call-large',
          phase: 'started',
          targetDetail,
          activityTargetDetail: detail,
        },
      });
      for (let index = 1; index < 500; index += 1) {
        await repository.insert({
          id: `event-${index}`,
          timestamp: `2026-08-30T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
          actorId: 'test',
          actorName: 'test',
          action: 'mcp_tool:git_status',
          resultCode: 'SUCCESS',
          durationMs: 1,
          metadata: {
            toolName: 'git_status',
            callId: `call-${index}`,
            phase: 'completed',
            targetDetail: { detailRef: null, itemCount: 0, preview: [], legacyIncomplete: false },
          },
        });
      }
      database.connection.exec('COMMIT;');
    } catch (error) {
      database.connection.exec('ROLLBACK;');
      throw error;
    }

    const rows = await repository.listActivityScoped({ actionPrefix: 'mcp_tool:' }, 500);
    const snapshot = JSON.stringify(rows);
    expect(rows).toHaveLength(500);
    expect(snapshot).not.toContain('"items"');
    expect(snapshot.length).toBeLessThan(1_000_000);
    const resolved = await repository.resolveActivityTargetDetail('call-large');
    expect(resolved?.items).toHaveLength(500);
    expect(resolved?.items.every((item) => item.length === 4_096)).toBe(true);
    database.close();
  }, 15_000);

  it('persists full sanitized detail once and resolves it lazily by event or call ID', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-audit-target-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const audit = new AuditService(repository);
    const compactEvents: ActivitySinkEvent[] = [];
    const tracker = new ActivityTracker(
      { async record(event): Promise<void> { compactEvents.push(event); } },
      undefined,
      {
        async record(event, detail): Promise<void> {
          await audit.recordMcpTool({
            actorId: 'test', actorName: 'test', toolName: event.toolName, callId: event.callId, phase: event.phase,
            targetSummary: event.targetSummary, targetDetail: event.targetDetail!,
            ...(detail === undefined ? {} : { activityTargetDetail: detail }),
            resultCode: event.resultCode, durationMs: event.durationMs, timestamp: event.timestamp,
          });
        },
      },
    );
    const inputs = ['a.ts', 'a.ts', 'เอกสาร/ไฟล์.ts', 'api_key=super-secret', 'd.ts', 'e.ts', 'f.ts'];
    const callId = await tracker.begin('read_files', { files: inputs.map((filePath) => ({ path: filePath })) });
    await tracker.end(callId, 'SUCCESS', 4);

    const stored = await repository.listByActionPrefix('mcp_tool:', 10);
    const started = stored.find((event) => event.metadata.phase === 'started')!;
    const completed = stored.find((event) => event.metadata.phase === 'completed')!;
    expect(started.metadata.activityTargetDetail).toEqual({
      kind: 'files', items: ['a.ts', 'a.ts', 'เอกสาร/ไฟล์.ts', 'api_key=[REDACTED]', 'd.ts', 'e.ts', 'f.ts'],
    });
    expect(completed.metadata).not.toHaveProperty('activityTargetDetail');
    expect(await repository.resolveActivityTargetDetail(callId)).toEqual(started.metadata.activityTargetDetail);
    expect(await repository.resolveActivityTargetDetail(started.id)).toEqual(started.metadata.activityTargetDetail);

    const rows = await repository.listActivityScoped({ actionPrefix: 'mcp_tool:' }, 10);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.targetDetail.detailRef === callId && row.targetDetail.itemCount === 7)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('"items"');
    expect(JSON.stringify(compactEvents)).not.toContain('d.ts');
    expect(JSON.stringify(stored)).not.toContain('super-secret');
    database.close();
  });

  it('keeps the compact reference from JSONL and decodes legacy lines without detail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-live-log-target-'));
    temporaryRoots.push(root);
    const activityPath = path.join(root, 'mcp-activity.log');
    const current = {
      callId: 'call-current', toolName: 'read_files', phase: 'started', resultCode: 'STARTED', durationMs: 0,
      timestamp: '2026-08-30T00:00:00.000Z', targetSummary: 'a.ts, b.ts, c.ts',
      targetDetail: { detailRef: 'call-current', itemCount: 7, preview: ['a.ts', 'b.ts', 'c.ts'], legacyIncomplete: false },
    };
    const legacy = {
      callId: 'call-legacy', toolName: 'read_files', phase: 'completed', resultCode: 'SUCCESS', durationMs: 1,
      timestamp: '2026-08-30T00:00:01.000Z', targetSummary: 'old-a.ts, old-b.ts (+5)',
    };
    await writeFile(activityPath, `${JSON.stringify(current)}\n${JSON.stringify(legacy)}\n`, 'utf8');
    const hub = new LogHub({ tunnelLogPath: path.join(root, 'missing-tunnel.log'), mcpActivityLogPath: activityPath });
    hub.start();
    hub.stop();

    const lines = hub.snapshot().lines.filter((line) => line.source === 'mcp');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.targetDetail).toEqual(current.targetDetail);
    expect(lines[1]?.targetDetail).toEqual({
      detailRef: null,
      itemCount: 7,
      preview: ['old-a.ts', 'old-b.ts'],
      legacyIncomplete: true,
    });
    expect(JSON.stringify(lines)).not.toContain('"items"');
  });
});
