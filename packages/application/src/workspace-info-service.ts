import { appError, err, ok, type InvocationAuthorization, type Result } from '@lnwjing/domain';
import { preflightWorkspacePath, type WorkspacePathPreflightResult } from './workspace-path-preflight.js';
import {
  hostPathApi,
  isAbsoluteHostPath,
  isHostPathWithin,
  isMachineRootPath,
  resolveHostPath,
  type Workspace,
  type WorkspaceRepository,
  type WorkspaceService,
} from '@lnwjing/workspace';
import type { FileActor } from './file-service.js';

export type WorkspaceKind = 'machine_root' | 'project';

export interface WorkspaceInfo {
  readonly id: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly realRootPath: string;
  readonly createdAt: string;
  readonly kind: WorkspaceKind;
}

export interface RegisterWorkspaceRequest {
  readonly parentWorkspaceId?: string;
  readonly path: string;
  readonly displayName?: string;
}

export class WorkspaceInfoService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly workspaceService?: WorkspaceService,
    private readonly unrestricted: boolean = false,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public preflight(actor: FileActor, request: { readonly path: string; readonly userConfirmed?: boolean }, authorization?: InvocationAuthorization): Promise<Result<WorkspacePathPreflightResult>> {
    void actor;
    return preflightWorkspacePath(request.path, request.userConfirmed === true, authorization, this.platform);
  }

  public async list(actor: FileActor): Promise<Result<readonly WorkspaceInfo[]>> {
    void actor;
    const workspaces = await this.workspaces.list();
    return ok(workspaces.map((workspace) => this.toWorkspaceInfo(workspace)));
  }

  public async info(actor: FileActor, workspaceId: string): Promise<Result<WorkspaceInfo>> {
    void actor;
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null
      ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'))
      : ok(this.toWorkspaceInfo(workspace));
  }

  private toWorkspaceInfo(workspace: Workspace): WorkspaceInfo {
    const isRoot = isMachineRootPath(workspace.realRootPath, this.platform) || isMachineRootPath(workspace.rootPath, this.platform);
    return {
      id: workspace.id,
      displayName: workspace.displayName,
      rootPath: workspace.rootPath,
      realRootPath: workspace.realRootPath,
      createdAt: workspace.createdAt,
      kind: isRoot ? 'machine_root' : 'project',
    };
  }

  public async register(actor: FileActor, request: RegisterWorkspaceRequest): Promise<Result<WorkspaceInfo>> {
    void actor;
    void this.unrestricted;
    if (this.workspaceService === undefined) {
      return err(appError('INTERNAL_ERROR', 'Workspace registration is unavailable'));
    }

    let absolutePath: string;
    if (request.parentWorkspaceId === undefined) {
      if (!isAbsoluteHostPath(request.path, this.platform)) {
        return err(appError('INVALID_INPUT', 'path must be absolute when parentWorkspaceId is omitted'));
      }
      const resolved = resolveHostPath(request.path, this.platform);
      if (resolved === null) return err(appError('INVALID_INPUT', 'path uses a foreign host syntax'));
      absolutePath = resolved;
    } else {
      const parent = await this.workspaces.get(request.parentWorkspaceId);
      if (parent === null) {
        return err(appError('WORKSPACE_NOT_FOUND', 'Parent workspace was not found'));
      }
      if (!isMachineRootPath(parent.realRootPath, this.platform) && !isMachineRootPath(parent.rootPath, this.platform)) {
        return err(appError('INVALID_INPUT', 'parentWorkspaceId must be a drive-root machine root'));
      }

      const api = hostPathApi(this.platform);
      const requestedPath = isAbsoluteHostPath(request.path, this.platform)
        ? resolveHostPath(request.path, this.platform)
        : resolveHostPath(api.join(parent.rootPath, request.path), this.platform);
      if (requestedPath === null) return err(appError('INVALID_INPUT', 'path uses a foreign host syntax'));
      absolutePath = requestedPath;
      const parentRoot = resolveHostPath(parent.realRootPath || parent.rootPath, this.platform);
      if (parentRoot === null || !isHostPathWithin(parentRoot, absolutePath, this.platform)) {
        return err(appError('INVALID_INPUT', 'Registered path must be under its parent machine root'));
      }
    }

    // Advisory preflight receipts never authorize registration. Independently
    // inspect each ancestor now; reject reparse/symlink links or missing paths.
    // Windows ACL uncertainty is kept in the preflight status, and the
    // WorkspaceService repeats stat/realpath during the subsequent add.
    const targetCheck = await preflightWorkspacePath(absolutePath, true, undefined, this.platform);
    if (!targetCheck.ok || !targetCheck.value.exists || targetCheck.value.kind !== 'directory'
      || targetCheck.value.reparseChain === 'CONFLICT' || targetCheck.value.canonicalPath === undefined) {
      return err(appError('CONFLICT', 'Workspace path is missing, changed or could not be independently verified for registration', true));
    }

    const existing = await this.workspaces.list();
    const normalizedTarget = normalizeCompare(absolutePath, this.platform);
    const duplicate = existing.find((entry) => normalizeCompare(entry.realRootPath, this.platform) === normalizedTarget
      || normalizeCompare(entry.rootPath, this.platform) === normalizedTarget);
    if (duplicate !== undefined) return ok(this.toWorkspaceInfo(duplicate));

    const displayName = request.displayName?.trim()
      || hostPathApi(this.platform).basename(absolutePath)
      || 'Workspace';
    const added = await this.workspaceService.add(displayName, absolutePath);
    if (!added.ok) return added;
    return ok(this.toWorkspaceInfo(added.value));
  }
}

function normalizeCompare(rootPath: string, platform: NodeJS.Platform): string {
  const resolved = resolveHostPath(rootPath, platform) ?? rootPath.trim();
  const api = hostPathApi(platform);
  const withSep = resolved === api.parse(resolved).root || resolved.endsWith(api.sep) ? resolved : `${resolved}${api.sep}`;
  return platform === 'win32' ? withSep.toLowerCase() : withSep;
}
