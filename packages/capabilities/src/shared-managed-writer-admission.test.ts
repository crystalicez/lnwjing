import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableShellTaskStore } from './durable-shell-task-store.js';
import { SharedManagedWriterAdmission } from './shared-managed-writer-admission.js';
import { SqliteWorkspaceWriterLease } from './workspace-writer-lease.js';

describe('global managed writer admission', () => {
  it('refuses to grant/release workspace lease while a separate managed writer is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-global-lease-admission-'));
    try {
      const gate = new SharedManagedWriterAdmission(path.join(root, 'background-tasks'));
      const lease = new SqliteWorkspaceWriterLease(path.join(root, 'writer-leases.sqlite'), Date.now, gate);
      const blocker = await gate.enter({ actorClientId: 'other-client', workspaceId: 'other-workspace', kind: 'synchronous_mutation' });
      expect(blocker.ok).toBe(true);
      if (!blocker.ok) return;
      expect(await lease.acquire('first-workspace', 'owner', 'session', 60))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await blocker.value.releaseAfterVerifiedTermination();
      const acquired = await lease.acquire('first-workspace', 'owner', 'session', 60);
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      const active = await gate.enter({ actorClientId: 'other-client', workspaceId: 'other-workspace', kind: 'synchronous_mutation' });
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(await lease.release('first-workspace', 'owner', 'session', acquired.value))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await active.value.releaseAfterVerifiedTermination();
      expect(await lease.release('first-workspace', 'owner', 'session', acquired.value))
        .toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, 20000);

  it('serializes workspace lifecycle against real durable shell launches without blocking unrelated workspaces', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-lifecycle-admission-')));
    try {
      const gate = new SharedManagedWriterAdmission(root);
      const peer = new SharedManagedWriterAdmission(root);
      const store = new DurableShellTaskStore(root);
      const barrier = await gate.holdWorkspaceLifecycle('first');
      if (!barrier.ok) throw new Error('lifecycle not admitted');
      const launch = {
        taskId: 'lifecycle-test',
        executable: process.execPath, arguments: ['-e', 'process.stdout.write("completed")'],
        cwd: root, timeoutSeconds: 30, maxOutputBytes: 1024, includeStdout: true, includeStderr: false,
        owner: { clientId: 'peer', sessionId: 'session', workspaceId: 'first' },
      };
      try {
        expect(await store.launch(launch)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
        expect(await peer.holdWorkspaceLifecycle('first')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
        const unrelated = await peer.enter({ actorClientId: 'peer', workspaceId: 'second', kind: 'synchronous_mutation' });
        if (!unrelated.ok) throw new Error('unrelated workspace blocked');
        await unrelated.value.releaseAfterVerifiedTermination();
      } finally { await barrier.value.releaseAfterVerifiedTermination(); }
      const active = await peer.enter({ actorClientId: 'peer', workspaceId: 'first', kind: 'synchronous_mutation' });
      if (!active.ok) throw new Error('writer not admitted');
      try {
        expect(await gate.holdWorkspaceLifecycle('first')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
        const unrelated = await gate.holdWorkspaceLifecycle('second');
        if (!unrelated.ok) throw new Error('unrelated lifecycle blocked');
        await unrelated.value.releaseAfterVerifiedTermination();
      } finally { await active.value.releaseAfterVerifiedTermination(); }
      expect(await store.launch(launch)).toMatchObject({ ok: true });
      await expect.poll(async (): Promise<string> => {
        const observed = await store.snapshot(launch.taskId);
        return observed.ok ? String(observed.value.state) : 'unknown';
      }, { timeout: 20000 }).toBe('completed');
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 }); }
  }, 45000);

  it('refuses same-client idle recovery until the global managed writer is released', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-recover-managed-writer-'));
    try {
      let time = 100_000;
      const gate = new SharedManagedWriterAdmission(path.join(root, 'background-tasks'));
      const lease = new SqliteWorkspaceWriterLease(path.join(root, 'leases.sqlite'), () => time, gate);
      expect(await lease.acquire('workspace', 'owner', 'old-session', 600)).toMatchObject({ ok: true });
      const blocker = await gate.enter({ actorClientId: 'separate-client', workspaceId: 'other-workspace', kind: 'synchronous_mutation' });
      if (!blocker.ok) throw new Error('global writer not admitted');
      time += 61_000;
      expect(await lease.acquire('workspace', 'owner', 'new-session', 600, true))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await blocker.value.releaseAfterVerifiedTermination();
      expect(await lease.acquire('workspace', 'owner', 'new-session', 600, true))
        .toMatchObject({ ok: true, value: { generation: 2 } });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  });

  it('excludes repository import against even a different workspace synchronous file writer', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-global-admission-')));
    try {
      const gate = new SharedManagedWriterAdmission(root);
      const store = new DurableShellTaskStore(root);
      const entered = await gate.enter({ actorClientId: 'file-client', workspaceId: 'other-workspace', kind: 'synchronous_mutation' });
      expect(entered).toMatchObject({ ok: true });
      if (!entered.ok) throw new Error('admission failed');
      const start = {
        taskId: 'import-test',
        executable: process.execPath, arguments: ['-e', 'process.exit(0)'],
        cwd: root, timeoutSeconds: process.env.CI ? 110 : 15,
        mutationKind: 'repository_import' as const,
        maxOutputBytes: 1000, includeStdout: false, includeStderr: false,
        owner: { clientId: 'other-client', sessionId: 'other', workspaceId: 'import-workspace' },
      };
      expect(await store.launch(start)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await entered.value.releaseAfterVerifiedTermination();
      expect(await store.launch(start)).toMatchObject({ ok: true });
      await expect.poll(async (): Promise<string> => {
        const observed = await store.snapshot(start.taskId);
        return observed.ok ? String(observed.value.state) : 'unverified';
      }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('completed');
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, process.env.CI ? 130000 : 25000);

  it('an uncontained writer keeps its reservation until an explicit verified-release operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-uncontained-'));
    try {
      const gate = new SharedManagedWriterAdmission(root);
      const writer = await gate.enter({ actorClientId: 'direct-process', workspaceId: 'different-workspace', kind: 'uncontained_process' });
      expect(writer.ok).toBe(true);
      const store = new DurableShellTaskStore(root);
      const launch = {
        taskId: 'import-while-opaque', mutationKind: 'repository_import' as const,
        executable: process.execPath, arguments: ['-e', 'process.exit(0)'],
        cwd: root, timeoutSeconds: 10, maxOutputBytes: 1000, includeStdout: false, includeStderr: false,
        owner: { clientId: 'import', sessionId: 'import', workspaceId: 'import-workspace' },
      };
      expect(await store.launch(launch)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  });
});
