import { describe, expect, it, vi } from 'vitest';
import { appError } from '@lnwjing/domain';
import { mapError, mapResult } from './result-mapper.js';
import { ok } from '@lnwjing/domain';
import { ShellCapacityRetryQueue, shellCapacityRetryQueueFor } from './shell-capacity-retry.js';
import { ToolWorkloadAdmission } from './tool-workload-admission.js';

const full = mapError({ ...appError('CONFLICT', 'full', true), details: { reason: 'durable_shell_capacity' } });
const success = mapResult(ok({ task_id: 'launched', state: 'running' }));

describe('shell capacity retry backpressure', () => {
  it('retries only explicit pre-launch capacity rejection and preserves the actual result', async () => {
    const queue = new ShellCapacityRetryQueue(1000, 5);
    const run = vi.fn(async () => success);
    const ambiguous = mapError(appError('PROCESS_TIMEOUT', 'transport lost', true));
    expect(await queue.retry(ambiguous, run)).toBe(ambiguous);
    expect(run).not.toHaveBeenCalled();
    expect(await queue.retry(full, run)).toBe(success);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('serializes retrying clients, bounds attempts, and does not retry unrelated conflicts', async () => {
    const queue = new ShellCapacityRetryQueue(1000, 5);
    const order: string[] = [];
    const failed = mapError(appError('CONFLICT', 'workspace lease changed', true));
    const first = queue.retry(full, async () => { order.push('first'); return full; });
    const second = queue.retry(full, async () => { order.push('second'); return failed; });
    expect(await first).toBe(full);
    expect(await second).toBe(failed);
    expect(order).toEqual(['first', 'first', 'second']);
  });

  it('removes aborted waiting requests without dispatching and keeps the queue usable', async () => {
    const queue = new ShellCapacityRetryQueue(1000, 50);
    const abort = new AbortController();
    const run = vi.fn(async () => success);
    const first = queue.retry(full, async () => success);
    const cancelled = queue.retry(full, run, abort.signal);
    abort.abort();
    expect((await cancelled).structuredContent).toMatchObject({ error: { code: 'REQUEST_CANCELLED', details: { dispatchState: 'not_dispatched', outcome: 'not_started' } } });
    expect(run).not.toHaveBeenCalled();
    expect(await first).toBe(success);
    expect(await queue.retry(full, run)).toBe(success);
  });

  it('bounds pending requests and waiting time without spawning work', async () => {
    const queue = new ShellCapacityRetryQueue(25, 100, 1);
    const run = vi.fn(async () => success);
    const first = queue.retry(full, run);
    expect(await queue.retry(full, run)).toBe(full);
    expect(await first).toBe(full);
    expect(run).not.toHaveBeenCalled();
  });

  it('shares a queue across one endpoint but not independent endpoints', () => {
    const endpoint = new ToolWorkloadAdmission();
    expect(shellCapacityRetryQueueFor(endpoint)).toBe(shellCapacityRetryQueueFor(endpoint));
    expect(shellCapacityRetryQueueFor(endpoint)).not.toBe(shellCapacityRetryQueueFor(new ToolWorkloadAdmission()));
  });
});
