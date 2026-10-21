import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjing/domain';
import { DurableShellTaskStore } from './durable-shell-task-store.js';
import { windowsRepositoryImportAnchorSource } from './windows-repository-import-anchor.js';
import { repositoryImportStageAclScript, repositoryImportStageIdentityScript, repositoryImportPublishScript, repositoryImportVerifyPublishedScript } from './repository-import-scripts.js';
import { repositoryImportWorkerSource } from './repository-import-worker-source.js';
import type { CapabilityTaskOwner } from './task-ownership.js';

export interface SecureRepositoryImportStart {
  readonly request: {
    readonly workspaceId: string;
    readonly requestId: string;
    readonly url: string;
    readonly destination: string;
    readonly commit: string;
  };
  readonly owner: CapabilityTaskOwner;
  readonly workspaceRoot: string;
}

export interface SecureRepositoryImportHandle {
  readonly taskId: string;
  readonly owner: CapabilityTaskOwner;
}

interface ImportManifest {
  readonly version: 1;
  readonly requestDigest: string;
  readonly owner: CapabilityTaskOwner;
  readonly requestId: string;
  readonly url: string;
  readonly commit: string;
  readonly workspaceRoot: string;
  readonly destination: string;
  readonly stagePath: string;
  readonly privateHome: string;
  readonly stageAclPath: string;
  readonly stageIdentityPath: string;
  readonly publisherPath: string;
  readonly anchorSourcePath: string;
  readonly statePath: string;
}

const execFileAsync = promisify(execFile);

interface NativeReceipt {
  readonly version: 1;
  readonly state: 'prepared' | 'published';
  readonly nativeIdentity: string;
  readonly commit: string;
}

/**
 * Native Windows-only provider. A durable Windows Job Object contains every
 * Git/PowerShell descendant. Its reservation index is the SAME directory used
 * by the generic shell provider, not an independently scoped workspace queue.
 *
 * NOTE: the public tool must not be advertised until direct process/Git/file
 * writers also participate in the same exclusive admission boundary.
 */
export class SecureRepositoryImportRuntime {
  private readonly taskStore: DurableShellTaskStore;
  private readonly root: string;

  constructor(private readonly dataPath: string) {
    this.root = path.join(dataPath, 'repository-imports');
    this.taskStore = new DurableShellTaskStore(path.join(dataPath, 'background-tasks'));
  }

