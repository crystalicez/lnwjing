/** Process-wide ripgrep admission. Bounds concurrent disk scans without silently dropping queued searches. */
const MAX_ACTIVE_SEARCHES = 2;
const MAX_ACTIVE_PER_ROOT = 1;
const MAX_PENDING_SEARCHES = 64;
const MAX_QUEUE_WAIT_MS = 15_000;

export type SearchAdmission = { readonly status: 'granted'; readonly release: () => void } | { readonly status: 'aborted' | 'busy' };

interface Waiter {
  readonly root: string;
  readonly resolve: (result: SearchAdmission) => void;
  readonly signal?: AbortSignal;
  readonly cancel: () => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

const activeByRoot = new Map<string, number>();
const waiting: Waiter[] = [];
let active = 0;
let peakActive = 0;
let started = 0;
let finished = 0;
let rejected = 0;
let cancelled = 0;
let totalExecutionMs = 0;

export function ripgrepAdmissionSnapshot(): {
  readonly active: number;
  readonly queued: number;
  readonly peakActive: number;
  readonly started: number;
  readonly finished: number;
  readonly rejected: number;
  readonly cancelled: number;
  readonly totalExecutionMs: number;
} {
  return { active, queued: waiting.length, peakActive, started, finished, rejected, cancelled, totalExecutionMs };
}

export function recordRipgrepExecution(durationMs: number): void {
  finished += 1;
  totalExecutionMs += Math.max(0, durationMs);
}

export function acquireRipgrep(rootPath: string, signal?: AbortSignal): Promise<SearchAdmission> {
  if (signal?.aborted) {
    cancelled += 1;
    return Promise.resolve({ status: 'aborted' });
  }
  const root = rootPath.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '');
  if (waiting.length === 0 && eligible(root)) return Promise.resolve(grant(root));
  if (waiting.length >= MAX_PENDING_SEARCHES) {
    rejected += 1;
    return Promise.resolve({ status: 'busy' });
  }
  return new Promise<SearchAdmission>((resolve) => {
    const cancel = (): void => {
      const index = waiting.indexOf(waiter);
      if (index < 0) return;
      waiting.splice(index, 1);
      clearTimeout(waiter.timeout);
      signal?.removeEventListener('abort', cancel);
      cancelled += 1;
      resolve({ status: 'aborted' });
      drain();
    };
    const timeout = setTimeout(() => {
      const index = waiting.indexOf(waiter);
      if (index < 0) return;
      waiting.splice(index, 1);
      signal?.removeEventListener('abort', cancel);
      rejected += 1;
      resolve({ status: 'busy' });
      drain();
    }, MAX_QUEUE_WAIT_MS);
    timeout.unref?.();
    const waiter: Waiter = { root, resolve, ...(signal === undefined ? {} : { signal }), cancel, timeout };
    waiting.push(waiter);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else drain();
  });
}

function eligible(root: string): boolean {
  return active < MAX_ACTIVE_SEARCHES && (activeByRoot.get(root) ?? 0) < MAX_ACTIVE_PER_ROOT;
}

function grant(root: string): SearchAdmission {
  active += 1;
  started += 1;
  peakActive = Math.max(peakActive, active);
  activeByRoot.set(root, (activeByRoot.get(root) ?? 0) + 1);
  let released = false;
  return {
    status: 'granted',
    release: (): void => {
      if (released) return;
      released = true;
      active -= 1;
      const remaining = (activeByRoot.get(root) ?? 0) - 1;
      if (remaining <= 0) activeByRoot.delete(root);
      else activeByRoot.set(root, remaining);
      drain();
    },
  };
}

function drain(): void {
  while (active < MAX_ACTIVE_SEARCHES) {
    const index = waiting.findIndex((waiter) => eligible(waiter.root));
    if (index < 0) return;
    const [waiter] = waiting.splice(index, 1);
    if (waiter === undefined) return;
    clearTimeout(waiter.timeout);
    waiter.signal?.removeEventListener('abort', waiter.cancel);
    if (waiter.signal?.aborted) {
      cancelled += 1;
      waiter.resolve({ status: 'aborted' });
      continue;
    }
    waiter.resolve(grant(waiter.root));
  }
}
