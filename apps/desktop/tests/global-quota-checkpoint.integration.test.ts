import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GlobalStorageQuotaReservations } from '@lnwjing/storage';
import { ToolRegistry } from '@lnwjing/mcp-server';
import { permissionProfiles } from '@lnwjing/permissions';
import { describe, expect, it } from 'vitest';
import { createDesktopRuntime } from '../src/main/desktop-services.js';

describe('Desktop global quota for file Undo', () => {
  it('preserves the original edit target on refusal and retries after reclaiming old diagnostics', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-checkpoint-quota-'));
    try {
      const source = path.join(root, 'source');
      const profile = path.join(root, 'profile');
      await mkdir(source);
      const runtime = createDesktopRuntime(profile, { checkpointEncryptionKey: Buffer.alloc(32, 83) });
      try {
        const { file, checkpoint } = runtime.mcpServices;
        if (file === undefined || checkpoint === undefined) throw new Error('File tools are unavailable');
        const target = path.join(source, 'lesson.md');
        await writeFile(target, 'before');
        const workspaceId = await runtime.ensureDefaultWorkspace(source);
        runtime.storageMaintenance.configurePolicy({ userConfirmed: true, checkpointCreationMode: 'always' });
        const quota = new GlobalStorageQuotaReservations(profile);
        quota.configure({ limitBytes: 64 * 1024, criticalReserveBytes: 1024 });
        const request = { path: 'lesson.md', oldText: 'before', newText: 'after' };
        const registry = new ToolRegistry(runtime.mcpServices, runtime.mcpActor, {
          activityTracker: runtime.activityTracker, profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
          authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
        });

        const denied = await file.editFile(runtime.mcpActor, workspaceId, request);
        expect(denied).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
        await expect(file.deleteFile(runtime.mcpActor, workspaceId, { path: 'lesson.md', userConfirmed: true }))
          .resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
        expect(await readFile(target, 'utf8')).toBe('before');
        expect(await checkpoint.list(workspaceId)).toMatchObject({ ok: true, value: [] });
        expect(quota.status()?.activeReservations).toBe(0);
        await expect(registry.invoke('edit_file', { workspaceId, ...request }))
          .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT', message: expect.stringMatching(/audit/) } } });

        await mkdir(path.join(profile, 'diagnostics'), { recursive: true });
        const disposable = path.join(profile, 'diagnostics', 'expired.log');
        await writeFile(disposable, Buffer.alloc(4 * 1024 ** 2));
        const old = new Date('2020-01-01T00:00:00Z');
        await utimes(disposable, old, old);
        const fullProfile = await quota.inspect();
        quota.configure({ limitBytes: fullProfile.logicalUsedBytes - 256 * 1024, criticalReserveBytes: 1024 });

        const reservations: number[] = [];
        const unsubscribe = runtime.activityTracker.subscribe((event) => {
          if (event.toolName === 'edit_file') reservations.push(quota.status()?.activeReservations ?? 0);
        });
        try {
          const edited = await registry.invoke('edit_file', { workspaceId, ...request });
          expect(edited).toMatchObject({ structuredContent: { checkpointId: expect.any(String) } });
          expect(reservations).toEqual([1, 1]);
        } finally { unsubscribe(); }
        expect(await readFile(target, 'utf8')).toBe('after');
        await expect(readFile(disposable)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(quota.status()?.activeReservations).toBe(0);
      } finally { await runtime.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
