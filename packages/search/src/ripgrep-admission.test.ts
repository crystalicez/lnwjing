import { describe, expect, it } from 'vitest';
import { acquireRipgrep, ripgrepAdmissionSnapshot, recordRipgrepExecution } from './ripgrep-admission.js';

describe('ripgrep admission (process-wide)', () => {
  it('limits two concurrent scans and only one per root, then admits waiting work', async () => {
    const first = await acquireRipgrep('E:\\one');
    const second = await acquireRipgrep('E:\\two');
    expect(first.status).toBe('granted');
    expect(second.status).toBe('granted');
    if (first.status !== 'granted' || second.status !== 'granted') return;
    const queuedOne = acquireRipgrep('E:\\one');
    const queuedThree = acquireRipgrep('E:\\three');
    expect(ripgrepAdmissionSnapshot().active).toBe(2);
    expect(ripgrepAdmissionSnapshot().queued).toBe(2);
    first.release();
    const nextOne = await queuedOne;
    expect(nextOne.status).toBe('granted');
    expect(ripgrepAdmissionSnapshot().active).toBe(2);
    second.release();
    const third = await queuedThree;
    expect(third.status).toBe('granted');
    if (third.status === 'granted') third.release();
    if (nextOne.status === 'granted') nextOne.release();
    expect(ripgrepAdmissionSnapshot().active).toBe(0);
    expect(ripgrepAdmissionSnapshot().queued).toBe(0);
  });

  it('treats Windows root aliases as one disk-scanning workspace', async () => {
    const first = await acquireRipgrep('E:\\Project\\');
    if (first.status !== 'granted') throw new Error('Expected first search to be admitted');
    const controller = new AbortController();
    const second = acquireRipgrep('e:/project', controller.signal);
    expect(ripgrepAdmissionSnapshot().queued).toBe(1);
    controller.abort();
    expect(await second).toEqual({ status: 'aborted' });
    first.release();
    expect(ripgrepAdmissionSnapshot().active).toBe(0);
  });

  it('removes cancelled requests without launching a delayed scan', async () => {
    const active = await acquireRipgrep('E:\\busy');
    if (active.status !== 'granted') throw new Error('Expected granted admission');
    const controller = new AbortController();
    const queued = acquireRipgrep('E:\\busy', controller.signal);
    controller.abort();
    expect(await queued).toEqual({ status: 'aborted' });
    expect(ripgrepAdmissionSnapshot().queued).toBe(0);
    active.release();
    expect(await acquireRipgrep('E:\\busy', controller.signal)).toEqual({ status: 'aborted' });
    const final = await acquireRipgrep('E:\\busy');
    if (final.status !== 'granted') throw new Error('Expected capacity after cancellation');
    recordRipgrepExecution(3);
    final.release();
    expect(ripgrepAdmissionSnapshot().active).toBe(0);
  });

  it('rejects only the queue overflow instead of creating unbounded waiters', async () => {
    const active = await acquireRipgrep('E:\\overflow');
    if (active.status !== 'granted') throw new Error('Expected granted admission');
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const pending = controllers.map((controller) => acquireRipgrep('E:\\overflow', controller.signal));
    expect(ripgrepAdmissionSnapshot().queued).toBe(64);
    expect(await acquireRipgrep('E:\\overflow')).toEqual({ status: 'busy' });
    controllers.forEach((controller) => controller.abort());
    expect((await Promise.all(pending)).every((result) => result.status === 'aborted')).toBe(true);
    active.release();
    expect(ripgrepAdmissionSnapshot().queued).toBe(0);
  });
});
