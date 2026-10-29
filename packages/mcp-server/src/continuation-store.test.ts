import { describe, expect, it } from 'vitest';
import { ContinuationStore } from './continuation-store.js';

describe('ContinuationStore', () => {
  it('consumes entries exactly once', () => {
    const store = new ContinuationStore<string>();
    store.set('token', 'value');
    expect(store.take('token')).toBe('value');
    expect(store.take('token')).toBeUndefined();
  });

  it('bounds retained inventory cost without disk-backed caching', () => {
    const store = new ContinuationStore<number>({ maxWeight: 10, weightOf: (value): number => value });
    expect(store.set('first', 6)).toBe(true);
    expect(store.set('second', 6)).toBe(true);
    expect(store.take('first')).toBeUndefined();
    expect(store.set('too-large', 11)).toBe(false);
    expect(store.take('second')).toBe(6);
    expect(store.size()).toBe(0);
    expect(store.set('third', 10)).toBe(true);
    expect(store.take('third')).toBe(10);
    expect(store.set('fourth', 10)).toBe(true);
    expect(store.set('fourth', 3)).toBe(true);
    expect(store.set('fifth', 7)).toBe(true);
    expect(store.take('fourth')).toBe(3);
    expect(store.take('fifth')).toBe(7);
  });

  it('expires abandoned entries and evicts oldest entries over capacity', () => {
    let now = 100;
    const expiring = new ContinuationStore<string>({ ttlMs: 50, now: (): number => now });
    expiring.set('token', 'value');
    now = 150;
    expect(expiring.take('token')).toBeUndefined();

    const bounded = new ContinuationStore<number>({ maxEntries: 2 });
    bounded.set('first', 1); bounded.set('second', 2); bounded.set('third', 3);
    expect(bounded.take('first')).toBeUndefined();
    expect(bounded.take('second')).toBe(2);
    expect(bounded.take('third')).toBe(3);
  });
});
