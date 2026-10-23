import { describe, expect, it, vi } from 'vitest';
import { WorkspaceIndexQueue } from './workspace-index-queue.js';

describe('WorkspaceIndexQueue', () => {
  it('batches distinct changes, preserves follow-up events and reports failed batch coverage', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const batches: string[][] = [];
    const errors: string[] = [];
    const queue = new WorkspaceIndexQueue(async () => { throw new Error('single-file worker should not run'); }, {
      debounceMs: 0,
      batchWorker: async (events): Promise<void> => {
        batches.push(events.map((event) => event.relativePath));
        if (batches.length === 1) {
          entered.resolve();
          await release.promise;
          return;
        }
        throw new Error('simulated batch failure');
      },
    });
    queue.onError((event) => errors.push(event.relativePath));
    queue.enqueue({ relativePath: 'a.ts', kind: 'change' });
    queue.enqueue({ relativePath: 'b.ts', kind: 'change' });
    const first = queue.drain();
    await entered.promise;
    queue.enqueue({ relativePath: 'c.ts', kind: 'change' });
    queue.enqueue({ relativePath: 'd.ts', kind: 'change' });
    release.resolve();
    await Promise.all([first, queue.drain()]);
    expect(batches).toEqual([['a.ts', 'b.ts'], ['c.ts', 'd.ts']]);
    expect(errors).toEqual(['c.ts', 'd.ts']);
    expect(queue.status()).toMatchObject({ completedEvents: 2, failedEvents: 2, pendingEvents: 0, activeWorkers: 0 });
  });

  it('resolves every concurrent drain after a blocked worker finishes', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const queue = new WorkspaceIndexQueue(async () => {
      started.resolve();
      await release.promise;
    }, { concurrency: 1 });
    queue.enqueue({ relativePath: 'first.ts', kind: 'change' });
    const firstDrain = queue.drain();
    await started.promise;
    const secondDrain = queue.drain();
    const thirdDrain = queue.drain();
    await Promise.resolve();
    release.resolve();
    await Promise.all([firstDrain, secondDrain, thirdDrain]);
    expect(queue.status()).toMatchObject({ completedEvents: 1, activeWorkers: 0, pendingEvents: 0 });
  }, 1000);

  it('drains pending events while all worker slots are occupied', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const seen: string[] = [];
    const queue = new WorkspaceIndexQueue(async (event) => {
      seen.push(event.relativePath);
      if (event.relativePath === 'first.ts') {
        started.resolve();
        await release.promise;
      }
    }, { concurrency: 1 });
    queue.enqueue({ relativePath: 'first.ts', kind: 'change' });
    const firstDrain = queue.drain();
    await started.promise;
    queue.enqueue({ relativePath: 'second.ts', kind: 'change' });
    const secondDrain = queue.drain();
    const completion = Promise.all([firstDrain, secondDrain]);
    release.resolve();
    await completion;
    expect(seen).toEqual(['first.ts', 'second.ts']);
    expect(queue.status()).toMatchObject({ completedEvents: 2, activeWorkers: 0, pendingEvents: 0 });
  });

  it('coalesces duplicate paths without dropping distinct paths', async () => {
    const seen: string[] = [];
    const queue = new WorkspaceIndexQueue(async (event) => {
      seen.push(`${event.kind}:${event.relativePath}`);
    }, { debounceMs: 0, concurrency: 2 });

    queue.enqueue({ relativePath: 'src/a.ts', kind: 'change' });
    queue.enqueue({ relativePath: 'src/a.ts', kind: 'change' });
    queue.enqueue({ relativePath: '.env', kind: 'change' });
    queue.enqueue({ relativePath: '.git/config', kind: 'change' });
    await queue.drain();

    expect(seen.sort()).toEqual(['change:.env', 'change:.git/config', 'change:src/a.ts']);
    expect(queue.status().coalescedEvents).toBe(1);
    expect(queue.status().droppedEvents).toBe(0);
  });

  it('promotes an excessive distinct-path backlog into one lossless rescan', async () => {
    const seen: string[] = [];
    const queue = new WorkspaceIndexQueue(async (event) => {
      seen.push(`${event.kind}:${event.relativePath}`);
    }, { debounceMs: 0, concurrency: 1 });
    for (let index = 0; index < 1_200; index += 1) {
      queue.enqueue({ relativePath: `generated/${index}.ts`, kind: 'change' });
    }
    expect(queue.status()).toMatchObject({
      pendingEvents: 1, overflowRescans: 1, droppedEvents: 0,
    });
    await queue.drain();
    expect(seen).toEqual(['rescan:']);
    expect(queue.status()).toMatchObject({ completedRescans: 1, pendingEvents: 0 });
  });

  it('waits for a filesystem storm to settle before overflow rescan, without dropping updates', async () => {
    vi.useFakeTimers();
    try {
      const worker = vi.fn(async () => undefined);
      const queue = new WorkspaceIndexQueue(worker, { debounceMs: 10 });
      for (let index = 0; index < 1_100; index += 1) {
        queue.enqueue({ relativePath: `src/changed-${index}.ts`, kind: 'change' });
      }
      expect(queue.status()).toMatchObject({ pendingEvents: 1, overflowRescans: 1, droppedEvents: 0 });
      await vi.advanceTimersByTimeAsync(1_990);
      expect(worker).not.toHaveBeenCalled();
      queue.enqueue({ relativePath: 'src/change-during-checkout.ts', kind: 'change' });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(worker).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(worker).toHaveBeenCalledTimes(1);
      expect(worker).toHaveBeenCalledWith({ relativePath: '', kind: 'rescan' });
      await queue.drain();
      expect(queue.status()).toMatchObject({ pendingEvents: 0, completedRescans: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves overflow quiet time when an earlier batch finishes during the storm', async () => {
    vi.useFakeTimers();
    try {
      const firstStarted = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const seen: string[] = [];
      const queue = new WorkspaceIndexQueue(async (event) => {
        seen.push(event.kind);
        if (seen.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      }, { debounceMs: 10, concurrency: 1 });

      queue.enqueue({ relativePath: 'first.ts', kind: 'change' });
      await vi.advanceTimersByTimeAsync(10);
      await firstStarted.promise;
      for (let i = 0; i < 1_100; i += 1) {
        queue.enqueue({ relativePath: `src/burst-${i}.ts`, kind: 'change' });
      }
      expect(queue.status()).toMatchObject({ pendingEvents: 1, overflowRescans: 1 });
      releaseFirst.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(seen).toEqual(['change']);
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toEqual(['change', 'rescan']);
      await queue.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces an explicit rescan with queued changes without dropping coverage', async () => {
    const seen: string[] = [];
    const queue = new WorkspaceIndexQueue(async (event) => {
      seen.push(event.kind);
    }, { debounceMs: 0, concurrency: 1 });
    queue.enqueue({ relativePath: 'src/a.ts', kind: 'change' });
    queue.enqueue({ relativePath: '', kind: 'rescan' });
    queue.enqueue({ relativePath: 'src/b.ts', kind: 'change' });
    expect(queue.status()).toMatchObject({ pendingEvents: 1, droppedEvents: 0 });
    await queue.drain();
    expect(seen).toEqual(['rescan']);
  });

  it('limits active workers and reports failures without stopping siblings', async () => {
    let active = 0;
    let peak = 0;
    const failures: string[] = [];
    const queue = new WorkspaceIndexQueue(async (event) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (event.relativePath === 'bad.ts') throw new Error('fixture failure');
    }, { debounceMs: 0, concurrency: 2 });
    queue.onError((event) => failures.push(event.relativePath));

    for (const relativePath of ['a.ts', 'b.ts', 'bad.ts', 'c.ts']) {
      queue.enqueue({ relativePath, kind: 'change' });
    }
    await queue.drain();

    expect(peak).toBeLessThanOrEqual(2);
    expect(failures).toEqual(['bad.ts']);
    expect(queue.status().completedEvents).toBe(3);
    expect(queue.status().failedEvents).toBe(1);
  });

  it('waits for the configured debounce window before processing', async () => {
    vi.useFakeTimers();
    try {
      const worker = vi.fn(async () => undefined);
      const queue = new WorkspaceIndexQueue(worker, { debounceMs: 50, concurrency: 1 });
      queue.enqueue({ relativePath: 'src/a.ts', kind: 'change' });
      await vi.advanceTimersByTimeAsync(49);
      expect(worker).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await queue.drain();
      expect(worker).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
