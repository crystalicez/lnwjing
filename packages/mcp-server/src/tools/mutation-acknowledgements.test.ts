import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@lnwjing/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { codexTools } from './codex-tools.js';
import { processTools } from './process-tools.js';
import type { McpToolContext } from './tool-types.js';

describe('structured acknowledgements for successful void mutations', () => {
  it('returns a valid object after stopping an owned process', async () => {
    let calls = 0;
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: { process: { async stop() { calls += 1; return ok(undefined); } } },
    } as unknown as McpToolContext;
    const tool = processTools(context).find((entry) => entry.name === 'process_stop');
    if (tool === undefined) throw new Error('process_stop is missing');
    const result = await tool.execute({ workspaceId: 'ws', processId: 'owned', userConfirmed: true }, new AbortController().signal);
    expect(result).toEqual({ ok: true, value: { stopped: true, processId: 'owned' } });
    if (result.ok) expect(tool.outputSchema?.safeParse(result.value).success).toBe(true);
    expect(calls).toBe(1);
  });

  it('returns a valid object after stopping an owned Codex task', async () => {
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: { codex: { async stop() { return ok(undefined); } } },
    } as unknown as McpToolContext;
    const tool = codexTools(context).find((entry) => entry.name === 'codex_stop');
    if (tool === undefined) throw new Error('codex_stop is missing');
    const result = await tool.execute({ workspaceId: 'ws', codexTaskId: 'task', userConfirmed: true }, new AbortController().signal);
    expect(result).toEqual({ ok: true, value: { stopped: true, codexTaskId: 'task' } });
    if (result.ok) expect(tool.outputSchema?.safeParse(result.value).success).toBe(true);
  });

  it('preserves stop errors instead of returning a misleading success acknowledgement', async () => {
    const failure = err(appError('PERMISSION_DENIED', 'Not owned by this client'));
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: { process: { async stop() { return failure; } } },
    } as unknown as McpToolContext;
    const tool = processTools(context).find((entry) => entry.name === 'process_stop');
    if (tool === undefined) throw new Error('process_stop is missing');
    await expect(tool.execute({ workspaceId: 'ws', processId: 'foreign', userConfirmed: true }, new AbortController().signal))
      .resolves.toEqual(failure);
  });
});
