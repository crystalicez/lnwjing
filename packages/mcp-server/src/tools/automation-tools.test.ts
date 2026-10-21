import { describe, expect, it, vi } from 'vitest';
import { ok } from '@lnwjing/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { AUTOMATION_TOOL_NAMES, automationTools } from './automation-tools.js';
import type { McpApplicationServices, McpToolContext, McpToolDefinition } from './tool-types.js';

const actor = { clientId: 'automation-owner', clientName: 'Automation owner', sessionId: 'session-a' };

const validPlan = {
  milestones: [{
    id: 'build',
    title: 'Build application',
    goalStepId: 'build',
    dependsOn: [],
    provider: 'shell',
    role: 'blocking_job',
    cancelWithGoal: true,
    dispatch: {
      executable: 'node',
      arguments: ['--version'],
      cwd: 'E:\\project',
      timeoutSeconds: 60,
      maxOutputBytes: 64 * 1024,
      includeStdout: false,
      includeStderr: true,
    },
    verification: [{ id: 'exit', kind: 'command_exit', expectedExitCode: 0 }],
  }],
} as const;

function context(automation?: McpApplicationServices['automation']): McpToolContext {
  return {
    actor,
    contextEconomy: new ContextEconomyRuntime(),
    services: automation === undefined ? {} : { automation },
  };
}

function findTool(tools: readonly McpToolDefinition[], name: string): McpToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing tool ${name}`);
  return tool;
}

describe('automationTools', () => {
  it('exports exactly the six public automation operations in append order', () => {
    expect(automationTools(context()).map((tool) => tool.name)).toEqual([...AUTOMATION_TOOL_NAMES]);
    expect(AUTOMATION_TOOL_NAMES).toEqual([
      'automation_create',
      'automation_status',
      'automation_events',
      'automation_run',
      'automation_control',
      'automation_finalize',
    ]);
  });

  it('rejects unsupported providers, empty verification and unbounded extra fields at the schema boundary', () => {
    const create = findTool(automationTools(context()), 'automation_create');
    expect(create.parse({ workspaceId: 'workspace-1', goalId: 'goal-1', leaseToken: 'lease-1', plan: validPlan })).toMatchObject({ ok: true });
    expect(create.parse({
      workspaceId: 'workspace-1', goalId: 'goal-1', leaseToken: 'lease-1',
      plan: { milestones: [{ ...validPlan.milestones[0], provider: 'process' }] },
    })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(create.parse({
      workspaceId: 'workspace-1', goalId: 'goal-1', leaseToken: 'lease-1',
      plan: { milestones: [{ ...validPlan.milestones[0], verification: [] }] },
    })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(create.parse({ workspaceId: 'workspace-1', goalId: 'goal-1', leaseToken: 'lease-1', plan: validPlan, surprise: true }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('routes each public operation through the actor-aware application service', async () => {
    const createRun = vi.fn(async () => ok({ kind: 'created' }));
    const status = vi.fn(async () => ok({ kind: 'status' }));
    const events = vi.fn(async () => ok({ events: [], nextSequence: 3 }));
    const advance = vi.fn(async () => ok({ kind: 'advanced' }));
    const pause = vi.fn(async () => ok({ kind: 'paused' }));
    const resume = vi.fn(async () => ok({ kind: 'resumed' }));
    const cancel = vi.fn(async () => ok({ kind: 'cancelled' }));
    const finalize = vi.fn(async () => ok({ kind: 'finalized' }));
    const services = { createRun, status, events, advance, pause, resume, cancel, finalize } as unknown as McpApplicationServices['automation'];
    const tools = automationTools(context(services));
    const signal = new AbortController().signal;

    await findTool(tools, 'automation_create').execute({ workspaceId: 'workspace-1', goalId: 'goal-1', leaseToken: 'lease-1', plan: validPlan }, signal);
    await findTool(tools, 'automation_status').execute({ workspaceId: 'workspace-1', runId: 'run-1' }, signal);
    await findTool(tools, 'automation_events').execute({ workspaceId: 'workspace-1', runId: 'run-1', afterSequence: 2, limit: 25 }, signal);
    await findTool(tools, 'automation_run').execute({ workspaceId: 'workspace-1', goalId: 'goal-1', runId: 'run-1', leaseToken: 'lease-1', expectedRevision: 4, userConfirmed: true }, signal);
    for (const action of ['pause', 'resume', 'cancel'] as const) {
      await findTool(tools, 'automation_control').execute({
        workspaceId: 'workspace-1', goalId: 'goal-1', runId: 'run-1', leaseToken: 'lease-1', expectedRevision: 5,
        action, summary: action === 'cancel' ? 'Cancelled by owner.' : undefined, userConfirmed: true,
      }, signal);
    }
    await findTool(tools, 'automation_finalize').execute({ workspaceId: 'workspace-1', goalId: 'goal-1', runId: 'run-1', leaseToken: 'lease-1', expectedRevision: 6, userConfirmed: true }, signal);

    expect(createRun).toHaveBeenCalledWith(actor, { workspaceId: 'workspace-1', goalId: 'goal-1', leaseToken: 'lease-1', plan: validPlan });
    expect(status).toHaveBeenCalledWith(actor, { workspaceId: 'workspace-1', runId: 'run-1' });
    expect(events).toHaveBeenCalledWith(actor, { workspaceId: 'workspace-1', runId: 'run-1', afterSequence: 2, limit: 25 });
    expect(advance).toHaveBeenCalledWith(actor, { workspaceId: 'workspace-1', goalId: 'goal-1', runId: 'run-1', leaseToken: 'lease-1', expectedRevision: 4, userConfirmed: true });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(actor, expect.objectContaining({ summary: 'Cancelled by owner.' }));
    expect(finalize).toHaveBeenCalledWith(actor, { workspaceId: 'workspace-1', goalId: 'goal-1', runId: 'run-1', leaseToken: 'lease-1', expectedRevision: 6, userConfirmed: true });
  });

  it('fails closed when the automation runtime is not wired', async () => {
    const result = await findTool(automationTools(context()), 'automation_status')
      .execute({ workspaceId: 'workspace-1', runId: 'run-1' }, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });
});
