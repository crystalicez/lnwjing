import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setImmediate as yieldToEventLoop, setTimeout as pause } from 'node:timers/promises';
import { appError, err, ok, type Result } from '@lnwjing/domain';
import { acquireDiskScanLease, classifyContextPath, type ContextDiscoveryMode } from '@lnwjing/search';
import { hostPathApi, isHostPathWithin, resolveHostPath, type Workspace, type WorkspaceRepository } from '@lnwjing/workspace';
import { WorkspaceIndexQueue, type WorkspaceIndexQueueOptions, type WorkspaceIndexQueueStatus } from './workspace-index-queue.js';
import { WorkspaceIndexBusyError, withWorkspaceIndexMutex } from './workspace-index-mutex.js';
import { withIndexScanBudget } from './workspace-index-scan-budget.js';

function waitForIndexOperation<T>(operation: Promise<T>, signal?: AbortSignal, hasStarted: () => boolean = () => false): Promise<T> {
  if (signal === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      if (!hasStarted()) {
        signal.removeEventListener('abort', abort);
        reject(signal.reason ?? new Error('Workspace index operation was cancelled'));
      }
    };
    const removeListener = (): void => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => { removeListener(); resolve(value); },
      (error: unknown) => { removeListener(); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

/**
 * A competing rg/full scan can outlive the normal 12-second disk-lease wait.
 * Watcher batches must retry bounded contention rather than immediately
 * recording a permanently missed filesystem event. Non-busy errors never retry.
 */
async function retryBusyIndexOperation<T>(
  operation: () => Promise<Result<T>>, signal?: AbortSignal,
): Promise<Result<T>> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    const result = await operation();
    if (result.ok || result.error.code !== 'CONFLICT'
      || !result.error.message.includes('Workspace index is busy') || attempt >= 3) return result;
    await pause(250 * (attempt + 1), undefined, { ...(signal === undefined ? {} : { signal }) });
  }
}

export interface WorkspaceIndexEntry {
  readonly relativePath: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly size: number;
  readonly mtimeMs: number;
  /** Extra metadata fences for safe reuse during a full scan (older snapshots omit them). */
  readonly ctimeMs?: number;
  readonly birthtimeMs?: number;
  readonly contentHash: string | null;
  readonly gitBlobSha: string | null;
  readonly language: string | null;
  readonly isTest: boolean;
  readonly packageMetadata?: Readonly<Record<string, unknown>>;
  readonly symbols: readonly string[];
  readonly imports: readonly string[];
  readonly exports: readonly string[];
  readonly functions: readonly string[];
  readonly classes: readonly string[];
  readonly interfaces: readonly string[];
  readonly indexedAt: string;
}

const WORKSPACE_INDEX_DISCOVERY_POLICY_REVISION = 1;
const MAX_INDEX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DEEP_INDEX_FILE_BYTES = 128 * 1024 * 1024;
class DeepIndexFileTooLargeError extends Error {}
const MAX_CACHED_INDEX_BYTES = 32 * 1024 * 1024;

export interface WorkspaceIndexSnapshot {
  readonly version: 1;
  readonly discoveryPolicyRevision: 1;
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly indexedAt: string;
  readonly entries: readonly WorkspaceIndexEntry[];
}

/** Small persisted status sidecar, bound to the precise snapshot file identity. */
export interface WorkspaceIndexMetadata {
  readonly version: 1;
  readonly identity: string;
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly indexedAt: string;
  readonly entryCount: number;
  readonly generation: string;
  readonly automaticCoverage: boolean;
}

export interface WorkspaceIndexMutation {
  load(): Promise<WorkspaceIndexSnapshot | null>;
  save(snapshot: WorkspaceIndexSnapshot): Promise<void>;
  delete(): Promise<void>;
}

export interface WorkspaceIndexStore {
  load(workspaceId: string): Promise<WorkspaceIndexSnapshot | null>;
  loadMetadata?(workspaceId: string): Promise<WorkspaceIndexMetadata | null>;
  withMutation<T>(workspaceId: string, mutation: (store: WorkspaceIndexMutation) => Promise<T>, signal?: AbortSignal): Promise<T>;
  isInternalPath?(absolutePath: string): boolean;
}

export class JsonWorkspaceIndexStore implements WorkspaceIndexStore {
  private cached: { readonly workspaceId: string; readonly identity: string; readonly snapshot: WorkspaceIndexSnapshot } | null = null;

  public constructor(private readonly directory: string = path.join(os.tmpdir(), 'lnwjing', 'index')) {}

  public isInternalPath(absolutePath: string): boolean {
    return isHostPathWithin(path.resolve(this.directory), path.resolve(absolutePath));
  }

