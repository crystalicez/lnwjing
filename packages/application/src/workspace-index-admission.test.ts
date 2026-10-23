import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@lnwjing/workspace';
import type { DiskScanLease } from '@lnwjing/search';
import { JsonWorkspaceIndexStore, WorkspaceIndexService } from './workspace-index.js';

const admission = vi.hoisted(() => ({ occupied: false, acquisitions: 0, active: false }));

vi.mock('@lnwjing/search', async (importOriginal) => {
  const original = await importOriginal<typeof import('@lnwjing/search')>();
  return {
    ...original,
    acquireDiskScanLease: async (): Promise<DiskScanLease> => {
      admission.acquisitions += 1;
      if (admission.occupied || admission.active) return { status: 'busy' as const };
      admission.active = true;
      return {
        status: 'granted' as const,
        release: async (): Promise<void> => { admission.active = false; },
      };
    },
  };
});

const cleanup: string[] = [];
async function fixture(): Promise<{ root: string; workspace: Workspace; service: WorkspaceIndexService }> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-index-admission-'));
  cleanup.push(temporary);
  const root = path.join(temporary, 'workspace');
  await mkdir(root);
  const workspace: Workspace = {
    id: 'budgeted', displayName: 'budgeted', rootPath: root, realRootPath: root,
    createdAt: new Date().toISOString(),
  };
  const repository: WorkspaceRepository = {
    async list() { return [workspace]; },
    async get(id) { return id === workspace.id ? workspace : null; },
    async insert() { /* immutable test fixture */ },
    async delete() { /* immutable test fixture */ },
  };
  return {
    root, workspace,
    service: new WorkspaceIndexService(repository, new JsonWorkspaceIndexStore(path.join(temporary, 'index'))),
  };
}

afterEach(async () => {
  admission.occupied = false;
  admission.active = false;
  admission.acquisitions = 0;
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('incremental index disk-scan admission', () => {
  it('fails closed on an occupied cross-process budget without publishing changed file content', async () => {
    const { root, workspace, service } = await fixture();
    try {
      const source = path.join(root, 'source.ts');
      await writeFile(source, 'export const first = 1;');
      expect((await service.indexWorkspace(workspace.id)).ok).toBe(true);
      const acquisitionsBefore = admission.acquisitions;
      admission.occupied = true;
      await writeFile(source, 'export const second = 2;');

      const blocked = await service.indexPath(workspace.id, 'source.ts');
      expect(blocked).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(admission.acquisitions).toBe(acquisitionsBefore + 1);
      const unchanged = await service.snapshot(workspace.id);
      expect(unchanged.ok && unchanged.value?.entries[0]?.symbols).toContain('first');

      admission.occupied = false;
      const retried = await service.indexPath(workspace.id, 'source.ts');
      expect(retried.ok && retried.value.entries[0]?.symbols).toContain('second');
      expect(admission.active).toBe(false);
    } finally {
      await service.close();
    }
  });

  it('uses one lease for a changed directory subtree instead of recursively deadlocking on reacquisition', async () => {
    const { root, workspace, service } = await fixture();
    try {
      await writeFile(path.join(root, 'before.ts'), 'export const before = 1;');
      expect((await service.indexWorkspace(workspace.id)).ok).toBe(true);
      const acquisitionsBefore = admission.acquisitions;
      await mkdir(path.join(root, 'nested'));
      await writeFile(path.join(root, 'nested', 'new.ts'), 'export const nested = true;');

      const changed = await service.indexPath(workspace.id, 'nested');
      expect(changed.ok).toBe(true);
      expect(admission.acquisitions).toBe(acquisitionsBefore + 1);
      if (changed.ok) expect(changed.value.entries.find((entry) => entry.relativePath === 'nested/new.ts')?.symbols).toContain('nested');
      expect(admission.active).toBe(false);
    } finally {
      await service.close();
    }
  });
});
