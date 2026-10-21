import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { err, ok, type AppErrorCode, type Result } from '@lnwjing/domain';
import type { FileActor } from '@lnwjing/application';
import { classifyContextPath } from '@lnwjing/search';
import type { McpApplicationServices } from './tools/tool-types.js';
import { ContextEconomyRuntime, type ContextEconomyStats, type ContextDeliveryKind } from './context-economy.js';
import { ContinuationStore, scopedContinuationKey } from './continuation-store.js';

export type ContextIntent = 'auto' | 'debug' | 'implement' | 'review' | 'trace' | 'explore';
export type ContextMode = 'optimized' | 'full' | 'exhaustive';

type ContextSource = 'text_search' | 'file_search' | 'git' | 'file_read' | 'workspace' | 'project' | 'index';
export type ContextSourceObservation = {
  readonly workspaceId: string;
  readonly source: ContextSource;
  readonly path?: string;
} & (
  | { readonly state: 'complete' | 'truncated'; readonly observedItems: number }
  | { readonly state: 'unavailable' | 'unknown'; readonly error: { readonly code: AppErrorCode } }
);

interface ContextObservationSummary {
  readonly completeness: 'complete' | 'partial' | 'unavailable' | 'unknown';
  readonly observations: readonly ContextSourceObservation[];
}

type ObservedProvider<T> =
  | { readonly state: 'complete' | 'truncated'; readonly value: T }
  | { readonly state: 'unavailable' | 'unknown'; readonly code: AppErrorCode };

const errorCodeSchema = z.enum([
  'INVALID_INPUT', 'CONFLICT', 'ENGINEERING_PREFLIGHT_REQUIRED', 'ENGINEERING_POLICY_CHANGED',
  'WORKSPACE_NOT_FOUND', 'PATH_OUTSIDE_WORKSPACE', 'SECRET_ACCESS_DENIED', 'PERMISSION_DENIED',
  'PERMISSION_REQUIRED', 'FILE_NOT_FOUND', 'FILE_TOO_LARGE', 'BINARY_FILE', 'PROCESS_NOT_FOUND',
  'PROCESS_TIMEOUT', 'EXECUTABLE_NOT_FOUND', 'GIT_NOT_REPOSITORY', 'CODEX_NOT_AVAILABLE',
  'UNSUPPORTED_PLATFORM', 'INTERNAL_ERROR',
] satisfies readonly AppErrorCode[]);
const providerEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: errorCodeSchema }) }),
]);
const textSearchSchema = z.object({ matches: z.array(z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() }).passthrough()), truncated: z.boolean() }).passthrough();
const fileSearchSchema = z.object({ paths: z.array(z.string()), truncated: z.boolean() }).passthrough();
const gitStatusSchema = z.object({ entries: z.array(z.object({ path: z.string() }).passthrough()) }).passthrough();
const fileReadSchema = z.object({
  path: z.string(), content: z.string(), startLine: z.number().int().nonnegative(), endLine: z.number().int().nonnegative(),
  encoding: z.enum(['utf8', 'base64']).optional(), byteLength: z.number().int().nonnegative().optional(),
}).passthrough();
const snapshotSchema = z.record(z.string(), z.unknown());
const workspaceListSchema = z.array(z.object({ id: z.string().min(1).refine((value) => value.trim().length > 0) }).passthrough());
const indexStatusSchema = z.object({
  freshness: z.string(),
  snapshot: z.object({ entries: z.array(z.object({ relativePath: z.string(), kind: z.enum(['file', 'directory', 'symlink']) }).passthrough()) }).passthrough().nullable(),
}).passthrough();

export interface WorkspaceContextRequest {
  readonly query: string;
  readonly workspaceId?: string;
  readonly path?: string;
  readonly intent?: ContextIntent;
  readonly mode?: ContextMode;
  readonly includeIgnored?: boolean;
  readonly responseTargetBytes?: number;
  readonly pageSize?: number;
}

