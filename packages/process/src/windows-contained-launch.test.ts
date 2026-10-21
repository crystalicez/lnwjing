import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareWindowsContainedLaunch, readWindowsContainmentReceipt } from './windows-contained-launch.js';

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
