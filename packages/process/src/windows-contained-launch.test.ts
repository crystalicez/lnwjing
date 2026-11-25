import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareWindowsContainedLaunch, pruneVerifiedWindowsContainmentInputs, pruneVerifiedWindowsContainmentRoot, readWindowsContainmentReceipt } from './windows-contained-launch.js';

describe.skipIf(process.platform !== 'win32')('contained launch receipt', () => {
  it('forwards PowerShell host and Console standard output when contained', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-powershell-stdio-'));
    try {
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const invocation = await prepareWindowsContainedLaunch({
        directory: root, executable: powershell, cwd: root, timeoutMs: 10_000,
        args: ['-NoProfile', '-NonInteractive', '-Command',
          'Write-Output "POWERSHELL_HOST_OUTPUT"; [Console]::Out.WriteLine("CONSOLE_OUTPUT"); exit 0'],
      });
      const child = spawn(invocation.executable, [...invocation.args], { windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      const [code] = await once(child, 'close') as [number | null];
      expect(code).toBe(0);
      expect(stdout).toContain('POWERSHELL_HOST_OUTPUT');
      expect(stdout).toContain('CONSOLE_OUTPUT');
      expect(await readWindowsContainmentReceipt(invocation.receiptPath))
        .toMatchObject({ outcome: 'completed', activeProcesses: 0, exitCode: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  it('finishes a nested PowerShell build-like command with a zero-active receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-nested-build-job-'));
    try {
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32',
        'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const invocation = await prepareWindowsContainedLaunch({
        directory: root, executable: powershell, cwd: root, timeoutMs: 12_000,
        args: ['-NoProfile', '-NonInteractive', '-Command',
          '& powershell.exe -NoProfile -NonInteractive -Command "Write-Output NESTED_STEP"; Write-Output READY_PORTABLE; exit $LASTEXITCODE'],
      });
      const child = spawn(invocation.executable, [...invocation.args], { windowsHide: true });
      const closed = once(child, 'close');
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      const [code] = await closed as [number | null];
      expect(code).toBe(0);
      expect(stdout).toContain('NESTED_STEP');
      expect(stdout).toContain('READY_PORTABLE');
      expect(await readWindowsContainmentReceipt(invocation.receiptPath))
        .toMatchObject({ outcome: 'completed', exitCode: 0, activeProcesses: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  it.each(['completed', 'cancelled'] as const)('publishes verified %s receipt and forwards child output', async (outcome) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing job receipt '));
    try {
      const invocation = await prepareWindowsContainedLaunch({
        directory: root, executable: process.execPath, cwd: root, timeoutMs: 10000,
        args: ['-e', outcome === 'completed' ? 'console.log("CHILD_OUTPUT")' : 'console.log("CHILD_OUTPUT");setInterval(()=>{},1000)'],
      });
      const child = spawn(invocation.executable, [...invocation.args], { windowsHide: true });
      const closed = once(child, 'close');
      let stdout = '';
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      if (outcome === 'cancelled') await writeFile(invocation.cancelPath, 'cancel');
      await closed;
      expect(await readWindowsContainmentReceipt(invocation.receiptPath)).toMatchObject({ kind: 'windows_job_v1', outcome, activeProcesses: 0 });
      // No host-side cleanup or shell status call has run.
      for (const name of ['containment.cs', 'containment.json', 'containment.ps1']) {
        await expect(stat(path.join(root, name))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      if (outcome === 'completed') expect(stdout).toContain('CHILD_OUTPUT');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20000);
});

describe('verified one-use native input cleanup', () => {
  it('leaves unfinished launches intact, then drops only disposable inputs after verified exit', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-containment-prune-'));
    const receipt = path.join(directory, 'containment.receipt.json');
    try {
      for (const name of ['containment.cs', 'containment.ps1', 'containment.json']) {
        await writeFile(path.join(directory, name), 'one-use', 'utf8');
      }
      await writeFile(path.join(directory, 'stdout.log'), 'keep evidence', 'utf8');
      expect(await pruneVerifiedWindowsContainmentInputs(receipt)).toBe(0);
      await writeFile(receipt, JSON.stringify({
        kind: 'windows_job_v1', outcome: 'completed', exitCode: 0, activeProcesses: 0,
      }));
      expect(await pruneVerifiedWindowsContainmentInputs(receipt)).toBe(3);
      expect(await pruneVerifiedWindowsContainmentInputs(receipt)).toBe(0);
      expect(await readFile(receipt, 'utf8')).toContain('activeProcesses');
      expect(await readFile(path.join(directory, 'stdout.log'), 'utf8')).toBe('keep evidence');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not clean when native proof says a descendant is still active', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-containment-unverified-'));
    try {
      await writeFile(path.join(directory, 'containment.cs'), 'keep');
      await writeFile(path.join(directory, 'containment.receipt.json'), JSON.stringify({
        kind: 'windows_job_v1', outcome: 'completed', exitCode: 0, activeProcesses: 1,
      }));
      expect(await pruneVerifiedWindowsContainmentInputs(path.join(directory, 'containment.receipt.json'))).toBe(0);
      expect(await readFile(path.join(directory, 'containment.cs'), 'utf8')).toBe('keep');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('bounded native launch cleanup', () => {
  it('prunes old terminal shell sidecars only, preserving requested evidence and uncertain tasks', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-shell-sidecar-cleanup-'));
    const root = await realpath(rawRoot);
    const old = new Date(Date.now() - 10 * 86400 * 1000);
    const ids = [1, 2, 3, 4].map(n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'));
    try {
      for (const [index, id] of ids.entries()) {
        const directory = path.join(root, id);
        await mkdir(directory);
        await writeFile(path.join(directory, 'task.json'), JSON.stringify({
          version: 1, task_id: id, containment: 'windows_job_v1',
          state: index === 1 ? 'running' : 'completed',
          exit_code: index === 3 ? 1 : 0,
          finished_at: index === 2 ? new Date().toISOString() : old.toISOString(),
          include_stdout: true, include_stderr: false,
        }));
        await writeFile(path.join(directory, 'containment.receipt.json'), JSON.stringify({
          kind: 'windows_job_v1', outcome: 'completed', exitCode: 0, activeProcesses: 0,
        }));
        for (const [name, data] of [['worker.pid', '123'], ['worker.started', old.toISOString()],
          ['stdout.log', 'required evidence'], ['stderr.log', 'disabled output']] as const) {
          const file = path.join(directory, name);
          await writeFile(file, data);
          await utimes(file, old, old);
        }
      }
      expect(await pruneVerifiedWindowsContainmentRoot(root, { userConfirmed: true }))
        .toMatchObject({ removedFiles: 0 });
      expect(await pruneVerifiedWindowsContainmentRoot(root, { userConfirmed: true, pruneShellSidecars: true }))
        .toMatchObject({ inspected: 4, removedFiles: 3, nextCursor: null });
      const first = path.join(root, ids[0]!);
      for (const name of ['worker.pid', 'worker.started', 'stderr.log']) {
        await expect(stat(path.join(first, name))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(path.join(first, 'stdout.log'), 'utf8')).toBe('required evidence');
      expect(await readWindowsContainmentReceipt(path.join(first, 'containment.receipt.json'))).toBeDefined();
      expect(await readFile(path.join(first, 'task.json'), 'utf8')).toContain('completed');
      for (const id of ids.slice(1)) {
        expect(await readFile(path.join(root, id, 'worker.pid'), 'utf8')).toBe('123');
        expect(await readFile(path.join(root, id, 'stderr.log'), 'utf8')).toBe('disabled output');
      }
      expect(await pruneVerifiedWindowsContainmentRoot(root, { userConfirmed: true, pruneShellSidecars: true }))
        .toMatchObject({ removedFiles: 0 });
    } finally { await rm(rawRoot, { recursive: true, force: true }); }
  });

  it('never removes native launcher inputs through a redirected directory or receipt', async () => {
    const raw = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-native-link-'));
    const root = await realpath(raw);
    try {
      const outside = path.join(root, 'outside');
      const profile = path.join(root, 'profile');
      await mkdir(outside);
      await mkdir(profile);
      const receipt = JSON.stringify({ kind: 'windows_job_v1', outcome: 'completed', activeProcesses: 0, exitCode: 0 });
      await writeFile(path.join(outside, 'containment.cs'), 'outside canary');
      await writeFile(path.join(outside, 'containment.receipt.json'), receipt);
      const junction = path.join(profile, '00000000-0000-4000-8000-000000000001');
      await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
      expect(await pruneVerifiedWindowsContainmentInputs(path.join(junction, 'containment.receipt.json'))).toBe(0);
      expect(await readFile(path.join(outside, 'containment.cs'), 'utf8')).toBe('outside canary');
      const safe = path.join(profile, '00000000-0000-4000-8000-000000000002');
      await mkdir(safe);
      await writeFile(path.join(safe, 'containment.cs'), 'local canary');
      await link(path.join(outside, 'containment.receipt.json'), path.join(safe, 'containment.receipt.json'));
      expect(await pruneVerifiedWindowsContainmentInputs(path.join(safe, 'containment.receipt.json'))).toBe(0);
      expect(await readFile(path.join(safe, 'containment.cs'), 'utf8')).toBe('local canary');
      await rm(path.join(safe, 'containment.receipt.json'));
      await writeFile(path.join(safe, 'containment.receipt.json'), receipt);
      await link(path.join(outside, 'containment.cs'), path.join(safe, 'containment.ps1'));
      expect(await pruneVerifiedWindowsContainmentInputs(path.join(safe, 'containment.receipt.json'))).toBe(1);
      expect(await readFile(path.join(safe, 'containment.ps1'), 'utf8')).toBe('outside canary');
      expect(await readFile(path.join(outside, 'containment.cs'), 'utf8')).toBe('outside canary');
    } finally { await rm(raw, { recursive: true, force: true }); }
  });

  it('requires confirmation and cursors safely across multiple UUID subdirectories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-native-batch-'));
    const ids = [1, 2, 3].map((n) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`);
    try {
      for (const [index, id] of ids.entries()) {
        if (id === undefined) throw new Error('Missing fixture identity');
        const directory = path.join(root, id);
        await mkdir(directory);
        await writeFile(path.join(directory, 'containment.cs'), 'one-use');
        await writeFile(path.join(directory, 'containment.receipt.json'), JSON.stringify({
          kind: 'windows_job_v1', outcome: 'completed', exitCode: 0,
          activeProcesses: index === 1 ? 1 : 0,
        }));
      }
      await expect(pruneVerifiedWindowsContainmentRoot(root, { userConfirmed: false }))
        .rejects.toThrow(/confirmation/);
      const first = await pruneVerifiedWindowsContainmentRoot(root, {
        userConfirmed: true, maxDirectories: 2,
      });
      expect(first).toEqual({ inspected: 2, removedFiles: 1, nextCursor: ids[1] });
      expect(await readFile(path.join(root, ids[1]!, 'containment.cs'), 'utf8')).toBe('one-use');
      const second = await pruneVerifiedWindowsContainmentRoot(root, {
        userConfirmed: true, maxDirectories: 2, afterName: first.nextCursor!,
      });
      expect(second).toEqual({ inspected: 1, removedFiles: 1, nextCursor: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