  async start(input: SecureRepositoryImportStart, _signal?: AbortSignal): Promise<Result<Record<string, unknown>>> {
    if (process.platform !== 'win32') return err(appError('INVALID_INPUT', 'Secure repository import requires verified local Windows NTFS'));
    if (_signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Repository import request was cancelled', true));
    const { request, owner } = input;
    if (request.workspaceId !== owner.workspaceId
      || !/^[0-9a-f-]{36}$/i.test(request.requestId)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(request.commit)
      || !path.win32.isAbsolute(input.workspaceRoot)
      || input.workspaceRoot.startsWith('\\\\')) return err(appError('INVALID_INPUT', 'Repository import scope is invalid'));
    const taskId = this.taskId(request.requestId);
    const directory = this.importDirectory(request.requestId);
    const manifestPath = path.join(directory, 'spec.json');
    const digest = createHash('sha256').update(JSON.stringify({ input })).digest('hex');
    try {
      const canonicalWorkspace = await realpath(input.workspaceRoot);
      if (canonicalWorkspace.toLowerCase() !== path.win32.normalize(input.workspaceRoot).toLowerCase()
        || !(await stat(canonicalWorkspace)).isDirectory()) {
        return err(appError('PERMISSION_DENIED', 'Repository import workspace identity is not stable'));
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let manifest: ImportManifest;
      try {
        const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as ImportManifest;
        if (existing.version !== 1 || existing.requestDigest !== digest
          || existing.owner.clientId !== owner.clientId || existing.owner.sessionId !== owner.sessionId
          || existing.owner.workspaceId !== owner.workspaceId
          || existing.stageIdentityPath !== path.join(directory, 'stage-identity.ps1')) {
          return err(appError('CONFLICT', 'Repository import request identifier was already used', true));
        }
        manifest = existing;
      } catch (error: unknown) {
        if (!isMissing(error)) return err(appError('CONFLICT', 'Repository import manifest could not be verified', true));
        const stagePath = path.join(path.win32.dirname(canonicalWorkspace), '.lnwjing-import-stage-' + randomUUID());
        manifest = {
          version: 1, requestDigest: digest, owner, requestId: request.requestId,
          url: request.url, commit: request.commit.toLowerCase(), workspaceRoot: canonicalWorkspace,
          destination: request.destination, stagePath,
          privateHome: path.join(directory, 'home'),
          stageAclPath: path.join(directory, 'stage-acl.ps1'),
          stageIdentityPath: path.join(directory, 'stage-identity.ps1'),
          publisherPath: path.join(directory, 'publish.ps1'),
          anchorSourcePath: path.join(directory, 'anchor.cs'),
          statePath: path.join(directory, 'publication.json'),
        };
        try {
          await writeFile(manifestPath, JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        } catch (error: unknown) {
          if (isExists(error)) return err(appError('CONFLICT', 'Concurrent repository import admission requires a retry', true));
          throw error;
        }
      }
      const workerPath = path.join(directory, 'worker.cjs');
      for (const [filename, content] of [
        [workerPath, repositoryImportWorkerSource],
        [manifest.stageAclPath, repositoryImportStageAclScript],
        [manifest.stageIdentityPath, repositoryImportStageIdentityScript],
        [manifest.publisherPath, repositoryImportPublishScript],
        [path.join(directory, 'verify-published.ps1'), repositoryImportVerifyPublishedScript],
        [manifest.anchorSourcePath, windowsRepositoryImportAnchorSource],
      ] as const) {
        const asset = await this.ensureAsset(filename, content);
        if (!asset) return err(appError('CONFLICT', 'Repository import runner assets changed unexpectedly'));
      }
      const started = await this.taskStore.launch({
        mutationKind: 'repository_import',
        taskId, executable: process.execPath, arguments: [workerPath, manifestPath],
        cwd: directory, timeoutSeconds: 900,
        maxOutputBytes: 4096, includeStdout: true, includeStderr: false,
        owner,
      });
      if (!started.ok) return started;
      return this.status({ taskId, owner });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Repository import could not be admitted', true));
    }
  }

  async status(input: SecureRepositoryImportHandle): Promise<Result<Record<string, unknown>>> {
    const manifest = await this.readOwnedManifest(input);
    if (!manifest.ok) return manifest;
    const snapshot = await this.taskStore.snapshot(input.taskId, undefined, input.owner);
    if (!snapshot.ok) return snapshot;
    const state = snapshot.value.state;
    const response = { task_id: input.taskId, requested_commit: manifest.value.commit, destination: manifest.value.destination };
    if (state === 'running') return ok({ ...response, state: 'running' });
    if (state === 'completed' && snapshot.value.exit_code === 0) {
      const native = await this.nativeReceipt(manifest.value.statePath);
      if (native?.state === 'published' && native.commit === manifest.value.commit
        && await this.verifyPublishedIdentity(manifest.value, native)) {
        return ok({ ...response, state: 'completed', verified_commit: native.commit, native_identity: native.nativeIdentity });
      }
      // A process can crash after no-replace rename but before writing its
      // terminal receipt. A matching commit/HEAD is NOT native ownership proof.
      return ok({ ...response, state: 'unresolved', detail: 'Native publication proof is incomplete' });
    }
    if (state === 'termination_unverified' || state === 'running') {
      return ok({ ...response, state: 'unresolved' });
    }
    const native = await this.nativeReceipt(manifest.value.statePath);
    if (native?.commit === manifest.value.commit && (native.state === 'prepared' || native.state === 'published')) {
      // The native no-replace rename can complete between durable receipt writes.
      // A prepared receipt cannot prove whether publication happened, even when the worker failed.
      return ok({ ...response, state: 'unresolved', detail: 'Native publication may have occurred without a successful contained worker receipt' });
    }
    // A worker can stop without its publication receipt even after a native
    // rename. A destination still present makes a terminal failure ambiguous.
    if (typeof manifest.value.workspaceRoot !== 'string'
      || typeof manifest.value.destination !== 'string'
      || !path.win32.isAbsolute(manifest.value.workspaceRoot)
      || path.win32.isAbsolute(manifest.value.destination)
      || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(manifest.value.destination)) {
      return ok({ ...response, state: 'unresolved', detail: 'Native publication destination is unverified' });
    }
    try {
      await lstat(path.win32.join(manifest.value.workspaceRoot, manifest.value.destination));
      return ok({ ...response, state: 'unresolved', detail: 'Destination exists without a verified native publication receipt' });
    } catch (error: unknown) {
      if (typeof error !== 'object' || error === null || !('code' in error)
        || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return ok({ ...response, state: 'unresolved', detail: 'Native destination could not be inspected' });
      }
    }
    return ok({ ...response, state: state === 'cancelled' ? 'cancelled' : 'failed' });
  }

  async cancel(input: SecureRepositoryImportHandle): Promise<Result<Record<string, unknown>>> {
    const manifest = await this.readOwnedManifest(input);
    if (!manifest.ok) return manifest;
    const cancelled = await this.taskStore.cancel(input.taskId, input.owner);
    if (!cancelled.ok) return cancelled;
    return this.status(input);
  }

  private taskId(requestId: string): string {
    return 'repository-import-' + requestId.toLowerCase();
  }

  private importDirectory(requestId: string): string {
    return path.join(this.root, requestId.toLowerCase());
  }

  private async readOwnedManifest(handle: SecureRepositoryImportHandle): Promise<Result<ImportManifest>> {
    if (!/^repository-import-[0-9a-f-]{36}$/.test(handle.taskId)) {
      return err(appError('INVALID_INPUT', 'Repository import task ID is invalid'));
    }
    const requestId = handle.taskId.slice('repository-import-'.length);
    try {
      const value = JSON.parse(await readFile(path.join(this.importDirectory(requestId), 'spec.json'), 'utf8')) as ImportManifest;
      if (value.version !== 1 || value.requestId !== requestId
        || value.owner.clientId !== handle.owner.clientId
        || value.owner.sessionId !== handle.owner.sessionId
        || value.owner.workspaceId !== handle.owner.workspaceId) {
        return err(appError('PERMISSION_DENIED', 'Repository import belongs to another client, session or workspace'));
      }
      return ok(value);
    } catch {
      return err(appError('PROCESS_NOT_FOUND', 'Repository import task was not found'));
    }
  }

  private async ensureAsset(filename: string, content: string): Promise<boolean> {
    try {
      await writeFile(filename, content, { flag: 'wx', mode: 0o600 });
    } catch (error: unknown) {
      if (!isExists(error)) throw error;
      try {
        if (await readFile(filename, 'utf8') !== content) return false;
      } catch { return false; }
    }
    return true;
  }

  private async verifyPublishedIdentity(manifest: ImportManifest, native: NativeReceipt): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    try {
      // The task's publication receipt is durable history, not proof the live
      // destination still has the originally published NTFS file identity.
      const verifier = path.join(this.importDirectory(manifest.requestId), 'verify-published.ps1');
      if (await readFile(verifier, 'utf8') !== repositoryImportVerifyPublishedScript
        || await readFile(manifest.anchorSourcePath, 'utf8') !== windowsRepositoryImportAnchorSource) return false;
      const windowsRoot = process.env.SystemRoot;
      if (!windowsRoot || !path.win32.isAbsolute(windowsRoot)) return false;
      const powershell = path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const environment: NodeJS.ProcessEnv = {};
      for (const name of ['SystemRoot', 'windir', 'PATH', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP', 'SystemDrive', 'PROCESSOR_ARCHITECTURE']) {
        if (typeof process.env[name] === 'string') environment[name] = process.env[name];
      }
      const result = await execFileAsync(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', verifier,
        manifest.anchorSourcePath, manifest.workspaceRoot, manifest.destination, native.nativeIdentity,
      ], { cwd: this.importDirectory(manifest.requestId), env: environment, windowsHide: true, timeout: process.env.CI ? 90000 : 30000, maxBuffer: 8192 });
      return result.stdout.trim() === 'PUBLISHED_NATIVE_IDENTITY_MATCH';
    } catch { return false; }
  }

  private async nativeReceipt(filename: string): Promise<NativeReceipt | undefined> {
    try {
      const value = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>;
      if (value.version !== 1 || (value.state !== 'prepared' && value.state !== 'published')
        || typeof value.nativeIdentity !== 'string' || !/^[0-9A-F]{16}-[0-9A-F]{32}$/i.test(value.nativeIdentity)
        || typeof value.commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value.commit)) return undefined;
      return value as unknown as NativeReceipt;
    } catch { return undefined; }
  }
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
function isExists(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}
