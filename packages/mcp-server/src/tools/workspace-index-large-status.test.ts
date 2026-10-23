import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjing/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { workspaceIndexTools } from './workspace-index-tools.js';
import { workspaceIndexWatchSchema } from './schemas.js';
import type { McpToolContext } from './tool-types.js';

describe('large-project workspace status', () => {
  it('defaults MCP watcher starts to 1000ms and forwards explicit values', async () => {
    const calls: Array<{ workspaceId: string; debounceMs?: number; signal?: AbortSignal }> = [];
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        workspaceIndex: {
          async startWatch(workspaceId: string, options: { debounceMs?: number; signal?: AbortSignal }) {
            calls.push({ workspaceId, ...options });
            return ok({ watcher: { debounceMs: options.debounceMs } });
          },
        },
      },
    } as unknown as McpToolContext;
    const tool = workspaceIndexTools(context).find((item) => item.name === 'workspace_index_watch');
    if (tool === undefined) throw new Error('workspace_index_watch is missing');
    const signal = new AbortController().signal;
    const defaultInput = workspaceIndexWatchSchema.parse({ workspaceId: 'workspace-large' });
    expect(defaultInput.debounceMs).toBe(1_000);
    await tool.execute(defaultInput, signal);
    await tool.execute(workspaceIndexWatchSchema.parse({ workspaceId: 'workspace-large', debounceMs: 250 }), signal);
    expect(calls).toMatchObject([
      { workspaceId: 'workspace-large', debounceMs: 1_000 },
      { workspaceId: 'workspace-large', debounceMs: 250 },
    ]);
    expect(calls.every((call) => call.signal === signal)).toBe(true);
  });


  it('prefers the indexed sidecar fast path without calling full status', async () => {
    let fullCalls = 0;
    let compactCalls = 0;
    const compact = {
      indexed: true,
      snapshot: { version: 1, discoveryPolicyRevision: 1, workspaceId: 'workspace-large', rootPath: 'E:/code/large', indexedAt: '2026-10-23T00:00:00Z', entries: [] },
      snapshotEntryCount: 30_000,
      snapshotEntriesOmitted: true,
      watcher: null,
      generation: 'a'.repeat(64),
      freshness: 'unverified',
      stale: null,
      watcherError: null,
    };
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        workspaceIndex: {
          async status() { fullCalls += 1; throw new Error('Unexpected full JSON status read'); },
          async compactStatus() { compactCalls += 1; return ok(compact); },
        },
      },
    } as unknown as McpToolContext;
    const tool = workspaceIndexTools(context).find((item) => item.name === 'workspace_index_status');
    if (tool === undefined) throw new Error('workspace_index_status is missing');
    const result = await tool.execute({ workspaceId: 'workspace-large', summaryOnly: true }, new AbortController().signal);
    expect(result).toEqual(ok(compact));
    expect(compactCalls).toBe(1);
    expect(fullCalls).toBe(0);
  });


  it('returns compact metadata only on request, preserving legacy full status', async () => {
    const entries = Array.from({ length: 30_000 }, (_, i) => ({
      relativePath: `src/file-${i}.ts`, kind: 'file', size: 100,
    }));
    const snapshot = {
      version: 1, discoveryPolicyRevision: 1, workspaceId: 'workspace-large',
      rootPath: 'E:/code/large', indexedAt: '2026-10-23T00:00:00Z', entries,
    };
    const status = {
      indexed: true, snapshot, watcher: null, generation: 'abc',
      freshness: 'unverified', stale: null, watcherError: null,
    };
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: { workspaceIndex: { async status() { return ok(status); } } },
    } as unknown as McpToolContext;
    const tool = workspaceIndexTools(context).find((item) => item.name === 'workspace_index_status');
    if (tool === undefined) throw new Error('workspace_index_status is missing');
    const signal = new AbortController().signal;
    const compact = await tool.execute({ workspaceId: 'workspace-large', summaryOnly: true }, signal);
    expect(compact.ok).toBe(true);
    if (compact.ok) {
      expect(compact.value).toMatchObject({
        indexed: true, snapshotEntryCount: 30_000, snapshotEntriesOmitted: true,
        snapshot: { entries: [] }, generation: 'abc',
      });
      expect(JSON.stringify(compact.value).length).toBeLessThan(1000);
    }
    const full = await tool.execute({ workspaceId: 'workspace-large' }, signal);
    expect(full).toEqual(ok(status));
    expect(status.snapshot.entries).toHaveLength(30_000);
  });
});
