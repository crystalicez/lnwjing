import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { electronExecutablePath, terminateProcessTree } from '../e2e/electron-runtime.js';

describe('E2E Electron runtime', () => {
  it.each([
    ['win32', ['electron.exe']],
    ['linux', ['electron']],
    ['darwin', ['Electron.app', 'Contents', 'MacOS', 'Electron']],
  ] as const)('resolves the %s distribution under a checkout containing spaces', (platform, executable) => {
    const desktopRoot = path.resolve('checkout with spaces', 'apps', 'desktop');
    expect(electronExecutablePath(desktopRoot, platform)).toBe(
      path.join(desktopRoot, 'node_modules', 'electron', 'dist', ...executable),
    );
  });

  it.skipIf(process.platform !== 'win32')('accepts a dead Windows PID even if its exit event was missed', async () => {
    const exited = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      exited.once('error', reject);
      exited.once('exit', () => resolve());
    });
    if (exited.pid === undefined) throw new Error('Missing fixture PID');
    const missingExitNotification = Object.assign(new EventEmitter(), {
      pid: exited.pid, exitCode: null, signalCode: null,
    }) as ChildProcess;
    await expect(terminateProcessTree(missingExitNotification)).resolves.toBeUndefined();
  }, 15_000);

  it('terminates an owned live process and permits repeated cleanup', async () => {
    const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000);'], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture did not start')), 5_000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('message', () => { clearTimeout(timer); resolve(); });
      });
      await terminateProcessTree(child);
      if (process.platform === 'win32') {
        // taskkill can remove the process before Node has emitted 'exit'.
        expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      } else {
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      }
      await terminateProcessTree(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) await terminateProcessTree(child);
    }
  });
});
