import { describe, expect, it, vi } from 'vitest';
import { measurableGoalIds, subscribeVisibleResourcePolling, trackedGoalIds } from '../src/renderer/features/resources/ResourcePanel.js';
import type { ResourceSnapshot } from '@lnwjing/ipc-contracts';

describe('Resources Goal filter', () => {
  it('lists only Goals with actual sampled CPU or memory (including measured zero)', () => {
    const snapshot = {
      workspaceId:'ws', sampledAt:'2026-10-09T00:00:00Z', stale:false, coverage:'partial', contextScope:'unavailable',
      context:{ rawContextBytes:null,contextSentBytes:null,previouslySeenBytesAvoided:null,ledgerHits:null },
      resources:[
        { goalId:'goal-unknown', taskId:'a',provider:'shell',role:'blocking_job',ownership:'unknown',canCancel:false },
        { goalId:'goal-measured-zero',taskId:'b',provider:'shell',role:'blocking_job',ownership:'owned',canCancel:true,workingSetBytes:0 },
        { goalId:'goal-measured-cpu',taskId:'c',provider:'process',role:'blocking_job',ownership:'owned',canCancel:false,cpuPercent:12.5 },
      ],
    } satisfies ResourceSnapshot;
    expect([...measurableGoalIds(snapshot)]).toEqual(['goal-measured-zero', 'goal-measured-cpu']);
    expect(measurableGoalIds(null).size).toBe(0);
    expect([...trackedGoalIds(snapshot)]).toEqual(['goal-unknown','goal-measured-zero','goal-measured-cpu']);
    expect(trackedGoalIds(null).size).toBe(0);
  });

  it('does not arm the poll timer when the Resources window is initially hidden', async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const visibility = {
      visibilityState: 'hidden' as DocumentVisibilityState,
      addEventListener: (_type: 'visibilitychange', listener: () => void): void => { listeners.add(listener); },
      removeEventListener: (_type: 'visibilitychange', listener: () => void): void => { listeners.delete(listener); },
      show(): void {
        visibility.visibilityState = 'visible';
        for (const listener of listeners) listener();
      },
    };
    const sample = vi.fn(async (): Promise<void> => {});
    const stop = subscribeVisibleResourcePolling(sample, visibility, 1_000);
    try {
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(sample).not.toHaveBeenCalled();
      visibility.show();
      await vi.advanceTimersByTimeAsync(0);
      expect(sample).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      stop();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it('suspends sampling while hidden and refreshes immediately when visible again', async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const visibility = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_type: 'visibilitychange', listener: () => void): void => { listeners.add(listener); },
      removeEventListener: (_type: 'visibilitychange', listener: () => void): void => { listeners.delete(listener); },
      change(state: DocumentVisibilityState): void {
        visibility.visibilityState = state;
        for (const listener of listeners) listener();
      },
    };
    const sample = vi.fn(async (): Promise<void> => {});
    const stop = subscribeVisibleResourcePolling(sample, visibility, 1_000);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sample).toHaveBeenCalledTimes(1);
      visibility.change('hidden');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sample).toHaveBeenCalledTimes(1);
      visibility.change('visible');
      await vi.advanceTimersByTimeAsync(0);
      expect(sample).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sample).toHaveBeenCalledTimes(3);
      stop();
      expect(listeners.size).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sample).toHaveBeenCalledTimes(3);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it('coalesces a visibility resume with an in-flight sample', async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const visibility = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_type: 'visibilitychange', listener: () => void): void => { listeners.add(listener); },
      removeEventListener: (_type: 'visibilitychange', listener: () => void): void => { listeners.delete(listener); },
      change(state: DocumentVisibilityState): void {
        visibility.visibilityState = state;
        for (const listener of listeners) listener();
      },
    };
    let finishFirst: (() => void) | undefined;
    const sample = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(undefined);
    const stop = subscribeVisibleResourcePolling(sample, visibility, 1_000);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sample).toHaveBeenCalledTimes(1);
      visibility.change('hidden');
      visibility.change('visible');
      expect(sample).toHaveBeenCalledTimes(1);
      finishFirst?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(sample).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
