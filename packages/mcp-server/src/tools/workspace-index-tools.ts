import path from 'node:path';
import { err, ok } from '@lnwjing/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { workspaceIndexSchema, workspaceIndexStatusSchema, workspaceIndexStopSchema, workspaceIndexWatchSchema } from './schemas.js';

export function workspaceIndexTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'workspace_index',
      description: 'Refresh a workspace index or one targeted path. Only deepLargeFile with a path reads oversized file content; background indexing stays metadata-only for large files.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceIndexSchema,
      handler: async (input, signal) => {
        const service = context.services.workspaceIndex;
        if (service === undefined) return missingService();
        if (input.deepLargeFile && input.path === undefined) {
          return err({ code: 'INVALID_INPUT', message: 'deepLargeFile requires a specific path', recoverable: false });
        }
        const options = {
          discovery: input.includeIgnored ? 'explicit' as const : 'automatic' as const,
          rebuild: input.rebuild,
          signal,
        };
        if (input.path === undefined) return service.indexWorkspace(input.workspaceId, options);
        if (service.indexPath === undefined) return missingService();
        const result = await service.indexPath(input.workspaceId, input.path, { ...options, deepLargeFile: input.deepLargeFile });
        if (!result.ok || input.summaryOnly === false) return result;
        const normalizedTarget = path.posix.normalize(input.path.replaceAll(path.win32.sep, '/')).replace(/^\.\//, '');
        return ok({
          workspaceId: input.workspaceId,
          path: input.path,
          entry: result.value.entries.find((entry) => entry.relativePath === normalizedTarget) ?? null,
          snapshotEntryCount: result.value.entries.length,
          snapshotEntriesOmitted: true,
        });
      },
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
      description: 'Start a workspace watcher with a baseline index (serialized with other heavy indexing). Incremental updates default to a 1000 ms debounce; use workspace_index_stop to stop without waiting behind the index admission queue.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceIndexWatchSchema,
      handler: async (input, signal) => context.services.workspaceIndex === undefined
        ? missingService()
        : context.services.workspaceIndex.startWatch(input.workspaceId, {
          debounceMs: input.debounceMs,
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
