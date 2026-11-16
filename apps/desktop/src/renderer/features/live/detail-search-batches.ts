import type { ActivityTargetSearchCandidate } from '@lnwjing/ipc-contracts';

const MAX_CANDIDATES_PER_REQUEST = 250;

/**
 * Keeps each IPC message small and gives the main process a chance to service
 * other work between deep-search batches. A superseded search stops sending
 * work instead of queuing thousands of now-irrelevant SQLite lookups.
 */
export async function searchTargetDetailCandidatesInBatches(
  query: string,
  candidates: readonly ActivityTargetSearchCandidate[],
  search: (query: string, batch: readonly ActivityTargetSearchCandidate[]) => Promise<readonly string[]>,
  isCurrent: () => boolean = () => true,
): Promise<readonly string[]> {
  const matched: string[] = [];
  for (let offset = 0; offset < candidates.length; offset += MAX_CANDIDATES_PER_REQUEST) {
    if (!isCurrent()) return [];
    const batch = candidates.slice(offset, offset + MAX_CANDIDATES_PER_REQUEST);
    matched.push(...await search(query, batch));
    if (!isCurrent()) return [];
  }
  return matched;
}
