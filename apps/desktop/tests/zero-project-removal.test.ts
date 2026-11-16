import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime } from './test-desktop-runtime.js';

const roots: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('workspace removal and zero-project dashboard', () => {
  it('deletes the only project without leaving a stale selected workspace in dashboard or MCP', async () => {
    const dataRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-empty-registration-db-')));
    const projectRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-empty-registration-project-')));
    roots.push(dataRoot, projectRoot);
    await writeFile(path.join(projectRoot, 'preserve.txt'), 'untouched project contents');
    const runtime = createDesktopRuntime(dataRoot, { hostMutationApprovalProvider: async (): Promise<boolean> => true });
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: projectRoot });
      await runtime.services.selectWorkspace({ workspaceId: workspace.id });
      const before = await runtime.services.getDashboard();
      expect(before.selectedWorkspace?.id).toBe(workspace.id);

      await expect(runtime.services.deleteWorkspace({ workspaceId: workspace.id, userConfirmed: true }))
        .resolves.toMatchObject({ deleted: true, workspaceId: workspace.id });
      await expect(runtime.services.listWorkspaces()).resolves.toEqual([]);
      const dashboard = await runtime.services.getDashboard();
      expect(dashboard.selectedWorkspace).toBeNull();
      expect(dashboard.activeWorkspaces).toEqual([]);
      expect(dashboard.recovery.trashItems).toEqual([]);
      expect(dashboard.recovery.checkpoints).toEqual([]);
      await expect(runtime.getActiveWorkspaceScope()).resolves.toBeNull();
      await expect(runtime.getActiveWorkspaceScopes()).resolves.toEqual([]);
      await expect(runtime.services.getDashboard()).resolves.toMatchObject({ selectedWorkspace: null });
      await expect(runtime.services.getRunningProjectsActivity()).resolves.toMatchObject({
        selectedWorkspace: null, activeWorkspaces: [],
      });
    } finally {
      await runtime.close();
    }
  }, 45_000);

  it('does not reject concurrent dashboard reads while the final registration is being removed', async () => {
    const dataRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-racing-dashboard-db-')));
    const projectRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-racing-dashboard-project-')));
    roots.push(dataRoot, projectRoot);
    const runtime = createDesktopRuntime(dataRoot, { hostMutationApprovalProvider: async (): Promise<boolean> => true });
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: projectRoot });
      const dashboards = Array.from({ length: 6 }, () => runtime.services.getDashboard());
      await runtime.services.deleteWorkspace({ workspaceId: workspace.id, userConfirmed: true });
      const snapshots = await Promise.all(dashboards);
      for (const snapshot of snapshots) {
        expect(snapshot.selectedWorkspace === null || snapshot.selectedWorkspace.id === workspace.id).toBe(true);
      }
      await expect(runtime.services.getDashboard()).resolves.toMatchObject({
        selectedWorkspace: null, activeWorkspaces: [],
      });
    } finally {
      await runtime.close();
    }
  }, 45_000);

  it('recovers when a selected workspace disappears during a pending recovery-trash read', async () => {
    const dataRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-delayed-dashboard-db-')));
    const projectRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-delayed-dashboard-project-')));
    roots.push(dataRoot, projectRoot);
    const runtime = createDesktopRuntime(dataRoot, { hostMutationApprovalProvider: async (): Promise<boolean> => true });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const nativeRead = runtime.mcpServices.file.listRecoveryItems.bind(runtime.mcpServices.file);
    const spy = vi.spyOn(runtime.mcpServices.file, 'listRecoveryItems').mockImplementation(async (...args) => {
      entered();
      await blocked;
      return nativeRead(...args);
    });
    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: projectRoot });
      const pendingDashboard = runtime.services.getDashboard();
      await started;
      await runtime.services.deleteWorkspace({ workspaceId: workspace.id, userConfirmed: true });
      release();
      await expect(pendingDashboard).resolves.toMatchObject({ selectedWorkspace: null, activeWorkspaces: [] });
    } finally {
      release();
      spy.mockRestore();
      await runtime.close();
    }
  }, 45_000);

  it('selects a surviving active project after deleting the primary registration', async () => {
    const dataRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-switch-registration-db-')));
    const firstRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-switch-registration-first-')));
    const nextRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-switch-registration-next-')));
    roots.push(dataRoot, firstRoot, nextRoot);
    const runtime = createDesktopRuntime(dataRoot, { hostMutationApprovalProvider: async (): Promise<boolean> => true });
    try {
      const first = await runtime.services.addWorkspace({ rootPath: firstRoot });
      const next = await runtime.services.addWorkspace({ rootPath: nextRoot });
      await runtime.services.selectWorkspace({ workspaceId: first.id });
      await runtime.services.deleteWorkspace({ workspaceId: first.id, userConfirmed: true });
      const dashboard = await runtime.services.getDashboard();
      expect(dashboard.selectedWorkspace?.id).toBe(next.id);
      expect(dashboard.activeWorkspaces.map((workspace) => workspace.id)).toEqual([next.id]);
      await expect(runtime.getActiveWorkspaceScope()).resolves.toMatchObject({ workspaceId: next.id });
    } finally {
      await runtime.close();
    }
  }, 45_000);
});
