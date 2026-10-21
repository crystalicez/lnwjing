import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WindowsProcessTree } from './windows-process-tree.js';

describe('WindowsProcessTree', () => {
  it('does not resolve a successful stop until the target child has exited', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-process-tree-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: root,
      windowsHide: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    try {
      if (child.pid === undefined) throw new Error('fixture process has no PID');
      await new WindowsProcessTree().stop(child, child.pid);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await expect(rm(root, { recursive: true, force: true })).resolves.toBeUndefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses accepted taskkill proof after a late root close without targeting the PID twice', async () => {
    const child = fakeChild();
    let taskkillCalls = 0;
    let waitCalls = 0;
    const tree = new WindowsProcessTree({
      platform: 'win32',
      taskkill: async (): Promise<number> => { taskkillCalls += 1; return 0; },
      waitForExit: async (): Promise<void> => {
        waitCalls += 1;
        if (waitCalls === 1) throw new Error('close event was late');
      },
    });

    await expect(tree.stop(child, 4_242)).rejects.toThrow('close event was late');
    Object.assign(child, { exitCode: 1 });
    await expect(tree.stop(child, 4_242)).resolves.toBeUndefined();
    expect(taskkillCalls).toBe(1);
  });

  it('never retries taskkill against a terminal root when no tree-stop proof exists', async () => {
    const child = fakeChild();
    let taskkillCalls = 0;
    const tree = new WindowsProcessTree({
      platform: 'win32',
      taskkill: async (): Promise<number> => { taskkillCalls += 1; return 128; },
      waitForExit: async (): Promise<void> => undefined,
    });

    await expect(tree.stop(child, 4_242)).rejects.toThrow('exited with code 128');
    Object.assign(child, { exitCode: 1 });
    await expect(tree.stop(child, 4_242)).rejects.toThrow('root exited before tree termination could be verified');
    expect(taskkillCalls).toBe(1);
  });

  it('terminates an externally owned PID tree without a ChildProcess handle', async () => {
    let alive = true;
    let taskkillCalls = 0;
    const tree = new WindowsProcessTree({
      platform: 'win32',
      processIsAlive: (): boolean => alive,
      taskkill: async (): Promise<number> => { taskkillCalls += 1; alive = false; return 0; },
      waitForPidExit: async (): Promise<void> => undefined,
    });
    await expect(tree.stopPid?.(4_242)).resolves.toBeUndefined();
    expect(taskkillCalls).toBe(1);
  });
});

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 4_242,
    exitCode: null,
    signalCode: null,
    kill: (): boolean => true,
  }) as unknown as ChildProcess;
}
