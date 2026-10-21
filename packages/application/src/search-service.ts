import { realpath, stat } from 'node:fs/promises';
import { appError, err, isFullBypassAuthorization, ok, type InvocationAuthorization, type Result } from '@lnwjing/domain';
import { RipgrepAdapter, type ContextDiscoveryMode, type SearchFilesRequest as AdapterFilesRequest, type SearchFilesResult, type SearchTextRequest as AdapterTextRequest, type SearchTextResult } from '@lnwjing/search';
import { hostPathApi, isAbsoluteHostPath, isHostPathWithin, resolveHostPath, type Workspace, type WorkspaceRepository } from '@lnwjing/workspace';
import type { FileActor } from './file-service.js';
import { resolveWorkspaceForPath } from './workspace-locator.js';

export interface SearchTextRequest {
  readonly query: string;
  /** Literal search by default; true opts into ripgrep regex semantics. */
  readonly regex?: boolean;
  readonly path?: string;
  readonly glob?: string;
  readonly maxResults?: number;
  readonly discovery?: ContextDiscoveryMode;
}

export interface SearchFilesRequest {
  readonly path?: string;
  readonly glob?: string;
  readonly maxResults?: number;
  readonly discovery?: ContextDiscoveryMode;
}

export interface SearchAdapter {
  searchText(request: AdapterTextRequest): Promise<Result<SearchTextResult>>;
  searchFiles(request: AdapterFilesRequest): Promise<Result<SearchFilesResult>>;
}

export class SearchService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly adapter: SearchAdapter = new RipgrepAdapter(),
  ) {}

  public async searchText(actor: FileActor, workspaceId: string | undefined, request: SearchTextRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<SearchTextResult>> {
    void actor;
    const validation = this.validateLimit(request.maxResults);
    if (!validation.ok) return validation;
    if (request.query.length === 0) return err(appError('INVALID_INPUT', 'Search query is required'));
    const workspace = await resolveWorkspaceForPath(this.workspaces, workspaceId, request.path ?? '.', authorization);
    if (!workspace.ok) return workspace;
    const searchRoot = await resolveSearchRoot(workspace.value, request.path, authorization);
    if (!searchRoot.ok) return searchRoot;
    const searchTarget = await resolveSearchTextTarget(searchRoot.value);
    return this.adapter.searchText({
      rootPath: searchTarget.rootPath,
      ...(searchTarget.targetPath === undefined ? {} : { targetPath: searchTarget.targetPath }),
      query: request.query,
      ...(request.regex === undefined ? {} : { regex: request.regex }),
      ...(request.glob === undefined ? {} : { glob: request.glob }),
      ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
      ...(request.discovery === undefined ? {} : { discovery: request.discovery }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async searchFiles(actor: FileActor, workspaceId: string | undefined, request: SearchFilesRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<SearchFilesResult>> {
    void actor;
    const validation = this.validateLimit(request.maxResults);
    if (!validation.ok) return validation;
    const workspace = await resolveWorkspaceForPath(this.workspaces, workspaceId, request.path ?? '.', authorization);
    if (!workspace.ok) return workspace;
    const searchRoot = await resolveSearchRoot(workspace.value, request.path, authorization);
    if (!searchRoot.ok) return searchRoot;
    return this.adapter.searchFiles({
      rootPath: searchRoot.value,
      ...(request.glob === undefined ? {} : { glob: request.glob }),
      ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
      ...(request.discovery === undefined ? {} : { discovery: request.discovery }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private validateLimit(limit: number | undefined): Result<void> {
    return limit === undefined || Number.isInteger(limit) && limit >= 1 && limit <= 500
      ? ok(undefined)
      : err(appError('INVALID_INPUT', 'Search result limit is invalid'));
  }
}

async function resolveSearchTextTarget(resolvedPath: string): Promise<{ readonly rootPath: string; readonly targetPath?: string }> {
  try {
    if (!(await stat(resolvedPath)).isFile()) return { rootPath: resolvedPath };
  } catch {
    return { rootPath: resolvedPath };
  }
  const api = hostPathApi(process.platform);
  return { rootPath: api.dirname(resolvedPath), targetPath: api.basename(resolvedPath) };
}

async function resolveSearchRoot(workspace: Workspace, requestedPath: string | undefined, authorization?: InvocationAuthorization): Promise<Result<string>> {
  const requested = requestedPath?.trim();
  if (requested === undefined || requested.length === 0 || requested === '.') return ok(workspace.realRootPath);
  const platform = process.platform;
  const api = hostPathApi(platform);
  const candidate = isAbsoluteHostPath(requested, platform)
    ? resolveHostPath(requested, platform)
    : resolveHostPath(api.join(workspace.realRootPath, requested), platform);
  if (candidate === null) return err(appError('INVALID_INPUT', 'Search path uses a foreign host path syntax'));
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch {
    return err(appError('FILE_NOT_FOUND', `Search path was not found: ${requested}`));
  }
  if (isFullBypassAuthorization(authorization)) return ok(canonicalCandidate);
  const roots = await Promise.all([workspace.realRootPath, workspace.rootPath].map(async (root) => {
    const resolved = resolveHostPath(root, platform);
    if (resolved === null) return null;
    try { return await realpath(resolved); } catch { return resolved; }
  }));
  return roots.some((root) => root !== null && isHostPathWithin(root, canonicalCandidate, platform))
    ? ok(canonicalCandidate)
    : err(appError('PATH_OUTSIDE_WORKSPACE', 'Search path is outside the workspace'));
}
