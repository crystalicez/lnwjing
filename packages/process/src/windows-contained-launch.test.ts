import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareWindowsContainedLaunch, pruneVerifiedWindowsContainmentInputs, pruneVerifiedWindowsContainmentRoot, readWindowsContainmentReceipt } from './windows-contained-launch.js';

describe.skipIf(process.platform !== 'win32')('contained launch receipt', () => {
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
