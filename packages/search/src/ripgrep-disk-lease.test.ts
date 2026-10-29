import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDiskScanLease, hasWaitingDiskScanRequests, type DiskScanLease } from './ripgrep-disk-lease.js';

const temporaryDirectories: string[] = [];
async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-search-disk-test-'));
  temporaryDirectories.push(directory);
  return directory;
}
async function grant(root: string, directory: string): Promise<Extract<DiskScanLease, { status: 'granted' }>> {
  const lease = await acquireDiskScanLease(root, undefined, { directory, waitMs: 200 });
  if (lease.status !== 'granted') throw new Error(`Expected disk lease: ${lease.status}`);
  return lease;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })));
});

describe('same-user cross-process ripgrep disk budget', () => {
  it('advertises waiting work only during actual contention and removes its marker on grant', async () => {
    const directory = await testDirectory();
    const holder = await grant('E:\\index', directory);
    expect(await hasWaitingDiskScanRequests({ directory })).toBe(false);
    const waiting = acquireDiskScanLease('E:\\search', undefined, { directory, waitMs: 2_000 });
    try {
      let visible = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await hasWaitingDiskScanRequests({ directory })) {
          visible = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(visible).toBe(true);
      expect((await readdir(directory)).some((name) => name.startsWith('wait-'))).toBe(true);
    } finally {
      await holder.release();
    }
    const resumed = await waiting;
    expect(resumed.status).toBe('granted');
    if (resumed.status === 'granted') await resumed.release();
    expect(await hasWaitingDiskScanRequests({ directory })).toBe(false);
    expect((await readdir(directory)).some((name) => name.startsWith('wait-'))).toBe(false);
  });

  it('admits one heavy disk scan across roots in poteto-mode', async () => {
    const directory = await testDirectory();
    const first = await grant('E:\\project-a', directory);
    try {
      expect(await acquireDiskScanLease('E:\\project-b', undefined, { directory, waitMs: 25 })).toEqual({ status: 'busy' });
      expect(await acquireDiskScanLease('E:\\project-c', undefined, { directory, waitMs: 25 })).toEqual({ status: 'busy' });
    } finally {
      await first.release();
    }
    const third = await grant('E:\\project-c', directory);
    await third.release();
    await third.release();
  });

  it('coordinates capacity with a separately launched Node/MCP process', async () => {
    const directory = await testDirectory();
    const first = await grant('E:\\external-a', directory);
    try {
      expect(await acquireDiskScanLease('E:\\external-b', undefined, { directory, waitMs: 25 })).toEqual({ status: 'busy' });
      const moduleUri = pathToFileURL(path.join(import.meta.dirname, 'ripgrep-disk-lease.ts')).href;
      const script = `import { acquireDiskScanLease } from ${JSON.stringify(moduleUri)};
        const result = await acquireDiskScanLease('E:/external-c', undefined, { directory: process.argv[1], waitMs: 30 });
        process.stdout.write(result.status);
        if (result.status === 'granted') await result.release();`;
      const result = execFileSync(process.execPath, [
        '--experimental-strip-types', '--input-type=module', '-e', script, directory,
      ], { encoding: 'utf8', timeout: 6_000 });
      expect(result).toBe('busy');
    } finally {
      await first.release();
    }
  });

  it('makes a waiting MCP process visible to the indexing process', async () => {
    const directory = await testDirectory();
    const holder = await grant('E:\\index-child', directory);
    const moduleUri = pathToFileURL(path.join(import.meta.dirname, 'ripgrep-disk-lease.ts')).href;
    const script = `import { acquireDiskScanLease } from ${JSON.stringify(moduleUri)};
      const lease = await acquireDiskScanLease('E:/child-search', undefined, { directory: process.argv[1], waitMs: 3000 });
      process.stdout.write(lease.status);
      if (lease.status === 'granted') await lease.release();`;
    const child = spawn(process.execPath, [
      '--experimental-strip-types', '--input-type=module', '-e', script, directory,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const completed = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    try {
      let visible = false;
      for (let attempt = 0; attempt < 90; attempt += 1) {
        visible = await hasWaitingDiskScanRequests({ directory });
        if (visible) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(visible).toBe(true);
      await holder.release();
      expect(await completed).toBe(0);
      expect(output).toBe('granted');
      expect(await hasWaitingDiskScanRequests({ directory })).toBe(false);
    } finally {
      await holder.release();
      if (child.exitCode === null) child.kill();
    }
  }, 8_000);

  it('limits overlapping scans of the same root despite an unused global slot', async () => {
    const directory = await testDirectory();
    const first = await grant('E:\\same', directory);
    try {
      expect(await acquireDiskScanLease('E:\\same', undefined, { directory, waitMs: 25 })).toEqual({ status: 'busy' });
    } finally {
      await first.release();
    }
    const second = await grant('E:\\same', directory);
    await second.release();
  });

  it('removes a visible waiter marker when a queued scan is cancelled', async () => {
    const directory = await testDirectory();
    const holder = await grant('E:\\busy-marker', directory);
    const controller = new AbortController();
    const queued = acquireDiskScanLease('E:\\cancelled-marker', controller.signal, { directory, waitMs: 2_000 });
    try {
      let announced = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        announced = await hasWaitingDiskScanRequests({ directory });
        if (announced) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(announced).toBe(true);
    } finally {
      controller.abort();
    }
    expect(await queued).toEqual({ status: 'aborted' });
    expect(await hasWaitingDiskScanRequests({ directory })).toBe(false);
    await holder.release();
  });

  it('cancels queued scans promptly without leaking global slots', async () => {
    const directory = await testDirectory();
    const first = await grant('E:\\busy', directory);
    const controller = new AbortController();
    const waiting = acquireDiskScanLease('E:\\busy', controller.signal, { directory, waitMs: 2_000 });
    controller.abort();
    expect(await waiting).toEqual({ status: 'aborted' });
    await first.release();
    const next = await grant('E:\\busy', directory);
    await next.release();
  });

  it('reclaims an old orphaned file lock only after verifying its dead owner', async () => {
    const directory = await testDirectory();
    const root = await testDirectory();
    const rootKey = createHash('sha256').update(root.replaceAll('\\', '/').toLowerCase()).digest('hex').slice(0, 24);
    const rootLock = path.join(directory, `root-${rootKey}.lock`);
    await writeFile(rootLock, JSON.stringify({ pid: 99999999, token: 'abandoned' }), 'utf8');
    const old = new Date(Date.now() - 180_000);
    await utimes(rootLock, old, old);
    const recovered = await acquireDiskScanLease(root, undefined, { directory, waitMs: 900 });
    expect(recovered.status).toBe('granted');
    if (recovered.status === 'granted') await recovered.release();
  });

  it('does not treat a dead orphaned request marker as ongoing contention', async () => {
    const directory = await testDirectory();
    const marker = path.join(directory, 'wait-00000000-0000-0000-0000-000000000000.lock');
    await writeFile(marker, JSON.stringify({ pid: 99999999, token: 'orphaned' }));
    const old = new Date(Date.now() - 180_000);
    await utimes(marker, old, old);
    expect(await hasWaitingDiskScanRequests({ directory })).toBe(false);
    expect((await readdir(directory)).some((name) => name.startsWith('wait-'))).toBe(false);
  });

  it('uses the physical root when different directory aliases request a scan', async () => {
    const directory = await testDirectory();
    const physical = await testDirectory();
    const alias = path.join(directory, 'alias-root');
    await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const current = await grant(physical, directory);
    try {
      expect(await acquireDiskScanLease(alias, undefined, { directory, waitMs: 30 })).toEqual({ status: 'busy' });
    } finally {
      await current.release();
    }
  });

  it('rejects pre-aborted scans without touching the coordination directory', async () => {
    const directory = path.join(await testDirectory(), 'does-not-exist');
    const controller = new AbortController();
    controller.abort();
    expect(await acquireDiskScanLease('E:\\busy', controller.signal, { directory })).toEqual({ status: 'aborted' });
  });
});
