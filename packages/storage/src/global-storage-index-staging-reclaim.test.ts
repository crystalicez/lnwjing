import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reclaimExpiredDisposableFiles } from './global-storage-reclaim.js';
import { GlobalStorageQuotaReservations } from './global-storage-quota.js';

async function departedPid(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 && child.pid !== undefined) resolve(child.pid);
      else reject(new Error('Could not establish a terminated child PID'));
    });
  });
}
const OLD = new Date('2020-01-01T00:00:00Z');
const MIB = 1024 * 1024;
const stageName = (prefix: string, pid: number): string => `${prefix}.${pid}.${randomUUID()}.tmp`;

async function oldFile(filename: string, bytes = 1024): Promise<void> {
  await writeFile(filename, Buffer.alloc(bytes, 5));
  await utimes(filename, OLD, OLD);
}

describe('global quota dead JSON-index staging reclaim', () => {
  it('reclaims only abandoned staging files, never authoritative indexes or active writers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-abandoned-index-'));
    try {
      const index = path.join(root, 'workspace-index');
      await mkdir(index);
      const pid = await departedPid();
      const staleSnapshot = path.join(index, stageName('project.json', pid));
      const staleSidecar = path.join(index, stageName('project.json.meta.json', pid));
      const active = path.join(index, stageName('project.json', process.pid));
      const malformed = path.join(index, `project.json.${pid}.not-an-index-id.tmp`);
      const realIndex = path.join(index, 'project.json');
      const realMetadata = path.join(index, 'project.json.meta.json');
      const realSqlite = path.join(index, 'project.sqlite');
      for (const f of [staleSnapshot, staleSidecar, active, malformed, realIndex, realMetadata, realSqlite]) {
        await oldFile(f);
      }
      const result = await reclaimExpiredDisposableFiles(root);
      expect(result.removed).toBe(2);
      expect(result.removedLogicalBytes).toBe(2048);
      for (const file of [staleSnapshot, staleSidecar]) {
        await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      for (const file of [active, malformed, realIndex, realMetadata, realSqlite]) {
        expect(await readFile(file)).toHaveLength(1024);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  it('will not reclaim recent, hardlinked, or redirected staging names', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-abandoned-index-protected-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-abandoned-index-other-'));
    try {
      const index = path.join(root, 'workspace-index');
      await mkdir(index);
      const pid = await departedPid();
      const recent = path.join(index, stageName('recent.json', pid));
      const outsideUser = path.join(outside, 'important.txt');
      const hardlink = path.join(index, stageName('shared.json', pid));
      await writeFile(recent, 'RECENT');
      await oldFile(outsideUser);
      await link(outsideUser, hardlink);
      await utimes(hardlink, OLD, OLD);
      const summary = await reclaimExpiredDisposableFiles(root);
      expect(summary.removed).toBe(0);
      expect(await readFile(recent, 'utf8')).toBe('RECENT');
      expect(await readFile(outsideUser)).toHaveLength(1024);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 20_000);

  it('ignores an entire redirected index directory rather than following outside the profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-abandoned-index-link-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-abandoned-index-target-'));
    try {
      const file = path.join(outside, stageName('outside.json', await departedPid()));
      await oldFile(file);
      try { await symlink(outside, path.join(root, 'workspace-index'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error: unknown) {
        if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
        throw error;
      }
      expect((await reclaimExpiredDisposableFiles(root)).removed).toBe(0);
      expect(await readFile(file)).toHaveLength(1024);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 20_000);

  it('recovers admission when an expired crash temp caused physical-volume pressure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-abandoned-index-pressure-'));
    try {
      const index = path.join(root, 'workspace-index');
      await mkdir(index);
      const abandoned = path.join(index, stageName('project.json', await departedPid()));
      await oldFile(abandoned, 600 * 1024);
      const quota = new GlobalStorageQuotaReservations(root, {
        availableVolumeBytes: (): bigint => BigInt(64 * MIB + 200 * 1024 + (existsSync(abandoned) ? 0 : 600 * 1024)),
      });
      quota.configure({ limitBytes: 4 * MIB, criticalReserveBytes: 1024 });
      const proof = await quota.reserve(300 * 1024);
      await expect(stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(quota.status()?.activeReservations).toBe(1);
      quota.release(proof);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);
});
