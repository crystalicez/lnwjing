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
