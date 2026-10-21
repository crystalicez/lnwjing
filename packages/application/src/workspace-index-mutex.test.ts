import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { withWorkspaceIndexMutex } from './workspace-index-mutex.js';

const workerSource = `
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
const { withWorkspaceIndexMutex } = await import(process.argv[2]);
await withWorkspaceIndexMutex(process.argv[3], 'shared', async () => {
  const payload = path.join(process.argv[3], 'payload.json');
  const snapshot = JSON.parse(await readFile(payload, 'utf8'));
  process.send('acquired');
  await once(process, 'message');
  snapshot.facts.push('child');
  await writeFile(payload, JSON.stringify(snapshot));
});
process.disconnect();
`;

describe('workspace index mutex', () => {
  it('serializes another process while allowing another workspace and preserving both updates', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-index-mutex-process-'));
    const payload = path.join(directory, 'payload.json');
    const worker = path.join(directory, 'worker.mjs');
    await writeFile(payload, '{"facts":[]}');
    await writeFile(worker, workerSource);
    const child = spawn(process.execPath, [worker, new URL('./workspace-index-mutex.ts', import.meta.url).href, directory], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    try {
      const [message] = await once(child, 'message');
      expect(message).toBe('acquired');
      const lockDirectory = path.join(directory, '.locks');
      const files = (await readdir(lockDirectory)).filter((file) => file.endsWith('.sqlite'));
      expect(files).toHaveLength(1);
      const probe = new DatabaseSync(path.join(lockDirectory, files[0] ?? ''), { timeout: 0 });
      try {
        expect(() => probe.exec('BEGIN IMMEDIATE')).toThrow(expect.objectContaining({ errcode: 5 }));
      } finally { probe.close(); }
      let waiterRan = false;
      const waiter = withWorkspaceIndexMutex(directory, 'shared', async () => {
        waiterRan = true;
        const snapshot: unknown = JSON.parse(await readFile(payload, 'utf8'));
        expect(snapshot).toEqual({ facts: ['child'] });
        await writeFile(payload, JSON.stringify({ facts: ['child', 'parent'] }));
      });
      await withWorkspaceIndexMutex(directory, 'different', async () => undefined);
      expect(waiterRan).toBe(false);
      child.send('release');
      await waiter;
      expect((await exited)[0]).toBe(0);
      expect(JSON.parse(await readFile(payload, 'utf8'))).toEqual({ facts: ['child', 'parent'] });
    } finally {
      if (child.exitCode === null) { child.kill(); await exited; }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not steal a live lock on timeout and acquires after its holder dies', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-index-mutex-crash-'));
    const payload = path.join(directory, 'payload.json');
    const worker = path.join(directory, 'worker.mjs');
    await writeFile(payload, '{"facts":[]}');
    await writeFile(worker, workerSource);
    const child = spawn(process.execPath, [worker, new URL('./workspace-index-mutex.ts', import.meta.url).href, directory], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    try {
      await once(child, 'message');
      let calls = 0;
      await expect(withWorkspaceIndexMutex(directory, 'shared', async () => { calls += 1; }, { timeoutMs: 50 }))
        .rejects.toThrow('Workspace index is busy');
      expect(calls).toBe(0);
      expect(JSON.parse(await readFile(payload, 'utf8'))).toEqual({ facts: [] });
      const before = (await readdir(path.join(directory, '.locks'))).filter((file) => file.endsWith('.sqlite'));
      const lockPath = path.join(directory, '.locks', before[0] ?? '');
      const identity = await stat(lockPath);
      child.kill();
      await exited;
      await withWorkspaceIndexMutex(directory, 'shared', async () => { calls += 1; });
      expect(calls).toBe(1);
      expect((await readdir(path.join(directory, '.locks'))).filter((file) => file.endsWith('.sqlite'))).toEqual(before);
      const restored = await stat(lockPath);
      expect({ ino: restored.ino, dev: restored.dev }).toEqual({ ino: identity.ino, dev: identity.dev });
    } finally {
      if (child.exitCode === null) { child.kill(); await exited; }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('preserves a mutation error, releases ownership, and aborts a waiting caller', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-index-mutex-error-'));
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holding: Promise<void> | undefined;
    try {
      const failure = new Error('Fixture mutation failed');
      await expect(withWorkspaceIndexMutex(directory, 'shared', async () => { throw failure; })).rejects.toBe(failure);
      holding = withWorkspaceIndexMutex(directory, 'shared', async () => { held.resolve(); await release.promise; });
      await held.promise;
      const controller = new AbortController();
      const waiting = withWorkspaceIndexMutex(directory, 'shared', async () => { throw new Error('Aborted mutation must not run'); }, { signal: controller.signal });
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      release.resolve();
      await holding;
      await expect(withWorkspaceIndexMutex(directory, 'shared', async () => 'recovered')).resolves.toBe('recovered');
    } finally {
      release.resolve();
      await holding;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
