import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjing/domain';
import type { Checkpoint, Workspace, WorkspaceRepository } from '@lnwjing/workspace';
import { FileService } from './file-service.js';
import { canRecoverEntirelyFromGit } from './checkpoint-git-policy.js';

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; workspace: Workspace }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-checkpoint-mode-')));
  roots.push(root);
  await mkdir(path.join(root, 'src'));
  await run('git', ['init', '-q', root], { timeout: 10_000 });
  await writeFile(path.join(root, 'src', 'tracked.txt'), 'original\n', 'utf8');
  await run('git', ['-C', root, 'add', '--', 'src/tracked.txt'], { timeout: 10_000 });
  await run('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed'], { timeout: 10_000 });
  return { root, workspace: { id: 'ws', displayName: 'Git fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() } };
}

describe('Git-aware automatic checkpoint policy', () => {
  it('only trusts byte-identical committed tracked files; any dirty, untracked or outside path falls back', async () => {
    const { root } = await fixture();
    expect(await canRecoverEntirelyFromGit(root, ['src/tracked.txt'])).toBe(true);
    expect(await canRecoverEntirelyFromGit(root, ['src/tracked.txt', 'src/missing.txt'])).toBe(false);
    expect(await canRecoverEntirelyFromGit(root, ['../outside.txt'])).toBe(false);
    await writeFile(path.join(root, 'src', 'new.txt'), 'new');
    expect(await canRecoverEntirelyFromGit(root, ['src/new.txt'])).toBe(false);
    expect(await canRecoverEntirelyFromGit(root, ['src/tracked.txt', 'src/new.txt'])).toBe(false);
    await writeFile(path.join(root, 'src', 'tracked.txt'), 'changed');
    expect(await canRecoverEntirelyFromGit(root, ['src/tracked.txt'])).toBe(false);
    await writeFile(path.join(root, 'src', 'tracked.txt'), 'original\n');
    expect(await canRecoverEntirelyFromGit(root, ['src/tracked.txt'])).toBe(true);
  });

  it('batches multiple tracked blobs and refuses missing Git objects without a checkpoint bypass', async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, 'src', 'second.txt'), 'second\\n');
    await run('git', ['-C', root, 'add', '--', 'src/second.txt']);
    await run('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'more']);
    expect(await canRecoverEntirelyFromGit(root, ['src/tracked.txt', 'src/second.txt'])).toBe(true);
    const { stdout } = await run('git', ['-C', root, 'rev-parse', 'HEAD:src/tracked.txt']);
    const objectId = stdout.trim();
    await rm(path.join(root, '.git', 'objects', objectId.slice(0, 2), objectId.slice(2)));
    expect(await canRecoverEntirelyFromGit(root, ['src/tracked.txt', 'src/second.txt'])).toBe(false);
  });

  it('defaults to Git-aware when no per-instance provider is configured', async () => {
    const { root, workspace } = await fixture();
    let snapshots = 0;
    const workspaces: WorkspaceRepository = {
      async get(): Promise<Workspace> { return workspace; },
      async list(): Promise<Workspace[]> { return [workspace]; },
      async insert(): Promise<void> {}, async delete(): Promise<void> {},
    };
    const checkpointService = {
      async createForFiles(): Promise<Result<Checkpoint>> {
        snapshots += 1;
        return ok({ id: 'snapshot', workspaceId: workspace.id, createdAt: new Date(0).toISOString(), files: [] });
      },
    };
    const fileService = new FileService(workspaces, undefined, undefined, { checkpointService });
    const actor = { clientId: 'fixture', clientName: 'Fixture' };
    const tracked = await fileService.editFile(actor, workspace.id,
      { path: 'src/tracked.txt', oldText: 'original', newText: 'first' });
    expect(tracked).toMatchObject({ ok: true });
    expect(tracked.ok && ('checkpointId' in tracked.value)).toBe(false);
    expect(snapshots).toBe(0);
    await writeFile(path.join(root, 'src', 'tracked.txt'), 'original\\n');
    await writeFile(path.join(root, 'src', 'untracked.txt'), 'before');
    const untracked = await fileService.editFile(actor, workspace.id,
      { path: 'src/untracked.txt', oldText: 'before', newText: 'after' });
    expect(untracked).toMatchObject({ ok: true, value: { checkpointId: 'snapshot' } });
    expect(snapshots).toBe(1);
  });

  it('honors explicit Standard and skips only Git-recoverable edits in Git-aware mode', async () => {
    const { root, workspace } = await fixture();
    const calls: string[][] = [];
    const repository: WorkspaceRepository = {
      async get(id: string): Promise<Workspace | null> { return id === 'ws' ? workspace : null; },
      async list(): Promise<Workspace[]> { return [workspace]; },
      async insert(): Promise<void> {}, async delete(): Promise<void> {},
    };
    const checkpointService = {
      async createForFiles(_actor: unknown, _id: string, files: readonly string[]): Promise<Result<Checkpoint>> {
        calls.push([...files]);
        return ok({ id: 'checkpoint-' + calls.length, workspaceId: 'ws', createdAt: new Date(0).toISOString(), files: [] });
      },
    };
    const actor = { clientId: 'fixture', clientName: 'Fixture' };
    let mode: 'always' | 'git-aware' = 'always';
    const service = new FileService(repository, undefined, undefined, {
      checkpointService, checkpointModeProvider: (): 'always' | 'git-aware' => mode,
    });
    const standard = await service.editFile(actor, 'ws', { path: 'src/tracked.txt', oldText: 'original', newText: 'first' });
    expect(standard).toMatchObject({ ok: true, value: { checkpointId: 'checkpoint-1' } });
    expect(calls).toHaveLength(1);
    // A dirty tracked file still receives recovery protection in Git-aware mode.
    mode = 'git-aware';
    const dirty = await service.editFile(actor, 'ws', { path: 'src/tracked.txt', oldText: 'first', newText: 'second' });
    expect(dirty).toMatchObject({ ok: true, value: { checkpointId: 'checkpoint-2' } });
    expect(calls).toHaveLength(2);
    await writeFile(path.join(root, 'src', 'tracked.txt'), 'original\n');
    const gitCovered = await service.editFile(actor, 'ws', { path: 'src/tracked.txt', oldText: 'original', newText: 'modified' });
    expect(gitCovered).toMatchObject({ ok: true, value: { bytesWritten: 9 } });
    expect(gitCovered.ok && ('checkpointId' in gitCovered.value)).toBe(false);
    expect(calls).toHaveLength(2);
    expect(await readFile(path.join(root, 'src', 'tracked.txt'), 'utf8')).toBe('modified\n');
  });
});
