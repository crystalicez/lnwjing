import { ok } from '@lnwjing/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { workspaceIndexSchema, workspaceIndexStatusSchema, workspaceIndexStopSchema, workspaceIndexWatchSchema } from './schemas.js';

export function workspaceIndexTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'workspace_index',
      description: 'Build or refresh the persistent workspace index using automatic context filters unless ignored paths are explicitly included.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceIndexSchema,
      handler: async (input, signal) => context.services.workspaceIndex === undefined
        ? missingService()
        : context.services.workspaceIndex.indexWorkspace(input.workspaceId, {
          discovery: input.includeIgnored ? 'explicit' : 'automatic',
          rebuild: input.rebuild,
          signal,
        }),
    }),
    defineTool({
      name: 'workspace_index_status',
      description: 'Return persistent index metadata and lossless watcher queue telemetry.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceIndexStatusSchema,
      handler: async (input) => {
        if (context.services.workspaceIndex === undefined) return missingService();
        if (input.summaryOnly && typeof context.services.workspaceIndex.compactStatus === 'function') {
          return context.services.workspaceIndex.compactStatus(input.workspaceId);
        }
        const result = await context.services.workspaceIndex.status(input.workspaceId);
        if (!result.ok || !input.summaryOnly) return result;
        const snapshot = result.value.snapshot;
        return ok({
          ...result.value,
          // Explicitly signal omitted entries; an empty list here does NOT
          // mean an empty index. Other status metadata remains intact.
          snapshot: snapshot === null ? null : { ...snapshot, entries: [] },
          snapshotEntryCount: snapshot?.entries.length ?? 0,
          snapshotEntriesOmitted: snapshot !== null,
        });
      },
    }),
    defineTool({
      name: 'workspace_index_watch',
      description: 'Watch all workspace paths and incrementally re-index only changed paths with configurable debounce/concurrency.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceIndexWatchSchema,
      handler: async (input, signal) => context.services.workspaceIndex === undefined
        ? missingService()
        : context.services.workspaceIndex.startWatch(input.workspaceId, {
          ...(input.debounceMs === undefined ? {} : { debounceMs: input.debounceMs }),
          ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
          signal,
        }),
    }),
    defineTool({
      name: 'workspace_index_stop',
      description: 'Stop a workspace watcher after draining all queued path updates.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceIndexStopSchema,
      handler: async (input) => context.services.workspaceIndex === undefined
        ? missingService()
        : context.services.workspaceIndex.stopWatch(input.workspaceId),
    }),
  ];
}
