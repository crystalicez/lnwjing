import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDiskScanLease, type DiskScanLease } from './ripgrep-disk-lease.js';

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
  it('admits at most two different roots and releases capacity without a daemon', async () => {
    const directory = await testDirectory();
    const first = await grant('E:\\project-a', directory);
    const second = await grant('E:\\project-b', directory);
    try {
      expect(await acquireDiskScanLease('E:\\project-c', undefined, { directory, waitMs: 25 })).toEqual({ status: 'busy' });
    } finally {
      await first.release();
      await second.release();
    }
    const third = await grant('E:\\project-c', directory);
    await third.release();
    await third.release();
  });

  it('coordinates capacity with a separately launched Node/MCP process', async () => {
    const directory = await testDirectory();
    const first = await grant('E:\\external-a', directory);
    const second = await grant('E:\\external-b', directory);
    try {
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
      await second.release();
    }
  });

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

  it('rejects pre-aborted scans without touching the coordination directory', async () => {
    const directory = path.join(await testDirectory(), 'does-not-exist');
    const controller = new AbortController();
    controller.abort();
    expect(await acquireDiskScanLease('E:\\busy', controller.signal, { directory })).toEqual({ status: 'aborted' });
  });
});
