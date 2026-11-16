import { describe, expect, it, vi } from 'vitest';
import type { ActivityTargetSearchCandidate } from '@lnwjing/ipc-contracts';
import { searchTargetDetailCandidatesInBatches } from '../src/renderer/features/live/detail-search-batches.js';

describe('large log target search batching', () => {
  const candidates: ActivityTargetSearchCandidate[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `inflight:call-${index}`, detailRef: `call-${index}`, workspaceId: 'workspace-a',
  }));

  it('searches all 10,000 retained lines without exceeding the IPC candidate bound', async () => {
    const lookup = vi.fn(async (_query: string, batch: readonly ActivityTargetSearchCandidate[]) => {
      expect(batch.length).toBeLessThanOrEqual(250);
      return batch.filter((candidate) => Number(candidate.id.split('-').at(-1)) % 999 === 0).map((candidate) => candidate.id);
    });
    const matches = await searchTargetDetailCandidatesInBatches('needle', candidates, lookup);
    expect(lookup).toHaveBeenCalledTimes(40);
    expect(matches).toContain('inflight:call-999');
    expect(matches).toContain('inflight:call-9990');
  });

  it('cancels superseded queries before issuing additional SQLite requests', async () => {
    let current = true;
    const lookup = vi.fn(async () => { current = false; return ['stale']; });
    await expect(searchTargetDetailCandidatesInBatches('needle', candidates, lookup, () => current)).resolves.toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
