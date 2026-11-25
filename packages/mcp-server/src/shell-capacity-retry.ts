import { setTimeout as delay } from 'node:timers/promises';
import { appError } from '@lnwjing/domain';
import { mapError, type McpToolResponse } from './result-mapper.js';
import { ToolWorkloadAdmission } from './tool-workload-admission.js';

const queues = new WeakMap<ToolWorkloadAdmission, ShellCapacityRetryQueue>();

/** Shared by all registries on an endpoint, not by unrelated profiles. */
export function shellCapacityRetryQueueFor(endpoint: ToolWorkloadAdmission): ShellCapacityRetryQueue {
  let queue = queues.get(endpoint);
  if (queue === undefined) {
    queue = new ShellCapacityRetryQueue();
    queues.set(endpoint, queue);
  }
  return queue;
}

export function isShellCapacityRejection(response: McpToolResponse): boolean {
  const error = response.structuredContent?.error;
  if (response.isError !== true || typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  const details = record.details;
  return record.code === 'CONFLICT' && record.recoverable === true
    && typeof details === 'object' && details !== null
    && (details as Record<string, unknown>).reason === 'durable_shell_capacity';
}

/**
 * Brief, request-scoped backpressure. Only a definite pre-launch capacity
 * rejection is retryable. Never persist a command, consume a worker slot
 * while waiting, retry ambiguous dispatch, or execute after the caller leaves.
 * The callback MUST perform fresh authorization and invoke the regular
 * dispatch path, including the cross-process reservation lock.
 */
export class ShellCapacityRetryQueue {
  private readonly gate = new ToolWorkloadAdmission({ process: 1 });
  private pending = 0;

  constructor(
    private readonly maxWaitMs = 5_000,
    private readonly retryDelayMs = 750,
    private readonly maxPending = 16,
  ) {}

  public async retry(
    initial: McpToolResponse,
    attempt: (waitSignal: AbortSignal) => Promise<McpToolResponse>,
    parentSignal?: AbortSignal,
  ): Promise<McpToolResponse> {
    if (!isShellCapacityRejection(initial)) return initial;
    const cancelled = (): McpToolResponse => mapError(appError('PROCESS_TIMEOUT', 'Shell request cancelled while waiting for capacity; no retry was dispatched', true));
    if (parentSignal?.aborted) return cancelled();
    if (this.pending >= this.maxPending) return initial;
    this.pending += 1;
    const timeout = AbortSignal.timeout(this.maxWaitMs);
    const signal = parentSignal === undefined ? timeout : AbortSignal.any([parentSignal, timeout]);
    let release: (() => void) | undefined;
    let response = initial;
    try {
      try { release = await this.gate.acquire('shell', signal); }
      catch { return parentSignal?.aborted ? cancelled() : response; }
      for (let i = 0; i < 2 && isShellCapacityRejection(response); i++) {
        try { await delay(this.retryDelayMs, undefined, { signal }); }
        catch { return parentSignal?.aborted ? cancelled() : response; }
        if (signal.aborted) return parentSignal?.aborted ? cancelled() : response;
        response = await attempt(signal);
      }
      // Once an attempt returns, its actual result is authoritative. A parent
      // abort does not prove that a successfully admitted worker was stopped.
      return response;
    } finally {
      release?.();
      this.pending -= 1;
    }
  }
}
