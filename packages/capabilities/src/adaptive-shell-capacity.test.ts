import { describe, expect, it, vi } from 'vitest';
import { createAdaptiveShellCapacity } from './adaptive-shell-capacity.js';

describe('adaptive shell capacity', () => {
  it('samples only on demand, respects user limit, and reduces capacity under measured pressure', () => {
    let enabled = false; let configured = 16; let time = 0;
    let freeBytes = 8 * 1024 ** 3; let idle = 0; let total = 100;
    const sample = vi.fn(() => ({ now: time, availableCpus: 8, freeBytes, cpuIdleTicks: idle, cpuTotalTicks: total }));
    const capacity = createAdaptiveShellCapacity(() => configured, () => enabled, sample, () => time);
    expect(capacity()).toBe(16);
    expect(sample).not.toHaveBeenCalled();
    enabled = true;
    expect(capacity()).toBe(16);
    expect(capacity()).toBe(16);
    expect(sample).toHaveBeenCalledTimes(1);
    time += 2000; total += 100; idle += 5;
    expect(capacity()).toBe(8);
    time += 2000; total += 100; idle += 80; freeBytes = 700 * 1024 ** 2;
    expect(capacity()).toBe(1);
    time += 2000; total += 100; idle += 80; freeBytes = 8 * 1024 ** 3;
    configured = 3;
    expect(capacity()).toBe(3);
    enabled = false; configured = 32;
    expect(capacity()).toBe(32);
    expect(sample).toHaveBeenCalledTimes(4);
  });
});
