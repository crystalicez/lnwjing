import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjing/domain';
import { AtomicFileWriter, MAX_FILE_WRITE_BYTES } from '@lnwjing/filesystem';
import { DefaultPermissionEngine, permissionProfiles, type PermissionEngine, type PermissionProfile } from '@lnwjing/permissions';
import { WorkspacePathGuard, type Checkpoint, type CheckpointFile, type CheckpointRepository, type Workspace, type WorkspaceRepository } from '@lnwjing/workspace';
import type { FileActor } from './file-service.js';
import { createGuardedWriteValidator } from './guarded-write.js';
import { runMutationTransaction } from './mutation-transaction.js';

export interface CheckpointServicePort {
  createForFiles(actor: FileActor, workspaceId: string, paths: readonly string[]): Promise<Result<Checkpoint>>;
}

export interface RestoreOptions {
  readonly profile?: PermissionProfile;
  readonly expectedCurrentHashes?: Readonly<Record<string, string>>;
  /** Required after a human reviews and confirms the restore. */
  readonly userConfirmed?: boolean;
}

export interface RestoreResult {
  readonly restoredPaths: readonly string[];
  /** Snapshot of the live files immediately before this restore, for one-click undo. */
  readonly rollbackCheckpointId?: string;
}

export interface CheckpointSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly files: readonly {
    readonly path: string;
    readonly contentSha256: string;
    readonly size: number;
  }[];
}

/** Do not expose the cached objects to consumers that may mutate IPC results. */
function copyCheckpointSummaries(summaries: readonly CheckpointSummary[]): CheckpointSummary[] {
  return summaries.map((summary) => ({
    ...summary,
    files: summary.files.map((file) => ({ ...file })),
  }));
}

export interface CheckpointServiceDependencies {
  readonly guard?: WorkspacePathGuard;
  readonly writer?: AtomicFileWriter;
  readonly permissionEngine?: PermissionEngine;
  readonly profile?: PermissionProfile;
  readonly profileProvider?: () => PermissionProfile;
  /** Test/fixture override; production composition uses the real host. */
  readonly platform?: NodeJS.Platform;
}

