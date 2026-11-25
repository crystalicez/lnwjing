import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime } from './test-desktop-runtime.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Recovery Center selected-workspace authority', () => {
  it('shows only recovery entries belonging to the host-selected workspace', async () => {
    const rawData = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-recovery-selection-data-'));
    const rawA = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-recovery-selection-a-'));
    const rawB = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-recovery-selection-b-'));
    temporaryRoots.push(rawData, rawA, rawB);
    const dataRoot = await realpath(rawData);
    const rootA = await realpath(rawA);
    const rootB = await realpath(rawB);
    const runtime = createDesktopRuntime(dataRoot, { hostMutationApprovalProvider: async () => true });
    try {
      const workspaceA = await runtime.services.addWorkspace({ rootPath: rootA });
      const workspaceB = await runtime.services.addWorkspace({ rootPath: rootB });
      await writeFile(path.join(rootA, 'a.txt'), 'A', 'utf8');
      await writeFile(path.join(rootB, 'b.txt'), 'B', 'utf8');

      await expect(runtime.mcpServices.file.deleteFile(runtime.mcpActor, workspaceA.id, { path: 'a.txt', userConfirmed: true }))
        .resolves.toMatchObject({ ok: true });
      await expect(runtime.mcpServices.file.deleteFile(runtime.mcpActor, workspaceB.id, { path: 'b.txt', userConfirmed: true }))
        .resolves.toMatchObject({ ok: true });

      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      const trashReads = vi.spyOn(runtime.mcpServices.file, 'listRecoveryItems');
      const checkpointReads = vi.spyOn(runtime.mcpServices.checkpoint, 'list');
      for (let i = 0; i < 3; i += 1) {
        const overview = await runtime.services.getDashboard('overview');
        expect(overview).toMatchObject({
          detailScope: 'overview', selectedWorkspace: { id: workspaceA.id },
          recovery: { trashItems: [], checkpoints: [] }, backups: [],
          gitSummary: { message: 'Git details not requested' },
        });
      }
      expect(trashReads).not.toHaveBeenCalled();
      expect(checkpointReads).not.toHaveBeenCalled();
      expect(await runtime.services.getLogSnapshot()).toMatchObject({ locale: expect.any(String), hostPlatform: process.platform });
      await expect(runtime.services.getDashboard()).resolves.toMatchObject({
        selectedWorkspace: { id: workspaceA.id },
        recovery: { trashItems: [expect.objectContaining({ workspaceId: workspaceA.id, relativePath: 'a.txt' })] },
      });
      expect(trashReads).toHaveBeenCalledTimes(1);
      expect(checkpointReads).toHaveBeenCalledTimes(1);
      expect((await runtime.services.getDashboard()).recovery.trashItems.some((entry) => entry.workspaceId === workspaceB.id)).toBe(false);

      await runtime.services.selectWorkspace({ workspaceId: workspaceB.id });
      await expect(runtime.services.getDashboard()).resolves.toMatchObject({
        selectedWorkspace: { id: workspaceB.id },
        recovery: { trashItems: [expect.objectContaining({ workspaceId: workspaceB.id, relativePath: 'b.txt' })] },
      });
      expect((await runtime.services.getDashboard()).recovery.trashItems.some((entry) => entry.workspaceId === workspaceA.id)).toBe(false);
    } finally {
      await runtime.close();
    }
  }, 30_000);
});
