import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjing/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { workspaceIndexTools } from './workspace-index-tools.js';
import type { McpToolContext } from './tool-types.js';

describe('large-project workspace status', () => {
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
