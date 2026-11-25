import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRuntimeDiagnosticsHistory, RuntimeDiagnosticsHistoryRecorder, type RuntimeDiagnosticsSample } from '../src/main/runtime-diagnostics-history.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lnwjing-runtime-diagnostics-'));
  roots.push(root);
  return root;
}

function sample(sequence: number): Omit<RuntimeDiagnosticsSample, 'schemaVersion' | 'capturedAt'> {
  return {
    sessionId: 'session-a',
    uptimeSeconds: sequence,
    memory: {
      rssBytes: 100 + sequence,
      heapTotalBytes: 80 + sequence,
      heapUsedBytes: 50 + sequence,
      externalBytes: 10,
      arrayBuffersBytes: 5,
      totalWorkingSetBytes: 200 + sequence,
      desktopProcessCount: 4,
      byProcessType: { Browser: { count: 1, workingSetBytes: 100 + sequence, privateBytes: 80 + sequence, percentCPUUsage: 1.5 } },
    },
    system: { totalMemoryBytes: 16_000, freeMemoryBytes: 8_000 },
    cpu: { userMicros: sequence * 10, systemMicros: sequence * 5 },
    eventLoop: { idleMs: sequence, activeMs: sequence / 2, utilization: 0.25 },
    activeResources: { Timeout: 2, TCPSocketWrap: 1 },
    search: { active: 1, queued: 2, peakActive: 2, started: sequence, finished: sequence, rejected: 0, cancelled: 0, totalExecutionMs: sequence * 5 },
    logs: {
      totalLines: 3,
      totalRetainedBytes: 300,
      seenMcpDeliveries: 2,
      mcpOccurrences: 2,
      tailPendingBytes: 0,
      sources: {
        tunnel: { lines: 0, retainedBytes: 0, seenKeys: 0 },
        mcp: { lines: 2, retainedBytes: 200, seenKeys: 2 },
        process: { lines: 1, retainedBytes: 100, seenKeys: 1 },
      },
    },
    mcp: {
      toolAvailabilityListeners: sequence,
      calls: sequence,
      completed: sequence,
      successes: sequence,
      errors: 0,
      cancellations: 0,
      active: 0,
      recentErrorClasses: [],
      inFlightByTool: {},
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('RuntimeDiagnosticsHistoryRecorder', () => {
  it('persists a bounded trend and reloads only the newest samples', () => {
    const root = tempRoot();
    let sequence = 0;
    let nowMs = Date.parse('2026-09-18T00:00:00.000Z');
    const recorder = new RuntimeDiagnosticsHistoryRecorder(
      root,
      (): Omit<RuntimeDiagnosticsSample, 'schemaVersion' | 'capturedAt'> => sample(++sequence),
      { maxSamples: 3, intervalMs: 5_000, now: (): Date => new Date(nowMs += 1_000) },
    );

    expect(recorder.captureNow()).toBe(true);
    expect(recorder.captureNow()).toBe(true);
    expect(recorder.captureNow()).toBe(true);
    expect(recorder.captureNow()).toBe(true);

    const history = readRuntimeDiagnosticsHistory(root);
    expect(history).not.toBeNull();
    expect(history?.maxSamples).toBe(3);
    expect(history?.samples).toHaveLength(3);
    expect(history?.samples.map((entry) => entry.uptimeSeconds)).toEqual([2, 3, 4]);
    expect(history?.samples.at(-1)?.mcp.toolAvailabilityListeners).toBe(4);
    expect(history?.samples.at(-1)?.activeResources).toEqual({ Timeout: 2, TCPSocketWrap: 1 });
    expect(history?.samples.at(-1)?.logs.totalRetainedBytes).toBe(300);
    expect(history?.samples.at(-1)?.search?.started).toBe(4);
  });

  it('appends only new samples, bounds journal growth, and recovers a torn append', () => {
    const root = tempRoot();
    let sequence = 0;
    const recorder = new RuntimeDiagnosticsHistoryRecorder(root, () => sample(++sequence));
    for (let i = 0; i < 361; i += 1) expect(recorder.captureNow()).toBe(true);
    const before = statSync(recorder.filePath).size;
    expect(recorder.captureNow()).toBe(true);
    const growth = statSync(recorder.filePath).size - before;
    // One new sample, not a second serialization of the whole history.
    expect(growth).toBeGreaterThan(0);
    expect(growth).toBeLessThan(4096);
    for (let i = 0; i < 119; i += 1) expect(recorder.captureNow()).toBe(true);
    expect(statSync(recorder.filePath).size).toBeLessThan(1024 * 1024);
    expect(readRuntimeDiagnosticsHistory(root)?.samples.map(s => s.uptimeSeconds))
      .toEqual(Array.from({ length: 360 }, (_, i) => 122 + i));
    appendFileSync(recorder.filePath, '{"schemaVersion":1,"samples":[');
    expect(readRuntimeDiagnosticsHistory(root)?.samples.at(-1)?.uptimeSeconds).toBe(481);
    const restarted = new RuntimeDiagnosticsHistoryRecorder(root, () => sample(++sequence));
    expect(restarted.captureNow()).toBe(true);
    expect(readRuntimeDiagnosticsHistory(root)?.samples.at(-1)?.uptimeSeconds).toBe(482);
    expect(readFileSync(restarted.filePath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('recreates a reclaimed journal with the entire retained trend instead of a suffix', () => {
    const root = tempRoot();
    let sequence = 0;
    const recorder = new RuntimeDiagnosticsHistoryRecorder(root, () => sample(++sequence));
    for (let i = 0; i < 10; i++) expect(recorder.captureNow()).toBe(true);
    rmSync(recorder.filePath);
    expect(recorder.captureNow()).toBe(true);
    expect(readRuntimeDiagnosticsHistory(root)?.samples.map(s => s.uptimeSeconds))
      .toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(readFileSync(recorder.filePath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('loads legacy snapshot history without losing samples on first write', () => {
    const root = tempRoot();
    const directory = path.join(root, 'diagnostics');
    mkdirSync(directory);
    writeFileSync(path.join(directory, 'runtime-history.json'), JSON.stringify({
      schemaVersion: 1, intervalMs: 60000, maxSamples: 360,
      samples: [{ schemaVersion: 1, capturedAt: '2026-09-18T00:00:00.000Z', ...sample(1) }],
    }));
    const recorder = new RuntimeDiagnosticsHistoryRecorder(root, () => sample(2));
    expect(recorder.captureNow()).toBe(true);
    expect(readRuntimeDiagnosticsHistory(root)?.samples.map(s => s.uptimeSeconds)).toEqual([1, 2]);
  });

  it('batches periodic disk writes but retains each sample and flushes on stop', () => {
    vi.useFakeTimers();
    try {
      const root = tempRoot();
      let sequence = 0;
      const recorder = new RuntimeDiagnosticsHistoryRecorder(root, () => sample(++sequence), { intervalMs: 5_000 });
      recorder.start();
      expect(readRuntimeDiagnosticsHistory(root)?.samples).toHaveLength(1);
      vi.advanceTimersByTime(20_000);
      expect(recorder.snapshot().samples).toHaveLength(5);
      expect(readRuntimeDiagnosticsHistory(root)?.samples).toHaveLength(1);
      vi.advanceTimersByTime(5_000);
      expect(readRuntimeDiagnosticsHistory(root)?.samples).toHaveLength(6);
      vi.advanceTimersByTime(5_000);
      recorder.stop();
      expect(readRuntimeDiagnosticsHistory(root)?.samples).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });
});