export class CheckpointService implements CheckpointServicePort {
  private readonly guard: WorkspacePathGuard;
  private readonly writer: AtomicFileWriter;
  private readonly permissionEngine: PermissionEngine;
  private readonly profileProvider: () => PermissionProfile;
  private readonly platform: NodeJS.Platform;
  // One workspace only; this stores safe metadata, never file payloads.
  private cachedRecoveryList: {
    readonly workspaceId: string;
    readonly limit: number;
    readonly revision: number;
    readonly connectionIdentity: object;
    readonly summaries: readonly CheckpointSummary[];
  } | null = null;

  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly repository: CheckpointRepository,
    dependencies: CheckpointServiceDependencies = {},
  ) {
    this.guard = dependencies.guard ?? new WorkspacePathGuard();
    this.writer = dependencies.writer ?? new AtomicFileWriter();
    this.permissionEngine = dependencies.permissionEngine ?? new DefaultPermissionEngine();
    this.profileProvider = dependencies.profileProvider ?? ((): PermissionProfile => dependencies.profile ?? permissionProfiles.balanced);
    this.platform = dependencies.platform ?? process.platform;
  }

  public async createForFiles(actor: FileActor, workspaceId: string, paths: readonly string[]): Promise<Result<Checkpoint>> {
    void actor;
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20) return err(appError('INVALID_INPUT', 'Checkpoint requires 1 to 20 files'));
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    const files: CheckpointFile[] = [];
    let totalBytes = 0;
    const seen = new Set<string>();
    for (const inputPath of paths) {
      const resolved = await this.guard.resolveForRead(workspace.value, inputPath);
      if (!resolved.ok) return resolved;
      const duplicateKey = this.platform === 'win32' ? resolved.value.relativePath.toLowerCase() : resolved.value.relativePath;
      if (seen.has(duplicateKey)) return err(appError('INVALID_INPUT', 'Checkpoint contains duplicate paths'));
      seen.add(duplicateKey);
      const file = await this.readCheckpointFile(resolved.value.realPath ?? resolved.value.absolutePath, resolved.value.relativePath);
      if (!file.ok) return file;
      totalBytes += file.value.size;
      if (totalBytes > MAX_FILE_WRITE_BYTES) return err(appError('FILE_TOO_LARGE', 'Checkpoint exceeds the maximum size'));
      files.push(file.value);
    }
    const checkpoint: Checkpoint = { id: randomUUID(), workspaceId, createdAt: new Date().toISOString(), files };
    await this.repository.insert(checkpoint);
    return ok(checkpoint);
  }

  public async list(workspaceId: string, limit = 100): Promise<Result<readonly CheckpointSummary[]>> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
    const before = this.repository.revisionSnapshot?.();
    const cached = this.cachedRecoveryList;
    if (before !== undefined && cached !== null && cached.workspaceId === workspaceId
      && cached.limit === boundedLimit && cached.revision === before.revision
      && cached.connectionIdentity === before.connectionIdentity) {
      return ok(copyCheckpointSummaries(cached.summaries));
    }
    const checkpoints = await this.repository.list(workspaceId, boundedLimit);
    const summaries = checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      workspaceId: checkpoint.workspaceId,
      createdAt: checkpoint.createdAt,
      files: checkpoint.files.map((file) => ({
        path: file.path,
        contentSha256: file.contentSha256,
        size: file.size,
      })),
    }));
    const after = this.repository.revisionSnapshot?.();
    // No cached results when a different writer modified checkpoint state
    // during this read. A later dashboard request will fetch authoritative data.
    this.cachedRecoveryList = before !== undefined && after !== undefined
      && before.revision === after.revision && before.connectionIdentity === after.connectionIdentity
      ? { workspaceId, limit: boundedLimit, revision: after.revision,
        connectionIdentity: after.connectionIdentity, summaries }
      : null;
    return ok(copyCheckpointSummaries(summaries));
  }

  public async restore(
    actor: FileActor,
    workspaceId: string,
    checkpointId: string,
    options: RestoreOptions = {},
    authorization?: InvocationAuthorization,
  ): Promise<Result<RestoreResult>> {
    if (!isApplicationAuthorized(authorization, options.userConfirmed === true)) return err(appError('PERMISSION_REQUIRED', 'Checkpoint restore requires explicit user confirmation'));
    const checkpoint = await this.repository.get(checkpointId);
    if (checkpoint === null) return err(appError('FILE_NOT_FOUND', 'Checkpoint was not found'));
    if (checkpoint.workspaceId !== workspaceId) return err(appError('PERMISSION_DENIED', 'Checkpoint belongs to another workspace'));
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;

    const resolvedFiles: {
      readonly file: CheckpointFile;
      readonly absolutePath: string;
      readonly validateDestination: () => Promise<Result<void>>;
    }[] = [];
    for (const file of checkpoint.files) {
      const resolved = await this.guard.resolveForWrite(workspace.value, file.path);
      if (!resolved.ok) return resolved;
      if (!resolved.value.exists) return err(appError('INVALID_INPUT', 'Checkpoint restore target is missing; use Recovery Trash for deleted paths'));
      if (options.expectedCurrentHashes !== undefined) {
        const currentHash = await this.hashCurrentFile(resolved.value.realPath ?? resolved.value.absolutePath);
        const expected = options.expectedCurrentHashes[file.path];
        if (expected !== undefined && currentHash !== expected) return err(appError('INVALID_INPUT', 'Checkpoint restore conflict detected'));
      }
      resolvedFiles.push({
        file,
        absolutePath: resolved.value.realPath ?? resolved.value.absolutePath,
        validateDestination: createGuardedWriteValidator(this.guard, workspace.value, file.path, resolved.value, authorization),
      });
    }

    const profile = options.profile ?? this.profileProvider();
    const decision = this.permissionEngine.decide(profile, { action: 'restore_checkpoint', level: 'WRITE', workspaceId, target: checkpointId, destructive: false });
    if (decision === 'DENY') return err(appError('PERMISSION_DENIED', 'Checkpoint restore is denied'));
    if (decision === 'ASK' && !isApplicationAuthorized(authorization, options.userConfirmed === true)) return err(appError('PERMISSION_REQUIRED', 'Checkpoint restore requires permission'));
    const rollback = await this.createForFiles(actor, workspaceId, checkpoint.files.map((file) => file.path));
    if (!rollback.ok) return rollback;
    const rollbackFiles = new Map(rollback.value.files.map((file) => [file.path, file.content] as const));
    const transaction = await runMutationTransaction(resolvedFiles.map((resolved) => ({
      label: resolved.file.path,
      commit: (): Promise<Result<void>> => this.writer.write(resolved.absolutePath, resolved.file.content, {
        validateDestination: resolved.validateDestination,
      }),
      rollback: (): Promise<Result<void>> => {
        const original = rollbackFiles.get(resolved.file.path);
        if (original === undefined) {
          return Promise.resolve(err(appError('INTERNAL_ERROR', 'Rollback checkpoint is missing a file required for restore recovery', true)));
        }
        return this.writer.write(resolved.absolutePath, original, { validateDestination: resolved.validateDestination });
      },
    })));
    if (!transaction.ok) return transaction;
    return ok({ restoredPaths: resolvedFiles.map((resolved) => resolved.file.path), rollbackCheckpointId: rollback.value.id });
  }

  private async readCheckpointFile(filePath: string, relativePath: string): Promise<Result<CheckpointFile>> {
    let data: Buffer;
    try {
      if (!(await lstat(filePath)).isFile()) return err(appError('INVALID_INPUT', 'Checkpoint target must be a file'));
      data = await readFile(filePath);
    } catch {
      return err(appError('FILE_NOT_FOUND', 'Checkpoint file was not found'));
    }
    if (data.byteLength > MAX_FILE_WRITE_BYTES) return err(appError('FILE_TOO_LARGE', 'Checkpoint file exceeds the maximum size'));
    if (data.subarray(0, 8192).includes(0)) return err(appError('BINARY_FILE', 'Binary files cannot be checkpointed'));
    const content = data.toString('utf8');
    return ok({ path: relativePath, content, contentSha256: hash(content), size: data.byteLength });
  }

  private async hashCurrentFile(filePath: string): Promise<string | null> {
    try {
      const data = await readFile(filePath);
      return hash(data.toString('utf8'));
    } catch {
      return null;
    }
  }

  private async getWorkspace(workspaceId: string): Promise<Result<Workspace>> {
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found')) : ok(workspace);
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
