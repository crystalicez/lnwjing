/**
 * Endpoint-shared admission for tool classes with high CPU / disk pressure.
 * Per-request MCP Server instances must share one limiter or HTTP bursts bypass
 * the cap. Admission is bounded and abort-aware; no work is dispatched after
 * its request has been cancelled.
 */
type WorkloadClass = 'search' | 'index' | 'process';

interface Waiter {
  readonly priority: 'interactive' | 'background';
  readonly grant: () => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

const MAX_WAITERS_PER_CLASS = 64;
const MAX_INDEX_INTERACTIVE_GRANTS_BEFORE_BACKGROUND = 4;

function classify(tool: string): WorkloadClass | null {
  // Status and stop must never queue behind expensive baseline indexing.
  // Starting a watcher performs an initial workspace index, so watch MUST
  // share this permit with explicit workspace_index across all HTTP requests.
  if (tool === 'workspace_index' || /^workspace_index_(?!status$|stop$)/.test(tool)
    || /^index_(?!status$|stop$)/.test(tool) || tool === 'workspace_reindex' || tool === 'workspace_full_scan' || tool === 'workspace_full_scan_continue') return 'index';
  if (/^(search_text|search_files|search_symbols|search_regex|search_all|ripgrep|workspace_context|workspace_snapshot|workspace_tree|project_snapshot|read_many_files)$/.test(tool)) return 'search';
  if (/^(shell|wsl_exec|process_start|process_run|project_dev|project_test|project_lint|project_typecheck|project_build)$/.test(tool)) return 'process';
  return null;
}

export class ToolWorkloadAdmission {
  private readonly busy: Record<WorkloadClass, number> = { search: 0, index: 0, process: 0 };
  private readonly waiters: Record<WorkloadClass, Waiter[]> = { search: [], index: [], process: [] };
  private readonly caps: Record<WorkloadClass, number>;
  private consecutiveInteractiveIndexGrants = 0;

  public constructor(limits: Partial<Record<WorkloadClass, number>> = {}) {
    this.caps = {
      search: clamp(limits.search, 3),
      index: clamp(limits.index, 1),
      process: clamp(limits.process, 4),
    };
  }

  public async acquire(tool: string, signal: AbortSignal): Promise<() => void> {
    const kind = classify(tool);
    if (kind === null) return () => undefined;
    if (signal.aborted) throw new Error('Tool request was cancelled before admission');
    if (this.busy[kind] < this.caps[kind] && this.waiters[kind].length === 0) {
      this.busy[kind] += 1;
      return this.releaseFor(kind);
    }
    if (this.waiters[kind].length >= MAX_WAITERS_PER_CLASS) {
      throw new Error('Tool workload admission queue is full; retry later or use a durable task');
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters[kind].indexOf(waiter);
        if (index >= 0) this.waiters[kind].splice(index, 1);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Tool request was cancelled while waiting for workload admission'));
      };
      const waiter: Waiter = {
        priority: kind === 'index' && (tool === 'workspace_index_watch' || tool === 'workspace_reindex') ? 'background' : 'interactive',
        signal, onAbort,
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(this.releaseFor(kind));
        },
        reject: (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      };
      this.waiters[kind].push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  public snapshot(): Readonly<{ active: Record<WorkloadClass, number>; queued: Record<WorkloadClass, number> }> {
    return {
      active: { ...this.busy },
      queued: {
        search: this.waiters.search.length,
        index: this.waiters.index.length,
        process: this.waiters.process.length,
      },
    };
  }

  private releaseFor(kind: WorkloadClass): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiting = this.waiters[kind];
      while (waiting.length > 0) {
        const backgroundIndex = kind === 'index' ? waiting.findIndex((entry) => entry.priority === 'background') : -1;
        const interactiveIndex = kind === 'index' ? waiting.findIndex((entry) => entry.priority === 'interactive') : -1;
        const useInteractive = interactiveIndex >= 0
          && (backgroundIndex < 0 || this.consecutiveInteractiveIndexGrants < MAX_INDEX_INTERACTIVE_GRANTS_BEFORE_BACKGROUND);
        const position = kind === 'index' ? useInteractive ? interactiveIndex : backgroundIndex : 0;
        const [next] = waiting.splice(position, 1);
        if (next === undefined) break;
        if (next.signal.aborted) {
          next.reject(new Error('Tool request was cancelled before admission'));
          continue;
        }
        if (kind === 'index') {
          this.consecutiveInteractiveIndexGrants = useInteractive ? this.consecutiveInteractiveIndexGrants + 1 : 0;
        }
        next.grant();
        return;
      }
      this.busy[kind] -= 1;
      if (kind === 'index') this.consecutiveInteractiveIndexGrants = 0;
    };
  }
}

function clamp(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 1 && value <= 32 ? value : fallback;
}
