import { createHash, randomUUID } from 'node:crypto';
import { appError, err, ok, type Result } from '@lnwjing/domain';
import { DurableShellTaskIndex } from './durable-shell-task-index.js';
import { DurableShellTaskStore } from './durable-shell-task-store.js';

export type WriterContainmentKind = 'synchronous_mutation' | 'uncontained_process' | 'contained_process';

export interface ManagedWriterAdmissionLease {
  readonly id: string;
  /** Call only after the mutation completed and every spawned process was verified terminated. */
  releaseAfterVerifiedTermination(): Promise<void>;
}

/**
 * Reuses the durable shell's single on-disk reservation index across all
 * workspaces. An uncontained process reservation deliberately cannot be
 * reclaimed by PID disappearance; child/orphan zero-activity proof is required.
 */
export class SharedManagedWriterAdmission {
  private readonly index: DurableShellTaskIndex;

  constructor(taskDirectory: string) {
    const store = new DurableShellTaskStore(taskDirectory);
    this.index = new DurableShellTaskIndex(taskDirectory, {
      maxConcurrentTasks: 10000,
      inspectTask: (taskId): ReturnType<DurableShellTaskStore['inspectForWriterAdmission']> =>
        store.inspectForWriterAdmission(taskId),
    });
  }

  /**
   * Acquire a short-lived repository-import-class barrier across the durable
   * shell/process index. It inspects and conservatively refuses active or
   * unverifiable tasks before a workspace lease is acquired or released.
   * The caller holds the barrier across its SQLite admission transaction.
   */
  async holdExclusiveProbe(workspaceId: string): Promise<Result<ManagedWriterAdmissionLease>> {
    if (!workspaceId) return err(appError('INVALID_INPUT', 'Workspace lease probe requires a workspace ID'));
    const id = 'workspace-writer-probe-' + randomUUID();
    const requestDigest = createHash('sha256').update(id + ':' + workspaceId).digest('hex');
    const reserved = await this.index.reserve({
      taskId: id,
      requestDigest,
      mutationKind: 'repository_import',
      ownerClientId: 'lnwjing-workspace-writer-fence',
      ownerWorkspaceId: workspaceId,
    });
    if (!reserved.ok) return reserved;
    return ok({
      id,
      releaseAfterVerifiedTermination: (): Promise<void> => this.index.release(id, requestDigest),
    });
  }

  async enter(input: {
    readonly actorClientId: string;
    readonly workspaceId: string;
    readonly kind: WriterContainmentKind;
    readonly nativeReceiptPath?: string;
  }): Promise<Result<ManagedWriterAdmissionLease>> {
    if (!input.actorClientId || !input.workspaceId
      || (input.kind !== 'synchronous_mutation' && input.kind !== 'uncontained_process' && input.kind !== 'contained_process')) {
      return err(appError('INVALID_INPUT', 'Managed writer admission identity is invalid'));
    }
    const id = 'managed-writer-' + randomUUID();
    const digest = createHash('sha256').update(id + ':' + input.actorClientId + ':' + input.workspaceId).digest('hex');
    const reserved = await this.index.reserve({
      taskId: id,
      requestDigest: digest,
      mutationKind: input.kind === 'uncontained_process' ? 'opaque_uncontained' : input.kind === 'contained_process' ? 'opaque_contained_process' : 'opaque',
      ...(input.nativeReceiptPath === undefined ? {} : { nativeReceiptPath: input.nativeReceiptPath }),
      ownerClientId: input.actorClientId,
      ownerWorkspaceId: input.workspaceId,
    });
    if (!reserved.ok) return reserved;
    return ok({
      id,
      releaseAfterVerifiedTermination: (): Promise<void> => this.index.release(id, digest),
    });
  }
}
