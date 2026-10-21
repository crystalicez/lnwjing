import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProcessManager } from './process-manager.js';

describe.skipIf(process.platform !== 'win32')('native contained ProcessManager', () => {
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