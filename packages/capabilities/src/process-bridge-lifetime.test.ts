import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { ProcessTreeTerminator } from '@lnwjing/process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}));

import { PowerShellWindowsCapabilityBridge } from './windows-bridge.js';
import { WindowsOcrProcessBridge } from './windows-ocr-backend.js';

beforeEach(() => {
  spawnMock.mockReset();
});

describe('process bridge termination lifetime', () => {
  it('keeps the Windows native bridge pending across a failed tree-stop verification', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { terminator, release, attempts } = delayedRetryTerminator();
    const bridge = new PowerShellWindowsCapabilityBridge({
      scriptPath: 'C:\\lnwjing\\windows-capability-bridge.ps1',
      platform: 'win32',
      terminator,
      terminationRetryMs: 1,
    });
    const controller = new AbortController();
    let settled = false;

    const running = bridge.execute({ capability: 'window', input: { operation: 'list' } }, controller.signal)
      .then((result) => {
        settled = true;
        return result;
      });
    controller.abort();
    await vi.waitFor(() => expect(attempts()).toBeGreaterThanOrEqual(2));
    closeChild(child);
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await expect(running).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });

  it('keeps the OCR helper pending across a failed tree-stop verification', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { terminator, release, attempts } = delayedRetryTerminator();
    const bridge = new WindowsOcrProcessBridge({
      helperPath: 'C:\\lnwjing\\windows-ocr-helper.exe',
      platform: 'win32',
      terminator,
      terminationRetryMs: 1,
    });
    const controller = new AbortController();
    let settled = false;

    const running = bridge.execute({ action: 'ocr', image_base64: 'cG5n' }, controller.signal)
      .then((result) => {
        settled = true;
        return result;
      });
    controller.abort();
    await vi.waitFor(() => expect(attempts()).toBeGreaterThanOrEqual(2));
    closeChild(child);
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await expect(running).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });
});

function fakeChild(): ChildProcess {
  const stdout = new EventEmitter();
  const stderr = Object.assign(new EventEmitter(), { resume: vi.fn() });
  const stdin = { end: vi.fn() };
  return Object.assign(new EventEmitter(), {
    pid: 4_242,
    stdout,
    stderr,
    stdin,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

function closeChild(child: ChildProcess): void {
  Object.assign(child, { exitCode: 1 });
  child.emit('close', 1, null);
}

function delayedRetryTerminator(): {
  readonly terminator: ProcessTreeTerminator;
  readonly release: () => void;
  readonly attempts: () => number;
} {
  let attemptCount = 0;
  let release!: () => void;
  const verified = new Promise<void>((resolve) => { release = resolve; });
  return {
    terminator: {
      async stop(): Promise<void> {
        attemptCount += 1;
        if (attemptCount === 1) throw new Error('tree verification unavailable');
        await verified;
      },
    },
    release,
    attempts: () => attemptCount,
  };
}
