import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appError, err, type Result } from '@lnwjing/domain';
import { AtomicFileWriter, type AtomicWriteOptions } from '@lnwjing/filesystem';
import { permissionProfiles, type PermissionProfile, type PermissionProfileName } from '@lnwjing/permissions';
import type { Checkpoint, CheckpointRepository, Workspace, WorkspaceRepository } from '@lnwjing/workspace';
import { CheckpointService } from './checkpoint-service.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ workspace: Workspace; checkpoints: MemoryCheckpointRepository }> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-checkpoint-'));
  temporaryRoots.push(rawRoot);
  const root = await realpath(rawRoot);
  await mkdir(path.join(root, 'src'));
  const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
  return { workspace, checkpoints: new MemoryCheckpointRepository() };
}

function workspaces(workspace: Workspace): WorkspaceRepository {
  return { async list(): Promise<Workspace[]> { return [workspace]; }, async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; }, async insert(): Promise<void> {}, async delete(): Promise<void> {} };
}

class MemoryCheckpointRepository implements CheckpointRepository {
  private readonly checkpoints: Checkpoint[] = [];
  public async insert(value: Checkpoint): Promise<void> { this.checkpoints.push(value); }
  public async get(id: string): Promise<Checkpoint | null> { return this.checkpoints.find((entry) => entry.id === id) ?? null; }
  public async list(workspaceId: string, limit = 100): Promise<Checkpoint[]> {
    return this.checkpoints.filter((entry) => entry.workspaceId === workspaceId).slice(0, limit);
  }
}

