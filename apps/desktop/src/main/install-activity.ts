import type {
  InstallActivitySnapshot,
  InstallOperationKind,
  InstallOperationPhase,
  InstallOperationStatus,
} from '@lnwjing/ipc-contracts';

export interface InstallOperationUpdate {
  readonly kind: InstallOperationKind;
  readonly phase: InstallOperationPhase;
  readonly progressPercent: number | null;
  readonly message: string | null;
}

export class InstallActivityCoordinator {
  private readonly operations = new Map<InstallOperationKind, InstallOperationStatus>();

  public constructor(
    private readonly publish: (snapshot: InstallActivitySnapshot) => void = () => undefined,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public snapshot(): InstallActivitySnapshot {
    return {
      operations: [...this.operations.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    };
  }

  public set(update: InstallOperationUpdate): InstallActivitySnapshot {
    const timestamp = this.now();
    const current = this.operations.get(update.kind);
    this.operations.set(update.kind, {
      ...update,
      progressPercent: update.progressPercent === null ? null : Math.max(0, Math.min(100, update.progressPercent)),
      startedAt: current?.startedAt ?? timestamp,
      updatedAt: timestamp,
    });
    return this.emit();
  }

  public clear(kind: InstallOperationKind): InstallActivitySnapshot {
    if (!this.operations.delete(kind)) return this.snapshot();
    return this.emit();
  }

  private emit(): InstallActivitySnapshot {
    const snapshot = this.snapshot();
    this.publish(snapshot);
    return snapshot;
  }
}
