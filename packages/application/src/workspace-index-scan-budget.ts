/**
 * Poteto-mode: serialize heavy full-workspace directory walks across every
 * WorkspaceIndexService instance in this Node process. Full workspace walks
 * and incremental directory-subtree walks acquire it; direct single-file edits
 * stay independent. The gate itself never touches disk.
 *
 * This process-local queue is supplemented by the cross-process disk lease
 * when the caller starts a full workspace walk. The queue alone is not a
 * cross-process disk guarantee.
 */
export type IndexScanPriority = 'interactive' | 'background';

interface ScanWaiter {
  readonly priority: IndexScanPriority;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  readonly cancel: () => void;
}

let active = false;
const waiting: ScanWaiter[] = [];
// Ensure a steady stream of interactive requests cannot starve background indexing.
const MAX_INTERACTIVE_GRANTS_BEFORE_BACKGROUND = 4;
let consecutiveInteractiveGrants = 0;

function takeNext(): void {
  if (waiting.length === 0) {
    active = false;
    consecutiveInteractiveGrants = 0;
    return;
  }
  const interactive = waiting.findIndex((waiter) => waiter.priority === 'interactive');
  const background = waiting.findIndex((waiter) => waiter.priority === 'background');
  const selectInteractive = interactive >= 0 && (background < 0 || consecutiveInteractiveGrants < MAX_INTERACTIVE_GRANTS_BEFORE_BACKGROUND);
  const index = selectInteractive ? interactive : background;
  const [next] = waiting.splice(index, 1);
  if (next === undefined) {
    active = false;
    return;
  }
  consecutiveInteractiveGrants = selectInteractive ? consecutiveInteractiveGrants + 1 : 0;
  next.signal?.removeEventListener('abort', next.cancel);
  next.resolve();
}

export async function withIndexScanBudget<T>(scan: () => Promise<T>, signal?: AbortSignal, priority: IndexScanPriority = 'background'): Promise<T> {
  signal?.throwIfAborted();
  if (active) {
    await new Promise<void>((resolve, reject) => {
      const cancel = (): void => {
        const index = waiting.indexOf(waiter);
        if (index < 0) return;
        waiting.splice(index, 1);
        signal?.removeEventListener('abort', cancel);
        reject(signal?.reason ?? new Error('Workspace scan cancelled'));
      };
      const waiter: ScanWaiter = { resolve, reject, priority, ...(signal === undefined ? {} : { signal }), cancel };
      waiting.push(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  } else {
    active = true;
  }
  try {
    signal?.throwIfAborted();
    return await scan();
  } finally {
    takeNext();
  }
}
