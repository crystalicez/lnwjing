import { appError, err, ok } from '@lnwjing/domain';
import { describe, expect, it } from 'vitest';
import { ContextEconomyRuntime } from '../context-economy.js';
import type { McpApplicationServices, McpToolContext } from './tool-types.js';
import { workspaceTools } from './workspace-tools.js';

describe('workspace registration indexing', () => {
  it.each(['missing', 'error', 'throw', 'ready'])('preserves registration and reports optional indexing %s', async (mode) => {
    const registered = { id: 'workspace-registered', displayName: 'fixture', rootPath: 'fixture-root', custom: { retained: true } };
    const indexCalls: string[] = [];
    const index: NonNullable<McpApplicationServices['workspaceIndex']> = {
      async indexWorkspace(workspaceId) {
        indexCalls.push(workspaceId);
        if (mode === 'throw') throw new Error('Fixture index failure');
        if (mode === 'error') return err(appError('INTERNAL_ERROR', 'Fixture index failure'));
        return ok({ version: 1, discoveryPolicyRevision: 1, workspaceId, rootPath: registered.rootPath, indexedAt: new Date(0).toISOString(), entries: [] });
      },
      async status() { return err(appError('INTERNAL_ERROR', 'Unused fixture method')); },
      async startWatch() { return err(appError('INTERNAL_ERROR', 'Unused fixture method')); },
      async stopWatch() { return ok({ stopped: false }); },
    };
    const context: McpToolContext = {
      actor: { clientId: 'fixture', clientName: 'fixture' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        workspaceInfo: {
          async info() { return ok(registered); },
          async register() { return ok(registered); },
        },
        ...(mode === 'missing' ? {} : { workspaceIndex: index }),
      },
    };
    const tool = workspaceTools(context).find((entry) => entry.name === 'workspace_register');
    if (tool === undefined) throw new Error('Workspace registration tool missing');
    const response = await tool.execute({ path: registered.rootPath }, new AbortController().signal);
    const status = mode === 'missing' ? 'unavailable' : mode === 'ready' ? 'ready' : 'failed';
    expect(response).toMatchObject({ ok: true, value: { ...registered, indexing: { status } } });
    expect(indexCalls).toEqual(mode === 'missing' ? [] : [registered.id]);
    if (mode !== 'ready') expect(response).toMatchObject({ value: { indexing: { retry: { tool: 'workspace_index', arguments: { workspaceId: registered.id } } } } });
  });
});