  public async load(workspaceId: string): Promise<WorkspaceIndexSnapshot | null> {
    const filePath = this.filePath(workspaceId);
    try {
      const before = await stat(filePath, { bigint: true });
      const identity = indexFileIdentity(before);
      if (this.cached?.workspaceId === workspaceId && this.cached.identity === identity) return this.cached.snapshot;
      const content = await readFile(filePath, 'utf8');
      const value: unknown = JSON.parse(content);
      if (isRecord(value) && value.version === 1 && (value.discoveryPolicyRevision === undefined || value.discoveryPolicyRevision === 0)) return null;
      if (!isSnapshot(value) || value.workspaceId !== workspaceId) throw new Error('Workspace index data is invalid; rebuild the index to recover');
      // Cache only one reasonably sized snapshot. Identity changes on atomic replacement by another runtime.
      this.cached = before.size <= BigInt(MAX_CACHED_INDEX_BYTES) && indexFileIdentity(await stat(filePath, { bigint: true })) === identity
        ? { workspaceId, identity, snapshot: value } : null;
      return value;
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) {
        this.cached = null;
        return null;
      }
      throw error;
    }
  }

  /**
   * Stat the snapshot (one metadata syscall) then read a bounded sidecar.
   * Missing/stale sidecars are rebuilt only after checking the snapshot identity.
   * No sidecar is ever treated as valid for an atomically replaced index.
   */
  public async loadMetadata(workspaceId: string, retry = 0): Promise<WorkspaceIndexMetadata | null> {
    const filePath = this.filePath(workspaceId);
    let identity: string;
    try {
      identity = indexFileIdentity(await stat(filePath, { bigint: true }));
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(`${filePath}.meta.json`, 'utf8'));
      if (isIndexMetadata(parsed, workspaceId, identity)
        && indexFileIdentity(await stat(filePath, { bigint: true })) === identity) return parsed;
    } catch {
      // A missing/stale sidecar must never change an index's authoritative content.
    }
    const snapshot = await this.load(workspaceId);
    if (snapshot === null) return null;
    // Prevent publishing metadata about a file replaced while it was parsed.
    const afterIdentity = indexFileIdentity(await stat(filePath, { bigint: true }));
    if (afterIdentity !== identity) {
      if (retry >= 2) throw new WorkspaceIndexBusyError();
      return this.loadMetadata(workspaceId, retry + 1);
    }
    const metadata = snapshotMetadata(snapshot, identity, (entry) => !this.isInternalPath(path.resolve(snapshot.rootPath, entry.relativePath)));
    await this.writeMetadata(metadata).catch(() => undefined);
    return metadata;
  }

  private async writeMetadata(metadata: WorkspaceIndexMetadata): Promise<void> {
    const target = `${this.filePath(metadata.workspaceId)}.meta.json`;
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(metadata), { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  public withMutation<T>(workspaceId: string, mutation: (store: WorkspaceIndexMutation) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withWorkspaceIndexMutex(this.directory, workspaceId, () => mutation({
      load: () => this.load(workspaceId),
      save: async (snapshot) => {
        if (snapshot.workspaceId !== workspaceId) throw new Error('Workspace index mutation belongs to another workspace');
        await this.save(snapshot, signal);
      },
      delete: async () => {
        await rm(this.filePath(workspaceId), { force: true });
        await rm(`${this.filePath(workspaceId)}.meta.json`, { force: true });
        if (this.cached?.workspaceId === workspaceId) this.cached = null;
      },
    }), { ...(signal === undefined ? {} : { signal }) });
  }

  private async save(snapshot: WorkspaceIndexSnapshot, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = `${this.filePath(snapshot.workspaceId)}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', flag: 'wx', ...(signal === undefined ? {} : { signal }) });
      signal?.throwIfAborted();
      await rename(temporaryPath, this.filePath(snapshot.workspaceId));
      this.cached = null;
      // Sidecar is a disposable cache; a failure may not invalidate a committed index.
      try {
        const identity = indexFileIdentity(await stat(this.filePath(snapshot.workspaceId), { bigint: true }));
        await this.writeMetadata(snapshotMetadata(snapshot, identity, (entry) =>
          !this.isInternalPath(path.resolve(snapshot.rootPath, entry.relativePath))));
      } catch { /* A later compact read reconstructs the missing sidecar. */ }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private filePath(workspaceId: string): string {
    return path.join(this.directory, `${encodeURIComponent(workspaceId)}.json`);
  }
}

function indexFileIdentity(stats: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint; readonly birthtimeNs: bigint }): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, stats.birthtimeNs].join(':');
}

export type WorkspaceIndexWatchOptions = WorkspaceIndexQueueOptions & { readonly signal?: AbortSignal };

export interface WorkspaceIndexOptions {
  readonly discovery?: ContextDiscoveryMode;
  readonly rebuild?: boolean;
  /** Explicit single-file request only; automatic and full index scans never deep-read oversized files. */
  readonly deepLargeFile?: boolean;
  /** Watcher-driven updates are background work; targeted explicit requests stay interactive. */
  readonly background?: boolean;
  readonly signal?: AbortSignal;
}

export interface WorkspaceIndexCompactStatus extends Omit<WorkspaceIndexStatus, 'snapshot'> {
  readonly snapshot: Omit<WorkspaceIndexSnapshot, 'entries'> & { readonly entries: readonly [] } | null;
  readonly snapshotEntryCount: number;
  readonly snapshotEntriesOmitted: boolean;
}

export interface WorkspaceIndexStatus {
  readonly indexed: boolean;
  readonly snapshot: WorkspaceIndexSnapshot | null;
  readonly watcher: WorkspaceIndexQueueStatus | null;
  readonly generation: string | null;
  readonly freshness: 'missing' | 'unverified' | 'watching_clean' | 'watching_pending' | 'watching_degraded';
  readonly stale: boolean | null;
  readonly watcherError: string | null;
}

interface IndexWatcher {
  readonly fileWatcher: FSWatcher;
  readonly queue: WorkspaceIndexQueue;
  recoveredFailures: number;
  baselineVerified: boolean;
  error: string | null;
}

interface WatchStartAttempt {
  watcher: IndexWatcher | null;
  completed: boolean;
}

export class WorkspaceIndexService {
  private readonly watchers = new Map<string, IndexWatcher>();
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly watchLifecycles = new Map<string, Promise<void>>();
  // Identity-based memoization: idle status polls must not repeatedly hash or
  // classify all 30k+ entries. Weak references do not retain old snapshots.
  private readonly automaticCoverageCache = new WeakMap<WorkspaceIndexSnapshot, boolean>();
  private readonly generationCache = new WeakMap<WorkspaceIndexSnapshot, string>();
  private watchingClosed = false;

  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly store: WorkspaceIndexStore = new JsonWorkspaceIndexStore(),
  ) {}

  public async indexWorkspace(workspaceId: string, options: WorkspaceIndexOptions = {}): Promise<Result<WorkspaceIndexSnapshot>> {
    const watcher = this.watchers.get(workspaceId);
    let useWatchedSnapshot = false;
    if (options.rebuild !== true && options.discovery !== 'explicit' && watcher?.baselineVerified === true) {
      try {
        const snapshot = await this.store.load(workspaceId);
        useWatchedSnapshot = snapshot !== null && this.isAutomaticallyObservable(snapshot);
        if (useWatchedSnapshot) await waitForIndexOperation(watcher.queue.drain(), options.signal);
      } catch {
        if (options.signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Workspace index refresh was cancelled', true));
        return err(appError('INTERNAL_ERROR', 'Workspace index refresh failed'));
      }
    }
    return this.mutateSnapshot(workspaceId, async (workspace, store) => {
      if (useWatchedSnapshot && this.watchers.get(workspaceId) === watcher) {
        const refreshed = await store.load();
        if (refreshed !== null && this.isAutomaticallyObservable(refreshed)) return ok(refreshed);
      }
      return this.rebuildSnapshot(workspace, store, options);
    }, options.signal);
  }

  public async indexPath(workspaceId: string, relativePath: string, options: WorkspaceIndexOptions = {}): Promise<Result<WorkspaceIndexSnapshot>> {
    return this.indexPaths(workspaceId, [relativePath], options);
  }

  /**
   * Process a burst of native filesystem changes inside ONE mutation and one
   * snapshot publication, rather than serializing the full JSON index per path.
   * All paths are validated before publishing any result.
   */
  private async indexPaths(workspaceId: string, relativePaths: readonly string[], options: WorkspaceIndexOptions = {}): Promise<Result<WorkspaceIndexSnapshot>> {
    const paths = [...new Set(relativePaths.map(normalizeRelativePath))];
    if (paths.includes('') || paths.length === 0) return this.indexWorkspace(workspaceId, options);
    return this.mutateSnapshot(workspaceId, async (workspace, store) => {
      const rootPath = resolveHostPath(workspace.realRootPath);
      if (rootPath === null) return err(appError('INVALID_INPUT', 'Index path uses a foreign host path syntax'));
      // Validate ALL paths before an index-missing rebuild, and before any
      // publication: a rejected path must not turn into an implicit full scan.
      const validatedPaths: Array<readonly [string, string]> = [];
      const canonicalSeen = new Set<string>();
      for (const normalized of paths) {
        options.signal?.throwIfAborted();
        const absolutePath = resolveHostPath(hostPathApi(process.platform).join(rootPath, normalized));
        if (absolutePath === null) return err(appError('INVALID_INPUT', 'Index path uses a foreign host path syntax'));
        if (!isHostPathWithin(rootPath, absolutePath)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Index path is outside workspace'));
        // A symlink or junction inside the workspace must not make a direct
        // incremental update read or crawl a target outside its real root.
        try {
          if (!isHostPathWithin(rootPath, await realpath(absolutePath))) {
            return err(appError('PATH_OUTSIDE_WORKSPACE', 'Index path resolves outside workspace'));
          }
        } catch (error: unknown) {
          if (!isNodeError(error, 'ENOENT')) throw error;
        }
        const canonicalRelative = normalizeRelativePath(hostPathApi(process.platform).relative(rootPath, absolutePath));
        if (canonicalSeen.has(canonicalRelative)) continue;
        canonicalSeen.add(canonicalRelative);
        validatedPaths.push([canonicalRelative, absolutePath]);
      }
      const current = await store.load();
      if (current === null) return options.deepLargeFile === true
        ? err(appError('CONFLICT', 'Build the workspace index before requesting deep analysis of a single large file', true))
        : this.rebuildSnapshot(workspace, store, options);
      const discovery = options.discovery ?? 'automatic';
      // Lookups and updates are keyed by path. The previous array.filter()
      // implementation scanned *every* existing entry twice per changed file:
      // 30k indexed paths x 1k events meant ~60 million comparisons.
      const entries = new Map(current.entries.map((entry) => [entry.relativePath, entry]));
      let changed = false;
      // Every incremental batch can read many 8 MiB files; share the same
      // cross-process heavy-I/O lease used by full scans and ripgrep.
      await this.scanWithBudget(rootPath, async (checkpoint) => {
        let processed = 0;
        for (const [normalized, absolutePath] of validatedPaths) {
          if (++processed % 8 === 0) await checkpoint();
          options.signal?.throwIfAborted();
          if (!classifyContextPath(normalized, discovery).discoverable || (discovery === 'automatic' && this.store.isInternalPath?.(absolutePath))) continue;
          const original = entries.get(normalized);
          const additions: WorkspaceIndexEntry[] = [];
          let isDirectory = false;
          try {
            const metadata = await lstat(absolutePath);
            if (options.deepLargeFile === true && metadata.isFile() && metadata.size > MAX_DEEP_INDEX_FILE_BYTES) {
              throw new DeepIndexFileTooLargeError();
            }
            isDirectory = metadata.isDirectory();
            if (isDirectory) await this.scanDirectory(rootPath, absolutePath, additions, discovery, options.signal, undefined, { visited: 0 }, checkpoint);
            else additions.push(await this.describePath(rootPath, absolutePath, metadata, options.signal,
              options.rebuild === true ? undefined : entries, options.deepLargeFile === true));
          } catch (error: unknown) {
            if (!isNodeError(error, 'ENOENT')) throw error;
          }
          const previous = original === undefined ? [] : [original];
          // Scanning descendants is necessary only for directory changes or
          // removal of a previously indexed directory, not for each file event.
          if (isDirectory || original?.kind === 'directory') {
            const prefix = `${normalized}/`;
            for (const [key, entry] of entries) {
              if (key.startsWith(prefix)) previous.push(entry);
            }
          }
          previous.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
          additions.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
          if (isDeepStrictEqual(previous.map(indexEntryContent), additions.map(indexEntryContent))) continue;
          for (const entry of previous) entries.delete(entry.relativePath);
          for (const entry of additions) entries.set(entry.relativePath, entry);
          changed = true;
        }
      }, options.signal, options.background === true ? 'background' : 'interactive');
      if (!changed) return ok(current);
      const snapshot = this.snapshotValue(workspace, [...entries.values()]);
      await store.save(snapshot);
      return ok(snapshot);
    }, options.signal);
  }

  public async removePath(workspaceId: string, relativePath: string): Promise<Result<WorkspaceIndexSnapshot>> {
    const normalized = normalizeRelativePath(relativePath);
    return this.mutateSnapshot(workspaceId, async (workspace, store) => {
      const current = await store.load();
      if (current === null) return err(appError('CONFLICT', 'Workspace index is missing; rebuild before removing entries', true));
      const entries = current.entries.filter((entry) => entry.relativePath !== normalized && !entry.relativePath.startsWith(`${normalized}/`));
      if (entries.length === current.entries.length) return ok(current);
      const snapshot = this.snapshotValue(workspace, entries);
      await store.save(snapshot);
      return ok(snapshot);
    });
  }

  public async snapshot(workspaceId: string): Promise<Result<WorkspaceIndexSnapshot | null>> {
    const workspace = await this.resolve(workspaceId);
    if (!workspace.ok) return workspace;
    try {
      return ok(await this.store.load(workspace.value.id));
    } catch {
      return err(appError('INTERNAL_ERROR', 'Workspace index could not be read; rebuild the index to recover'));
    }
  }

  public async status(workspaceId: string): Promise<Result<WorkspaceIndexStatus>> {
    const snapshot = await this.snapshot(workspaceId);
    if (!snapshot.ok) return snapshot;
    const watchState = this.watchers.get(workspaceId);
    const watcher = watchState?.queue.status() ?? null;
    const freshness = indexFreshness(snapshot.value, watcher, watchState, snapshot.value === null || this.isAutomaticallyObservable(snapshot.value));
    return ok({
      indexed: snapshot.value !== null,
      snapshot: snapshot.value,
      watcher,
      generation: snapshot.value === null ? null : this.generationFor(snapshot.value),
      freshness: freshness.state,
      stale: freshness.stale,
      watcherError: watchState?.error ?? null,
    });
  }

  /** Compact status reads a sidecar instead of materializing 30k+ entries. */
  public async compactStatus(workspaceId: string): Promise<Result<WorkspaceIndexCompactStatus>> {
    const workspace = await this.resolve(workspaceId);
    if (!workspace.ok) return workspace;
    let metadata: WorkspaceIndexMetadata | null;
    try {
      if (this.store.loadMetadata !== undefined) {
        metadata = await this.store.loadMetadata(workspace.value.id);
      } else {
        // Custom/legacy storage retains compatible full-status behavior.
        const snapshot = await this.store.load(workspace.value.id);
        metadata = snapshot === null ? null
          : snapshotMetadata(snapshot, '', (entry) => !this.store.isInternalPath?.(path.resolve(snapshot.rootPath, entry.relativePath)));
      }
    } catch {
      return err(appError('INTERNAL_ERROR', 'Workspace index metadata could not be read'));
    }
    const watchState = this.watchers.get(workspaceId);
    const watcher = watchState?.queue.status() ?? null;
    const compactSnapshot: WorkspaceIndexCompactStatus['snapshot'] = metadata === null ? null : {
      version: 1,
      discoveryPolicyRevision: 1,
      workspaceId: metadata.workspaceId,
      rootPath: metadata.rootPath,
      indexedAt: metadata.indexedAt,
      entries: [],
    };
    const freshness = indexFreshness(compactSnapshot, watcher, watchState, metadata?.automaticCoverage ?? true);
    return ok({
      indexed: metadata !== null,
      snapshot: compactSnapshot,
      snapshotEntryCount: metadata?.entryCount ?? 0,
      snapshotEntriesOmitted: metadata !== null,
      watcher,
      generation: metadata?.generation ?? null,
      freshness: freshness.state,
      stale: freshness.stale,
      watcherError: watchState?.error ?? null,
    });
  }

  public async startWatch(workspaceId: string, options: WorkspaceIndexWatchOptions = {}): Promise<Result<WorkspaceIndexStatus>> {
    const attempt: WatchStartAttempt = { watcher: null, completed: false };
    const cancel = (): void => {
      if (attempt.completed || attempt.watcher === null) return;
      attempt.watcher.fileWatcher.close();
      if (this.watchers.get(workspaceId) === attempt.watcher) this.watchers.delete(workspaceId);
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const starting = this.serialize(this.watchLifecycles, workspaceId, async () => {
      const result = await this.startWatchNow(workspaceId, options, attempt);
      attempt.completed = result.ok;
      return result;
    }, options.signal);
    try {
      return await waitForIndexOperation(starting, options.signal, () => attempt.completed);
    } catch (error: unknown) {
      if (options.signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Workspace watcher start was cancelled', true));
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      if (options.signal?.aborted) cancel();
    }
  }

  private async startWatchNow(workspaceId: string, options: WorkspaceIndexWatchOptions, attempt: WatchStartAttempt): Promise<Result<WorkspaceIndexStatus>> {
    options.signal?.throwIfAborted();
    if (this.watchingClosed) return err(appError('CONFLICT', 'Workspace watcher service is closed'));
    const workspace = await this.resolve(workspaceId);
    if (!workspace.ok) return workspace;
    options.signal?.throwIfAborted();
    await this.stopWatchNow(workspaceId);
    options.signal?.throwIfAborted();
    let bootstrapping = true;
    const queue = new WorkspaceIndexQueue(async (event) => {
      const mutationOptions: WorkspaceIndexOptions = { background: true, ...(bootstrapping && options.signal !== undefined ? { signal: options.signal } : {}) };
      const result = await retryBusyIndexOperation(() => event.kind === 'rescan'
        ? this.mutateSnapshot(workspaceId, (resolved, store) => this.rebuildSnapshot(resolved, store, mutationOptions, true), mutationOptions.signal)
        : this.indexPath(workspaceId, event.relativePath, mutationOptions), mutationOptions.signal);
      if (!result.ok) throw new Error(result.error.message, { cause: result.error });
    }, {
      ...options,
      // Keep the service default explicit when called from MCP with no option.
      debounceMs: options.debounceMs ?? 1_000,
      batchWorker: async (events): Promise<void> => {
        const mutationOptions: WorkspaceIndexOptions = { background: true, ...(bootstrapping && options.signal !== undefined ? { signal: options.signal } : {}) };
        const result = await retryBusyIndexOperation(() => events.some((event) => event.kind === 'rescan')
          ? this.mutateSnapshot(workspaceId, (resolved, store) => this.rebuildSnapshot(resolved, store, mutationOptions, true), mutationOptions.signal)
          : this.indexPaths(workspaceId, events.map((event) => event.relativePath), mutationOptions), mutationOptions.signal);
        if (!result.ok) throw new Error(result.error.message, { cause: result.error });
      },
    });
    let fileWatcher: FSWatcher;
    try {
      fileWatcher = watch(workspace.value.realRootPath, { recursive: true }, (_eventType, filename) => {
        if (filename === null || filename.length === 0) {
          queue.enqueue({ relativePath: '', kind: 'rescan' });
          return;
        }
        const relativePath = filename;
        if (this.store.isInternalPath?.(path.resolve(workspace.value.realRootPath, relativePath))) return;
        if (!classifyContextPath(relativePath, 'automatic').discoverable) return;
        queue.enqueue({ relativePath, kind: 'change' });
      });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Workspace watcher could not be started'));
    }
    const watcher: IndexWatcher = { fileWatcher, queue, recoveredFailures: 0, baselineVerified: false, error: null };
    attempt.watcher = watcher;
    fileWatcher.on('error', () => {
      watcher.error = 'Workspace watcher failed; restart watching to recover';
      fileWatcher.close();
    });
    this.watchers.set(workspaceId, watcher);
    let completed = false;
    try {
      options.signal?.throwIfAborted();
      // Scan metadata to reconcile offline changes, but reuse content fingerprints
      // for unchanged files; forcing rebuild reread every source file at each watch start.
      const indexed = await this.indexWorkspace(workspaceId, { ...(options.signal === undefined ? {} : { signal: options.signal }) });
      if (!indexed.ok) return indexed;
      await waitForIndexOperation(queue.drain(), options.signal);
      const status = await this.status(workspaceId);
      options.signal?.throwIfAborted();
      completed = status.ok;
      bootstrapping = false;
      return status;
    } catch (error: unknown) {
      if (options.signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Workspace watcher start was cancelled', true));
      throw error;
    } finally {
      if (!completed) {
        fileWatcher.close();
        if (this.watchers.get(workspaceId) === watcher) this.watchers.delete(workspaceId);
        await queue.drain();
      }
    }
  }

  /** Reconfigure an active native watcher in-place; never walks the file tree. */
  public updateWatchDebounce(workspaceId: string, debounceMs: number): Promise<Result<WorkspaceIndexCompactStatus>> {
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > 60_000) {
      return Promise.resolve(err(appError('INVALID_INPUT', 'Watcher debounceMs must be between 0 and 60000')));
    }
    return this.serialize(this.watchLifecycles, workspaceId, async () => {
      const watcher = this.watchers.get(workspaceId);
      if (watcher === undefined) return err(appError('CONFLICT', 'Workspace watcher is not active'));
      if (watcher.error !== null) return err(appError('CONFLICT', 'Workspace watcher has failed; restart it to recover'));
      watcher.queue.setDebounceMs(debounceMs);
      return this.compactStatus(workspaceId);
    });
  }

  public stopWatch(workspaceId: string): Promise<Result<{ readonly stopped: boolean }>> {
    return this.serialize(this.watchLifecycles, workspaceId, () => this.stopWatchNow(workspaceId));
  }

  private async stopWatchNow(workspaceId: string): Promise<Result<{ readonly stopped: boolean }>> {
    const watcher = this.watchers.get(workspaceId);
    if (watcher === undefined) return ok({ stopped: false });
    watcher.fileWatcher.close();
    await watcher.queue.drain();
    if (this.watchers.get(workspaceId) === watcher) this.watchers.delete(workspaceId);
    return ok({ stopped: true });
  }

  public async forgetWorkspace(workspaceId: string): Promise<void> {
    await this.serialize(this.watchLifecycles, workspaceId, async () => {
      await this.stopWatchNow(workspaceId);
      await this.serialize(this.mutations, workspaceId, () => this.store.withMutation(workspaceId, (store) => store.delete()));
    });
  }

  public async close(): Promise<void> {
    this.watchingClosed = true;
    await Promise.all([...this.watchLifecycles.values()]);
    for (const workspaceId of [...this.watchers.keys()]) await this.stopWatch(workspaceId);
    await Promise.all([...this.mutations.values()]);
  }

  private async resolve(workspaceId: string): Promise<Result<Workspace>> {
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found')) : ok(workspace);
  }

  private generationFor(snapshot: WorkspaceIndexSnapshot): string {
    const cached = this.generationCache.get(snapshot);
    if (cached !== undefined) return cached;
    const generation = snapshotGeneration(snapshot);
    this.generationCache.set(snapshot, generation);
    return generation;
  }

  private isAutomaticallyObservable(snapshot: WorkspaceIndexSnapshot): boolean {
    const cached = this.automaticCoverageCache.get(snapshot);
    if (cached !== undefined) return cached;
    const root = resolveHostPath(snapshot.rootPath);
    const observable = root !== null && snapshot.entries.every((entry) =>
      classifyContextPath(entry.relativePath, 'automatic').discoverable &&
      !this.store.isInternalPath?.(path.resolve(root, entry.relativePath)));
    this.automaticCoverageCache.set(snapshot, observable);
    return observable;
  }

  private async rebuildSnapshot(workspace: Workspace, store: WorkspaceIndexMutation, options: WorkspaceIndexOptions, skipUnchangedPublication = false): Promise<Result<WorkspaceIndexSnapshot>> {
    const entries: WorkspaceIndexEntry[] = [];
    const rootPath = resolveHostPath(workspace.realRootPath);
    if (rootPath === null) return err(appError('INVALID_INPUT', 'Workspace root uses a foreign host path syntax'));
    const watcher = this.watchers.get(workspace.id);
    const failureWatermark = watcher?.queue.status().failedEvents ?? 0;
    const discovery = options.discovery ?? 'automatic';
    const previous = discovery === 'automatic' ? await store.load().catch(() => null) : null;
    const reusable = options.rebuild !== true && previous !== null && previous.rootPath === workspace.realRootPath && this.isAutomaticallyObservable(previous)
      ? new Map(previous.entries.map((entry) => [entry.relativePath, entry])) : undefined;
    // One heavy full-workspace walk at a time across active projects in this
    // process; incremental file updates remain independent of this budget.
    await this.scanWithBudget(rootPath, (checkpoint) => this.scanDirectory(rootPath, rootPath, entries, discovery, options.signal, reusable, { visited: 0 }, checkpoint), options.signal);
    const snapshot = this.snapshotValue(workspace, entries);
    options.signal?.throwIfAborted();
    // Avoid serializing and rewriting a whole index when its contents did not
    // change. This also covers manual index requests and watch bootstrap.
    const comparison = previous ?? (skipUnchangedPublication ? await store.load().catch(() => null) : null);
    const unchanged = comparison !== null && isDeepStrictEqual(comparison.entries.map(indexEntryContent), snapshot.entries.map(indexEntryContent));
    options.signal?.throwIfAborted();
    if (!unchanged) await store.save(snapshot);
    if (watcher !== undefined && this.watchers.get(workspace.id) === watcher) {
      watcher.recoveredFailures = Math.max(watcher.recoveredFailures, failureWatermark);
      watcher.baselineVerified = true;
    }
    return ok(unchanged ? comparison : snapshot);
  }

  private async mutateSnapshot(
    workspaceId: string,
    mutation: (workspace: Workspace, store: WorkspaceIndexMutation) => Promise<Result<WorkspaceIndexSnapshot>>,
    signal?: AbortSignal,
  ): Promise<Result<WorkspaceIndexSnapshot>> {
    try {
      return await this.serialize(this.mutations, workspaceId, async () => {
        return await this.store.withMutation(workspaceId, async (store) => {
          signal?.throwIfAborted();
          const workspace = await this.resolve(workspaceId);
          return workspace.ok ? mutation(workspace.value, store) : workspace;
        }, signal);
      }, signal);
    } catch (error: unknown) {
      if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Workspace index update was cancelled', true));
      if (error instanceof WorkspaceIndexBusyError) return err(appError('CONFLICT', error.message, true));
      if (error instanceof DeepIndexFileTooLargeError) return err(appError('FILE_TOO_LARGE', 'Deep file analysis exceeds the 128 MiB read budget'));
      return err(appError('INTERNAL_ERROR', 'Workspace index update failed'));
    }
  }

  private async serialize<T>(operations: Map<string, Promise<void>>, workspaceId: string, mutation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = operations.get(workspaceId) ?? Promise.resolve();
    let started = false;
    const operation = previous.then(() => {
      signal?.throwIfAborted();
      started = true;
      return mutation();
    });
    const settled = operation.then(() => undefined, () => undefined);
    operations.set(workspaceId, settled);
    void settled.then(() => {
      if (operations.get(workspaceId) === settled) operations.delete(workspaceId);
    });
    return waitForIndexOperation(operation, signal, () => started);
  }

  /** Full and incremental directory scans share the same one-slot disk budget as rg.exe. */
  private scanWithBudget<T>(rootPath: string, scan: (checkpoint: () => Promise<void>) => Promise<T>, signal?: AbortSignal, priority: 'interactive' | 'background' = 'background'): Promise<T> {
    return withIndexScanBudget(async () => {
      const lease = await acquireDiskScanLease(rootPath, signal);
      if (lease.status !== 'granted') throw new WorkspaceIndexBusyError();
      let release: (() => Promise<void>) | undefined = lease.release;
      let acquiredAt = Date.now();
      const checkpoint = async (): Promise<void> => {
        signal?.throwIfAborted();
        if (Date.now() - acquiredAt < 2_000) return;
        const held = release;
        release = undefined;
        await held?.();
        await pause(300, undefined, { ...(signal === undefined ? {} : { signal }) });
        const resumed = await acquireDiskScanLease(rootPath, signal, { waitMs: 60_000 });
        if (resumed.status !== 'granted') throw new WorkspaceIndexBusyError();
        release = resumed.release;
        acquiredAt = Date.now();
      };
      try {
        return await scan(checkpoint);
      } finally {
        await release?.();
      }
    }, signal, priority);
  }

  private async scanDirectory(rootPath: string, directoryPath: string, entries: WorkspaceIndexEntry[], discovery: ContextDiscoveryMode, signal?: AbortSignal, reusable?: ReadonlyMap<string, WorkspaceIndexEntry>, progress: { visited: number } = { visited: 0 }, checkpoint?: () => Promise<void>): Promise<void> {
    signal?.throwIfAborted();
    if (discovery === 'automatic' && this.store.isInternalPath?.(directoryPath)) return;
    const api = hostPathApi(process.platform);
    const directoryRelativePath = normalizeRelativePath(api.relative(rootPath, directoryPath));
    if (directoryRelativePath !== '' && !classifyContextPath(directoryRelativePath, discovery).discoverable) return;
    if (directoryRelativePath !== '') entries.push(await this.describePath(rootPath, directoryPath, await stat(directoryPath), signal));
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      signal?.throwIfAborted();
      const childPath = api.join(directoryPath, child.name);
      if (discovery === 'automatic' && this.store.isInternalPath?.(childPath)) continue;
      const childRelativePath = normalizeRelativePath(api.relative(rootPath, childPath));
      if (!classifyContextPath(childRelativePath, discovery).discoverable) continue;
      // Yield periodically so a 30k+ path walk does not monopolize Electron's
      // main event loop. No timer or disk polling occurs while idle.
      progress.visited += 1;
      if (progress.visited % 8 === 0) await checkpoint?.();
      if (progress.visited % 256 === 0) {
        signal?.throwIfAborted();
        await yieldToEventLoop();
      }
      const beforeChild = entries.length;
      try {
        if (child.isDirectory()) await this.scanDirectory(rootPath, childPath, entries, discovery, signal, reusable, progress, checkpoint);
        else if (child.isSymbolicLink()) entries.push(await this.describePath(rootPath, childPath, await statOrLstat(childPath, true), signal));
        else entries.push(await this.describePath(rootPath, childPath, await stat(childPath), signal, reusable));
      } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) throw error;
        entries.splice(beforeChild);
      }
    }
  }

  private async describePath(rootPath: string, absolutePath: string, metadata: Awaited<ReturnType<typeof stat>>, signal?: AbortSignal, reusable?: ReadonlyMap<string, WorkspaceIndexEntry>, deepLargeFile = false): Promise<WorkspaceIndexEntry> {
    const relativePath = normalizeRelativePath(hostPathApi(process.platform).relative(rootPath, absolutePath));
    const previous = reusable?.get(relativePath);
    if (metadata.isFile() && previous?.kind === 'file'
      && previous.size === metadata.size && previous.mtimeMs === metadata.mtimeMs
      && previous.ctimeMs !== undefined && previous.ctimeMs === metadata.ctimeMs
      && previous.birthtimeMs !== undefined && previous.birthtimeMs === metadata.birthtimeMs
      && (!deepLargeFile || metadata.size <= MAX_INDEX_FILE_BYTES || previous.contentHash !== null)) return previous;
    const indexedAt = new Date().toISOString();
    if (metadata.isDirectory()) return { relativePath, kind: 'directory', size: 0, mtimeMs: Number(metadata.mtimeMs), contentHash: null, gitBlobSha: null, language: null, isTest: false, symbols: [], imports: [], exports: [], functions: [], classes: [], interfaces: [], indexedAt };
    if (metadata.isSymbolicLink()) return { relativePath, kind: 'symlink', size: Number(metadata.size), mtimeMs: Number(metadata.mtimeMs), contentHash: null, gitBlobSha: null, language: languageFor(relativePath), isTest: isTestPath(relativePath), symbols: [], imports: [], exports: [], functions: [], classes: [], interfaces: [], indexedAt };
    if (metadata.size > MAX_INDEX_FILE_BYTES) {
      const analysis = deepLargeFile
        ? await analyzeOversizedSource(absolutePath, metadata, signal)
        : { contentHash: null, gitBlobSha: null, symbols: [], imports: [], exports: [], functions: [], classes: [], interfaces: [] };
      return {
        relativePath, kind: 'file', size: Number(metadata.size), mtimeMs: Number(metadata.mtimeMs),
        ctimeMs: Number(metadata.ctimeMs), birthtimeMs: Number(metadata.birthtimeMs),
        language: languageFor(relativePath), isTest: isTestPath(relativePath),
        ...analysis, indexedAt,
      };
    }
    const content = await readFile(absolutePath, { ...(signal === undefined ? {} : { signal }) });
    const contentHash = createHash('sha256').update(content).digest('hex');
    const gitBlobSha = createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
    const text = content.includes(0) ? null : content.toString('utf8');
    const symbols = text === null ? [] : unique([...matchAll(text, /\b(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g)]);
    const functions = text === null ? [] : unique([...matchAll(text, /\bfunction\s+([A-Za-z_$][\w$]*)/g), ...matchAll(text, /\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g)]);
    const classes = text === null ? [] : unique([...matchAll(text, /\bclass\s+([A-Za-z_$][\w$]*)/g)]);
    const interfaces = text === null ? [] : unique([...matchAll(text, /\binterface\s+([A-Za-z_$][\w$]*)/g)]);
    const imports = text === null ? [] : unique([...matchAll(text, /\bimport[^'"\n]*from\s*['"]([^'"]+)['"]/g), ...matchAll(text, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]);
    const exports = text === null ? [] : unique([...matchAll(text, /\bexport\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)?\s*([A-Za-z_$][\w$]*)?/g)].filter((value) => value.length > 0));
    const packageMetadata = path.basename(relativePath).toLowerCase() === 'package.json' && text !== null ? parsePackageMetadata(text) : undefined;
    return {
      relativePath,
      kind: 'file',
      size: Number(metadata.size),
      mtimeMs: Number(metadata.mtimeMs),
      ctimeMs: Number(metadata.ctimeMs), birthtimeMs: Number(metadata.birthtimeMs),
      contentHash,
      gitBlobSha,
      language: languageFor(relativePath),
      isTest: isTestPath(relativePath),
      ...(packageMetadata === undefined ? {} : { packageMetadata }),
      symbols,
      imports,
      exports,
      functions,
      classes,
      interfaces,
      indexedAt,
    };
  }

  private snapshotValue(workspace: Workspace, entries: readonly WorkspaceIndexEntry[]): WorkspaceIndexSnapshot {
    return { version: 1, discoveryPolicyRevision: WORKSPACE_INDEX_DISCOVERY_POLICY_REVISION, workspaceId: workspace.id, rootPath: workspace.realRootPath, indexedAt: new Date().toISOString(), entries: [...entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath)) };
  }
}

/**
 * On-demand analysis only. Never invoked from watcher or automatic full indexing.
 * Hashes the file once with bounded read buffers and an overlapping text window.
 */
async function analyzeOversizedSource(
  absolutePath: string, metadata: Awaited<ReturnType<typeof stat>>, signal?: AbortSignal,
): Promise<Pick<WorkspaceIndexEntry, 'contentHash' | 'gitBlobSha' | 'symbols' | 'imports' | 'exports' | 'functions' | 'classes' | 'interfaces'>> {
  const digest = createHash('sha256');
  const blob = createHash('sha1').update(`blob ${metadata.size}\0`);
  const decoder = new TextDecoder();
  const found = {
    symbols: new Set<string>(), imports: new Set<string>(), exports: new Set<string>(),
    functions: new Set<string>(), classes: new Set<string>(), interfaces: new Set<string>(),
  };
  let carry = '';
  let binary = false;
  const overlapChars = 8192;
  const consume = (text: string, final = false): void => {
    if (binary) return;
    const source = carry + text;
    if (source.includes('\0')) {
      binary = true;
      for (const values of Object.values(found)) values.clear();
      return;
    }
    // Delay matches near a chunk boundary until the complete identifier has arrived.
    const readyEnd = final ? source.length : Math.max(0, source.length - overlapChars);
    const record = (expression: RegExp, destination: Set<string>): void => {
      for (const match of source.matchAll(expression)) {
        if (match.index + match[0].length > readyEnd) continue;
        if (match[1]) destination.add(match[1]);
      }
    };
    record(/\b(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g, found.symbols);
    record(/\bfunction\s+([A-Za-z_$][\w$]*)/g, found.functions);
    record(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g, found.functions);
    record(/\bclass\s+([A-Za-z_$][\w$]*)/g, found.classes);
    record(/\binterface\s+([A-Za-z_$][\w$]*)/g, found.interfaces);
    record(/\bimport[^'"\n]*from\s*['"]([^'"]+)['"]/g, found.imports);
    record(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, found.imports);
    record(/\bexport\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)?\s*([A-Za-z_$][\w$]*)?/g, found.exports);
    carry = source.slice(-overlapChars);
  };
  let bytes = 0;
  for await (const chunk of createReadStream(absolutePath, {
    highWaterMark: 256 * 1024,
    ...(signal === undefined ? {} : { signal }),
  })) {
    signal?.throwIfAborted();
    const buffer = chunk as Buffer;
    bytes += buffer.byteLength;
    if (bytes > MAX_DEEP_INDEX_FILE_BYTES) throw new DeepIndexFileTooLargeError();
    digest.update(buffer);
    blob.update(buffer);
    consume(decoder.decode(buffer, { stream: true }));
  }
  consume(decoder.decode(), true);
  const after = await stat(absolutePath);
  if (bytes !== metadata.size || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs
    || after.ctimeMs !== metadata.ctimeMs || after.birthtimeMs !== metadata.birthtimeMs) {
    throw new Error('File changed during deep indexing');
  }
  const sorted = (values: Set<string>): string[] => unique([...values]);
  return {
    contentHash: digest.digest('hex'), gitBlobSha: blob.digest('hex'),
    symbols: sorted(found.symbols), imports: sorted(found.imports), exports: sorted(found.exports),
    functions: sorted(found.functions), classes: sorted(found.classes), interfaces: sorted(found.interfaces),
  };
}


export function snapshotMetadata(
  snapshot: WorkspaceIndexSnapshot,
  identity: string,
  accepted: (entry: WorkspaceIndexEntry) => boolean,
): WorkspaceIndexMetadata {
  return {
    version: 1, identity, workspaceId: snapshot.workspaceId, rootPath: snapshot.rootPath,
    indexedAt: snapshot.indexedAt, entryCount: snapshot.entries.length,
    generation: snapshotGeneration(snapshot),
    automaticCoverage: snapshot.entries.every((entry) =>
      classifyContextPath(entry.relativePath, 'automatic').discoverable && accepted(entry)),
  };
}

export function isIndexMetadata(value: unknown, workspaceId: string, identity: string): value is WorkspaceIndexMetadata {
  if (!isRecord(value)) return false;
  return value.version === 1 && value.workspaceId === workspaceId && value.identity === identity
    && typeof value.rootPath === 'string' && typeof value.indexedAt === 'string'
    && Number.isSafeInteger(value.entryCount) && typeof value.entryCount === 'number' && value.entryCount >= 0
    && typeof value.generation === 'string' && /^[a-f0-9]{64}$/.test(value.generation)
    && typeof value.automaticCoverage === 'boolean';
}

export function snapshotGeneration(snapshot: WorkspaceIndexSnapshot): string {
  const identity = [snapshot.discoveryPolicyRevision, snapshot.entries.map((entry) => [entry.relativePath, entry.kind, entry.mtimeMs, entry.size, entry.contentHash])];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function indexEntryContent(entry: WorkspaceIndexEntry): Omit<WorkspaceIndexEntry, 'indexedAt'> {
  const { indexedAt, ...content } = entry;
  void indexedAt;
  return content;
}

function indexFreshness(
  snapshot: WorkspaceIndexSnapshot | null,
  watcher: WorkspaceIndexQueueStatus | null,
  watchState?: IndexWatcher,
  automaticCoverage = true,
): { readonly state: WorkspaceIndexStatus['freshness']; readonly stale: boolean | null } {
  if (snapshot === null) return { state: 'missing', stale: null };
  if (watcher === null) return { state: 'unverified', stale: null };
  if (watchState?.error !== null && watchState?.error !== undefined) return { state: 'watching_degraded', stale: true };
  if (watcher.failedEvents > (watchState?.recoveredFailures ?? 0)) return { state: 'watching_degraded', stale: true };
  if (watchState?.baselineVerified !== true || !automaticCoverage) return { state: 'unverified', stale: null };
  if (watcher.pendingEvents > 0 || watcher.activeWorkers > 0) return { state: 'watching_pending', stale: true };
  return { state: 'watching_clean', stale: false };
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function languageFor(relativePath: string): string | null {
  const extension = path.extname(relativePath).toLowerCase();
  const languages: Readonly<Record<string, string>> = { '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx', '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.json': 'json', '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml' };
  return languages[extension] ?? null;
}

function isTestPath(relativePath: string): boolean {
  return /(^|[/\\])(__tests__|tests?)([/\\]|$)|\.(test|spec)\.[^.]+$/i.test(relativePath);
}

function matchAll(text: string, expression: RegExp): string[] {
  return [...text.matchAll(expression)].map((match) => match[1]).filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function parsePackageMetadata(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.version === 'string' ? { version: record.version } : {}),
      ...(typeof record.scripts === 'object' && record.scripts !== null ? { scripts: record.scripts } : {}),
      ...(typeof record.dependencies === 'object' && record.dependencies !== null ? { dependencies: record.dependencies } : {}),
      ...(typeof record.devDependencies === 'object' && record.devDependencies !== null ? { devDependencies: record.devDependencies } : {}),
    };
  } catch {
    return undefined;
  }
}

async function statOrLstat(filePath: string, lstat: boolean): Promise<Awaited<ReturnType<typeof stat>>> {
  if (!lstat) return stat(filePath);
  const { lstat: readLinkStats } = await import('node:fs/promises');
  return readLinkStats(filePath);
}

export function isSnapshot(value: unknown): value is WorkspaceIndexSnapshot {
  return isRecord(value) && value.version === 1
    && value.discoveryPolicyRevision === WORKSPACE_INDEX_DISCOVERY_POLICY_REVISION
    && typeof value.workspaceId === 'string' && value.workspaceId.length > 0
    && typeof value.rootPath === 'string' && value.rootPath.length > 0
    && isTimestamp(value.indexedAt)
    && Array.isArray(value.entries) && value.entries.every(isIndexEntry);
}

function isIndexEntry(value: unknown): value is WorkspaceIndexEntry {
  return isRecord(value) && typeof value.relativePath === 'string' && value.relativePath.length > 0
    && (value.kind === 'file' || value.kind === 'directory' || value.kind === 'symlink')
    && typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
    && typeof value.mtimeMs === 'number' && Number.isFinite(value.mtimeMs)
    && (value.contentHash === null || typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/.test(value.contentHash))
    && (value.gitBlobSha === null || typeof value.gitBlobSha === 'string' && /^[a-f0-9]{40}$/.test(value.gitBlobSha))
    && (value.language === null || typeof value.language === 'string')
    && typeof value.isTest === 'boolean'
    && (value.packageMetadata === undefined || isRecord(value.packageMetadata))
    && [value.symbols, value.imports, value.exports, value.functions, value.classes, value.interfaces].every(isStringArray)
    && isTimestamp(value.indexedAt);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}
