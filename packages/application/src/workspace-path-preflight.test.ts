import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preflightWorkspacePath } from './workspace-path-preflight.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('read-only exact-target workspace path preflight', () => {
  it('requires explicit authorization for an unregistered path', async () => {
    expect(await preflightWorkspacePath(path.resolve(os.tmpdir()), false)).toMatchObject({
      ok: false, error: { code: 'PERMISSION_REQUIRED' },
    });
  });

  it('returns directory/file kind, canonical existing path without mutating either', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-path-probe-')));
    roots.push(root);
    const folder = path.join(root, 'project');
    await mkdir(folder);
    const file = path.join(folder, 'note.txt');
    await writeFile(file, 'before');
    const dir = await preflightWorkspacePath(folder, true);
    const target = await preflightWorkspacePath(file, true);
    expect(dir).toMatchObject({ ok: true, value: { exists: true, kind: 'directory', canonicalPath: folder, pathScope: 'exact_target' } });
    if (dir.ok) {
      expect(Number.isFinite(Date.parse(dir.value.checkedAt))).toBe(true);
      expect(dir.value.checkedIdentity.length).toBeGreaterThan(0);
      expect(dir.value.limitations).toHaveLength(1);
    }
    expect(target).toMatchObject({ ok: true, value: { exists: true, kind: 'file', canonicalPath: file } });
    if (process.platform === 'win32') {
      expect(dir).toMatchObject({ value: { status: 'UNVERIFIABLE', effectiveAccess: 'UNKNOWN', reparseChain: 'UNKNOWN' } });
    } else {
      expect(dir).toMatchObject({ value: { status: 'VERIFIED', reparseChain: 'CLEAR' } });
    }
    await expect(readFile(file, 'utf8')).resolves.toBe('before');
  });

  it('reports a missing exact target without inventing a canonical target', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-path-missing-')));
    roots.push(root);
    const result = await preflightWorkspacePath(path.join(root, 'not-registered'), true);
    expect(result).toMatchObject({ ok: true, value: { status: 'NOT_FOUND', exists: false, kind: 'missing' } });
    if (!result.ok) throw new Error('unexpected error');
    expect(result.value).not.toHaveProperty('canonicalPath');
  });

  it('rejects symlinked ancestry without following or listing it', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjing-path-link-')));
    roots.push(root);
    const folder = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    await mkdir(folder);
    try {
      await symlink(folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const result = await preflightWorkspacePath(path.join(alias, 'inside.txt'), true);
    expect(result).toMatchObject({ ok: true, value: { status: 'CONFLICT', reparseChain: 'CONFLICT' } });
  });

  it('rejects relative paths and never registers a workspace', async () => {
    expect(await preflightWorkspacePath('relative/path', true)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
