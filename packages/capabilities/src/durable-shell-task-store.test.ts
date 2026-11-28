import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShellCapabilityBackend } from './shell-backend.js';
import { SharedManagedWriterAdmission } from './shared-managed-writer-admission.js';
import { DurableShellTaskStore, parsePosixProcessProbe } from './durable-shell-task-store.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 50 : 0,
    retryDelay: 200,
  })));
});

describe('durable shell background tasks', () => {
  it('removes launch identity sidecars after terminal commit without polling the store', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-terminal-sidecars-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(state);
    const owner = { clientId: 'sidecar-client', sessionId: 'sidecar-session', workspaceId: 'sidecar-workspace' };
    const request = {
      taskId: 'sidecar-job', executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('verified'), 1800)"],
      cwd: root, timeoutSeconds: 30, maxOutputBytes: 1024,
      includeStdout: true, includeStderr: false, owner,
    };
    expect(await store.launch(request)).toMatchObject({ ok: true });
    const directory = path.join(state, request.taskId);
    expect(await stat(path.join(directory, 'worker.pid'))).toBeDefined();
    // Read only the raw durable record: no host-side cleanup or reconciliation.
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(path.join(directory, 'task.json'), 'utf8')).state; }
      catch { return 'unknown'; }
    }, { timeout: 20000 }).toBe('completed');
    await expect.poll(async () => {
      const present = await Promise.all(['worker.pid', 'worker.started'].map(async name =>
        stat(path.join(directory, name)).then(() => true, () => false)));
      return present.some(Boolean);
    }, { timeout: 8000 }).toBe(false);
    const reopened = new DurableShellTaskStore(state);
    expect(await reopened.snapshotForGoalEvidence(request.taskId, owner.workspaceId))
      .toMatchObject({ ok: true, value: { state: 'completed', stdout: 'verified' } });
    // Reusing the same durable ID must return its existing result, not execute again.
    expect(await reopened.launch(request)).toMatchObject({ ok: true, value: { state: 'completed', stdout: 'verified' } });
  }, 40000);

  it('isolates repository import child environment without changing ordinary shell behavior', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-env-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'env-owner', sessionId: 'env-session', workspaceId: 'env-workspace' };
    const key = 'LNWJING_IMPORT_CANARY_SECRET';
    const previous = process.env[key];
    process.env[key] = 'should-not-leak-to-repository-import';
    try {
      for (const kind of ['repository_import', 'opaque'] as const) {
        const id = kind === 'repository_import' ? 'isolated-import' : 'ordinary-shell';
        const launched = await store.launch({
          mutationKind: kind, taskId: id, executable: process.execPath,
          arguments: ['-e', 'process.stdout.write(process.env.LNWJING_IMPORT_CANARY_SECRET ? "leaked" : "isolated")'],
          cwd: root, timeoutSeconds: process.env.CI ? 100 : 15, maxOutputBytes: 256,
          includeStdout: true, includeStderr: false, owner,
        });
        expect(launched.ok).toBe(true);
        await expect.poll(async () => {
          const observation = await store.snapshot(id);
          return observation.ok ? observation.value.state : 'unknown';
        }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('completed');
        const evidence = await store.snapshotForGoalEvidence(id, owner.workspaceId);
        expect(evidence).toMatchObject({
          ok: true, value: { stdout: kind === 'repository_import' ? 'isolated' : 'leaked' },
        });
      }
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }, process.env.CI ? 160000 : 30000);

  it('holds an import-exclusive reservation through real contained worker lifetime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-worker-lifetime-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.tasks');
    const first = new DurableShellTaskStore(state);
    const second = new DurableShellTaskStore(state);
    const importRequest = {
      taskId: 'secure-import', mutationKind: 'repository_import' as const,
      executable: process.execPath, arguments: ['-e', 'setTimeout(() => {}, 2500)'],
      cwd: root, timeoutSeconds: process.env.CI ? 110 : 12, maxOutputBytes: 1024, includeStdout: false, includeStderr: false,
      owner: { clientId: 'owner', sessionId: 'session', workspaceId: 'workspace-1' },
    };
    const launched = await first.launch(importRequest);
    expect(launched.ok).toBe(true);
    const conflicting = await second.launch({
      ...importRequest, taskId: 'opaque-worker', mutationKind: 'opaque',
      owner: { clientId: 'other-owner', sessionId: 'other-session', workspaceId: 'workspace-2' },
    });
    expect(conflicting).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect.poll(async () => {
      const status = await first.snapshot('secure-import');
      return status.ok ? status.value.state : 'unknown';
    }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('completed');
    const after = await second.launch({
      ...importRequest, taskId: 'after', mutationKind: 'opaque',
      arguments: ['-e', 'process.exit(0)'],
    });
    expect(after.ok).toBe(true);
    await expect.poll(async () => {
      const status = await second.snapshot('after');
      return status.ok ? status.value.state : 'unknown';
    }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('completed');
  }, process.env.CI ? 160000 : 30000);

  it.skipIf(process.platform !== 'win32')('keeps durable ownership until detached descendants finish and persists native zero-active proof', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-contained-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(state);
    const marker = path.join(root, 'finished.txt');
    const childScript = path.join(root, 'child.cjs');
    await writeFile(childScript, [
      "const {spawn}=require('node:child_process');",
      "spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'done'),1500)\",process.argv[2]],{detached:true,stdio:'ignore'}).unref();",
    ].join('\n'));
    const result = await store.launch({
      taskId: 'contained', executable: process.execPath, arguments: [childScript, marker], cwd: root,
      timeoutSeconds: 15, maxOutputBytes: 1024, includeStdout: true, includeStderr: true,
      owner: { clientId: 'a', sessionId: 'a', workspaceId: 'a' },
    });
    expect(result.ok).toBe(true);
    await expect.poll(async () => {
      const status = await store.snapshot('contained');
      return status.ok ? status.value.state : 'unknown';
    }, { timeout: 10000 }).toBe('completed');
    expect(await readFile(marker, 'utf8').catch(() => 'not finished')).toBe('done');
    expect(JSON.parse(await readFile(path.join(state, 'contained', 'containment.receipt.json'), 'utf8'))).toMatchObject({ kind: 'windows_job_v1', activeProcesses: 0 });
  }, 15000);

  it('keeps liveness output-free but returns bounded terminal CI proof only to its workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-evidence-proof-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'proof-client', sessionId: 'proof-session', workspaceId: 'workspace-evidence' };
    const output = JSON.stringify({ headSha: 'a'.repeat(40), status: 'completed', conclusion: 'success' });
    const start = await store.launch({
      taskId: 'proof-1', commandFingerprint: 'a'.repeat(64), executable: process.execPath,
      arguments: ['-e', `process.stdout.write(${JSON.stringify(output)})`], cwd: root,
      timeoutSeconds: 15, maxOutputBytes: 4096, includeStdout: true, includeStderr: true, owner,
    });
    expect(start.ok).toBe(true);
    await expect.poll(async () => {
      const current = await store.snapshotForGoalLiveness('proof-1', owner.workspaceId);
      return current.ok ? current.value.state : 'error';
    }, { timeout: 10000 }).toBe('completed');
    const alive = await store.snapshotForGoalLiveness('proof-1', owner.workspaceId);
    expect(alive).toMatchObject({ ok: true, value: { state: 'completed', command_fingerprint: 'a'.repeat(64) } });
    if (alive.ok) expect(alive.value).not.toHaveProperty('stdout');
    const verified = await store.snapshotForGoalEvidence('proof-1', owner.workspaceId);
    expect(verified).toMatchObject({ ok: true, value: { stdout: output, state: 'completed', exit_code: 0 } });
    const foreign = await store.snapshotForGoalEvidence('proof-1', 'another-workspace');
    expect(foreign).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  }, 15000);

  it('fails closed for truncated terminal stdout evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-evidence-truncated-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'proof', sessionId: 'proof', workspaceId: 'workspace-evidence' };
    const start = await store.launch({
      taskId: 'proof-truncated', executable: process.execPath,
      arguments: ['-e', "process.stdout.write('X'.repeat(2048))"], cwd: root,
      timeoutSeconds: 15, maxOutputBytes: 64, includeStdout: true, includeStderr: true, owner,
    });
    expect(start.ok).toBe(true);
    await expect.poll(async () => {
      const status = await store.snapshot('proof-truncated');
      return status.ok ? status.value.state : 'error';
    }, { timeout: 10000 }).toBe('completed');
    expect(await store.snapshotForGoalEvidence('proof-truncated', owner.workspaceId)).toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    });
  }, 15000);

  it('treats an exited POSIX zombie as terminated without trusting a reused live PID', () => {
    expect(parsePosixProcessProbe('Wed Sep  9 14:58:14 2026 Z+')).toEqual({ state: 'gone' });
    expect(parsePosixProcessProbe('Wed Sep  9 14:58:14 2026 Ssl')).toMatchObject({
      state: 'live',
      processStartedAt: expect.any(String),
    });
    expect(parsePosixProcessProbe('not-a-valid-ps-row')).toEqual({ state: 'unverifiable', reason: 'invalid_probe_response' });
  });

  it.skipIf(process.platform === 'win32')('cancels the detached child group before retiring its durable worker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-groups-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks') });
    const started = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: root, execution: 'background', timeout_seconds: 40, userConfirmed: true,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);
    let childPid: number | undefined;
    let childStartedAt: string | undefined;
    try {
      await expect.poll(async () => {
        const status = await backend.execute({ operation: 'status', task_id: taskId });
        if (status.ok) {
          const value = status.value as Record<string, unknown>;
          if (typeof value.child_pid === 'number' && typeof value.child_started_at === 'string') {
            childPid = value.child_pid;
            childStartedAt = value.child_started_at;
            return true;
          }
        }
        return false;
      }, { timeout: 5000 }).toBe(true);
      const cancelled = await backend.execute({ operation: 'cancel', task_id: taskId, userConfirmed: true });
      expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } });
      expect(() => process.kill(childPid!, 0)).toThrow();
    } finally {
      // Red-phase cleanup is restricted to the exact fixture child identity.
      if (childPid !== undefined && childStartedAt !== undefined) {
        const probe = await promisify(execFile)('ps', ['-p', String(childPid), '-o', 'lstart=']).catch(() => null);
        if (probe && new Date(probe.stdout.trim()).toISOString() === childStartedAt) process.kill(-childPid, 'SIGKILL');
      }
    }
  }, 15000);

  it('survives a backend/runtime replacement and returns logs and result by task id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const firstRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });

    const started = await firstRuntime.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('durable-done'), 300)"],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
    });

    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const waited = await replacementRuntime.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(waited).toMatchObject({
      ok: true,
      value: { task_id: taskId, state: 'completed', exit_code: 0, stdout: 'durable-done', durable: true },
    });
    await expect(replacementRuntime.execute({ operation: 'list' })).resolves.toMatchObject({
      ok: true,
      value: { tasks: expect.arrayContaining([expect.objectContaining({ task_id: taskId, state: 'completed', durable: true })]) },
    });
  }, 15_000);

  it('does not overwrite terminal metadata when Windows-style PID reuse is observed during reconciliation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-pid-reuse-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const taskId = 'pid-reused-finalizing';
    const taskDirectory = path.join(taskStateDirectory, taskId);
    await mkdir(taskDirectory, { recursive: true });
    const metadataPath = path.join(taskDirectory, 'task.json');
    const runningMetadata = {
      version: 1,
      task_id: taskId,
      state: 'running',
      started_at: new Date(Date.now() - 20_000).toISOString(),
      include_stdout: false,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      worker_pid: process.pid,
      // The live PID belongs to this Vitest process, not the original durable worker.
      worker_started_at: '2000-01-01T00:00:00.000Z',
    } as const;
    await writeFile(metadataPath, JSON.stringify(runningMetadata), 'utf8');

    const finalized = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void writeFile(metadataPath, JSON.stringify({
          ...runningMetadata,
          state: 'completed',
          exit_code: 0,
          finished_at: new Date().toISOString(),
        }), 'utf8').then(() => resolve(), reject);
      }, 100);
    });

    const store = new DurableShellTaskStore(taskStateDirectory);
    const result = await store.snapshot(taskId);
    await finalized;
    expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0 } });
  }, 15_000);

  it('does not overwrite a concurrent completion when worker identity probing is unverifiable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-probe-race-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const taskId = 'probe-unverifiable-finalizing';
    const taskDirectory = path.join(taskStateDirectory, taskId);
    await mkdir(taskDirectory, { recursive: true });
    const metadataPath = path.join(taskDirectory, 'task.json');
    const runningMetadata = {
      version: 1,
      task_id: taskId,
      state: 'running',
      started_at: new Date(Date.now() - 20_000).toISOString(),
      include_stdout: false,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      // Invalid for an OS process probe, which deterministically models an
      // unverifiable worker identity without depending on the host platform.
      worker_pid: 2_147_483_648,
      worker_started_at: '2000-01-01T00:00:00.000Z',
    } as const;
    await writeFile(metadataPath, JSON.stringify(runningMetadata), 'utf8');

    const finalized = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void writeFile(metadataPath, JSON.stringify({
          ...runningMetadata,
          state: 'completed',
          exit_code: 0,
          finished_at: new Date().toISOString(),
        }), 'utf8').then(() => resolve(), reject);
      }, 100);
    });

    const store = new DurableShellTaskStore(taskStateDirectory);
    const result = await store.snapshot(taskId);
    await finalized;
    expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0 } });
    await expect(readFile(metadataPath, 'utf8').then((value) => JSON.parse(value))).resolves.toMatchObject({
      state: 'completed',
      exit_code: 0,
    });
  }, 15_000);

  it('applies a shared live shell limit across stores without terminating existing workers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-live-task-limit-'));
    temporaryRoots.push(root);
    const directory = path.join(root, '.tasks');
    let limit = 1;
    const options = { maxConcurrentTasksProvider: (): number => limit };
    const first = new DurableShellTaskStore(directory, options);
    const second = new DurableShellTaskStore(directory, options);
    const owner = { clientId: 'client', sessionId: 'session', workspaceId: 'workspace' };
    const request = { executable: process.execPath, arguments: ['-e', 'setTimeout(() => {}, 15000)'],
      cwd: root, timeoutSeconds: 40, maxOutputBytes: 1024, includeStdout: false, includeStderr: false, owner };
    try {
      expect(await first.launch({ ...request, taskId: 'first' })).toMatchObject({ ok: true });
      expect(await second.launch({ ...request, taskId: 'second' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      limit = 2;
      expect(await second.launch({ ...request, taskId: 'second' })).toMatchObject({ ok: true });
      limit = 1;
      expect(await first.launch({ ...request, taskId: 'third' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(await first.snapshot('first', undefined, owner)).toMatchObject({ ok: true, value: { state: 'running' } });
      expect(await second.snapshot('second', undefined, owner)).toMatchObject({ ok: true, value: { state: 'running' } });
      expect(await first.reservationDiagnostics()).toMatchObject({ limit: 1, total: 2, shell: 2, managed: 0, unknown: 0, unreadable: 0,
        rows: expect.arrayContaining([expect.objectContaining({ taskId: 'first', kind: 'durable_shell', recordedState: 'running', ownerClientId: owner.clientId, ownerSessionId: owner.sessionId, workspaceId: owner.workspaceId })]) });
    } finally {
      for (const id of ['first', 'second']) {
        if (await first.has(id)) await first.wait(id, 25, undefined, owner);
      }
    }
    expect(await second.launch({ ...request, taskId: 'third', arguments: ['-e', 'process.exit(0)'] })).toMatchObject({ ok: true });
    expect(await second.wait('third', 10, undefined, owner)).toMatchObject({ ok: true, value: { state: 'completed' } });
  }, 45000);

  it('reconciles a previously uncertain task when a verified native receipt arrives later', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-late-native-receipt-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.tasks');
    const taskId = 'late-receipt';
    const directory = path.join(state, taskId);
    await mkdir(directory, { recursive: true });
    const owner = { clientId: 'client', sessionId: 'session', workspaceId: 'workspace' };
    const metadata = {
      version: 1, task_id: taskId, state: 'termination_unverified', containment: 'windows_job_v1',
      request_digest: 'b'.repeat(64), started_at: new Date(Date.now() - 120000).toISOString(),
      deadline_at: new Date(Date.now() - 60000).toISOString(), error: 'Native containment termination could not be verified',
      include_stdout: false, include_stderr: false, max_output_bytes: 1024,
      owner_client_id: owner.clientId, owner_session_id: owner.sessionId, owner_workspace_id: owner.workspaceId,
    };
    await writeFile(path.join(directory, 'task.json'), JSON.stringify(metadata));
    const store = new DurableShellTaskStore(state, { maxConcurrentTasks: 1 });
    const receipt = path.join(directory, 'containment.receipt.json');
    expect(await store.snapshot(taskId, undefined, owner)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    await writeFile(receipt, JSON.stringify({ kind: 'windows_job_v1', outcome: 'completed', activeProcesses: 1, exitCode: 0 }));
    expect(await store.snapshot(taskId, undefined, owner)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    expect(await store.launch({ taskId: 'blocked', executable: process.execPath,
      arguments: ['-e', 'process.exit(0)'], cwd: root, timeoutSeconds: 30,
      maxOutputBytes: 1024, includeStdout: false, includeStderr: false, owner }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await writeFile(receipt, JSON.stringify({ kind: 'windows_job_v1', outcome: 'completed', activeProcesses: 0, exitCode: 0 }));
    expect(await store.snapshot(taskId, undefined, owner)).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0 } });
    expect(JSON.parse(await readFile(path.join(directory, 'task.json'), 'utf8'))).toMatchObject({ state: 'completed', exit_code: 0 });
    // The recovered terminal task no longer occupies the sole worker slot.
    const next = await store.launch({ taskId: 'replacement', executable: process.execPath,
      arguments: ['-e', "process.stdout.write('ok')"], cwd: root, timeoutSeconds: 30,
      maxOutputBytes: 1024, includeStdout: true, includeStderr: false, owner });
    expect(next.ok).toBe(true);
    expect(await store.wait('replacement', 5, undefined, owner)).toMatchObject({ ok: true, value: { state: 'completed', stdout: 'ok' } });
  }, 20000);

  it('does not overwrite a very fast durable completion back to running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory: path.join(root, '.tasks'),
      autoWaitSeconds: 1,
    });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('fast')"],
      cwd: root,
      execution: 'auto',
      timeout_seconds: 30,
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!result.ok) return;
    const taskId = String((result.value as Record<string, unknown>).task_id);
    const terminal = (result.value as Record<string, unknown>).state === 'running'
      ? await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 })
      : result;
    expect(terminal).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'fast', durable: true } });
    if (!terminal.ok) return;
    const workerPid = Number((terminal.value as Record<string, unknown>).worker_pid);
    expect(Number.isInteger(workerPid)).toBe(true);
    await expect.poll(() => {
      try {
        process.kill(workerPid, 0);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 2000, interval: 50 }).toBe(false);

    await expect(backend.execute({ operation: 'status', task_id: taskId })).resolves.toMatchObject({
      ok: true,
      value: { state: 'completed', exit_code: 0, stdout: 'fast', durable: true },
    });
  }, 15_000);

  it('retains Windows containment until a detached descendant closes inherited stdio', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory: path.join(root, '.tasks'),
    });
    const script = [
      "const { spawn } = require('node:child_process');",
      "const os = require('node:os');",
      "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2200)'], {",
      "cwd: os.tmpdir(), detached: true, stdio: ['ignore', process.stdout, process.stderr] });",
      "grandchild.unref();",
      "process.stdout.write('parent-done');",
    ].join('');

    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', script],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    try {
      const beforeDescendantExit = await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 0.25 });
      if (process.platform === 'win32') {
        expect(beforeDescendantExit).toMatchObject({ ok: true, value: { state: 'running', durable: true } });
      }
      const terminal = await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 6 });
      expect(terminal).toMatchObject({
        ok: true,
        value: { state: 'completed', exit_code: 0, stdout: 'parent-done', durable: true },
      });
    } finally {
      const current = await backend.execute({ operation: 'status', task_id: taskId });
      if (current.ok && (current.value as Record<string, unknown>).state === 'running') {
        await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
      }
    }
  }, 20000);

  // Replacement cancellation probes worker identity and may invoke taskkill;
  // PowerShell startup can exceed Vitest's 5s default on a busy Windows host.
  it('cancels a durable task from a replacement backend', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const firstRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const started = await firstRuntime.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: root,
      execution: 'background',
      timeout_seconds: 60,
      userConfirmed: true,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    await waitUntil(async () => {
      const status = await replacementRuntime.execute({ operation: 'status', task_id: taskId });
      if (!status.ok) return false;
      const value = status.value as Record<string, unknown>;
      return typeof value.worker_pid === 'number'
        && typeof value.worker_started_at === 'string'
        && typeof value.child_pid === 'number'
        && typeof value.child_started_at === 'string';
    }, 15_000);
    const cancelled = await replacementRuntime.execute({ operation: 'cancel', task_id: taskId, userConfirmed: true });

    expect(cancelled).toMatchObject({ ok: true, value: { task_id: taskId, state: 'cancelled', durable: true } });
  }, 45_000);

  it('keeps a durable auto task running when the original MCP caller aborts after submission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory,
      autoWaitSeconds: 0.3,
      maxSynchronousWaitSeconds: 0.3,
    });
    const controller = new AbortController();
    const running = backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('after-abort'), 600)"],
      cwd: root,
      execution: 'auto',
      timeout_seconds: 30,
      userConfirmed: true,
    }, controller.signal);
    setTimeout(() => controller.abort(), 100);

    const submitted = await running;
    // A fast host may complete the durable child before the auto response is observed.
    // Either state must retain a durable identity and the successful terminal receipt.
    expect(submitted).toMatchObject({ ok: true, value: { state: expect.stringMatching(/^(running|completed)$/), task_id: expect.any(String), durable: true } });
    if (!submitted.ok) return;
    const taskId = String((submitted.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const finished = await replacementRuntime.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(finished).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'after-abort', durable: true } });
  });

  it('caps concurrent durable workers so many chats cannot exhaust a Windows 10/11 machine with child consoles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-shell-cap-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(taskStateDirectory, { maxConcurrentTasks: 1 });
    const owner = { clientId: 'chatgpt', sessionId: 'session-a', workspaceId: 'workspace-a' };
    const common = {
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    } as const;

    const first = await store.launch({ taskId: 'task-one', ...common });
    expect(first).toMatchObject({ ok: true, value: { task_id: 'task-one', state: 'running' } });

    try {
      const second = await store.launch({ taskId: 'task-two', ...common });
      expect(second).toMatchObject({
        ok: false,
        error: {
          code: 'CONFLICT',
          recoverable: true,
        },
      });
    } finally {
      if (first.ok) await store.cancel('task-one', owner);
    }
  }, 15_000);
  it('does not hydrate historical durable output while enforcing the concurrency limit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-memory-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const historicalId = 'historical-completed';
    const historicalDirectory = path.join(taskStateDirectory, historicalId);
    await mkdir(historicalDirectory, { recursive: true });
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(path.join(historicalDirectory, 'task.json'), JSON.stringify({
      version: 1,
      task_id: historicalId,
      state: 'completed',
      started_at: startedAt,
      finished_at: new Date(Date.now() - 4_000).toISOString(),
      exit_code: 0,
      include_stdout: true,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8');
    const historicalOutputPath = path.join(historicalDirectory, 'stdout.log');
    await writeFile(historicalOutputPath, Buffer.alloc(2 * 1024 * 1024, 0x61));

    vi.mocked(readFile).mockClear();
    const store = new DurableShellTaskStore(taskStateDirectory);
    const owner = { clientId: 'chatgpt', sessionId: 'session-a', workspaceId: 'workspace-a' };
    const launched = await store.launch({
      taskId: 'new-task',
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('ok')"],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    });
    expect(launched.ok).toBe(true);

    const historicalOutputReads = vi.mocked(readFile).mock.calls.filter(
      ([filename]) => String(filename) === historicalOutputPath,
    );
    expect(historicalOutputReads).toEqual([]);

    if (launched.ok) await store.wait('new-task', 5, undefined, owner);
  }, 15_000);

  it('uses the persisted active index on warm launch without rescanning terminal task sidecars', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-warm-index-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const owner = { clientId: 'chatgpt', sessionId: 'session-a', workspaceId: 'workspace-a' };
    const request = {
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('ok')"],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    } as const;
    const terminalSidecars = new Set<string>();
    await Promise.all(Array.from({ length: 64 }, async (_, index) => {
      const taskId = `historical-${String(index).padStart(3, '0')}`;
      const taskDirectory = path.join(taskStateDirectory, taskId);
      await mkdir(taskDirectory, { recursive: true });
      const startedAt = new Date(Date.now() - 10_000 - index).toISOString();
      await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'completed',
        started_at: startedAt,
        finished_at: new Date(Date.now() - 5_000 - index).toISOString(),
        exit_code: 0,
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
      }), 'utf8');
      terminalSidecars.add(path.join(taskDirectory, 'task.json'));
      terminalSidecars.add(path.join(taskDirectory, 'worker.pid'));
      terminalSidecars.add(path.join(taskDirectory, 'worker.started'));
    }));

    const firstStore = new DurableShellTaskStore(taskStateDirectory);
    const first = await firstStore.launch({ taskId: 'first-terminal', ...request });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await expect(firstStore.wait('first-terminal', 5, undefined, owner)).resolves.toMatchObject({
      ok: true,
      value: { state: 'completed' },
    });

    const terminalDirectory = path.join(taskStateDirectory, 'first-terminal');
    terminalSidecars.add(path.join(terminalDirectory, 'task.json'));
    terminalSidecars.add(path.join(terminalDirectory, 'worker.pid'));
    terminalSidecars.add(path.join(terminalDirectory, 'worker.started'));
    vi.mocked(readFile).mockClear();

    const replacementStore = new DurableShellTaskStore(taskStateDirectory);
    const second = await replacementStore.launch({ taskId: 'second-running', ...request });
    expect(second.ok).toBe(true);
    const terminalReads = vi.mocked(readFile).mock.calls.filter(
      ([filename]) => terminalSidecars.has(String(filename)),
    );
    expect(terminalReads).toEqual([]);

    if (second.ok) await replacementStore.wait('second-running', 5, undefined, owner);
  }, 20_000);

  it.each([false, true])('preserves legacy launch history when writer admission initialized first (old ready=%s)', async (oldReady) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-writer-bootstrap-history-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.tasks');
    const owner = { clientId: 'history-client', sessionId: 'history-session', workspaceId: 'history-workspace' };
    for (let i = 0; i < 12; i++) {
      const id = 'legacy-' + i;
      const directory = path.join(state, id);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'task.json'), JSON.stringify({
        version: 1, task_id: id, state: 'completed', exit_code: 0,
        started_at: new Date(i * 1000).toISOString(), finished_at: new Date(i * 1000 + 1).toISOString(),
        deadline_at: new Date(60000).toISOString(), include_stdout: false, include_stderr: false, max_output_bytes: 1024,
        owner_client_id: owner.clientId, owner_session_id: owner.sessionId, owner_workspace_id: owner.workspaceId,
      }));
    }
    if (oldReady) {
      const index = path.join(state, '.index', 'v1');
      await mkdir(path.join(index, 'active'), { recursive: true });
      await writeFile(path.join(index, 'ready.json'), JSON.stringify({ version: 1, readyAt: new Date().toISOString() }));
      await writeFile(path.join(index, 'launches.jsonl'), '');
    }
    vi.mocked(readFile).mockClear();
    const admission = new SharedManagedWriterAdmission(state);
    const lease = await admission.enter({ actorClientId: owner.clientId, workspaceId: owner.workspaceId, kind: 'synchronous_mutation' });
    expect(lease.ok).toBe(true);
    if (lease.ok) await lease.value.releaseAfterVerifiedTermination();
    const reads = (): number => vi.mocked(readFile).mock.calls.filter(([filename]) => String(filename).endsWith(path.sep + 'task.json')).length;
    expect(reads()).toBe(oldReady ? 0 : 12);
    vi.mocked(readFile).mockClear();
    const store = new DurableShellTaskStore(state);
    const page = await store.listPage(owner, 12);
    expect(page).toMatchObject({ ok: true, value: { tasks: Array.from({ length: 12 }, (_, i) => ({ task_id: 'legacy-' + (11 - i) })) } });
    expect(reads()).toBe(oldReady ? 24 : 12);
    vi.mocked(readFile).mockClear();
    expect(await store.listPage(owner, 2)).toMatchObject({ ok: true, value: { tasks: [{ task_id: 'legacy-11' }, { task_id: 'legacy-10' }] } });
    expect(reads()).toBe(2);
  });

  it('hydrates only one owner-scoped journal page instead of all durable histories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-page-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const ownerA = { clientId: 'chatgpt', sessionId: 'session-a', workspaceId: 'workspace-a' };
    await Promise.all(Array.from({ length: 20 }, async (_, offset) => {
      const ordinal = offset + 1;
      const taskId = `history-${String(ordinal).padStart(2, '0')}`;
      const taskDirectory = path.join(taskStateDirectory, taskId);
      await mkdir(taskDirectory, { recursive: true });
      await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'completed',
        started_at: `2026-09-20T10:00:${String(ordinal).padStart(2, '0')}.000Z`,
        finished_at: `2026-09-20T10:01:${String(ordinal).padStart(2, '0')}.000Z`,
        exit_code: 0,
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: '2026-09-20T11:00:00.000Z',
        owner_client_id: ordinal % 2 === 0 ? 'other' : ownerA.clientId,
        owner_session_id: ordinal % 2 === 0 ? 'session-b' : ownerA.sessionId,
        owner_workspace_id: ownerA.workspaceId,
      }), 'utf8');
    }));
    const store = new DurableShellTaskStore(taskStateDirectory);
    const first = await store.listPage(ownerA, 3);
    expect(first).toMatchObject({
      ok: true,
      value: {
        tasks: [{ task_id: 'history-19' }, { task_id: 'history-17' }, { task_id: 'history-15' }],
        nextCursor: expect.any(String),
      },
    });
    if (!first.ok || first.value.nextCursor === undefined) return;

    vi.mocked(readFile).mockClear();
    const second = await store.listPage(ownerA, 3, first.value.nextCursor);
    expect(second).toMatchObject({
      ok: true,
      value: { tasks: [{ task_id: 'history-13' }, { task_id: 'history-11' }, { task_id: 'history-09' }] },
    });
    const metadataReads = vi.mocked(readFile).mock.calls.filter(
      ([filename]) => String(filename).endsWith(`${path.sep}task.json`),
    );
    expect(metadataReads).toHaveLength(3);
  });

  it('does not persist disabled output or create empty stream files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-output-files-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(state);
    const owner = { clientId: 'capture-owner', sessionId: 'capture-session', workspaceId: 'capture-workspace' };
    for (const [taskId, includeStdout, code] of [
      ['disabled', false, "process.stdout.write('x'.repeat(262144)); process.stderr.write('ignored')"],
      ['empty', true, 'process.exit(0)'],
      ['ordered', true, "process.stdout.write('a'.repeat(65536)); process.stdout.write('b'.repeat(65536))"],
    ] as const) {
      expect(await store.launch({
        taskId, executable: process.execPath, arguments: ['-e', code], cwd: root,
        timeoutSeconds: 30, maxOutputBytes: 256 * 1024, includeStdout, includeStderr: false, owner,
      })).toMatchObject({ ok: true });
      const result = await store.wait(taskId, 15, undefined, owner);
      expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, truncated: false } });
      await expect(stat(path.join(state, taskId, 'stderr.log'))).rejects.toMatchObject({ code: 'ENOENT' });
      if (taskId === 'ordered') {
        expect(result).toMatchObject({ ok: true, value: { stdout: 'a'.repeat(65536) + 'b'.repeat(65536) } });
        expect((await stat(path.join(state, taskId, 'stdout.log'))).size).toBe(131072);
      } else {
        await expect(stat(path.join(state, taskId, 'stdout.log'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    }
  }, 60_000);

  it('wait reads actual output only once despite repeated metadata polling', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-wait-io-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(state);
    const owner = { clientId: 'wait-owner', sessionId: 'wait-session', workspaceId: 'wait-workspace' };
    const taskId = 'wait-output';
    const launched = await store.launch({
      taskId, executable: process.execPath,
      arguments: ['-e', "process.stdout.write('a'.repeat(65536)); setTimeout(() => process.stdout.write('done'), 2500)"],
      cwd: root, timeoutSeconds: 30, maxOutputBytes: 128 * 1024,
      includeStdout: true, includeStderr: true, owner,
    });
    expect(launched.ok).toBe(true);
    vi.mocked(open).mockClear();
    vi.mocked(readFile).mockClear();
    const result = await store.wait(taskId, 15, undefined, owner);
    expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'a'.repeat(65536) + 'done' } });
    const outputOpens = vi.mocked(open).mock.calls.filter(([filename]) =>
      String(filename) === path.join(state, taskId, 'stdout.log') ||
      String(filename) === path.join(state, taskId, 'stderr.log'));
    expect(outputOpens).toHaveLength(2);
    expect(vi.mocked(readFile).mock.calls.filter(([filename]) => String(filename) === path.join(state, taskId, 'task.json')).length).toBeGreaterThan(1);
    vi.mocked(open).mockClear();
    expect(await store.wait(taskId, 0, undefined, { ...owner, clientId: 'foreign' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(vi.mocked(open).mock.calls.filter(([filename]) => String(filename).endsWith('.log'))).toHaveLength(0);
  }, 35_000);

  it('defaults shell history to a 50-record page and reads only requested metadata after bootstrap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-shell-page-default-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.tasks');
    for (let i = 0; i < 65; i++) {
      const id = 'historical-' + String(i).padStart(3, '0');
      const directory = path.join(state, id);
      await mkdir(directory, { recursive: true });
      const at = new Date(1700000000000 + i * 1000).toISOString();
      await writeFile(path.join(directory, 'task.json'), JSON.stringify({
        version: 1, task_id: id, state: 'completed', exit_code: 0,
        started_at: at, finished_at: at, deadline_at: at,
        include_stdout: true, include_stderr: true, max_output_bytes: 1024,
      }));
    }
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory: state });
    const warmup = await backend.execute({ operation: 'list', limit: 1 });
    expect(warmup).toMatchObject({ ok: true });
    vi.mocked(readFile).mockClear();
    const first = await backend.execute({ operation: 'list' });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('list failed');
    const page = first.value as { tasks: Record<string, unknown>[]; next_cursor: string };
    expect(page.tasks).toHaveLength(50);
    expect(page.tasks[0]?.task_id).toBe('historical-064');
    expect(page.next_cursor).toEqual(expect.any(String));
    expect(vi.mocked(readFile).mock.calls.filter(([filename]) => String(filename).endsWith(path.sep + 'task.json'))).toHaveLength(50);
    const second = await backend.execute({ operation: 'list', cursor: page.next_cursor });
    expect(second).toMatchObject({ ok: true, value: { tasks: expect.any(Array) } });
    if (!second.ok) throw new Error('second list failed');
    const remaining = second.value as { tasks: Record<string, unknown>[]; next_cursor?: string };
    expect(remaining.tasks).toHaveLength(15);
    expect(remaining.tasks[0]?.task_id).toBe('historical-014');
    expect(remaining.next_cursor).toBeUndefined();
  });

  it('lists durable task metadata without hydrating historical output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-list-memory-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const taskId = 'listed-completed';
    const taskDirectory = path.join(taskStateDirectory, taskId);
    await mkdir(taskDirectory, { recursive: true });
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
      version: 1,
      task_id: taskId,
      state: 'completed',
      started_at: startedAt,
      finished_at: new Date(Date.now() - 4_000).toISOString(),
      exit_code: 0,
      include_stdout: true,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8');
    const outputPath = path.join(taskDirectory, 'stdout.log');
    await writeFile(outputPath, Buffer.alloc(2 * 1024 * 1024, 0x63));

    vi.mocked(readFile).mockClear();
    const store = new DurableShellTaskStore(taskStateDirectory);
    const listed = await store.list();
    expect(listed).toEqual([expect.objectContaining({ task_id: taskId, state: 'completed', durable: true })]);
    expect(listed[0]).not.toHaveProperty('stdout');
    expect(listed[0]).not.toHaveProperty('stderr');
  });
  it('reads oversized legacy task output without whole-file readFile allocation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-durable-bounded-read-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const taskId = 'legacy-oversized';
    const taskDirectory = path.join(taskStateDirectory, taskId);
    await mkdir(taskDirectory, { recursive: true });
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
      version: 1,
      task_id: taskId,
      state: 'completed',
      started_at: startedAt,
      finished_at: new Date(Date.now() - 4_000).toISOString(),
      exit_code: 0,
      include_stdout: true,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8');
    const legacyOutputPath = path.join(taskDirectory, 'stdout.log');
    await writeFile(legacyOutputPath, Buffer.alloc(2 * 1024 * 1024, 0x62));

    vi.mocked(readFile).mockClear();
    const store = new DurableShellTaskStore(taskStateDirectory);
    const snapshot = await store.snapshot(taskId);
    expect(snapshot).toMatchObject({ ok: true, value: { stdout: 'b'.repeat(1024) } });
    const wholeFileReads = vi.mocked(readFile).mock.calls.filter(
      ([filename]) => String(filename) === legacyOutputPath,
    );
    expect(wholeFileReads).toEqual([]);
  });
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition was not met before timeout');
}
