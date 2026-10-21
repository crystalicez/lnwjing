import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositoryImportStageAclScript, repositoryImportVerifyPublishedScript } from './repository-import-scripts.js';
import { windowsRepositoryImportAnchorSource } from './windows-repository-import-anchor.js';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableShellTaskStore } from './durable-shell-task-store.js';
import { SecureRepositoryImportRuntime } from './repository-import-runtime.js';

describe('repository import crash recovery', () => {
  it.skipIf(process.platform !== 'win32')('atomically refuses racing stage creators instead of adopting a foreign directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-stage-'));
    try {
      const script = path.join(root, 'create-stage.ps1');
      const stage = path.join(root, 'stage');
      await writeFile(script, repositoryImportStageAclScript);
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const execute = (): Promise<{ stdout: string; stderr: string }> => promisify(execFile)(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, stage,
      ], { timeout: 30000, windowsHide: true });
      const contenders = await Promise.allSettled(Array.from({ length: 4 }, execute));
      expect(contenders.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      expect(contenders.filter((entry) => entry.status === 'rejected')).toHaveLength(3);
      expect((await stat(stage)).isDirectory()).toBe(true);
      await expect(execute()).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, 60000);


  it.skipIf(process.platform !== 'win32')('revalidates NTFS identity after a published destination is replaced', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-native-readback-')));
    const requestId = '77777777-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const taskId = 'repository-import-' + requestId;
    const owner = { clientId: 'identity-client', sessionId: 'identity-session', workspaceId: 'identity-workspace' };
    const commit = 'c'.repeat(40);
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const stage = path.join(root, 'stage');
      await mkdir(workspaceRoot);
      await mkdir(stage);
      const folder = path.join(root, 'repository-imports', requestId);
      await mkdir(folder, { recursive: true });
      const source = path.join(folder, 'anchor.cs');
      const publishedVerifier = path.join(folder, 'verify-published.ps1');
      const publisher = path.join(folder, 'publish-for-test.ps1');
      const statePath = path.join(folder, 'publication.json');
      await writeFile(source, windowsRepositoryImportAnchorSource);
      await writeFile(publishedVerifier, repositoryImportVerifyPublishedScript);
      await writeFile(publisher, [
        'param([string]$Source,[string]$Workspace,[string]$Stage)',
        '$ErrorActionPreference = "Stop"',
        'Add-Type -Path $Source',
        '$anchor=[RepositoryImportAnchor]::new($Workspace,"dest")',
        'try {$identity=$anchor.PrepareStage($Stage);$anchor.Publish();Write-Output $identity} finally {$anchor.Dispose()}',
      ].join('\n'));
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const native = (await promisify(execFile)(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', publisher, source, workspaceRoot, stage,
      ], { timeout: 30000, windowsHide: true })).stdout.trim();
      expect(native).toMatch(/^[A-F0-9]{16}-[A-F0-9]{32}$/);
      await writeFile(path.join(folder, 'spec.json'), JSON.stringify({
        version: 1, requestId, owner, commit, workspaceRoot, anchorSourcePath: source,
        destination: 'dest', statePath,
      }));
      await writeFile(statePath, JSON.stringify({ version: 1, state: 'published', commit, nativeIdentity: native }));
      const store = new DurableShellTaskStore(path.join(root, 'background-tasks'));
      const launch = await store.launch({
        mutationKind: 'repository_import', taskId, executable: process.execPath,
        arguments: ['-e', 'process.exit(0)'], cwd: root, timeoutSeconds: process.env.CI ? 90 : 15,
        maxOutputBytes: 256, includeStdout: false, includeStderr: false, owner,
      });
      expect(launch.ok).toBe(true);
      await expect.poll(async (): Promise<string> => {
        const observed = await store.snapshot(taskId);
        return observed.ok ? String(observed.value.state) : 'unknown';
      }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('completed');
      const runtime = new SecureRepositoryImportRuntime(root);
      expect(await runtime.status({ taskId, owner })).toMatchObject({
        ok: true, value: { state: 'completed', native_identity: native },
      });
      await rename(path.join(workspaceRoot, 'dest'), path.join(workspaceRoot, 'original'));
      await mkdir(path.join(workspaceRoot, 'dest'));
      expect(await runtime.status({ taskId, owner })).toMatchObject({
        ok: true, value: { state: 'unresolved' },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, process.env.CI ? 220000 : 65000);

  it('does not trust a published receipt when the live native destination is absent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-stale-receipt-'));
    const requestId = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const taskId = 'repository-import-' + requestId;
    const owner = { clientId: 'stale-client', sessionId: 'stale-session', workspaceId: 'stale-workspace' };
    const commit = 'b'.repeat(40);
    try {
      const store = new DurableShellTaskStore(path.join(root, 'background-tasks'));
      const launch = await store.launch({
        mutationKind: 'repository_import', taskId, executable: process.execPath,
        arguments: ['-e', 'process.exit(0)'], cwd: root, timeoutSeconds: process.env.CI ? 90 : 15,
        maxOutputBytes: 256, includeStdout: false, includeStderr: false, owner,
      });
      expect(launch.ok).toBe(true);
      await expect.poll(async (): Promise<string> => {
        const observed = await store.snapshot(taskId);
        return observed.ok ? String(observed.value.state) : 'unknown';
      }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('completed');
      const folder = path.join(root, 'repository-imports', requestId);
      const statePath = path.join(folder, 'publication.json');
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'spec.json'), JSON.stringify({
        version: 1, requestId, owner, commit,
        destination: 'absent', workspaceRoot: root, statePath,
      }));
      await writeFile(statePath, JSON.stringify({
        version: 1, state: 'published', commit,
        nativeIdentity: '0123456789ABCDEF-0123456789ABCDEF0123456789ABCDEF',
      }));
      const result = await new SecureRepositoryImportRuntime(root).status({ taskId, owner });
      expect(result).toMatchObject({
        ok: true, value: { state: 'unresolved', detail: 'Native publication proof is incomplete' },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, process.env.CI ? 130000 : 30000);

  it.skipIf(process.platform !== 'win32')('fails closed on a failed worker with an existing destination even without a native receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-missing-receipt-'));
    const requestId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const taskId = 'repository-import-' + requestId;
    const owner = { clientId: 'no-receipt-client', sessionId: 'no-receipt-session', workspaceId: 'no-receipt-workspace' };
    const commit = 'd'.repeat(40);
    try {
      const taskStore = new DurableShellTaskStore(path.join(root, 'background-tasks'));
      const launch = await taskStore.launch({
        mutationKind: 'repository_import', taskId, executable: process.execPath,
        arguments: ['-e', 'process.exit(7)'], cwd: root,
        timeoutSeconds: process.env.CI ? 90 : 15, maxOutputBytes: 256, includeStdout: false,
        includeStderr: false, owner,
      });
      expect(launch.ok).toBe(true);
      await expect.poll(async () => {
        const current = await taskStore.snapshot(taskId);
        return current.ok ? current.value.state : 'unknown';
      }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('failed');
      const folder = path.join(root, 'repository-imports', requestId);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'spec.json'), JSON.stringify({
        version: 1, requestId, owner, commit, workspaceRoot: root,
        destination: 'ambiguous-destination', statePath: path.join(folder, 'missing-publication.json'),
      }));
      await mkdir(path.join(root, 'ambiguous-destination'));
      const runtime = new SecureRepositoryImportRuntime(root);
      expect(await runtime.status({ taskId, owner })).toMatchObject({
        ok: true, value: { state: 'unresolved', detail: expect.stringContaining('Destination exists') },
      });
      await rm(path.join(root, 'ambiguous-destination'), { recursive: true });
      expect(await runtime.status({ taskId, owner })).toMatchObject({
        ok: true, value: { state: 'failed' },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, process.env.CI ? 130000 : 30000);

  it('reports unresolved when a failed worker has a prepared native receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-import-prepared-'));
    const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const taskId = 'repository-import-' + requestId;
    const owner = { clientId: 'crash-client', sessionId: 'crash-session', workspaceId: 'crash-workspace' };
    const commit = 'a'.repeat(40);
    try {
      const taskStore = new DurableShellTaskStore(path.join(root, 'background-tasks'));
      const launch = await taskStore.launch({
        mutationKind: 'repository_import', taskId, executable: process.execPath,
        arguments: ['-e', 'process.exit(7)'], cwd: root,
        timeoutSeconds: process.env.CI ? 90 : 15, maxOutputBytes: 256, includeStdout: false,
        includeStderr: false, owner,
      });
      expect(launch.ok).toBe(true);
      await expect.poll(async () => {
        const current = await taskStore.snapshot(taskId);
        return current.ok ? current.value.state : 'unknown';
      }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('failed');
      const folder = path.join(root, 'repository-imports', requestId);
      const statePath = path.join(folder, 'publication.json');
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'spec.json'), JSON.stringify({
        version: 1, requestId, owner, commit, destination: 'safe-import', statePath,
      }));
      await writeFile(statePath, JSON.stringify({
        version: 1, state: 'prepared', commit,
        nativeIdentity: '0123456789ABCDEF-0123456789ABCDEF0123456789ABCDEF',
      }));
      const runtime = new SecureRepositoryImportRuntime(root);
      const status = await runtime.status({ taskId, owner });
      expect(status).toMatchObject({
        ok: true, value: { state: 'unresolved', detail: expect.stringContaining('publication') },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, process.env.CI ? 130000 : 30000);
});
