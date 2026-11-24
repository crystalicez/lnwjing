import { describe, expect, it, vi } from 'vitest';
import { AsyncTtlCache } from '../src/main/async-ttl-cache.js';

describe('AsyncTtlCache', () => {
  it('reuses a resolved value until the TTL expires', async () => {
    let now = 1_000;
    const load = vi.fn(async () => 'value');
    const cache = new AsyncTtlCache<string>(5_000, () => now);

    await expect(cache.get(load)).resolves.toBe('value');
    now = 5_999;
    await expect(cache.get(load)).resolves.toBe('value');
    expect(load).toHaveBeenCalledTimes(1);

    now = 6_000;
    await expect(cache.get(load)).resolves.toBe('value');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent callers into one expensive probe', async () => {
    let resolveLoad!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>((resolve) => { resolveLoad = resolve; }));
    const cache = new AsyncTtlCache<number>(5_000, () => 1_000);

    const first = cache.get(load);
    const second = cache.get(load);
    expect(load).toHaveBeenCalledTimes(1);
    resolveLoad(42);

    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
  });

  it('does not reuse or cache an in-flight observation after invalidation', async () => {
    let resolveOld!: (value: string) => void;
    const cache = new AsyncTtlCache<string>(60_000, () => 1_000);
    const old = cache.get(() => new Promise(resolve => { resolveOld = resolve; }));
    cache.clear();
    await expect(cache.get(async () => 'new')).resolves.toBe('new');
    resolveOld('old');
    await expect(old).resolves.toBe('old');
    await expect(cache.get(async () => 'unexpected')).resolves.toBe('new');
  });

  it('supports explicit invalidation', async () => {
    const load = vi.fn(async () => load.mock.calls.length);
    const cache = new AsyncTtlCache<number>(60_000, () => 1_000);

    await expect(cache.get(load)).resolves.toBe(1);
    cache.clear();
    await expect(cache.get(load)).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