export interface ContextSnippet {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface ContextMatch {
  readonly workspaceId: string;
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface ContextFile {
  readonly workspaceId: string;
  readonly path: string;
  readonly reason: string;
  readonly snippets: readonly ContextSnippet[];
  readonly symbols: readonly string[];
  readonly gitRelevance: 'changed' | 'related' | 'none';
  readonly testRelevance: 'test' | 'source' | 'unknown';
  readonly readState: 'complete' | 'unavailable' | 'unknown';
  readonly byteLength?: number;
  readonly error?: { readonly code: AppErrorCode; readonly message: string };
  readonly delivery?: ContextDeliveryKind;
  readonly fingerprint?: string;
  readonly summary?: {
    readonly byteLength: number;
    readonly lineCount: number;
    readonly imports: readonly string[];
    readonly exports: readonly string[];
    readonly symbols: readonly string[];
  };
  readonly diff?: string;
  readonly referencePath?: string;
  readonly unchangedSince?: string;
}

export interface WorkspaceContextResult extends ContextObservationSummary {
  readonly files: readonly ContextFile[];
  readonly symbols: readonly string[];
  readonly matches: readonly ContextMatch[];
  readonly scannedFiles: number;
  readonly matchedFiles: number;
  readonly totalMatches: number;
  readonly hasMore: boolean;
  readonly searchTruncated: boolean;
  readonly continuationToken?: string;
  readonly economy?: ContextEconomyStats;
}

export interface ContextContinueRequest {
  readonly continuationToken: string;
  readonly pageSize?: number;
}

export interface SearchAllRequest {
  readonly query: string;
  readonly workspaceId?: string;
  readonly path?: string;
  readonly glob?: string;
  readonly maxResults?: number;
  readonly includeIgnored?: boolean;
}

export interface SearchAllResult extends ContextObservationSummary {
  readonly matches: readonly ContextMatch[];
  readonly paths: readonly { readonly workspaceId: string; readonly path: string }[];
  readonly scannedWorkspaces: number;
  readonly totalMatches: number;
  readonly hasMore: boolean;
}

export interface WorkspaceFullScanRequest {
  readonly workspaceId?: string;
  readonly path?: string;
  readonly glob?: string;
  readonly pageSize?: number;
  readonly includeIgnored?: boolean;
}

export interface WorkspaceFullScanResult extends ContextObservationSummary {
  readonly files: readonly { readonly workspaceId: string; readonly path: string }[];
  readonly scannedWorkspaces: number;
  readonly scannedFiles: number;
  readonly hasMore: boolean;
  readonly searchTruncated: boolean;
  readonly continuationToken?: string;
}

export interface ReadManyFilesRequest {
  readonly workspaceId?: string;
  readonly files: readonly { readonly path: string; readonly startLine?: number; readonly endLine?: number }[];
}

export interface ReadManyFileResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ReadManyFilesResult extends ContextObservationSummary {
  readonly files: readonly ReadManyFileResult[];
  readonly totalFiles: number;
  readonly failedFiles: number;
}

export interface WorkspaceSnapshotResult extends ContextObservationSummary {
  readonly workspace?: unknown;
  readonly project?: unknown;
}

interface Candidate {
  readonly workspaceId: string;
  readonly path: string;
  readonly matches: readonly ContextMatch[];
  readonly score: number;
  readonly reason: string;
  readonly gitRelevance: ContextFile['gitRelevance'];
  readonly testRelevance: ContextFile['testRelevance'];
}

interface WorkspaceCollection {
  readonly candidates: readonly Candidate[];
  readonly scannedFiles: number;
  readonly totalMatches: number;
  readonly searchTruncated: boolean;
  readonly observations: readonly ContextSourceObservation[];
}

export interface ContextContinuation {
  readonly candidates: readonly Candidate[];
  readonly request: WorkspaceContextRequest;
  readonly scannedFiles: number;
  readonly totalMatches: number;
  readonly searchTruncated: boolean;
  readonly observations: readonly ContextSourceObservation[];
}

export interface ScanContinuation {
  readonly files: readonly { readonly workspaceId: string; readonly path: string }[];
  readonly scannedWorkspaces: number;
  readonly scannedFiles: number;
  readonly searchTruncated: boolean;
  readonly observations: readonly ContextSourceObservation[];
}

const DEFAULT_RESPONSE_TARGET_BYTES = 256 * 1024;
const MAX_RESPONSE_TARGET_BYTES = 8 * 1024 * 1024;
const MAX_FILE_READ_CONCURRENCY = 8;
const DEFAULT_PAGE_SIZE: Record<ContextMode, number> = { optimized: 12, full: 50, exhaustive: 200 };
const SEARCH_LIMIT: Record<ContextMode, number> = { optimized: 100, full: 300, exhaustive: 500 };

export class ContextEngine {
  private readonly continuationScope: string;
  private readonly platform: NodeJS.Platform;

  public constructor(
    private readonly services: McpApplicationServices,
    private readonly actor: FileActor,
    private readonly economy: ContextEconomyRuntime = new ContextEconomyRuntime(),
    private readonly continuations: ContinuationStore<ContextContinuation> = new ContinuationStore<ContextContinuation>(),
    private readonly scanContinuations: ContinuationStore<ScanContinuation> = new ContinuationStore<ScanContinuation>(),
  ) {
    this.continuationScope = actor.sessionId?.trim() || actor.clientId;
    this.platform = services.platform ?? process.platform;
  }