describe('CheckpointService', () => {
  it('captures and restores file content through the workspace guard', async () => {
    const { workspace, checkpoints } = await setup();
    const target = path.join(workspace.rootPath, 'src', 'file.txt');
    await writeFile(target, 'before', 'utf8');
    const service = new CheckpointService(workspaces(workspace), checkpoints);
    const actor = { clientId: 'client-1', clientName: 'test' };

    const created = await service.createForFiles(actor, workspace.id, [path.join('src', 'file.txt')]);
    await writeFile(target, 'after', 'utf8');
    if (!created.ok) throw new Error('checkpoint creation failed');
    const restored = await service.restore(actor, workspace.id, created.value.id, { profile: permissionProfiles.full, userConfirmed: true });

    expect(restored).toMatchObject({ ok: true, value: { restoredPaths: [path.join('src', 'file.txt')], rollbackCheckpointId: expect.any(String) } });
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
    if (!restored.ok || restored.value.rollbackCheckpointId === undefined) throw new Error('rollback checkpoint missing');
    await expect(service.restore(actor, workspace.id, restored.value.rollbackCheckpointId, { profile: permissionProfiles.full, userConfirmed: true }))
      .resolves.toMatchObject({ ok: true });
    await expect(readFile(target, 'utf8')).resolves.toBe('after');
  });

  it('rolls back earlier restored files when a later checkpoint write fails', async () => {
    const { workspace, checkpoints } = await setup();
    const first = path.join(workspace.rootPath, 'src', 'first.txt');
    const second = path.join(workspace.rootPath, 'src', 'second.txt');
    await writeFile(first, 'checkpoint-first', 'utf8');
    await writeFile(second, 'checkpoint-second', 'utf8');
    const actor = { clientId: 'client-1', clientName: 'test' };
    const creator = new CheckpointService(workspaces(workspace), checkpoints);
    const created = await creator.createForFiles(actor, workspace.id, [path.join('src', 'first.txt'), path.join('src', 'second.txt')]);
    if (!created.ok) throw new Error('checkpoint creation failed');
    await writeFile(first, 'live-first', 'utf8');
    await writeFile(second, 'live-second', 'utf8');

    class FailSecondWriter extends AtomicFileWriter {
      private writes = 0;
      public override async write(filePath: string, content: string | Buffer, options: AtomicWriteOptions = {}): Promise<Result<void>> {
        this.writes += 1;
        if (this.writes === 2) return err(appError('INTERNAL_ERROR', 'injected checkpoint restore failure', true));
        return super.write(filePath, content, options);
      }
    }

    const restorer = new CheckpointService(workspaces(workspace), checkpoints, { writer: new FailSecondWriter() });
    const result = await restorer.restore(actor, workspace.id, created.value.id, { profile: permissionProfiles.full, userConfirmed: true });

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await expect(readFile(first, 'utf8')).resolves.toBe('live-first');
    await expect(readFile(second, 'utf8')).resolves.toBe('live-second');
  });

  it('lists recovery-safe checkpoint metadata without returning file content', async () => {
    const { workspace, checkpoints } = await setup();
    const target = path.join(workspace.rootPath, 'src', 'file.txt');
    await writeFile(target, 'secret-before-content', 'utf8');
    const service = new CheckpointService(workspaces(workspace), checkpoints);
    const actor = { clientId: 'client-1', clientName: 'test' };
    const created = await service.createForFiles(actor, workspace.id, [path.join('src', 'file.txt')]);
    if (!created.ok) throw new Error('checkpoint creation failed');

    const listed = await service.list(workspace.id);

    expect(listed).toMatchObject({ ok: true, value: [{
      id: created.value.id,
      workspaceId: workspace.id,
      files: [{ path: path.join('src', 'file.txt'), size: Buffer.byteLength('secret-before-content'), contentSha256: expect.any(String) }],
    }] });
    expect(JSON.stringify(listed)).not.toContain('secret-before-content');
  });

  it('caches only recovery metadata until checkpoint revision or connection identity changes', async () => {
    const { workspace } = await setup();
    class VersionedCheckpoints extends MemoryCheckpointRepository {
      public generation: object = {};
      public version = 0;
      public revisionSnapshot(): { readonly connectionIdentity: object; readonly revision: number } {
        return { connectionIdentity: this.generation, revision: this.version };
      }
      public override async insert(value: Checkpoint): Promise<void> {
        await super.insert(value);
        this.version += 1;
      }
    }
    const checkpoints = new VersionedCheckpoints();
    const makeCheckpoint = (id: string): Checkpoint => ({
      id, workspaceId: workspace.id, createdAt: new Date(0).toISOString(),
      files: [{ path: 'src/file.txt', content: 'private payload', contentSha256: 'hash', size: 15 }],
    });
    await checkpoints.insert(makeCheckpoint('first'));
    const fetch = vi.spyOn(checkpoints, 'list');
    const service = new CheckpointService(workspaces(workspace), checkpoints);
    const first = await service.list(workspace.id);
    expect(first).toMatchObject({ ok: true, value: [{ id: 'first' }] });
    expect(JSON.stringify(first)).not.toContain('private payload');
    if (first.ok && first.value[0]) {
      (first.value[0] as { id: string }).id = 'caller-mutation';
      const firstFile = first.value[0].files[0];
      if (firstFile) (firstFile as { path: string }).path = 'caller-mutated-path';
    }
    const secondRead = await service.list(workspace.id);
    expect(secondRead).toMatchObject({ ok: true, value: [{ id: 'first', files: [{ path: 'src/file.txt' }] }] });
    await service.list(workspace.id);
    expect(fetch).toHaveBeenCalledTimes(1);

    await checkpoints.insert(makeCheckpoint('second'));
    expect(await service.list(workspace.id)).toMatchObject({ ok: true, value: [{ id: 'first' }, { id: 'second' }] });
    expect(fetch).toHaveBeenCalledTimes(2);
    checkpoints.generation = {};
    await service.list(workspace.id);
    expect(fetch).toHaveBeenCalledTimes(3);
    await service.list(workspace.id, 1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('uses the current permission profile when restoring without an explicit override', async () => {
    const { workspace, checkpoints } = await setup();
    const target = path.join(workspace.rootPath, 'src', 'profile.txt');
    await writeFile(target, 'before', 'utf8');
    let profileName: PermissionProfileName = 'safe';
    const service = new CheckpointService(workspaces(workspace), checkpoints, {
      profileProvider: (): PermissionProfile => permissionProfiles[profileName],
    });
    const actor = { clientId: 'client-1', clientName: 'test' };
    const created = await service.createForFiles(actor, workspace.id, [path.join('src', 'profile.txt')]);
    if (!created.ok) throw new Error('checkpoint creation failed');
    await writeFile(target, 'after', 'utf8');

    await expect(service.restore(actor, workspace.id, created.value.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_REQUIRED' },
    });
    profileName = 'balanced';
    await expect(service.restore(actor, workspace.id, created.value.id, { userConfirmed: true })).resolves.toMatchObject({ ok: true });
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
  });

  it('rejects a checkpoint path that no longer resolves inside the workspace', async () => {
    const { workspace, checkpoints } = await setup();
    await checkpoints.insert({ id: 'checkpoint-1', workspaceId: workspace.id, createdAt: new Date(0).toISOString(), files: [{ path: path.join('..', 'outside.txt'), content: 'secret', contentSha256: 'hash', size: 6 }] });
    const result = await new CheckpointService(workspaces(workspace), checkpoints).restore(
      { clientId: 'client-1', clientName: 'test' }, workspace.id, 'checkpoint-1', { profile: permissionProfiles.full, userConfirmed: true },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });
});
