import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@lnwjing/workspace';
import { WorkspaceIndexService } from './workspace-index.js';
import { SqliteWorkspaceIndexStore } from './workspace-index-sqlite.js';

const RUN_PHYSICAL = process.env.LNWJING_RUN_PHYSICAL_INDEX_SCALE === '1';
const FIXTURE_ROOT = path.resolve(import.meta.dirname, '../../..', '.audit');
const FILES_PER_PROJECT = 30_000;
const PROJECT_COUNT = 2;
const LARGE_SPARSE_BYTES = 21 * 1024 * 1024 * 1024;

describe.skipIf(!RUN_PHYSICAL)('isolated Windows large filesystem workspace index smoke', () => {
  it('indexes 2 physical >30k-file roots, skips sparse binaries and refreshes a changed source path', async () => {
    if (process.platform !== 'win32') throw new Error('This opt-in sparse filesystem smoke is Windows-only');
    await mkdir(FIXTURE_ROOT, { recursive: true });
    const root = await mkdtemp(path.join(FIXTURE_ROOT, 'lnwjing-physical-index-'));
    const indexDirectory = path.join(root, 'index');
    const workspaces: Workspace[] = [];
    const report: Array<{
      workspace: string; files: number; sparseBytes: number;
      createMs: number; fullIndexMs: number; incrementalMs: number; entries: number;
      watcherMs: number; watcherEvents: number;
    }> = [];
    const repository: WorkspaceRepository = {
      async list() { return workspaces; },
      async get(id) { return workspaces.find((item) => item.id === id) ?? null; },
      async insert() { throw new Error('Fixture is immutable'); },
      async delete() { throw new Error('Fixture is immutable'); },
    };
    const service = new WorkspaceIndexService(repository, new SqliteWorkspaceIndexStore(indexDirectory));
    try {
      for (let projectIndex = 0; projectIndex < PROJECT_COUNT; projectIndex += 1) {
        const started = performance.now();
        const workspaceRoot = path.join(root, `project-${projectIndex}`);
        const srcRoot = path.join(workspaceRoot, 'src');
        await mkdir(srcRoot, { recursive: true });
        for (let group = 0; group < 30; group += 1) {
          const folder = path.join(srcRoot, `group-${String(group).padStart(2, '0')}`);
          await mkdir(folder);
          for (let fileIndex = 0; fileIndex < 1000; fileIndex += 64) {
            const count = Math.min(64, 1000 - fileIndex);
            await Promise.all(Array.from({ length: count }, async (_, offset) => {
              const file = path.join(folder, `file-${String(fileIndex + offset).padStart(4, '0')}.ts`);
              await writeFile(file, `export const fixture = ${group * 1000 + fileIndex + offset};\n`, { flag: 'wx' });
            }));
          }
        }
        // Never allocate 21 GiB of physical data: mark an empty user-owned
        // fixture file sparse BEFORE extending its logical length.
        const sparse = path.join(workspaceRoot, 'virtual-21GiB.bin');
        await writeFile(sparse, '', { flag: 'wx' });
        execFileSync('fsutil.exe', ['sparse', 'setflag', sparse], { windowsHide: true, timeout: 5_000 });
        const sparseHandle = await open(sparse, 'r+');
        try {
          await sparseHandle.truncate(LARGE_SPARSE_BYTES);
        } finally {
          await sparseHandle.close();
        }
        expect((await stat(sparse)).size).toBe(LARGE_SPARSE_BYTES);
        const createMs = performance.now() - started;
        const workspaceId = `scale-physical-${projectIndex}`;
        workspaces.push({
          id: workspaceId, displayName: workspaceId, rootPath: workspaceRoot,
          realRootPath: workspaceRoot, createdAt: new Date().toISOString(),
        });
        const fullStarted = performance.now();
        const result = await service.indexWorkspace(workspaceId);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        const fullIndexMs = performance.now() - fullStarted;
        expect(result.value.entries.length).toBeGreaterThan(FILES_PER_PROJECT);
        // Automatic discovery intentionally excludes large binary assets:
        // indexing 21 GiB of opaque data would violate the I/O budget.
        expect(result.value.entries.find((e) => e.relativePath === 'virtual-21GiB.bin')).toBeUndefined();
        const changedPath = path.join(srcRoot, 'group-00', 'file-0000.ts');
        await writeFile(changedPath, 'export const updated = true;\n');
        const incrementStarted = performance.now();
        const refreshed = await service.indexPath(workspaceId, 'src/group-00/file-0000.ts');
        expect(refreshed.ok).toBe(true);
        if (!refreshed.ok) throw new Error(refreshed.error.message);
        const incrementalMs = performance.now() - incrementStarted;
        expect(refreshed.value.entries.find((e) => e.relativePath === 'src/group-00/file-0000.ts')?.symbols).toContain('updated');
        const compact = await service.compactStatus(workspaceId);
        expect(compact.ok && compact.value.snapshotEntryCount).toBeGreaterThan(FILES_PER_PROJECT);
        // Exercise the actual recursive native watcher on a 30k-file root.
        // Compact status polls must not reload every entry while events drain.
        const start = await service.startWatch(workspaceId, { debounceMs: 1000 });
        expect(start.ok).toBe(true);
        const watcherStarted = performance.now();
        await Promise.all(Array.from({ length: 64 }, async (_, index) => {
          await writeFile(path.join(srcRoot, 'group-00', `file-${String(index + 100).padStart(4, '0')}.ts`),
            `export const watcherBurst = ${index};\n`);
        }));
        let watcherEvents = 0;
        try {
          await vi.waitFor(async () => {
            const observed = await service.compactStatus(workspaceId);
            expect(observed.ok).toBe(true);
            if (!observed.ok) return;
            expect(observed.value.watcher?.completedEvents).toBeGreaterThan(0);
            expect(observed.value.watcher?.pendingEvents).toBe(0);
            expect(observed.value.watcher?.activeWorkers).toBe(0);
            watcherEvents = observed.value.watcher?.enqueuedEvents ?? 0;
          }, { timeout: 25_000, interval: 300 });
          const confirmed = await service.snapshot(workspaceId);
          expect(confirmed.ok).toBe(true);
          if (!confirmed.ok) return;
          for (const index of [0, 63]) {
            const relativePath = `src/group-00/file-${String(index + 100).padStart(4, '0')}.ts`;
            expect(confirmed.value?.entries.find((entry) => entry.relativePath === relativePath)?.symbols)
              .toContain('watcherBurst');
          }
        } finally {
          await service.stopWatch(workspaceId);
        }
        const watcherMs = performance.now() - watcherStarted;
        report.push({
          workspace: workspaceId, files: FILES_PER_PROJECT, sparseBytes: LARGE_SPARSE_BYTES,
          createMs, fullIndexMs, incrementalMs, watcherMs, watcherEvents,
          entries: refreshed.value.entries.length,
        });
      }
      for (const workspace of workspaces) {
        const status = await service.compactStatus(workspace.id);
        expect(status.ok && status.value.snapshotEntryCount).toBeGreaterThan(FILES_PER_PROJECT);
      }
      console.info('INDEX_SCALE_REAL_FS_REPORT', JSON.stringify({
        projectCount: workspaces.length, sourceFilesCreated: FILES_PER_PROJECT * workspaces.length,
        physicalFileBytes: 'NOT MEASURED (sparse logical size only)',
        physicalETW: false, report,
      }));
    } finally {
      await service.close();
      // Only remove the freshly generated, uniquely named fixture below .audit.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 600_000);
});