  public async collect(request: WorkspaceContextRequest): Promise<Result<WorkspaceContextResult>> {
    this.economy.beginRequest();
    const validation = validateRequest(request);
    if (!validation.ok) return validation;
    const workspaceIds = await this.resolveWorkspaceIds(request.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    if (workspaceIds.value.length === 0) return err({ code: 'WORKSPACE_NOT_FOUND', message: 'No registered workspace is available', recoverable: false });

    const collections = await Promise.all(workspaceIds.value.map((workspaceId) => this.collectWorkspace(workspaceId, request)));
    const merged = mergeCollections(collections, this.platform);
    return this.materialize(merged.candidates, request, {
      scannedFiles: merged.scannedFiles,
      totalMatches: merged.totalMatches,
      searchTruncated: merged.searchTruncated,
      observations: merged.observations,
    });
  }

  public async continue(token: string, pageSize?: number): Promise<Result<WorkspaceContextResult>> {
    const continuation = this.continuations.take(scopedContinuationKey(this.continuationScope, token));
    if (continuation === undefined) return err({ code: 'INVALID_INPUT', message: 'Continuation token is invalid or expired', recoverable: false });
    return this.materialize(continuation.candidates, {
      ...continuation.request,
      ...(pageSize === undefined ? {} : { pageSize }),
    }, continuation);
  }

  public async searchAll(request: SearchAllRequest): Promise<Result<SearchAllResult>> {
    this.economy.beginRequest();
    if (request.query.trim().length === 0) return err({ code: 'INVALID_INPUT', message: 'Search query is required', recoverable: false });
    const workspaceIds = await this.resolveWorkspaceIds(request.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    const maxResults = Math.max(1, Math.min(500, Math.floor(request.maxResults ?? 500)));
    const results = await Promise.all(workspaceIds.value.map(async (workspaceId) => {
      const [text, files] = await Promise.all([
        this.safeSearchText(workspaceId, { query: request.query, ...(request.includeIgnored === undefined ? {} : { includeIgnored: request.includeIgnored }), ...(request.path === undefined ? {} : { path: request.path }) }, maxResults),
        this.safeSearchFiles(workspaceId, { query: request.query, ...(request.includeIgnored === undefined ? {} : { includeIgnored: request.includeIgnored }), ...(request.path === undefined ? {} : { path: request.path }) }, maxResults, request.glob),
      ]);
      return { workspaceId, text, files };
    }));
    const matches: ContextMatch[] = [];
    const paths: Array<{ readonly workspaceId: string; readonly path: string }> = [];
    let hasMore = false;
    let successfulWorkspaces = 0;
    const observations: ContextSourceObservation[] = [];
    for (const entry of results) {
      observations.push(sourceObservation(entry.workspaceId, 'text_search', entry.text, 'value' in entry.text ? entry.text.value.matches.length : 0));
      observations.push(sourceObservation(entry.workspaceId, 'file_search', entry.files, 'value' in entry.files ? entry.files.value.paths.length : 0));
      if ('value' in entry.text || 'value' in entry.files) successfulWorkspaces += 1;
      if ('value' in entry.text) {
        matches.push(...entry.text.value.matches
          .filter((match) => {
            const allowed = request.includeIgnored === true || classifyContextPath(match.path, 'automatic').discoverable;
            if (!allowed) this.economy.recordSkipped(match.path);
            return allowed;
          })
          .map((match) => ({ workspaceId: entry.workspaceId, path: match.path, line: match.line, text: match.text })));
        hasMore ||= entry.text.value.truncated;
      }
      if ('value' in entry.files) {
        paths.push(...entry.files.value.paths
          .filter((path) => {
            const allowed = request.includeIgnored === true || classifyContextPath(path, 'automatic').discoverable;
            if (!allowed) this.economy.recordSkipped(path);
            return allowed;
          })
          .map((path) => ({ workspaceId: entry.workspaceId, path })));
        hasMore ||= entry.files.value.truncated;
      }
    }
    return ok({
      matches,
      paths: dedupePaths(paths, this.platform),
      scannedWorkspaces: successfulWorkspaces,
      totalMatches: matches.length,
      hasMore,
      ...observationSummary(observations),
    });
  }

  public async fullScan(request: WorkspaceFullScanRequest): Promise<Result<WorkspaceFullScanResult>> {
    this.economy.beginRequest();
    const workspaceIds = await this.resolveWorkspaceIds(request.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    if (request.includeIgnored !== true && request.glob === undefined && request.workspaceId !== undefined && this.services.workspaceIndex !== undefined) {
      const indexed = await this.fullScanFromIndex(request.workspaceId, request.path, request.pageSize);
      if (indexed !== null) return indexed;
    }
    const maxResults = 500;
    const results = await Promise.all(workspaceIds.value.map(async (workspaceId) => ({
      workspaceId,
      result: await this.safeSearchFiles(workspaceId, { query: '*', includeIgnored: request.includeIgnored === true, ...(request.path === undefined ? {} : { path: request.path }) }, maxResults, request.glob),
    })));
    const files: Array<{ readonly workspaceId: string; readonly path: string }> = [];
    let searchTruncated = false;
    let scannedWorkspaces = 0;
    const observations: ContextSourceObservation[] = [];
    for (const entry of results) {
      observations.push(sourceObservation(entry.workspaceId, 'file_search', entry.result, 'value' in entry.result ? entry.result.value.paths.length : 0));
      if (!('value' in entry.result)) continue;
      scannedWorkspaces += 1;
      files.push(...entry.result.value.paths.map((path) => ({ workspaceId: entry.workspaceId, path })));
      searchTruncated ||= entry.result.value.truncated;
    }
    const deduped = dedupePaths(files, this.platform);
    const pageSize = normalizePageSize(request.pageSize ?? 200);
    const page = deduped.slice(0, pageSize);
    const remaining = deduped.slice(page.length);
    const hasMore = remaining.length > 0;
    let continuationToken: string | undefined;
    if (hasMore) {
      continuationToken = randomUUID();
      this.scanContinuations.set(scopedContinuationKey(this.continuationScope, continuationToken), { files: remaining, scannedWorkspaces, scannedFiles: deduped.length, searchTruncated, observations });
    }
    return ok({
      files: page,
      scannedWorkspaces,
      scannedFiles: deduped.length,
      hasMore,
      searchTruncated,
      ...observationSummary(observations),
      ...(continuationToken === undefined ? {} : { continuationToken }),
    });
  }

  public async continueFullScan(token: string, pageSize?: number): Promise<Result<WorkspaceFullScanResult>> {
    const continuation = this.scanContinuations.take(scopedContinuationKey(this.continuationScope, token));
    if (continuation === undefined) return err({ code: 'INVALID_INPUT', message: 'Scan continuation token is invalid or expired', recoverable: false });
    const size = normalizePageSize(pageSize ?? 200);
    const files = continuation.files.slice(0, size);
    const remaining = continuation.files.slice(files.length);
    let nextToken: string | undefined;
    if (remaining.length > 0) {
      nextToken = randomUUID();
      this.scanContinuations.set(scopedContinuationKey(this.continuationScope, nextToken), { ...continuation, files: remaining });
    }
    return ok({
      files,
      scannedWorkspaces: continuation.scannedWorkspaces,
      scannedFiles: continuation.scannedFiles,
      hasMore: remaining.length > 0,
      searchTruncated: continuation.searchTruncated,
      ...observationSummary(continuation.observations),
      ...(nextToken === undefined ? {} : { continuationToken: nextToken }),
    });
  }

  public async readMany(request: ReadManyFilesRequest): Promise<Result<ReadManyFilesResult>> {
    if (this.services.file === undefined) return err({ code: 'INTERNAL_ERROR', message: 'File service is unavailable', recoverable: true });
    const workspaceIds = await this.resolveWorkspaceIds(request.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    const workspaceId = request.workspaceId ?? workspaceIds.value[0];
    if (workspaceId === undefined) return err({ code: 'WORKSPACE_NOT_FOUND', message: 'No workspace is available', recoverable: false });
    const reads = await mapInBatches(request.files, MAX_FILE_READ_CONCURRENCY, async (file) => {
      const provider = await observeProvider(() => this.services.file!.readFile(this.actor, workspaceId, file), fileReadSchema);
      const value: ReadManyFileResult = 'value' in provider
        ? { workspaceId, path: file.path, result: provider.value }
        : { workspaceId, path: file.path, error: { code: provider.code, message: 'File read failed' } };
      return { value, observation: sourceObservation(workspaceId, 'file_read', provider, 1, file.path) };
    });
    const files = reads.map((read) => read.value);
    return ok({ files, totalFiles: files.length, failedFiles: files.filter((file) => file.error !== undefined).length, ...observationSummary(reads.map((read) => read.observation)) });
  }

  public async snapshot(workspaceId: string): Promise<Result<WorkspaceSnapshotResult>> {
    const workspaceInfo = this.services.workspaceInfo;
    const projectSnapshot = this.services.projectSnapshot;
    const [workspace, project] = await Promise.all([
      observeProvider(workspaceInfo === undefined ? undefined : (): ReturnType<NonNullable<typeof workspaceInfo>['info']> => workspaceInfo.info(this.actor, workspaceId), snapshotSchema),
      observeProvider(projectSnapshot === undefined ? undefined : (): ReturnType<NonNullable<typeof projectSnapshot>['snapshot']> => projectSnapshot.snapshot(this.actor, workspaceId), snapshotSchema),
    ]);
    return ok({
      ...('value' in workspace ? { workspace: workspace.value } : {}),
      ...('value' in project ? { project: project.value } : {}),
      ...observationSummary([sourceObservation(workspaceId, 'workspace', workspace, 1), sourceObservation(workspaceId, 'project', project, 1)]),
    });
  }

  private async fullScanFromIndex(workspaceId: string, requestedPath: string | undefined, pageSize: number | undefined): Promise<Result<WorkspaceFullScanResult> | null> {
    const pathApi = this.platform === 'win32' ? path.win32 : path.posix;
    if (requestedPath !== undefined && pathApi.parse(requestedPath).root.length > 0) return null;
    const requested = requestedPath === undefined ? '' : normalizePath(requestedPath, this.platform).replace(/\/$/, '');
    if (requested === '..' || requested.startsWith('../')) return null;
    const status = await observeProvider(() => this.services.workspaceIndex!.status(workspaceId), indexStatusSchema);
    if (!('value' in status) || status.value.snapshot === null || status.value.freshness !== 'watching_clean') return null;
    const prefix = requested === '.' ? '' : requested;
    const allFiles = status.value.snapshot.entries
      .filter((entry) => entry.kind === 'file' || entry.kind === 'symlink')
      .map((entry) => entry.relativePath)
      .filter((entry) => classifyContextPath(entry, 'automatic').discoverable)
      .filter((entry) => {
        const key = normalizePath(entry, this.platform);
        return prefix.length === 0 || key === prefix || key.startsWith(`${prefix}/`);
      })
      .sort((left, right) => normalizePath(left, this.platform).localeCompare(normalizePath(right, this.platform)))
      .map((path) => ({ workspaceId, path }));
    const observations = [sourceObservation(workspaceId, 'index', status, allFiles.length)];
    const size = normalizePageSize(pageSize ?? 200);
    const files = allFiles.slice(0, size);
    const remaining = allFiles.slice(files.length);
    let continuationToken: string | undefined;
    if (remaining.length > 0) {
      continuationToken = randomUUID();
      this.scanContinuations.set(scopedContinuationKey(this.continuationScope, continuationToken), { files: remaining, scannedWorkspaces: 1, scannedFiles: allFiles.length, searchTruncated: false, observations });
    }
    return ok({ files, scannedWorkspaces: 1, scannedFiles: allFiles.length, hasMore: remaining.length > 0, searchTruncated: false, ...observationSummary(observations), ...(continuationToken === undefined ? {} : { continuationToken }) });
  }

  private async resolveWorkspaceIds(workspaceId: string | undefined): Promise<Result<readonly string[]>> {
    if (workspaceId !== undefined && workspaceId.trim().length > 0) return ok([workspaceId]);
    const workspaceInfo = this.services.workspaceInfo;
    if (workspaceInfo?.list === undefined) return err({ code: 'INVALID_INPUT', message: 'workspaceId is required when workspace listing is unavailable', recoverable: false });
    const result = await observeProvider(() => workspaceInfo.list!(this.actor), workspaceListSchema);
    if (!('value' in result)) return err({ code: result.code, message: 'Workspace listing failed', recoverable: true });
    return ok([...new Set(result.value.map((entry) => entry.id))]);
  }

  private async collectWorkspace(workspaceId: string, request: WorkspaceContextRequest): Promise<WorkspaceCollection> {
    const limit = SEARCH_LIMIT[request.mode ?? 'optimized'];
    const searchTextPromise = this.safeSearchText(workspaceId, request, limit);
    const searchFilesPromise = this.safeSearchFiles(workspaceId, request, limit);
    const gitPromise = this.safeGitStatus(workspaceId);
    const [textResult, filesResult, gitResult] = await Promise.all([searchTextPromise, searchFilesPromise, gitPromise]);
    const changed = new Map<string, string>();
    if ('value' in gitResult) {
      for (const entry of gitResult.value.entries) {
        changed.set(normalizePath(entry.path, this.platform), entry.path);
      }
    }
    const candidates = new Map<string, {
      path: string;
      matches: ContextMatch[];
      score: number;
      fromFilename: boolean;
    }>();
    const query = request.query.toLowerCase();
    if ('value' in textResult) {
      for (const match of textResult.value.matches) {
        const key = normalizePath(match.path, this.platform);
        const current = candidates.get(key) ?? { path: match.path, matches: [], score: 0, fromFilename: false };
        current.matches.push({ workspaceId, path: match.path, line: match.line, text: match.text });
        current.score += 12 + (match.text.toLowerCase().includes(query) ? 8 : 0);
        candidates.set(key, current);
      }
    }
    if ('value' in filesResult) {
      for (const pathValue of filesResult.value.paths) {
        const key = normalizePath(pathValue, this.platform);
        const current = candidates.get(key) ?? { path: pathValue, matches: [], score: 0, fromFilename: false };
        current.fromFilename = true;
        if (pathValue.toLowerCase().includes(query)) current.score += 25;
        candidates.set(key, current);
      }
    }

    for (const [changedKey, changedPath] of changed) {
      const current = candidates.get(changedKey) ?? { path: changedPath, matches: [], score: 0, fromFilename: false };
      current.score += 30;
      candidates.set(changedKey, current);
    }

    const ranked = [...candidates.values()]
      .filter((candidate) => {
        const allowed = request.includeIgnored === true || changed.has(normalizePath(candidate.path, this.platform)) || classifyContextPath(candidate.path, 'automatic').discoverable;
        if (!allowed) this.economy.recordSkipped(candidate.path);
        return allowed;
      })
      .map((candidate): Candidate => {
      const normalized = normalizePath(candidate.path, this.platform);
      const gitRelevance: ContextFile['gitRelevance'] = changed.has(normalized)
        ? 'changed'
        : candidate.matches.length > 0 ? 'related' : 'none';
      const testRelevance = isTestPath(candidate.path) ? 'test' : isSourcePath(candidate.path) ? 'source' : 'unknown';
      const score = candidate.score
        + (gitRelevance === 'changed' ? 20 : gitRelevance === 'related' ? 4 : 0)
        + (request.intent === 'review' && testRelevance === 'test' ? 8 : 0)
        + (request.intent === 'implement' && testRelevance === 'source' ? 5 : 0);
      const reasons = [
        ...(candidate.matches.length > 0 ? ['text match'] : []),
        ...(candidate.fromFilename ? ['filename match or workspace inventory'] : []),
        ...(gitRelevance === 'changed' ? ['changed in Git'] : gitRelevance === 'related' ? ['Git-related path'] : []),
        ...(testRelevance === 'test' ? ['test relevance'] : []),
      ];
      return {
        workspaceId,
        path: candidate.path,
        matches: candidate.matches,
        score,
        reason: reasons.join('; ') || 'workspace inventory candidate',
        gitRelevance,
        testRelevance,
      };
      });
    ranked.sort((left, right) => right.score - left.score || normalizePath(left.path, this.platform).localeCompare(normalizePath(right.path, this.platform)));
    return {
      candidates: ranked,
      scannedFiles: 'value' in filesResult ? dedupePaths(filesResult.value.paths.map((path) => ({ workspaceId, path })), this.platform).length : 0,
      totalMatches: 'value' in textResult ? textResult.value.matches.length : 0,
      searchTruncated: textResult.state === 'truncated' || filesResult.state === 'truncated',
      observations: [
        sourceObservation(workspaceId, 'text_search', textResult, 'value' in textResult ? textResult.value.matches.length : 0),
        sourceObservation(workspaceId, 'file_search', filesResult, 'value' in filesResult ? filesResult.value.paths.length : 0),
        sourceObservation(workspaceId, 'git', gitResult, 'value' in gitResult ? gitResult.value.entries.length : 0),
      ],
    };
  }

  private async safeSearchText(workspaceId: string, request: WorkspaceContextRequest, maxResults: number): Promise<ObservedProvider<z.infer<typeof textSearchSchema>>> {
    const search = this.services.search;
    return observeProvider(search === undefined ? undefined : (): ReturnType<NonNullable<typeof search>['searchText']> => search.searchText(this.actor, workspaceId, {
        query: request.query,
        maxResults,
        discovery: request.includeIgnored === true ? 'explicit' : 'automatic',
        ...(request.path === undefined ? {} : { path: request.path }),
      }), textSearchSchema, (value) => value.truncated);
  }

  private async safeSearchFiles(workspaceId: string, request: WorkspaceContextRequest, maxResults: number, glob?: string): Promise<ObservedProvider<z.infer<typeof fileSearchSchema>>> {
    const search = this.services.search;
    return observeProvider(search === undefined ? undefined : (): ReturnType<NonNullable<typeof search>['searchFiles']> => search.searchFiles(this.actor, workspaceId, {
        maxResults,
        discovery: request.includeIgnored === true ? 'explicit' : 'automatic',
        ...(glob === undefined ? {} : { glob }),
        ...(request.path === undefined ? {} : { path: request.path }),
      }), fileSearchSchema, (value) => value.truncated);
  }

  private async safeGitStatus(workspaceId: string): Promise<ObservedProvider<z.infer<typeof gitStatusSchema>>> {
    const git = this.services.git;
    return observeProvider(git === undefined ? undefined : (): ReturnType<NonNullable<typeof git>['status']> => git.status(this.actor, workspaceId), gitStatusSchema);
  }

  private async materialize(
    candidates: readonly Candidate[],
    request: WorkspaceContextRequest,
    metadata: Pick<ContextContinuation, 'scannedFiles' | 'totalMatches' | 'searchTruncated' | 'observations'>,
  ): Promise<Result<WorkspaceContextResult>> {
    const mode = request.mode ?? 'optimized';
    const pageSize = normalizePageSize(request.pageSize ?? DEFAULT_PAGE_SIZE[mode]);
    const targetBytes = normalizeResponseTarget(request.responseTargetBytes);
    const selectedCandidates = candidates.slice(0, pageSize);
    const contextId = randomUUID();
    const selected = await mapInBatches(selectedCandidates, MAX_FILE_READ_CONCURRENCY, (candidate) => this.readCandidate(candidate, request, contextId));
    let consumed = selected.length;
    let estimatedBytes = selected.reduce((total, file) => total + Buffer.byteLength(JSON.stringify(file), 'utf8'), 0);
    while (selected.length > 1 && estimatedBytes > targetBytes) {
      const removed = selected.pop();
      if (removed !== undefined) estimatedBytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8');
      consumed -= 1;
    }
    const remaining = candidates.slice(consumed);
    const hasMore = remaining.length > 0;
    const observations: ContextSourceObservation[] = [...metadata.observations, ...selected.map((file): ContextSourceObservation => file.error === undefined
      ? { workspaceId: file.workspaceId, source: 'file_read', path: file.path, state: 'complete', observedItems: 1 }
      : { workspaceId: file.workspaceId, source: 'file_read', path: file.path, state: file.readState === 'unknown' ? 'unknown' : 'unavailable', error: { code: file.error.code } })];
    let continuationToken: string | undefined;
    if (hasMore) {
      continuationToken = randomUUID();
      this.continuations.set(scopedContinuationKey(this.continuationScope, continuationToken), {
        candidates: remaining,
        request,
        scannedFiles: metadata.scannedFiles,
        totalMatches: metadata.totalMatches,
        searchTruncated: metadata.searchTruncated,
        observations,
      });
    }
    const symbols = [...new Set(selected.flatMap((file) => file.symbols))];
    const matches = selectedCandidates.slice(0, consumed).flatMap((candidate) => candidate.matches);
    return ok({
      files: selected,
      symbols,
      matches,
      scannedFiles: metadata.scannedFiles,
      matchedFiles: candidates.length,
      totalMatches: metadata.totalMatches,
      hasMore,
      searchTruncated: metadata.searchTruncated,
      ...observationSummary(observations),
      ...(continuationToken === undefined ? {} : { continuationToken }),
      economy: this.economy.snapshot(),
    });
  }

  private async readCandidate(candidate: Candidate, request: WorkspaceContextRequest, contextId: string): Promise<ContextFile> {
    try {
      const fileService = this.services.file;
      const result = await observeProvider(fileService === undefined ? undefined : (): ReturnType<NonNullable<typeof fileService>['readFile']> => fileService.readFile(this.actor, candidate.workspaceId, { path: candidate.path }), fileReadSchema);
      if (!('value' in result)) {
        return {
          workspaceId: candidate.workspaceId,
          path: candidate.path,
          reason: candidate.reason,
          snippets: [],
          symbols: [],
          gitRelevance: candidate.gitRelevance,
          testRelevance: candidate.testRelevance,
          readState: result.state,
          error: { code: result.code, message: 'File read failed' },
        };
      }
      const prepared = this.economy.prepare({
        workspaceId: candidate.workspaceId,
        path: candidate.path,
        content: result.value.content,
        contextId,
        discovery: request.includeIgnored === true || candidate.gitRelevance === 'changed' ? 'explicit' : 'automatic',
        ...(result.value.encoding === undefined ? {} : { encoding: result.value.encoding }),
        ...(result.value.byteLength === undefined ? {} : { byteLength: result.value.byteLength }),
      });
      const snippets = prepared.delivery === 'unchanged' || prepared.delivery === 'reference' || prepared.delivery === 'metadata'
        ? []
        : createSnippets(result.value.content, candidate.matches, request.mode ?? 'optimized');
      const file: ContextFile = {
        workspaceId: candidate.workspaceId,
        path: candidate.path,
        reason: candidate.reason,
        snippets,
        symbols: prepared.delivery === 'unchanged' || prepared.delivery === 'reference' || prepared.delivery === 'metadata'
          ? []
          : prepared.summary.symbols.length > 0 ? prepared.summary.symbols : extractSymbols(result.value.content),
        gitRelevance: candidate.gitRelevance,
        testRelevance: candidate.testRelevance,
        readState: 'complete',
        ...(result.value.byteLength === undefined ? {} : { byteLength: result.value.byteLength }),
        delivery: prepared.delivery,
        fingerprint: prepared.fingerprint,
        summary: prepared.summary,
        ...(prepared.diff === undefined ? {} : { diff: prepared.diff }),
        ...(prepared.referencePath === undefined ? {} : { referencePath: prepared.referencePath }),
        ...(prepared.unchangedSince === undefined ? {} : { unchangedSince: prepared.unchangedSince }),
      };
      this.economy.recordDelivery(prepared, Buffer.byteLength(JSON.stringify(file), 'utf8'));
      return file;
    } catch {
      return {
        workspaceId: candidate.workspaceId,
        path: candidate.path,
        reason: candidate.reason,
        snippets: [],
        symbols: [],
        gitRelevance: candidate.gitRelevance,
        testRelevance: candidate.testRelevance,
        readState: 'unknown',
        error: { code: 'INTERNAL_ERROR', message: 'File read failed' },
      };
    }
  }
}

function mergeCollections(collections: readonly WorkspaceCollection[], platform: NodeJS.Platform): WorkspaceCollection {
  const byKey = new Map<string, Candidate>();
  let scannedFiles = 0;
  let totalMatches = 0;
  let searchTruncated = false;
  const observations: ContextSourceObservation[] = [];
  for (const collection of collections) {
    scannedFiles += collection.scannedFiles;
    totalMatches += collection.totalMatches;
    searchTruncated ||= collection.searchTruncated;
    observations.push(...collection.observations);
    for (const candidate of collection.candidates) {
      const key = `${candidate.workspaceId}\0${normalizePath(candidate.path, platform)}`;
      const existing = byKey.get(key);
      if (existing === undefined) byKey.set(key, candidate);
      else byKey.set(key, {
        ...existing,
        matches: [...existing.matches, ...candidate.matches],
        score: existing.score + candidate.score,
        reason: `${existing.reason}; ${candidate.reason}`,
      });
    }
  }
  const candidates = [...byKey.values()];
  candidates.sort((left, right) => right.score - left.score || `${left.workspaceId}:${normalizePath(left.path, platform)}`.localeCompare(`${right.workspaceId}:${normalizePath(right.path, platform)}`));
  return { candidates, scannedFiles, totalMatches, searchTruncated, observations };
}

function validateRequest(request: WorkspaceContextRequest): Result<void> {
  if (typeof request.query !== 'string' || request.query.trim().length === 0) return err({ code: 'INVALID_INPUT', message: 'Context query is required', recoverable: false });
  if (request.pageSize !== undefined && (!Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 500)) {
    return err({ code: 'INVALID_INPUT', message: 'Context pageSize is invalid', recoverable: false });
  }
  if (request.responseTargetBytes !== undefined && (!Number.isInteger(request.responseTargetBytes) || request.responseTargetBytes < 1024 || request.responseTargetBytes > MAX_RESPONSE_TARGET_BYTES)) {
    return err({ code: 'INVALID_INPUT', message: 'Context responseTargetBytes is invalid', recoverable: false });
  }
  return ok(undefined);
}

function normalizePageSize(value: number): number {
  return Math.max(1, Math.min(500, Math.floor(value)));
}

async function observeProvider<T>(
  read: (() => Promise<unknown>) | undefined,
  schema: z.ZodType<T>,
  truncated: (value: T) => boolean = () => false,
): Promise<ObservedProvider<T>> {
  if (read === undefined) return { state: 'unavailable', code: 'UNSUPPORTED_PLATFORM' };
  try {
    const envelope = providerEnvelopeSchema.safeParse(await read());
    if (!envelope.success) return { state: 'unknown', code: 'INTERNAL_ERROR' };
    if (!envelope.data.ok) return { state: 'unavailable', code: envelope.data.error.code };
    const value = z.custom<T>((input) => schema.safeParse(input).success).safeParse(envelope.data.value);
    if (!value.success) return { state: 'unknown', code: 'INTERNAL_ERROR' };
    return { state: truncated(value.data) ? 'truncated' : 'complete', value: value.data };
  } catch {
    return { state: 'unknown', code: 'INTERNAL_ERROR' };
  }
}

function sourceObservation<T>(workspaceId: string, source: ContextSource, result: ObservedProvider<T>, observedItems: number, path?: string): ContextSourceObservation {
  const identity = { workspaceId, source, ...(path === undefined ? {} : { path }) };
  return 'value' in result
    ? { ...identity, state: result.state, observedItems }
    : { ...identity, state: result.state, error: { code: result.code } };
}

function observationSummary(observations: readonly ContextSourceObservation[]): ContextObservationSummary {
  const available = observations.some((observation) => observation.state === 'complete' || observation.state === 'truncated');
  const complete = observations.every((observation) => observation.state === 'complete');
  const unknown = observations.some((observation) => observation.state === 'unknown');
  return {
    completeness: complete ? 'complete' : available ? 'partial' : unknown ? 'unknown' : 'unavailable',
    observations,
  };
}

async function mapInBatches<T, R>(values: readonly T[], batchSize: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    results.push(...await Promise.all(values.slice(offset, offset + batchSize).map(mapper)));
  }
  return results;
}

function normalizeResponseTarget(value: number | undefined): number {
  return Math.max(1024, Math.min(MAX_RESPONSE_TARGET_BYTES, Math.floor(value ?? DEFAULT_RESPONSE_TARGET_BYTES)));
}

function normalizePath(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.win32.normalize(value).replace(/\\/g, '/').toLowerCase()
    : path.posix.normalize(value);
}

function dedupePaths(paths: readonly { readonly workspaceId: string; readonly path: string }[], platform: NodeJS.Platform): readonly { readonly workspaceId: string; readonly path: string }[] {
  const seen = new Set<string>();
  const result: Array<{ readonly workspaceId: string; readonly path: string }> = [];
  for (const entry of paths) {
    const key = `${entry.workspaceId}\0${normalizePath(entry.path, platform)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function isTestPath(value: string): boolean {
  return /(^|[\\/])(test|tests)([\\/]|$)|\.(test|spec)\.[^.]+$/i.test(value);
}

function isSourcePath(value: string): boolean {
  return /\.(c|m)?(t|j)sx?$|\.py$|\.go$|\.rs$|\.java$|\.cs$/i.test(value);
}

function extractSymbols(content: string): readonly string[] {
  const symbols = new Set<string>();
  const pattern = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(pattern)) {
    const symbol = match[1];
    if (symbol !== undefined) symbols.add(symbol);
  }
  return [...symbols];
}

function createSnippets(content: string, matches: readonly ContextMatch[], mode: ContextMode): readonly ContextSnippet[] {
  const lines = content.split(/\r?\n/);
  const radius = mode === 'exhaustive' ? 4 : mode === 'full' ? 2 : 1;
  const ranges = matches.length === 0
    ? [{ start: 1, end: Math.min(lines.length, mode === 'exhaustive' ? 40 : 12) }]
    : matches.map((match) => ({ start: Math.max(1, match.line - radius), end: Math.min(lines.length, match.line + radius) }));
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged.map((range) => ({
    startLine: range.start,
    endLine: range.end,
    text: lines.slice(range.start - 1, range.end).join('\n'),
  }));
}
