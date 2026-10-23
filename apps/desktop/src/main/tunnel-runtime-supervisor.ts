import type { TunnelReconcileResult, TunnelRuntimeReconciler } from './tunnel-runtime-reconciler.js';
import type { TunnelRuntimeSnapshot } from './tunnel-runtime-state.js';

const TRANSIENT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;
const HEALTHY_RECONCILE_MS = 30_000;

export interface TunnelRuntimeSupervisorOptions {
  readonly reconciler: Pick<TunnelRuntimeReconciler, 'reconcile' | 'stop' | 'snapshot'>;
  readonly enabled: () => boolean;
  readonly now?: () => Date;
  readonly jitter?: (baseMs: number) => number;
  readonly healthyIntervalMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly onUpdate?: (snapshot: TunnelRuntimeSnapshot) => void;
}

export interface TunnelRuntimeSupervisorDiagnostics {
  readonly restartAttemptCount: number;
  readonly restartSuccessCount: number;
  readonly restartFailureCount: number;
  readonly restartScheduled: boolean;
  readonly lastScheduledAt: string | null;
  readonly lastStartedAt: string | null;
  readonly lastCompletedAt: string | null;
  readonly lastResult: 'never' | 'scheduled' | 'started' | 'success' | 'failure' | 'cancelled';
  readonly lastError: string | null;
}

