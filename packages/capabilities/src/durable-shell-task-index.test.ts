import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableShellTaskIndex } from './durable-shell-task-index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 100,
  })));
});

describe('DurableShellTaskIndex', () => {
  it('does not allow a different client or workspace to attach to another import reservation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-owner-'));
    temporaryRoots.push(root);
    const index = new DurableShellTaskIndex(root, { maxConcurrentTasks: 10, inspectTask: async (): Promise<'active'> => 'active' });
    const owned = {
      taskId: 'same-request', requestDigest: 'f'.repeat(64),
      mutationKind: 'repository_import' as const,
      ownerClientId: 'owner-client', ownerWorkspaceId: 'owner-workspace',
    };
    expect(await index.reserve(owned)).toMatchObject({ ok: true, value: { created: true } });
    expect(await index.reserve(owned)).toMatchObject({ ok: true, value: { created: false } });
    expect(await index.reserve({ ...owned, ownerClientId: 'other-client' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await index.reserve({ ...owned, ownerWorkspaceId: 'other-workspace' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it.each(['active', 'unknown', 'missing'] as const)('blocks import across workspaces while an opaque writer is %s', async (state) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-admission-'));
    temporaryRoots.push(root);
    const index = new DurableShellTaskIndex(root, { maxConcurrentTasks: 10, inspectTask: async (): Promise<typeof state> => state });
    expect(await index.reserve({ taskId: 'opaque', requestDigest: 'a'.repeat(64), ownerClientId: 'other-client', ownerWorkspaceId: 'other-workspace' })).toMatchObject({ ok: true });
    const restarted = new DurableShellTaskIndex(root, { maxConcurrentTasks: 10, inspectTask: async (): Promise<typeof state> => state });
    expect(await restarted.reserve({ taskId: 'import', requestDigest: 'b'.repeat(64), ownerClientId: 'import-client', ownerWorkspaceId: 'import-workspace', mutationKind: 'repository_import' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('atomically excludes import and opaque launches across index instances', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-race-'));
    temporaryRoots.push(root);
    const options = { maxConcurrentTasks: 10, inspectTask: async (): Promise<'unknown'> => 'unknown' };
    const first = new DurableShellTaskIndex(root, options);
    const second = new DurableShellTaskIndex(root, options);
    const results = await Promise.all([
      first.reserve({ taskId: 'import', requestDigest: 'a'.repeat(64), ownerClientId: 'a', mutationKind: 'repository_import' }),
      second.reserve({ taskId: 'opaque', requestDigest: 'b'.repeat(64), ownerClientId: 'b' }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('retains import exclusion across restart and permits writers after verified terminal observation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-lifetime-'));
    temporaryRoots.push(root);
    let terminal = false;
    const options = { maxConcurrentTasks: 10, inspectTask: async (): Promise<'terminal' | 'unknown'> => terminal ? 'terminal' : 'unknown' };
    const first = new DurableShellTaskIndex(root, options);
    const reservation = { taskId: 'import', requestDigest: 'a'.repeat(64), ownerClientId: 'a', mutationKind: 'repository_import' as const };
    expect(await first.reserve(reservation)).toMatchObject({ ok: true, value: { created: true } });
    const restarted = new DurableShellTaskIndex(root, options);
    expect(await restarted.reserve(reservation)).toMatchObject({ ok: true, value: { created: false } });
    expect(await restarted.reserve({ ...reservation, mutationKind: 'opaque' })).toMatchObject({ ok: false });
    const writer = { taskId: 'writer', requestDigest: 'b'.repeat(64), ownerClientId: 'b' };
    expect(await restarted.reserve(writer)).toMatchObject({ ok: false });
    terminal = true;
    expect(await restarted.reserve(writer)).toMatchObject({ ok: true });
  });

  it('bootstraps legacy terminal and active history once, then reinspects only active markers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-index-bootstrap-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'history-terminal'));
    await mkdir(path.join(root, 'history-running'));
    await mkdir(path.join(root, 'history-unverified'));
    const firstInspector = vi.fn(async (taskId: string) => taskId === 'history-terminal' ? 'terminal' as const : 'active' as const);

    const first = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 3,
      inspectTask: firstInspector,
    });
    await first.initialize();

    expect(firstInspector.mock.calls.map(([taskId]) => taskId).sort()).toEqual([
      'history-running',
      'history-terminal',
      'history-unverified',
    ]);

    const warmInspector = vi.fn(async () => 'active' as const);
    const replacement = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 3,
      inspectTask: warmInspector,
    });
    await replacement.initialize();
    const reserved = await replacement.reserve({
      taskId: 'new-task',
      requestDigest: 'a'.repeat(64),
      ownerClientId: 'chatgpt',
      ownerWorkspaceId: 'workspace-a',
    });

    expect(reserved).toMatchObject({ ok: true, value: { activeTasks: 3 } });
    expect(warmInspector.mock.calls.map(([taskId]) => taskId).sort()).toEqual([
      'history-running',
      'history-unverified',
    ]);
    await replacement.release('new-task', 'a'.repeat(64));
  });

  it('retries transient lock-file deletion before another store instance acquires the index', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-index-lock-release-'));
    temporaryRoots.push(root);
    let lockRemovalAttempts = 0;
    const index = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask: async (): Promise<'terminal'> => 'terminal',
      removeFile: async (filename, options): Promise<void> => {
        if (path.basename(filename.toString()) === 'index.lock' && lockRemovalAttempts++ === 0) {
          throw Object.assign(new Error('lock is still busy'), { code: 'EPERM' });
        }
        await rm(filename, options);
      },
    });

    await index.initialize();
    expect(lockRemovalAttempts).toBeGreaterThanOrEqual(2);

    const replacement = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask: async (): Promise<'terminal'> => 'terminal',
    });
    await expect(replacement.reserve({
      taskId: 'next-task',
      requestDigest: 'b'.repeat(64),
      ownerClientId: 'chatgpt',
      ownerWorkspaceId: 'workspace-a',
    })).resolves.toMatchObject({ ok: true, value: { activeTasks: 1, created: true } });
    await replacement.release('next-task', 'b'.repeat(64));
  });

  it('serializes reservations across store instances so the active limit cannot be raced', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-index-limit-'));
    temporaryRoots.push(root);
    const inspectTask = vi.fn(async () => 'active' as const);
    const first = new DurableShellTaskIndex(root, { maxConcurrentTasks: 1, inspectTask });
    const second = new DurableShellTaskIndex(root, { maxConcurrentTasks: 1, inspectTask });
    await first.initialize();
    await second.initialize();

    const results = await Promise.all([
      first.reserve({
        taskId: 'task-one',
        requestDigest: '1'.repeat(64),
        ownerClientId: 'chatgpt',
        ownerWorkspaceId: 'workspace-a',
      }),
      second.reserve({
        taskId: 'task-two',
        requestDigest: '2'.repeat(64),
        ownerClientId: 'chatgpt',
        ownerWorkspaceId: 'workspace-a',
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'CONFLICT', recoverable: true }) }),
    ]);

    const successfulTaskId = results[0]?.ok ? 'task-one' : 'task-two';
    const successfulDigest = successfulTaskId === 'task-one' ? '1'.repeat(64) : '2'.repeat(64);
    await first.release(successfulTaskId, successfulDigest);
  });

  it('counts an unreadable active marker as active instead of freeing capacity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-index-unknown-'));
    temporaryRoots.push(root);
    const owner = {
      taskId: 'uncertain-task',
      requestDigest: 'a'.repeat(64),
      ownerClientId: 'chatgpt',
      ownerWorkspaceId: 'workspace-a',
    } as const;
    const first = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask: async (): Promise<'unknown'> => 'unknown',
    });
    await first.initialize();
    expect(await first.reserve(owner)).toMatchObject({ ok: true });
    const activeDirectory = path.join(root, '.index', 'v1', 'active');
    const [markerName] = await readdir(activeDirectory);
    expect(markerName).toBeDefined();
    await writeFile(path.join(activeDirectory, markerName!), '{not-json', 'utf8');

    const inspectTask = vi.fn(async () => 'terminal' as const);
    const replacement = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask,
    });
    const blocked = await replacement.reserve({
      taskId: 'next-task',
      requestDigest: 'b'.repeat(64),
      ownerClientId: 'chatgpt',
      ownerWorkspaceId: 'workspace-a',
    });

    expect(blocked).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', recoverable: true },
    });
    expect(inspectTask).not.toHaveBeenCalled();
    expect(await replacement.hasReservation(owner.taskId, owner.requestDigest)).toBe(false);
  });

  it('reclaims a missing pre-metadata reservation only after its launcher is proven gone', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-index-abandoned-'));
    temporaryRoots.push(root);
    const now = new Date('2026-09-20T10:00:00.000Z');
    const index = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask: async (): Promise<'missing'> => 'missing',
      now: (): Date => now,
    });
    await index.initialize();
    const abandonedTaskId = 'abandoned-before-metadata';
    const markerName = `${createHash('sha256').update(abandonedTaskId).digest('hex')}.json`;
    await writeFile(path.join(root, '.index', 'v1', 'active', markerName), JSON.stringify({
      version: 1,
      taskId: abandonedTaskId,
      requestDigest: 'a'.repeat(64),
      reservedAt: '2026-09-20T09:58:00.000Z',
      launcherPid: 2_147_483_647,
      launcherStartedAt: '2026-09-20T09:00:00.000Z',
    }), 'utf8');

    const reserved = await index.reserve({
      taskId: 'replacement-task',
      requestDigest: 'b'.repeat(64),
      ownerClientId: 'chatgpt',
      ownerWorkspaceId: 'workspace-a',
    });

    expect(reserved).toMatchObject({ ok: true, value: { activeTasks: 1, created: true } });
    await index.release('replacement-task', 'b'.repeat(64));
  });

  it('bootstraps and pages the compact launch journal without hydrating filtered histories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-index-journal-'));
    temporaryRoots.push(root);
    const records = new Map(Array.from({ length: 5 }, (_, offset) => {
      const ordinal = offset + 1;
      const taskId = `task-${ordinal}`;
      return [taskId, {
        version: 1 as const,
        taskId,
        startedAt: `2026-09-20T10:00:0${ordinal}.000Z`,
        ownerClientId: ordinal % 2 === 0 ? 'client-b' : 'client-a',
        ownerSessionId: ordinal % 2 === 0 ? 'session-b' : 'session-a',
        ownerWorkspaceId: 'workspace-a',
      }];
    }));
    await Promise.all([...records.keys()].map((taskId) => mkdir(path.join(root, taskId))));
    const loadLaunchRecord = vi.fn(async (taskId: string) => records.get(taskId));
    const index = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 2,
      inspectTask: async (): Promise<'terminal'> => 'terminal',
      loadLaunchRecord,
    });
    await index.initialize();
    expect(loadLaunchRecord).toHaveBeenCalledTimes(5);
    loadLaunchRecord.mockClear();

    const first = await index.listLaunches({
      limit: 2,
      accept: (record) => record.ownerClientId === 'client-a',
    });
    expect(first).toMatchObject({
      ok: true,
      value: { records: [{ taskId: 'task-5' }, { taskId: 'task-3' }], nextCursor: expect.any(String) },
    });
    if (!first.ok || first.value.nextCursor === undefined) return;
    const second = await index.listLaunches({
      limit: 2,
      cursor: first.value.nextCursor,
      accept: (record) => record.ownerClientId === 'client-a',
    });
    expect(second).toMatchObject({ ok: true, value: { records: [{ taskId: 'task-1' }] } });
    expect(loadLaunchRecord).not.toHaveBeenCalled();

    await expect(index.listLaunches({ limit: 2, cursor: 'malformed' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('rebuilds a missing or corrupt launch journal under the index lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-index-journal-rebuild-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'task-a'));
    const record = {
      version: 1 as const,
      taskId: 'task-a',
      startedAt: '2026-09-20T10:00:00.000Z',
      ownerClientId: 'client-a',
      ownerSessionId: 'session-a',
      ownerWorkspaceId: 'workspace-a',
    };
    const index = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 1,
      inspectTask: async (): Promise<'terminal'> => 'terminal',
      loadLaunchRecord: async (): Promise<typeof record> => record,
    });
    await index.initialize();
    const journalPath = path.join(root, '.index', 'v1', 'launches.jsonl');
    await rm(journalPath);
    await expect(index.listLaunches({ limit: 1 })).resolves.toMatchObject({
      ok: true,
      value: { records: [{ taskId: 'task-a' }] },
    });

    await writeFile(journalPath, '{corrupt}\n', 'utf8');
    await expect(index.listLaunches({ limit: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', recoverable: true },
    });
    await expect(index.listLaunches({ limit: 1 })).resolves.toMatchObject({
      ok: true,
      value: { records: [{ taskId: 'task-a' }] },
    });
  });
});
