import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_TASK_OWNER_METADATA_KEY, ShellCapabilityBackend } from '@lnwjing/capabilities';
import { appError, err } from '@lnwjing/domain';
import { permissionProfiles, type PermissionProfile } from '@lnwjing/permissions';
import { ToolRegistry } from './tool-registry.js';
import { ToolWorkloadAdmission } from './tool-workload-admission.js';
import type { McpToolResponse } from './result-mapper.js';

describe('shell capacity through the real registry and worker', () => {
  it('waits briefly for capacity, rechecks the profile, and cancels only an owned task', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-shell-capacity-registry-'));
    const state = path.join(root, 'tasks');
    const hold = path.join(root, 'hold.mjs');
    const quick = path.join(root, 'quick.mjs');
    await writeFile(hold, 'setTimeout(() => {}, 30000);');
    await writeFile(quick, "process.stdout.write('queued-ok');");
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory: state,
      maxConcurrentTasksProvider: () => 1 });
    let profile: PermissionProfile = permissionProfiles.full;
    let signalCapacity: (() => void) | undefined;
    const services = { capabilities: {
      async execute(tool: string, input: unknown, signal?: AbortSignal, authorization?: Parameters<ShellCapabilityBackend['execute']>[2]): ReturnType<ShellCapabilityBackend['execute']> {
        if (tool !== 'shell') return err(appError('INVALID_INPUT', 'unsupported'));
        const result = await backend.execute(input, signal, authorization);
        if (!result.ok && result.error.details?.reason === 'durable_shell_capacity') signalCapacity?.();
        return result;
      },
    } };
    const owner = { clientId: 'owner', sessionId: 'session', workspaceId: 'workspace-a' };
    const workloadAdmission = new ToolWorkloadAdmission();
    const options = { profileProvider: (): PermissionProfile => profile,
      sessionId: owner.sessionId, workloadAdmission,
      activeWorkspaceScopesProvider: async () => [{ workspaceId: owner.workspaceId, rootPath: root }] };
    const registry = new ToolRegistry(services, { clientId: owner.clientId, clientName: 'owner' }, options);
    const foreign = new ToolRegistry(services, { clientId: 'foreign', clientName: 'foreign' }, { ...options, sessionId: 'other' });
    const run = (script: string): Promise<McpToolResponse> => registry.invoke('shell', {
      workspaceId: owner.workspaceId, operation: 'run', executable: process.execPath, arguments: [script],
      cwd: root, timeout_seconds: 45, execution: 'background',
    });
    const action = (operation: string, task_id: string): Record<string, unknown> =>
      ({ workspaceId: owner.workspaceId, operation, task_id });
    const ids: string[] = [];
    const idOf = (response: McpToolResponse): string => {
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const id = String(response.structuredContent?.task_id ?? '');
      expect(id).not.toBe('');
      ids.push(id);
      return id;
    };
    const nextCapacity = (): Promise<void> => new Promise(resolve => { signalCapacity = resolve; });
    try {
      const first = idOf(await run(hold));
      expect(await foreign.invoke('shell', action('cancel', first))).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      profile = permissionProfiles.safe;
      expect(await registry.invoke('shell', action('cancel', first))).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
      profile = permissionProfiles.full;
      const rejected = nextCapacity();
      const waiting = run(quick);
      await rejected;
      // Same session, standard full profile; no synthetic userConfirmed flag.
      expect(await registry.invoke('shell', action('cancel', first))).toMatchObject({ structuredContent: { state: 'cancelled' } });
      const second = idOf(await waiting);
      expect(await registry.invoke('shell', { ...action('wait', second), timeout_seconds: 5 })).toMatchObject({ structuredContent: { state: 'completed', stdout: 'queued-ok' } });
      const third = idOf(await run(hold));
      const rejectedAgain = nextCapacity();
      const denied = run(quick);
      await rejectedAgain;
      profile = permissionProfiles.safe;
      expect(await denied).toMatchObject({ isError: true, structuredContent: { error: { details: { reason: 'durable_shell_capacity' } } } });
      profile = permissionProfiles.full;
      expect(await registry.invoke('shell', action('status', third))).toMatchObject({ structuredContent: { state: 'running' } });
      expect(await registry.invoke('shell', action('cancel', third))).toMatchObject({ structuredContent: { state: 'cancelled' } });
    } finally {
      for (const task_id of ids) {
        await backend.execute({ operation: 'cancel', task_id, userConfirmed: true,
          metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: owner } });
      }
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    }
  }, 45000);
});
