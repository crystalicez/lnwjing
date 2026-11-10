import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProcessManager } from './process-manager.js';
import { readWindowsContainmentReceipt } from './windows-contained-launch.js';

describe.skipIf(process.platform !== 'win32')('native contained ProcessManager', () => {
  it('accepts zero-active native proof when the close notification is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-native-missing-close-'));
    try {
      const containedRoot = path.join(root, 'managed-processes');
      await mkdir(containedRoot);
      const manager = new ProcessManager(undefined, undefined, undefined, undefined, containedRoot);
      const result = await manager.start({
        executable: process.execPath, args: ['-e', "console.log('PIPE_MARKER')"],
        cwd: root, timeoutMs: 15000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Simulate a still-open inherited pipe: the OS exit fires, but the
      // ProcessManager does not receive Node's later stdio close notification.
      const record = (manager as unknown as { records: Map<string, {
        child: { removeAllListeners(event: string): void };
        nativeCloseObserved?: boolean;
      }> }).records.get(result.value.processId);
      expect(record).toBeDefined();
      record?.child.removeAllListeners('close');
      await expect.poll(() => {
        const status = manager.status(result.value.processId);
        return status.ok ? status.value.state : 'unknown';
      }, { timeout: 12000 }).toBe('exited');
      expect(record?.nativeCloseObserved).not.toBe(true);
      expect(manager.status(result.value.processId)).toMatchObject({ ok: true, value: { exitCode: 0 } });
      const receipt = JSON.parse(await readFile(path.join(containedRoot, result.value.processId,
        'containment.receipt.json'), 'utf8'));
      expect(receipt).toMatchObject({ kind: 'windows_job_v1', activeProcesses: 0 });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  }, 20000);

  it.each(['stopped', 'timed_out'] as const)(
    'preserves an already-completed native result when a host %s request races its receipt',
    async (request) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-native-late-stop-'));
      try {
        const containedRoot = path.join(root, 'managed-processes');
        await mkdir(containedRoot);
        const manager = new ProcessManager(undefined, undefined, undefined, undefined, containedRoot);
        const result = await manager.start({
          executable: process.execPath, args: ['-e', "console.log('TARGET_FINISHED')"],
          cwd: root, timeoutMs: 16000,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const processId = result.value.processId;
        const record = (manager as unknown as { records: Map<string, {
          child: { removeAllListeners(event: string): void };
        }> }).records.get(processId);
        expect(record).toBeDefined();
        // Hold host event delivery until the native OS proof is already on disk.
        // This makes the race repeatable without depending on wall-clock timing.
        record?.child.removeAllListeners('exit');
        record?.child.removeAllListeners('close');
        const receiptPath = path.join(containedRoot, processId, 'containment.receipt.json');
        await expect.poll(async () => readWindowsContainmentReceipt(receiptPath), {
          timeout: 12000,
        }).toMatchObject({ outcome: 'completed', activeProcesses: 0, exitCode: 0 });
        if (request === 'stopped') {
          await manager.stop(processId);
        } else {
          await (manager as unknown as { timeout(record: unknown): Promise<void> }).timeout(record);
        }
        expect(manager.status(processId)).toMatchObject({
          ok: true, value: { state: 'exited', exitCode: 0 },
        });
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
      }
    },
    20000,
  );

  it.each([0, 1] as const)('finalizes nested PowerShell output with the original exit code %i', async (code) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-managed-exit-'));
    try {
      const containedRoot = path.join(root, 'managed-processes');
      await mkdir(containedRoot);
      const manager = new ProcessManager(undefined, undefined, undefined, undefined, containedRoot);
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = await manager.start({
        executable: powershell,
        args: ['-NoProfile', '-NonInteractive', '-Command',
          '& powershell.exe -NoProfile -NonInteractive -Command "Write-Output INNER_TERMINAL; exit ' + code +
          '"; Write-Output TARGET_TERMINAL; exit $LASTEXITCODE'],
        cwd: root, timeoutMs: 18000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const processId = result.value.processId;
      await expect.poll(() => {
        const status = manager.status(processId);
        return status.ok ? status.value.state : 'unknown';
      }, { timeout: 15000 }).toBe(code === 0 ? 'exited' : 'failed');
      const status = manager.status(processId);
      expect(status).toMatchObject({ ok: true, value: { exitCode: code } });
      const logs = manager.logs(processId, { tailLines: 50 });
      expect(logs.ok).toBe(true);
      if (logs.ok) expect(logs.value.entries.map((entry) => entry.text).join('')).toContain('TARGET_TERMINAL');
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  }, 25000);

  it('keeps detached descendants alive until they exit, and then fires verified completion callback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-direct-process-contained-'));
    try {
      const containedRoot = path.join(root, 'managed-processes');
      await mkdir(containedRoot);
      const childFile = path.join(root, 'nested-child.cjs');
      const finished = path.join(root, 'grandchild-done');
      await writeFile(childFile, [
        "const cp=require('node:child_process');",
        "cp.spawn(process.execPath,['-e',`setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'yes'),1100)`,process.argv[2]],{detached:true,stdio:'ignore'}).unref();",
      ].join('\n'));
      let callbacks = 0;
      const manager = new ProcessManager(undefined, undefined, undefined, undefined, containedRoot);
      const result = await manager.start({
        executable: process.execPath, args: [childFile, finished], cwd: root,
        containmentId: '107c1eb1-638e-4d7d-bf47-c47ed7b6d558', timeoutMs: process.env.CI ? 110000 : 15000,
      }, undefined, undefined, (): void => { callbacks++; });
      expect(result).toMatchObject({ ok: true, value: { state: 'running' } });
      if (!result.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(manager.status(result.value.processId)).toMatchObject({ ok: true, value: { state: 'running' } });
      await expect.poll(() => manager.status(result.value.processId).ok
        ? manager.status(result.value.processId).value.state : 'unknown', { timeout: process.env.CI ? 100000 : 12000 }).toBe('exited');
      expect(await readFile(finished, 'utf8')).toBe('yes');
      expect(callbacks).toBe(1);
      const receipt = JSON.parse(await readFile(path.join(containedRoot, '107c1eb1-638e-4d7d-bf47-c47ed7b6d558', 'containment.receipt.json'), 'utf8'));
      expect(receipt).toMatchObject({ kind: 'windows_job_v1', activeProcesses: 0, outcome: 'completed' });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, process.env.CI ? 130000 : 18000);
});