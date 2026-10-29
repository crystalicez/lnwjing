import { describe, expect, it } from 'vitest';
import { ToolWorkloadAdmission } from './tool-workload-admission.js';

describe('ToolWorkloadAdmission', () => {
  it('limits searches across simultaneous callers, releasing queued work fairly', async () => {
    const admission = new ToolWorkloadAdmission({ search: 1 });
    const first = await admission.acquire('search_text', new AbortController().signal);
    let granted = false;
    const waiting = admission.acquire('search_files', new AbortController().signal).then(release => {
      granted = true;
      return release;
    });
    await Promise.resolve();
    expect(granted).toBe(false);
    expect(admission.snapshot().queued.search).toBe(1);
    first();
    const second = await waiting;
    expect(granted).toBe(true);
    expect(admission.snapshot().active.search).toBe(1);
    second();
    second();
    expect(admission.snapshot().active.search).toBe(0);
  });

  it('bounds pending searches and fails closed rather than queuing without limit', async () => {
    const admission = new ToolWorkloadAdmission({ search: 1 });
    const hold = await admission.acquire('search_text', new AbortController().signal);
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const pending = controllers.map(controller => admission.acquire('search_files', controller.signal));
    await expect(admission.acquire('search_text', new AbortController().signal))
      .rejects.toThrow('queue is full');
    for (const controller of controllers) controller.abort();
    await Promise.all(pending.map(call => expect(call).rejects.toThrow('cancelled')));
    hold();
    expect(admission.snapshot()).toMatchObject({ active: { search: 0 }, queued: { search: 0 } });
  });

  it('cancels queued requests before work can start', async () => {
    const admission = new ToolWorkloadAdmission({ index: 1 });
    const first = await admission.acquire('workspace_index', new AbortController().signal);
    const aborted = new AbortController();
    const blocked = admission.acquire('workspace_index_rebuild', aborted.signal);
    aborted.abort();
    await expect(blocked).rejects.toThrow('cancelled');
    expect(admission.snapshot().queued.index).toBe(0);
    first();
    expect(admission.snapshot().active.index).toBe(0);
  });

  it('serializes watcher baseline scans behind active indexing without blocking status/stop', async () => {
    const admission = new ToolWorkloadAdmission({ index: 1 });
    const indexRelease = await admission.acquire('workspace_index', new AbortController().signal);
    let watchEntered = false;
    const watch = admission.acquire('workspace_index_watch', new AbortController().signal).then(release => {
      watchEntered = true;
      return release;
    });
    const controlReleases = await Promise.all(['workspace_index_status', 'workspace_index_stop'].map(
      name => admission.acquire(name, new AbortController().signal)));
    expect(admission.snapshot()).toMatchObject({ active: { index: 1 }, queued: { index: 1 } });
    expect(watchEntered).toBe(false);
    for (const release of controlReleases) release();
    indexRelease();
    const watchRelease = await watch;
    expect(watchEntered).toBe(true);
    expect(admission.snapshot()).toMatchObject({ active: { index: 1 }, queued: { index: 0 } });
    watchRelease();
    expect(admission.snapshot().active.index).toBe(0);
  });

  it('cancels a queued watcher before its initial scan begins without taking the permit', async () => {
    const admission = new ToolWorkloadAdmission({ index: 1 });
    const indexRelease = await admission.acquire('workspace_index', new AbortController().signal);
    const controller = new AbortController();
    const watch = admission.acquire('workspace_index_watch', controller.signal);
    controller.abort();
    await expect(watch).rejects.toThrow('cancelled');
    expect(admission.snapshot().queued.index).toBe(0);
    indexRelease();
    expect(admission.snapshot().active.index).toBe(0);
  });

  it('starts an explicit index request before earlier queued watcher starts', async () => {
    const admission = new ToolWorkloadAdmission({ index: 1 });
    const active = await admission.acquire('workspace_index_watch', new AbortController().signal);
    const order: string[] = [];
    const queuedWatch = admission.acquire('workspace_index_watch', new AbortController().signal).then((release) => {
      order.push('watch');
      return release;
    });
    const queuedManual = admission.acquire('workspace_index', new AbortController().signal, { path: 'src/changed.ts' }).then((release) => {
      order.push('manual');
      return release;
    });
    active();
    const manual = await queuedManual;
    expect(order).toEqual(['manual']);
    manual();
    const watch = await queuedWatch;
    watch();
    expect(order).toEqual(['manual', 'watch']);
    expect(admission.snapshot().active.index).toBe(0);
  });

  it('prioritizes targeted index requests ahead of earlier queued whole-workspace scans', async () => {
    const admission = new ToolWorkloadAdmission({ index: 1 });
    const holding = await admission.acquire('workspace_index', new AbortController().signal);
    const order: string[] = [];
    const full = admission.acquire('workspace_index', new AbortController().signal, { workspaceId: 'p', path: '.' })
      .then((release) => { order.push('whole'); return release; });
    const scan = admission.acquire('workspace_full_scan', new AbortController().signal)
      .then((release) => { order.push('scan'); return release; });
    const targeted = admission.acquire('workspace_index', new AbortController().signal, {
      workspaceId: 'p', path: 'src/changed.ts',
    }).then((release) => { order.push('targeted'); return release; });
    holding();
    const fast = await targeted;
    expect(order).toEqual(['targeted']);
    fast();
    const slow = await full;
    slow();
    const walk = await scan;
    walk();
    expect(order).toEqual(['targeted', 'whole', 'scan']);
  });

  it('prevents queued watcher starts from starving under repeated manual index requests', async () => {
    const admission = new ToolWorkloadAdmission({ index: 1 });
    const active = await admission.acquire('workspace_index', new AbortController().signal);
    const order: string[] = [];
    const watcher = admission.acquire('workspace_index_watch', new AbortController().signal).then((release) => {
      order.push('watcher');
      return release;
    });
    const manual = Array.from({ length: 6 }, (_, index) => admission.acquire('workspace_index', new AbortController().signal, { path: `src/file-${index}.ts` }).then((release) => {
      order.push(`manual-${index}`);
      return release;
    }));
    active();
    for (let index = 0; index < manual.length; index += 1) {
      const release = await manual[index]!;
      release();
      if (index === 3) {
        const background = await watcher;
        background();
      }
    }
    expect(order.slice(0, 5)).toEqual(['manual-0', 'manual-1', 'manual-2', 'manual-3', 'watcher']);
  });

  it('queues full-scan continuations with indexing rather than bypassing disk admission', async () => {
    const admission = new ToolWorkloadAdmission({ index: 1 });
    const hold = await admission.acquire('workspace_full_scan', new AbortController().signal);
    let entered = false;
    const following = admission.acquire('workspace_full_scan_continue', new AbortController().signal).then((release) => {
      entered = true;
      return release;
    });
    await Promise.resolve();
    expect(entered).toBe(false);
    expect(admission.snapshot()).toMatchObject({ active: { index: 1 }, queued: { index: 1 } });
    hold();
    const release = await following;
    expect(entered).toBe(true);
    release();
    expect(admission.snapshot().active.index).toBe(0);
  });

  it('throttles expensive scans and builds while allowing light file commands', async () => {
    const admission = new ToolWorkloadAdmission({ index: 1, process: 1 });
    const search = await admission.acquire('workspace_full_scan', new AbortController().signal);
    const build = await admission.acquire('project_build', new AbortController().signal);
    expect(admission.snapshot().active).toMatchObject({ index: 1, process: 1 });
    const read = await admission.acquire('read_file_page', new AbortController().signal);
    read();
    search();
    build();
    expect(admission.snapshot().active).toMatchObject({ index: 0, process: 0 });
  });
});