export class TunnelRuntimeSupervisor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;
  private reconcileInFlight: Promise<TunnelReconcileResult | null> | null = null;
  private unexpectedFailureCount = 0;
  private nextReconnectAt: string | null = null;
  private restartAttemptCount = 0;
  private restartSuccessCount = 0;
  private restartFailureCount = 0;
  private restartScheduled = false;
  private lastRestartScheduledAt: string | null = null;
  private lastRestartStartedAt: string | null = null;
  private lastRestartCompletedAt: string | null = null;
  private lastRestartResult: TunnelRuntimeSupervisorDiagnostics['lastResult'] = 'never';
  private lastRestartError: string | null = null;

  public constructor(private readonly options: TunnelRuntimeSupervisorOptions) {}

  public async start(): Promise<TunnelReconcileResult | null> {
    this.disposed = false;
    this.running = true;
    this.clearTimer();
    return this.runOnce();
  }

  /**
   * Retry immediately after explicit operator repair (new key, new client path,
   * explicit reconfiguration). This is the only path that wakes an auth/operator
   * failure without waiting for another user action.
   */
  public async kick(): Promise<TunnelReconcileResult | null> {
    if (this.disposed) return null;
    this.running = true;
    this.clearTimer();
    return this.runOnce();
  }

  public async stopRuntime(): Promise<TunnelReconcileResult | null> {
    this.running = false;
    this.clearTimer();
    this.nextReconnectAt = null;
    const result = await this.options.reconciler.stop();
    this.publish(result.snapshot);
    return result;
  }

  /** Cancel Desktop monitoring while intentionally leaving a native managed
   * runtime alive. Used on Desktop exit so the same alias/tunnel can survive the
   * short GUI restart window and be rebound on the next launch. */
  public dispose(): void {
    this.disposed = true;
    this.running = false;
    this.nextReconnectAt = null;
    this.clearTimer();
  }

  public snapshot(): TunnelRuntimeSnapshot | null {
    const snapshot = this.options.reconciler.snapshot();
    return snapshot === null ? null : { ...snapshot, nextReconnectAt: this.nextReconnectAt };
  }

  public diagnostics(): TunnelRuntimeSupervisorDiagnostics {
    return {
      restartAttemptCount: this.restartAttemptCount,
      restartSuccessCount: this.restartSuccessCount,
      restartFailureCount: this.restartFailureCount,
      restartScheduled: this.restartScheduled,
      lastScheduledAt: this.lastRestartScheduledAt,
      lastStartedAt: this.lastRestartStartedAt,
      lastCompletedAt: this.lastRestartCompletedAt,
      lastResult: this.lastRestartResult,
      lastError: this.lastRestartError,
    };
  }

  private runOnce(restartAttempt = false): Promise<TunnelReconcileResult | null> {
    if (!this.running || this.disposed || !this.options.enabled()) return Promise.resolve(null);
    if (this.reconcileInFlight !== null) return this.reconcileInFlight;
    if (restartAttempt) {
      this.restartScheduled = false;
      this.restartAttemptCount += 1;
      this.lastRestartStartedAt = new Date(this.nowMs()).toISOString();
      this.lastRestartCompletedAt = null;
      this.lastRestartResult = 'started';
      this.lastRestartError = null;
    }
    const operation = this.options.reconciler.reconcile()
      .then((result) => {
        this.unexpectedFailureCount = 0;
        if (restartAttempt) {
          const succeeded = result.action === 'healthy' || result.action === 'connected' || result.action === 'reconnected';
          this.lastRestartCompletedAt = new Date(this.nowMs()).toISOString();
          this.lastRestartResult = succeeded ? 'success' : 'failure';
          if (succeeded) this.restartSuccessCount += 1;
          else {
            this.restartFailureCount += 1;
            this.lastRestartError = result.snapshot.message ?? result.snapshot.lastErrorCode ?? result.action;
          }
        }
        if (!this.running || this.disposed) return result;
        this.scheduleFrom(result);
        this.publish(result.snapshot);
        return result;
      })
      .catch((error: unknown) => {
        this.unexpectedFailureCount += 1;
        // A failed status/capabilities call must not permanently stop monitoring.
        // Back off even if it was a normal healthy poll rather than a retry.
        if (this.running && !this.disposed && this.options.enabled()) {
          const index = Math.min(this.unexpectedFailureCount - 1, TRANSIENT_BACKOFF_MS.length - 1);
          const base = TRANSIENT_BACKOFF_MS[index]!;
          const jittered = this.options.jitter?.(base) ?? defaultJitter(base);
          this.schedule(Math.max(250, Math.min(90_000, Math.round(jittered))), true);
        }
        if (restartAttempt) {
          this.restartFailureCount += 1;
          this.lastRestartCompletedAt = new Date(this.nowMs()).toISOString();
          this.lastRestartResult = 'failure';
        }
        // Keep the diagnostic visible even when schedule() clears the previous
        // failure while installing a new retry timer.
        this.lastRestartError = (error instanceof Error ? error.message : String(error)).slice(0, 512);
        throw error;
      })
      .finally(() => {
        if (this.reconcileInFlight === operation) this.reconcileInFlight = null;
      });
    this.reconcileInFlight = operation;
    return operation;
  }

  private scheduleFrom(result: TunnelReconcileResult): void {
    if (!this.running || this.disposed || !this.options.enabled()) return;
    switch (result.action) {
      case 'healthy':
      case 'connected':
      case 'reconnected':
        this.schedule(this.options.healthyIntervalMs ?? HEALTHY_RECONCILE_MS, false);
        return;
      case 'retry-required': {
        const failures = Math.max(1, result.snapshot.consecutiveFailures);
        const base = TRANSIENT_BACKOFF_MS[Math.min(failures - 1, TRANSIENT_BACKOFF_MS.length - 1)]!;
        const jittered = this.options.jitter?.(base) ?? defaultJitter(base);
        this.schedule(Math.max(250, Math.min(90_000, Math.round(jittered))), true);
        return;
      }
      case 'auth-required':
      case 'operator-required':
      case 'fallback-required':
      case 'disabled':
        // Fail quiet: these need an explicit repair/reconfigure/start action.
        this.nextReconnectAt = null;
        this.clearTimer();
        return;
    }
  }

  private schedule(delayMs: number, reconnect: boolean): void {
    this.clearTimer();
    const now = this.nowMs();
    const dueAt = new Date(now + delayMs).toISOString();
    this.nextReconnectAt = reconnect ? dueAt : null;
    if (reconnect) {
      this.restartScheduled = true;
      this.lastRestartScheduledAt = new Date(now).toISOString();
      this.lastRestartResult = 'scheduled';
      this.lastRestartError = null;
    }
    const create = this.options.setTimeout ?? setTimeout;
    this.timer = create(() => {
      this.timer = null;
      this.nextReconnectAt = null;
      const wasRestart = reconnect;
      if (wasRestart) this.restartScheduled = false;
      // Errors are already recorded and rescheduled by runOnce. Always observe
      // the promise so a timer tick cannot emit an unhandled rejection.
      void this.runOnce(wasRestart).catch(() => undefined);
    }, delayMs);
    this.timer.unref?.();
  }

  private publish(snapshot: TunnelRuntimeSnapshot): void {
    this.options.onUpdate?.({ ...snapshot, nextReconnectAt: this.nextReconnectAt });
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    (this.options.clearTimeout ?? clearTimeout)(this.timer);
    this.timer = null;
    if (this.restartScheduled) {
      this.restartScheduled = false;
      this.lastRestartCompletedAt = new Date(this.nowMs()).toISOString();
      this.lastRestartResult = 'cancelled';
    }
  }

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }
}

function defaultJitter(baseMs: number): number {
  // ±10% prevents synchronized retries while keeping the cap bounded.
  return baseMs * (0.9 + Math.random() * 0.2);
}

export { HEALTHY_RECONCILE_MS, TRANSIENT_BACKOFF_MS };
