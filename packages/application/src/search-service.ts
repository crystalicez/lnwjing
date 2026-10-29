import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, isFullBypassAuthorization, ok, type InvocationAuthorization, type Result } from '@lnwjing/domain';
import { RipgrepAdapter, type ContextDiscoveryMode, type SearchFilesRequest as AdapterFilesRequest, type SearchFilesResult, type SearchTextRequest as AdapterTextRequest, type SearchTextResult } from '@lnwjing/search';
import { hostPathApi, isAbsoluteHostPath, isHostPathWithin, resolveHostPath, WorkspacePathGuard, RESTRICTED_SEARCH_IGNORE_GLOBS, type Workspace, type WorkspaceRepository } from '@lnwjing/workspace';
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
  scanFiles?(request: Omit<AdapterFilesRequest, 'maxResults'>): Promise<Result<SearchFilesResult>>;
}

export class SearchService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly adapter: SearchAdapter = new RipgrepAdapter(),
    private readonly guard: WorkspacePathGuard = new WorkspacePathGuard(),
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
    const allowPath = this.searchPathPolicy(workspace.value, searchTarget.rootPath, authorization, request.glob);
    const excludeGlobs = this.searchExclusions(workspace.value, authorization);
    if (searchTarget.targetPath !== undefined && !allowPath(searchTarget.targetPath)) {
      return err(appError('SECRET_ACCESS_DENIED', 'Search access to this file is denied'));
    }
    return this.adapter.searchText({
      rootPath: searchTarget.rootPath,
      allowPath,
      excludeGlobs,
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
    const allowPath = this.searchPathPolicy(workspace.value, searchRoot.value, authorization, request.glob);
    const excludeGlobs = this.searchExclusions(workspace.value, authorization);
    return this.adapter.searchFiles({
      rootPath: searchRoot.value,
      allowPath,
      excludeGlobs,
      ...(request.glob === undefined ? {} : { glob: request.glob }),
      ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
      ...(request.discovery === undefined ? {} : { discovery: request.discovery }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Apply the same read-policy filter when a clean index supplies filenames. */
  public async filterSearchPaths(
    workspaceId: string, paths: readonly string[], authorization?: InvocationAuthorization,
  ): Promise<readonly string[]> {
    const workspace = await this.workspaces.get(workspaceId);
    if (workspace === null) return [];
    return paths.filter((file) => this.guard.assertSearchPathReadable(workspace, file, authorization).ok);
  }

  /** Internal inventory for workspace_full_scan. Normal search remains capped at 500 hits. */
  public async scanFiles(
    actor: FileActor, workspaceId: string | undefined, request: Omit<SearchFilesRequest, 'maxResults'>,
    signal?: AbortSignal, authorization?: InvocationAuthorization,
  ): Promise<Result<SearchFilesResult>> {
    void actor;
    if (this.adapter.scanFiles === undefined) {
      return err(appError('UNSUPPORTED_PLATFORM', 'Extended workspace inventory is unavailable'));
    }
    const workspace = await resolveWorkspaceForPath(this.workspaces, workspaceId, request.path ?? '.', authorization);
    if (!workspace.ok) return workspace;
    const root = await resolveSearchRoot(workspace.value, request.path, authorization);
    if (!root.ok) return root;
    return this.adapter.scanFiles({
      rootPath: root.value,
      allowPath: this.searchPathPolicy(workspace.value, root.value, authorization, request.glob),
      excludeGlobs: this.searchExclusions(workspace.value, authorization),
      ...(request.glob === undefined ? {} : { glob: request.glob }),
      ...(request.discovery === undefined ? {} : { discovery: request.discovery }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private searchExclusions(workspace: Workspace, authorization?: InvocationAuthorization): readonly string[] {
    return this.guard.assertSearchPathReadable(workspace, '.env', authorization).ok
      ? [] : RESTRICTED_SEARCH_IGNORE_GLOBS;
  }

  private searchPathPolicy(
    workspace: Workspace, searchRoot: string, authorization?: InvocationAuthorization, requestedGlob?: string,
  ): (foundPath: string) => boolean {
    const api = hostPathApi(process.platform);
    const relativeRoot = api.relative(workspace.realRootPath, searchRoot);
    return (foundPath) => {
      // The safe .env.example re-include glob must not override a caller's
      // narrower glob. Ripgrep's positive globs are additive, not intersecting.
      const normalized = foundPath.replaceAll('\\', '/').replace(/^\.\//, '');
      if (requestedGlob !== undefined && path.posix.basename(normalized) === '.env.example') {
        const negative = requestedGlob.startsWith('!');
        const pattern = (negative ? requestedGlob.slice(1) : requestedGlob).replaceAll('\\', '/');
        const matches = path.posix.matchesGlob(normalized, pattern) || path.posix.matchesGlob(path.posix.basename(normalized), pattern);
        if (negative ? matches : !matches) return false;
      }
      return this.guard.assertSearchPathReadable(
        workspace, api.join(relativeRoot, foundPath), authorization,
      ).ok;
    };
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
