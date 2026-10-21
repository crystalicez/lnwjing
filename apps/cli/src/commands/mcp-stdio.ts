import { appError, err, type Result } from '@lnwjing/domain';
import { startMcpStdio, type McpServerOptions } from '@lnwjing/mcp-server';
import type { Workspace } from '@lnwjing/workspace';

export interface ConfiguredWorkspaceResolver {
  resolve(reference: string): Promise<Result<Workspace>>;
}

export interface McpStdioServerHandle {
  close(): Promise<void>;
}

export interface McpStdioServerStarter {
  start(options: McpServerOptions): McpStdioServerHandle;
}

export interface McpStdioCommandOptions {
  readonly workspaceReference: string;
  readonly resolver: ConfiguredWorkspaceResolver;
  readonly createServerOptions: (workspace: Workspace) => McpServerOptions;
  readonly starter?: McpStdioServerStarter;
}

export interface McpStdioCommandResult {
  readonly workspaceId: string;
  readonly handle: McpStdioServerHandle;
}

const defaultStarter: McpStdioServerStarter = {
  start: startMcpStdio,
};

export async function runMcpStdioCommand(
  options: McpStdioCommandOptions,
): Promise<Result<McpStdioCommandResult>> {
  if (options.workspaceReference.trim().length === 0) {
    return err(appError('INVALID_INPUT', 'A workspace reference is required'));
  }

  const resolved = await options.resolver.resolve(options.workspaceReference);
  if (!resolved.ok) return resolved;

  const handle = (options.starter ?? defaultStarter).start(options.createServerOptions(resolved.value));
  return {
    ok: true,
    value: { workspaceId: resolved.value.id, handle },
  };
}
