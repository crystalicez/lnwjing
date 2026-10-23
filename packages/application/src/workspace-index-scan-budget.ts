/**
 * Poteto-mode: serialize heavy full-workspace directory walks across every
 * WorkspaceIndexService instance in this Node process. Incremental mutations
 * do not acquire this gate, so file edits remain responsive while another
 * project is being scanned. The gate never touches disk.
 *
 * Other app processes are independently bounded by ripgrep admission. A
 * process-wide scheduler is not a cross-process disk guarantee.
 */
interface ScanWaiter {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  readonly cancel: () => void;
}

let active = false;
const waiting: ScanWaiter[] = [];

function takeNext(): void {
  const next = waiting.shift();
  if (next === undefined) {
    active = false;
    return;
  }
  next.signal?.removeEventListener('abort', next.cancel);
  next.resolve();
}

export async function withIndexScanBudget<T>(scan: () => Promise<T>, signal?: AbortSignal): Promise<T> {
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
      const waiter: ScanWaiter = { resolve, reject, ...(signal === undefined ? {} : { signal }), cancel };
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
