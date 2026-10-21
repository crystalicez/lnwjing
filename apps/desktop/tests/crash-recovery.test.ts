import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CrashDiagnosticsRecorder, RendererRecoveryBarrier, RendererRecoveryPolicy, createCrashEventRecord, readCrashEventHistory } from '../src/main/crash-recovery.js';

const temporaryRoots: string[] = [];
afterEach(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('crash recovery diagnostics', () => {
  it('redacts credentials and bounds crash text without persisting stacks', () => {
    const record = createCrashEventRecord('4.6.1', {
      type: 'main-uncaught-exception',
      signal: 'SIGTERM',
      error: new Error(`Authorization: Bearer secret-token PASSWORD=hunter2 ${'x'.repeat(2_000)}`),
    }, '2026-08-22T00:00:00.000Z');

    const serialized = JSON.stringify(record);
    expect(record.schemaVersion).toBe(2);
    expect(record.timeZone).toBe('Asia/Bangkok');
    expect(record.pid).toBe(process.pid);
    expect(record.memory.rssBytes).toBeGreaterThan(0);
    expect(record.signal).toBe('SIGTERM');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('stack');
    expect(record.errorMessage?.length).toBeLessThanOrEqual(1_000);
  });

  it('uses a local offset timestamp for new records', () => {
    const record = createCrashEventRecord('5.0.1', { type: 'desktop-lifecycle', reason: 'process-exit', exitCode: 0 });
    expect(record.timestamp).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(record.timeZone).toBe('Asia/Bangkok');
  });

  it('writes local NDJSON crash records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-crash-'));
    temporaryRoots.push(root);
    const recorder = new CrashDiagnosticsRecorder(root, '4.6.1');
    recorder.record({ type: 'renderer-gone', processType: 'renderer', reason: 'crashed', exitCode: 1 });

    const content = await readFile(recorder.filePath, 'utf8');
    expect(content).toContain('"type":"renderer-gone"');
    expect(content).toContain('"reason":"crashed"');
  });

  it('reads persisted schema-1/schema-2 history after restart and ignores malformed lines', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-crash-history-'));
    temporaryRoots.push(root);
    const recorder = new CrashDiagnosticsRecorder(root, '5.1.1');
    expect(readCrashEventHistory(root)).toEqual([]);
    recorder.record({ type: 'desktop-lifecycle', processType: 'main', reason: 'desktop-started' });
    const legacy = { schemaVersion: 1, timestamp: '2026-09-16T01:00:00.000Z', appVersion: '5.0.0', type: 'desktop-lifecycle', processType: 'main', reason: 'process-exit', exitCode: 1 };
    const current = createCrashEventRecord('5.1.1', { type: 'renderer-gone', processType: 'renderer', reason: 'crashed', exitCode: 1 }, '2026-09-16T01:01:00.000+07:00');
    await writeFile(recorder.filePath, `${JSON.stringify(legacy)}\nnot-json\n${JSON.stringify(current)}\n`, 'utf8');

    expect(readCrashEventHistory(root)).toEqual([
      expect.objectContaining({ schemaVersion: 1, appVersion: '5.0.0', reason: 'process-exit' }),
      expect.objectContaining({ schemaVersion: 2, appVersion: '5.1.1', reason: 'crashed' }),
    ]);
    expect(readCrashEventHistory(root, 1)).toEqual([
      expect.objectContaining({ schemaVersion: 2, reason: 'crashed' }),
    ]);
  });

  it('persists bounded startup stages in the same local diagnostic stream', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-startup-'));
    temporaryRoots.push(root);
    const recorder = new CrashDiagnosticsRecorder(root, '4.62.2');
    recorder.record({ type: 'desktop-startup', processType: 'main', reason: 'safe-storage:status:begin' });

    const content = await readFile(recorder.filePath, 'utf8');
    expect(content).toContain('"type":"desktop-startup"');
    expect(content).toContain('"reason":"safe-storage:status:begin"');
  });

  it('rate-limits renderer recovery to avoid a crash loop', () => {
    const policy = new RendererRecoveryPolicy();
    expect(policy.shouldRecover('clean-exit', 1_000)).toBe(false);
    expect(policy.shouldRecover('crashed', 1_000)).toBe(true);
    expect(policy.shouldRecover('crashed', 2_000)).toBe(true);
    expect(policy.shouldRecover('oom', 3_000)).toBe(true);
    expect(policy.shouldRecover('crashed', 4_000)).toBe(false);
    expect(policy.shouldRecover('crashed', 5 * 60_000 + 5_000)).toBe(true);
  });

  it('keeps the desktop alive while a crashed renderer replacement is pending', () => {
    const barrier = new RendererRecoveryBarrier();
    expect(barrier.shouldQuitWhenWindowsClosed('win32')).toBe(true);
    expect(barrier.shouldQuitWhenWindowsClosed('darwin')).toBe(false);

    const complete = barrier.begin();
    expect(barrier.isPending()).toBe(true);
    expect(barrier.shouldQuitWhenWindowsClosed('win32')).toBe(false);
    complete();
    complete();

    expect(barrier.isPending()).toBe(false);
    expect(barrier.shouldQuitWhenWindowsClosed('win32')).toBe(true);
  });
});
