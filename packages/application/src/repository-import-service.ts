import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjing/domain';
import type { WorkspaceRepository } from '@lnwjing/workspace';
import type { FileActor } from './file-service.js';
import { parseRepositoryImportRequest, type RepositoryImportRequest } from './repository-import-contract.js';

export interface RepositoryImportActor {
  readonly clientId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
}

export interface RepositoryImportRuntimePort {
  start(input: {
    readonly request: RepositoryImportRequest;
    readonly owner: RepositoryImportActor;
    readonly workspaceRoot: string;
  }, signal?: AbortSignal): Promise<Result<Record<string, unknown>>>;
  status(input: { readonly taskId: string; readonly owner: RepositoryImportActor }): Promise<Result<Record<string, unknown>>>;
  cancel(input: { readonly taskId: string; readonly owner: RepositoryImportActor }): Promise<Result<Record<string, unknown>>>;
}

/**
 * Host-authorized use-case, distinct from generic Git. The runtime port alone
 * may select fixed Git commands and native publication; MCP never accepts argv,
 * destination absolute path, credentials, hooks, config or process environment.
 */
export class RepositoryImportService {
  constructor(
    private readonly workspaces: Pick<WorkspaceRepository, 'get'>,
    private readonly runtime: RepositoryImportRuntimePort,
  ) {}

  async start(actor: FileActor, rawRequest: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<Record<string, unknown>>> {
    const parsed = parseRepositoryImportRequest(rawRequest);
    if (!parsed.ok) return parsed;
    if (!isApplicationAuthorized(authorization)) {
      return err(appError('PERMISSION_REQUIRED', 'Repository import requires explicit host authorization'));
    }
    const workspace = await this.workspaces.get(parsed.value.workspaceId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
    if (!actor.clientId || !actor.sessionId) {
      return err(appError('PERMISSION_DENIED', 'Repository import requires verified client and session ownership'));
    }
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Repository import was cancelled', true));
    return this.runtime.start({
      request: parsed.value,
      workspaceRoot: workspace.realRootPath,
      owner: { clientId: actor.clientId, sessionId: actor.sessionId, workspaceId: parsed.value.workspaceId },
    }, signal);
  }

  async status(actor: FileActor, workspaceId: string, taskId: string): Promise<Result<Record<string, unknown>>> {
    const owner = this.checkedOwner(actor, workspaceId, taskId);
    return !owner.ok ? owner : this.runtime.status({ taskId, owner: owner.value });
  }

  async cancel(actor: FileActor, workspaceId: string, taskId: string): Promise<Result<Record<string, unknown>>> {
    const owner = this.checkedOwner(actor, workspaceId, taskId);
    return !owner.ok ? owner : this.runtime.cancel({ taskId, owner: owner.value });
  }

  private checkedOwner(actor: FileActor, workspaceId: string, taskId: string): Result<RepositoryImportActor> {
    if (!actor.clientId || !actor.sessionId
      || !/^[a-zA-Z0-9._:-]{1,128}$/.test(workspaceId)
      || !/^[a-zA-Z0-9._:-]{1,128}$/.test(taskId)) {
      return err(appError('INVALID_INPUT', 'Repository import ownership or task identity is invalid'));
    }
    return ok({ clientId: actor.clientId, sessionId: actor.sessionId, workspaceId });
  }
}
