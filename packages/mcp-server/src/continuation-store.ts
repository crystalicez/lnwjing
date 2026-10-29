export interface ContinuationStoreOptions<T> {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Optional aggregate cost cap; used for large in-memory scan inventories. */
  readonly maxWeight?: number;
  readonly weightOf?: (value: T) => number;
}

interface StoredContinuation<T> {
  readonly value: T;
  readonly expiresAtMs: number;
  readonly weight: number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function scopedContinuationKey(scope: string, token: string): string {
  return `${scope.length}:${scope}:${token}`;
}

/** One-shot, TTL-bounded pagination state; optional aggregate memory budget. */
export class ContinuationStore<T> {
  private readonly entries = new Map<string, StoredContinuation<T>>();
  private readonly maxEntries: number;
  private readonly maxWeight: number;
  private readonly weightOf: (value: T) => number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private totalWeight = 0;

  public constructor(options: ContinuationStoreOptions<T> = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_TTL_MS));
    this.now = options.now ?? Date.now;
    this.maxWeight = options.maxWeight ?? Number.POSITIVE_INFINITY;
    this.weightOf = options.weightOf ?? ((): number => 1);
  }

  /** Returns false if a single continuation cannot fit within the budget. */
  public set(token: string, value: T): boolean {
    const weight = this.weightOf(value);
    if (!Number.isFinite(weight) || weight < 0 || weight > this.maxWeight) return false;
    const now = this.now();
    this.pruneExpired(now);
    this.remove(token);
    this.entries.set(token, { value, weight, expiresAtMs: now + this.ttlMs });
    this.totalWeight += weight;
    while (this.entries.size > this.maxEntries || this.totalWeight > this.maxWeight) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.remove(oldest);
    }
    return true;
  }

  public take(token: string): T | undefined {
    this.pruneExpired(this.now());
    const stored = this.entries.get(token);
    if (stored === undefined) return undefined;
    this.remove(token);
    return stored.value;
  }

  public size(): number {
    this.pruneExpired(this.now());
    return this.entries.size;
  }

  private remove(token: string): void {
    const previous = this.entries.get(token);
    if (previous === undefined) return;
    this.totalWeight -= previous.weight;
    this.entries.delete(token);
  }

  private pruneExpired(now: number): void {
    for (const [token, stored] of this.entries) {
      if (now >= stored.expiresAtMs) this.remove(token);
    }
  }
}
