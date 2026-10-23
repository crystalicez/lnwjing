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
