import { describe, expect, it } from 'vitest';
import { withIndexScanBudget } from './workspace-index-scan-budget.js';

describe('process-wide workspace scan budget', () => {
  it('serializes scans across multiple projects', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const visited: string[] = [];
    const first = withIndexScanBudget(async () => {
      visited.push('a');
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const second = withIndexScanBudget(async () => { visited.push('b'); });
    const third = withIndexScanBudget(async () => { visited.push('c'); });
    expect(visited).toEqual(['a']);
    release.resolve();
    await Promise.all([first, second, third]);
    expect(visited).toEqual(['a', 'b', 'c']);
  });

  it('lets an interactive path update overtake queued background scans without preemption', async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const order: string[] = [];
    const active = withIndexScanBudget(async () => {
      order.push('active background');
      entered.resolve();
      await finish.promise;
    }, undefined, 'background');
    await entered.promise;
    const backgroundA = withIndexScanBudget(async () => { order.push('queued background A'); }, undefined, 'background');
    const backgroundB = withIndexScanBudget(async () => { order.push('queued background B'); }, undefined, 'background');
    const interactive = withIndexScanBudget(async () => { order.push('interactive file'); }, undefined, 'interactive');
    expect(order).toEqual(['active background']);
    finish.resolve();
    await Promise.all([active, backgroundA, backgroundB, interactive]);
    expect(order).toEqual([
      'active background', 'interactive file', 'queued background A', 'queued background B',
    ]);
  });

  it('lets background work advance despite sustained interactive arrivals', async () => {
    const started = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const order: string[] = [];
    const active = withIndexScanBudget(async () => {
      started.resolve();
      await proceed.promise;
    }, undefined, 'background');
    await started.promise;
    const background = withIndexScanBudget(async () => { order.push('background'); }, undefined, 'background');
    const foreground = Array.from({ length: 6 }, (_, i) => withIndexScanBudget(async () => {
      order.push(`foreground-${i}`);
    }, undefined, 'interactive'));
    proceed.resolve();
    await Promise.all([active, background, ...foreground]);
    expect(order.slice(0, 4)).toEqual(['foreground-0', 'foreground-1', 'foreground-2', 'foreground-3']);
    expect(order[4]).toBe('background');
  });

  it('removes an aborted interactive waiter without blocking background scans', async () => {
    const started = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const active = withIndexScanBudget(async () => { started.resolve(); await proceed.promise; });
    await started.promise;
    const abort = new AbortController();
    const waiting = withIndexScanBudget(async () => { throw new Error('should never run'); }, abort.signal, 'interactive');
    const background = withIndexScanBudget(async () => 'background complete', undefined, 'background');
    abort.abort(new Error('interactive cancelled'));
    await expect(waiting).rejects.toThrow('interactive cancelled');
    proceed.resolve();
    await active;
    await expect(background).resolves.toBe('background complete');
  });

  it('removes aborted queued scans so healthy projects proceed', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = withIndexScanBudget(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const abort = new AbortController();
    const rejected = withIndexScanBudget(async () => { throw new Error('should not run'); }, abort.signal);
    const next = withIndexScanBudget(async () => 'next project');
    abort.abort(new Error('cancelled'));
    await expect(rejected).rejects.toThrow('cancelled');
    release.resolve();
    await first;
    await expect(next).resolves.toBe('next project');
  });
});
