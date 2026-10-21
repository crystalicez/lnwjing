import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityTracker, type ActivitySinkEvent } from './activity-tracker.js';
import { composeActivitySinks, createFileActivitySink, formatActivityLogLine, mcpActivityLogPath } from './activity-log-file.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('mcp activity log file', () => {
  it('resolves the activity log under the shared data path', () => {
    expect(mcpActivityLogPath('C:\\Users\\me\\AppData\\Roaming\\lnwjing')).toMatch(/mcp-activity\.log$/);
  });

  it('writes started and completed NDJSON lines that Live Logs can tail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-activity-'));
    temporaryRoots.push(root);
    const filePath = mcpActivityLogPath(root);
    const tracker = new ActivityTracker(createFileActivitySink(filePath));

    const callId = await tracker.begin('read_file', { workspaceId: 'workspace-1', path: 'src\\app.ts' }, { sessionId: 'session-a' });
    await tracker.end(callId, 'SUCCESS', 4);

    const raw = await readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n').map((line) => JSON.parse(line) as { callId: string; phase: string; toolName: string; workspaceId?: string; sessionId?: string });
    expect(lines).toEqual([
      expect.objectContaining({ callId, phase: 'started', toolName: 'read_file', workspaceId: 'workspace-1', sessionId: 'session-a' }),
      expect.objectContaining({ callId, phase: 'completed', toolName: 'read_file', workspaceId: 'workspace-1', sessionId: 'session-a' }),
    ]);
    expect(formatActivityLogLine({
      callId: 'c1',
      toolName: 'write_file',
      phase: 'completed',
      resultCode: 'FILE_NOT_FOUND',
      durationMs: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      resultMessage: 'missing',
    })).toContain('"toolName":"write_file"');
  });

  it('flushes a large burst in order with no lost events across batch boundaries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-activity-burst-'));
    temporaryRoots.push(root);
    const filePath = mcpActivityLogPath(root);
    const sink = createFileActivitySink(filePath);
    await Promise.all(Array.from({ length: 300 }, (_, index) => sink.record({
      callId: `burst-${index}`, toolName: 'read_file', phase: 'completed',
      resultCode: 'SUCCESS', durationMs: 1, timestamp: '2026-10-21T00:00:00.000Z',
    })));
    const ids = (await readFile(filePath, 'utf8')).trim().split('\n')
      .map((line) => (JSON.parse(line) as { callId: string }).callId);
    expect(ids).toEqual(Array.from({ length: 300 }, (_, index) => `burst-${index}`));
  });

  it('trims a pre-existing oversized log to complete NDJSON rows on its first rotation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-activity-legacy-'));
    temporaryRoots.push(root);
    const filePath = mcpActivityLogPath(root);
    const event = (callId: string): ActivitySinkEvent => ({
      callId, toolName: 'read_file', phase: 'completed', resultCode: 'SUCCESS',
      durationMs: 1, timestamp: '2026-10-21T00:00:00.000Z',
    });
    await writeFile(filePath, Array.from({ length: 32 }, (_, i) => formatActivityLogLine(event(`old-${i}`))).join(''));
    await createFileActivitySink(filePath, { maxBytes: 512 }).record(event('new'));

    const archive = `${filePath}.1`;
    expect((await stat(archive)).size).toBeLessThanOrEqual(512);
    const rows = (await readFile(archive, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { callId: string });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.callId).toBe('old-31');
    expect(await readFile(filePath, 'utf8')).toContain('"callId":"new"');
  });

  it('retains a bounded set of complete NDJSON segments with concurrent activity writers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-activity-rotation-'));
    temporaryRoots.push(root);
    const filePath = mcpActivityLogPath(root);
    const first = createFileActivitySink(filePath, { maxBytes: 512 });
    const second = createFileActivitySink(filePath, { maxBytes: 512 });
    const event = (callId: string): ActivitySinkEvent => ({
      callId, toolName: 'read_file', phase: 'completed', resultCode: 'SUCCESS',
      durationMs: 1, timestamp: '2026-10-21T00:00:00.000Z',
    });
    await Promise.all(Array.from({ length: 24 }, (_, index) =>
      (index % 2 === 0 ? first : second).record(event(`call-${index}`))));

    const { readdir, stat } = await import('node:fs/promises');
    const names = (await readdir(root)).filter((name) => name === 'mcp-activity.log' || /^mcp-activity\.log\.[1-3]$/.test(name));
    expect(names.sort()).toEqual(['mcp-activity.log', 'mcp-activity.log.1', 'mcp-activity.log.2', 'mcp-activity.log.3']);
    const retained = new Set<string>();
    for (const name of names) {
      const segment = path.join(root, name);
      expect((await stat(segment)).size).toBeLessThanOrEqual(512);
      for (const row of (await readFile(segment, 'utf8')).trim().split('\n')) {
        const parsed = JSON.parse(row) as { callId: string; phase: string };
        expect(parsed.phase).toBe('completed');
        expect(retained.has(parsed.callId)).toBe(false);
        retained.add(parsed.callId);
      }
    }
    expect(retained.has('call-23')).toBe(true);
    expect(retained.size).toBeLessThan(24);
  });

  it('waits asynchronously for another runtime holding the SQLite log lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-activity-lock-'));
    temporaryRoots.push(root);
    const filePath = mcpActivityLogPath(root);
    const mutex = new DatabaseSync(`${filePath}.lock.sqlite`, { timeout: 0 });
    mutex.exec('BEGIN IMMEDIATE');
    const pending = createFileActivitySink(filePath).record({
      callId: 'after-lock', toolName: 'read_file', phase: 'completed',
      resultCode: 'SUCCESS', durationMs: 0, timestamp: '2026-10-21T00:00:00.000Z',
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      mutex.exec('ROLLBACK');
      mutex.close();
      await expect(pending).resolves.toBeUndefined();
      expect(await readFile(filePath, 'utf8')).toContain('after-lock');
    } finally {
      if (mutex.isOpen) mutex.close();
    }
  });

  it('limits verbose activity fields without dropping compact correlation', () => {
    const json = formatActivityLogLine({
      callId: 'bounded-call', toolName: 'read_file', phase: 'completed',
      resultCode: 'SUCCESS', durationMs: 0, timestamp: '2026-10-21T00:00:00.000Z',
      targetSummary: 'a'.repeat(20_000), resultMessage: 'b'.repeat(20_000),
    });
    const row = JSON.parse(json) as { callId: string; targetSummary: string; resultMessage: string };
    expect(row.callId).toBe('bounded-call');
    expect(row.targetSummary).toHaveLength(4_096);
    expect(row.resultMessage).toHaveLength(4_096);
  });

  it('still records to later sinks when an earlier activity sink fails', async () => {
    const recorded: ActivitySinkEvent[] = [];
    const sink = composeActivitySinks([
      {
        async record(): Promise<void> {
          throw new Error('file sink unavailable');
        },
      },
      {
        async record(event): Promise<void> {
          recorded.push(event);
        },
      },
    ]);

    await expect(sink.record({
      callId: 'c1',
      toolName: 'read_file',
      phase: 'started',
      resultCode: 'STARTED',
      durationMs: 0,
      timestamp: '2026-08-17T00:00:00.000Z',
    })).rejects.toThrow('file sink unavailable');
    expect(recorded).toHaveLength(1);
  });

  it('serializes only the compact target reference even if a started event carries full detail', () => {
    const raw = formatActivityLogLine({
      callId: 'call-files',
      toolName: 'read_files',
      phase: 'started',
      resultCode: 'STARTED',
      durationMs: 0,
      timestamp: '2026-08-30T00:00:00.000Z',
      targetSummary: 'a.ts, b.ts, c.ts',
      targetDetail: { detailRef: 'call-files', itemCount: 7, preview: ['a.ts', 'b.ts', 'c.ts'], legacyIncomplete: false },
      detail: { kind: 'files', items: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'api_key=super-secret'] },
    } as ActivitySinkEvent & { readonly detail: { readonly kind: 'files'; readonly items: readonly string[] } });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.targetDetail).toEqual({ detailRef: 'call-files', itemCount: 7, preview: ['a.ts', 'b.ts', 'c.ts'], legacyIncomplete: false });
    expect(parsed).not.toHaveProperty('detail');
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('(+');
  });
});
