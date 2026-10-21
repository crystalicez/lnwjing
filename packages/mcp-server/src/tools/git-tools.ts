import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { gitCloneSafeSchema, gitCloneHandleSchema, gitDiffSchema, gitLogSchema, gitRunSchema, gitStatusSchema } from './schemas.js';

export function gitTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'git_status',
      description: 'Inspect parsed read-only Git status. For writes (init, add, commit, remote, push, rm, clean, reset) use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitStatusSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.status(context.actor, input.workspaceId, signal),
    }),
    defineTool({
      name: 'git_diff',
      description: 'Return a bounded read-only Git diff. For writes use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitDiffSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.diff(context.actor, input.workspaceId, {
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.staged === undefined ? {} : { staged: input.staged }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        }, signal),
    }),
    defineTool({
      name: 'git_log',
      description: 'Return bounded structured Git history. For writes use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitLogSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.log(context.actor, input.workspaceId, {
          ...(input.maxCommits === undefined ? {} : { maxCommits: input.maxCommits }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        }, signal),
    }),
    defineTool({
      name: 'git_clone_safe',
      description: 'Start an explicitly authorized workspace-scoped HTTPS Git import pinned to one exact full commit. Requires a clean URL, new relative directory, UUID requestId, and host approval. No arbitrary Git arguments, inherited credentials, overwrite or Full Bypass are required. Native Windows publication fails closed on unknown state.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: gitCloneSafeSchema,
      handler: async (input, signal, authorization) => context.services.repositoryImport === undefined
        ? missingService()
        : context.services.repositoryImport.start(context.actor, {
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          url: input.url,
          destination: input.destination,
          commit: input.commit,
        }, signal, authorization),
    }),
    defineTool({
      name: 'git_clone_status',
      description: 'Inspect an owned repository import by exact workspace and durable task identity; returns only verified status and no credentials.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitCloneHandleSchema,
      handler: async (input) => context.services.repositoryImport === undefined
        ? missingService()
        : context.services.repositoryImport.status(context.actor, input.workspaceId, input.taskId),
    }),
    defineTool({
      name: 'git_clone_cancel',
      description: 'Cancel only an owned durable repository import, keeping native unknown/child liveness fail-closed.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: gitCloneHandleSchema,
      handler: async (input) => context.services.repositoryImport === undefined
        ? missingService()
        : context.services.repositoryImport.cancel(context.actor, input.workspaceId, input.taskId),
    }),
    defineTool({
      name: 'git',
      description: 'Run a Git subcommand with a separate args array. With Full Bypass OFF, Full Access runs ordinary read and non-destructive Git mutations without confirmation while destructive/data-loss forms, scope overrides, aliases, unsafe pathspecs, unknown commands, and destructive remote/history rewrites remain guarded or denied. Trusted Full Bypass skips lnwjing approval, command-policy, and Active Project scope checks, including explicitly absolute outside paths, without bypassing Git or OS errors. Do not wrap Git in PowerShell/cmd.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: gitRunSchema,
      handler: async (input, signal, authorization) => context.services.git === undefined
        ? missingService()
        : context.services.git.run(context.actor, {
          args: input.args,
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.timeoutSeconds === undefined ? {} : { timeoutMs: Math.floor(input.timeoutSeconds * 1000) }),
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal, authorization),
    }),
  ];
}
