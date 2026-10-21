import { describe, expect, it, vi } from 'vitest';
import { ok } from '@lnwjing/domain';
import { AUTOMATION_TOOL_NAMES } from './tools/automation-tools.js';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';

const actor = { clientId: 'automation-owner', clientName: 'Automation owner', sessionId: 'session-a' };

describe('public automation tool surface', () => {
  it('appends six public tools after the unchanged base and batch surface', () => {
    const names = new ToolRegistry({}, actor).listAll().map((tool) => tool.name);
    expect(names.slice(-AUTOMATION_TOOL_NAMES.length)).toEqual([...AUTOMATION_TOOL_NAMES]);
    expect(names.at(-(AUTOMATION_TOOL_NAMES.length + 1))).toBe('tool_batch');
    expect(names.filter((name) => name.startsWith('automation_'))).toEqual([...AUTOMATION_TOOL_NAMES]);
    expect(names).not.toEqual(expect.arrayContaining([
      'automation_observe', 'automation_verify', 'automation_resolve', 'automation_recover',
    ]));
  });

  it('keeps automation out of generic batch dispatch', async () => {
    const status = vi.fn(async () => ok({ status: 'active' }));
    const registry = new ToolRegistry({ automation: { status } as unknown as NonNullable<McpApplicationServices['automation']> }, actor);
    const response = await registry.invoke('tool_batch', {
      calls: [{ id: 'read-run', tool: 'automation_status', arguments: { workspaceId: 'workspace-1', runId: 'run-1' } }],
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent)).toContain('not eligible for tool_batch');
    expect(status).not.toHaveBeenCalled();
  });

  it('requires one consistent current goal proof for automation mutations while keeping reads unfenced', async () => {
    const createRun = vi.fn(async () => ok({ run: { id: 'run-1' } }));
    const status = vi.fn(async () => ok({ run: { id: 'run-1' } }));
    const begin = vi.fn(async () => ok({ leaseGeneration: 7 }));
    const services = {
      automation: { createRun, status },
      goals: { async validateGoalLease(): Promise<ReturnType<typeof ok<{ workspaceId: string; leaseGeneration: number }>>> { return ok({ workspaceId: 'workspace-1', leaseGeneration: 7 }); } },
      goalMutationFence: {
        async inspectWorkspaceFence() { return ok({ goalId: 'goal-1', leaseGeneration: 7 }); },
        begin,
        async heartbeat() { return ok(undefined); },
        async end() { return ok(undefined); },
      },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, {
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
      activeWorkspaceScopeProvider: async (): Promise<{ workspaceId: string; rootPath: string }> => ({ workspaceId: 'workspace-1', rootPath: 'E:\\project' }),
    });
    const mutation = {
      workspaceId: 'workspace-1', goalId: 'goal-1', leaseToken: 'lease-1',
      plan: { milestones: [{
        id: 'build', title: 'Build', goalStepId: 'build', dependsOn: [], provider: 'shell', role: 'blocking_job', cancelWithGoal: true,
        dispatch: { executable: 'node', arguments: ['--version'], cwd: 'E:\\project', timeoutSeconds: 60, maxOutputBytes: 1024, includeStdout: false, includeStderr: true },
        verification: [{ id: 'exit', kind: 'command_exit', expectedExitCode: 0 }],
      }] },
    };

    const missing = await registry.invoke('automation_create', mutation);
    expect(missing).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
    const mismatched = await registry.invoke('automation_create', {
      ...mutation,
      goalLease: { goalId: 'goal-2', leaseToken: 'lease-2', leaseGeneration: 7 },
    });
    expect(mismatched).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
    expect(createRun).not.toHaveBeenCalled();

    const valid = await registry.invoke('automation_create', {
      ...mutation,
      goalLease: { goalId: 'goal-1', leaseToken: 'lease-1', leaseGeneration: 7 },
    });
    expect(valid.isError).not.toBe(true);
    expect(begin).toHaveBeenCalledWith(actor, 'workspace-1', expect.any(String), {
      goalId: 'goal-1', leaseToken: 'lease-1', leaseGeneration: 7,
    });
    expect(createRun).toHaveBeenCalledTimes(1);

    const read = await registry.invoke('automation_status', { workspaceId: 'workspace-1', runId: 'run-1' });
    expect(read.isError).not.toBe(true);
    expect(status).toHaveBeenCalledTimes(1);
  });
});
