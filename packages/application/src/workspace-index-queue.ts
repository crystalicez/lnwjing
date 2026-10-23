export type WorkspaceIndexEventKind = 'change' | 'delete' | 'rescan';

export interface WorkspaceIndexEvent {
  readonly relativePath: string;
  readonly kind: WorkspaceIndexEventKind;
}

export interface WorkspaceIndexQueueStatus {
  readonly pendingEvents: number;
  readonly activeWorkers: number;
  readonly concurrency: number;
  readonly debounceMs: number;
  readonly enqueuedEvents: number;
  readonly coalescedEvents: number;
  readonly completedEvents: number;
  readonly failedEvents: number;
  readonly droppedEvents: number;
  readonly overflowRescans: number;
  readonly completedRescans: number;
  readonly lastRescanDurationMs: number;
}

export interface WorkspaceIndexQueueOptions {
  readonly debounceMs?: number;
  readonly concurrency?: number;
  /** Optional single-transaction batch handler for bursty filesystem events. */
  readonly batchWorker?: (events: readonly WorkspaceIndexEvent[]) => Promise<void>;
}

type EventWorker = (event: WorkspaceIndexEvent) => Promise<void>;
type QueueErrorListener = (event: WorkspaceIndexEvent, error: unknown) => void;

const MAX_PENDING_INDEX_EVENTS = 1_024;
// Allow filesystem storms (build, checkout, package restore) to settle before
// a lossless full rescan. Explicit drain/stop still flushes immediately.
const OVERFLOW_RESCAN_QUIET_MS = 2_000;

/**
 * A lossless event queue: only duplicate notifications for the same path are
 * coalesced. When overloaded it replaces distinct events with a full rescan
 * instead of silently losing coverage; path-discovery policy stays in the caller.
 */
export class WorkspaceIndexQueue {
  private readonly pending = new Map<string, WorkspaceIndexEvent>();
  private readonly debounceMs: number;
  private readonly concurrency: number;
  private readonly listeners = new Set<QueueErrorListener>();
  private readonly batchWorker: ((events: readonly WorkspaceIndexEvent[]) => Promise<void>) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleWaiters = new Set<() => void>();
  private activeWorkers = 0;
  private enqueuedEvents = 0;
  private coalescedEvents = 0;
  private completedEvents = 0;
  private failedEvents = 0;
  private overflowRescans = 0;
  private completedRescans = 0;
  private lastRescanDurationMs = 0;
  private overflowRescanPending = false;

  public constructor(private readonly worker: EventWorker, options: WorkspaceIndexQueueOptions = {}) {
    this.debounceMs = Math.max(0, Math.floor(options.debounceMs ?? 50));
    this.batchWorker = options.batchWorker;
    this.concurrency = this.batchWorker === undefined ? Math.max(1, Math.floor(options.concurrency ?? 2)) : 1;
  }

  public enqueue(event: WorkspaceIndexEvent): void {
    const key = event.relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
    this.enqueuedEvents += 1;
    if (event.kind === 'rescan') {
      this.coalescedEvents += this.pending.size;
      this.pending.clear();
      this.pending.set('', { relativePath: '', kind: 'rescan' });
    } else if (this.pending.has('')) {
      // The queued full rescan already includes this path.
      this.coalescedEvents += 1;
    } else if (!this.pending.has(key) && this.pending.size >= MAX_PENDING_INDEX_EVENTS) {
      // Replace the backlog with a complete rescan; never silently discard paths.
      this.coalescedEvents += this.pending.size;
      this.pending.clear();
      this.pending.set('', { relativePath: '', kind: 'rescan' });
      this.overflowRescans += 1;
      this.overflowRescanPending = true;
    } else {
      if (this.pending.has(key)) this.coalescedEvents += 1;
      this.pending.set(key, { relativePath: key, kind: event.kind });
    }
    this.schedule();
  }

  public onError(listener: QueueErrorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public status(): WorkspaceIndexQueueStatus {
    return {
      pendingEvents: this.pending.size,
      activeWorkers: this.activeWorkers,
      concurrency: this.concurrency,
      debounceMs: this.debounceMs,
      enqueuedEvents: this.enqueuedEvents,
      coalescedEvents: this.coalescedEvents,
      completedEvents: this.completedEvents,
      failedEvents: this.failedEvents,
      droppedEvents: 0,
      overflowRescans: this.overflowRescans,
      completedRescans: this.completedRescans,
      lastRescanDurationMs: this.lastRescanDurationMs,
    };
  }

  public async drain(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    if (this.pending.size > 0 || this.activeWorkers > 0 || this.timer !== undefined) {
      await new Promise<void>((resolve) => {
        this.idleWaiters.add(resolve);
      });
      await this.drain();
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.overflowRescanPending ? Math.max(this.debounceMs, OVERFLOW_RESCAN_QUIET_MS) : this.debounceMs);
  }

  private async flush(): Promise<void> {
    // An earlier worker finishing must not bypass the quiet window of a
    // newer filesystem burst. Explicit drain() cancels the timer first.
    if (this.timer !== undefined) return;
    const workers: Promise<void>[] = [];
    if (this.batchWorker !== undefined && this.activeWorkers === 0 && this.pending.size > 0) {
      const events = [...this.pending.values()];
      this.pending.clear();
      if (events.some((event) => event.kind === 'rescan')) this.overflowRescanPending = false;
      this.activeWorkers += 1;
      workers.push(this.runBatch(events, this.batchWorker));
    }
    while (this.batchWorker === undefined && this.activeWorkers < this.concurrency && this.pending.size > 0) {
      const next = this.pending.entries().next().value as [string, WorkspaceIndexEvent] | undefined;
      if (next === undefined) break;
      this.pending.delete(next[0]);
      if (next[1].kind === 'rescan') this.overflowRescanPending = false;
      this.activeWorkers += 1;
      workers.push(this.run(next[1]));
    }
    if (workers.length > 0) await Promise.all(workers);
    if (this.pending.size > 0 && this.activeWorkers < this.concurrency) await this.flush();
    if (this.pending.size === 0 && this.activeWorkers === 0) {
      const waiters = [...this.idleWaiters];
      this.idleWaiters.clear();
      for (const resolve of waiters) resolve();
    }
  }

  private async runBatch(
    events: readonly WorkspaceIndexEvent[],
    worker: (events: readonly WorkspaceIndexEvent[]) => Promise<void>,
  ): Promise<void> {
    const startedAt = events.some((event) => event.kind === 'rescan') ? Date.now() : null;
    try {
      await worker(events);
      this.completedEvents += events.length;
    } catch (error: unknown) {
      this.failedEvents += events.length;
      for (const event of events) {
        for (const listener of this.listeners) listener(event, error);
      }
    } finally {
      if (startedAt !== null) {
        this.completedRescans += 1;
        this.lastRescanDurationMs = Date.now() - startedAt;
      }
      this.activeWorkers -= 1;
    }
  }

  private async run(event: WorkspaceIndexEvent): Promise<void> {
    const startedAt = event.kind === 'rescan' ? Date.now() : null;
    try {
      await this.worker(event);
      this.completedEvents += 1;
    } catch (error: unknown) {
      this.failedEvents += 1;
      for (const listener of this.listeners) listener(event, error);
    } finally {
      if (startedAt !== null) {
        this.completedRescans += 1;
        this.lastRescanDurationMs = Date.now() - startedAt;
      }
      this.activeWorkers -= 1;
    }
  }
}
