import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SearchService, type SearchAdapter } from './search-service.js';
import type { WorkspaceRepository, Workspace } from '@lnwjing/workspace';

describe('SearchService', () => {
  it('resumes ignored source inventory with a glob while denying secrets and generated directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lnwjing-search-inventory-'));
    try {
      await mkdir(path.join(root, 'src'));
      await mkdir(path.join(root, 'node_modules'));
      await writeFile(path.join(root, '.gitignore'), 'ignored.ts\n');
      await writeFile(path.join(root, '.env'), 'SECRET=private\n');
      await writeFile(path.join(root, 'ignored.ts'), 'export const ignored = true;');
      await writeFile(path.join(root, 'src', 'main.ts'), 'export const ok = true;');
      await writeFile(path.join(root, 'node_modules', 'dependency.ts'), 'ignored');
      const realRoot = await realpath(root);
      const workspace: Workspace = { id: 'inventory', displayName: 'fixture', rootPath: realRoot, realRootPath: realRoot, createdAt: new Date(0).toISOString() };
      const repository: WorkspaceRepository = {
        async list(): Promise<Workspace[]> { return [workspace]; },
        async get(): Promise<Workspace | null> { return workspace; },
        async insert(): Promise<void> {},
        async delete(): Promise<void> {},
      };
      const service = new SearchService(repository);
      const actor = { clientId: 'inventory', clientName: 'fixture' };
      const files: string[] = [];
      let cursor;
      do {
        const page = await service.scanFilesPage(actor, workspace.id, { glob: '*.ts' }, 1, cursor);
        expect(page.ok).toBe(true);
        if (!page.ok) return;
        files.push(...page.value.paths);
        cursor = page.value.cursor;
      } while (cursor !== undefined);
      expect(files).toEqual(expect.arrayContaining(['ignored.ts', path.join('src', 'main.ts')]));
      expect(files).toHaveLength(2);
      const subdirectory = await service.scanFilesPage(actor, workspace.id, { path: 'src' }, 1);
      expect(subdirectory).toMatchObject({ ok: true, value: { paths: [path.join('src', 'main.ts')] } });
      const targeted = await service.scanFilesPage(actor, workspace.id, { path: 'src/main.ts', glob: '*.ts' }, 1);
      expect(targeted).toMatchObject({ ok: true, value: { paths: [path.join('src', 'main.ts')] } });
      const rejectedGlob = await service.scanFilesPage(actor, workspace.id, { path: 'src/main.ts', glob: '*.js' }, 1);
      expect(rejectedGlob).toMatchObject({ ok: true, value: { paths: [] } });
      const protectedFile = await service.scanFilesPage(actor, workspace.id, { path: '.env' }, 1);
      expect(protectedFile).toMatchObject({ ok: true, value: { paths: [] } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('filters clean-index inventories using the same secret policy as live search', async () => {
    const workspace: Workspace = {
      id: 'workspace-1', displayName: 'Fixture', rootPath: 'C:\\\\workspace',
      realRootPath: 'C:\\\\workspace', createdAt: new Date(0).toISOString(),
    };
    const repository: WorkspaceRepository = {
      async list() { return [workspace]; },
      async get(id) { return id === workspace.id ? workspace : null; },
      async insert() {},
      async delete() {},
    };
    const service = new SearchService(repository);
    expect(await service.filterSearchPaths(workspace.id, [
      'src\\\\main.ts', '.env', '.env.example', '.aws\\\\credentials', 'private.pem',
    ])).toEqual(['src\\\\main.ts', '.env.example']);
  });

  it('resolves the workspace before delegating a bounded text search', async () => {
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: 'C:\\workspace', realRootPath: 'C:\\workspace', createdAt: new Date(0).toISOString() };
    let receivedRoot = '';
    let receivedRegex: boolean | undefined;
    const adapter: SearchAdapter = {
      async searchText(request) { receivedRoot = request.rootPath; receivedRegex = request.regex; return { ok: true, value: { matches: [], truncated: false } }; },
      async searchFiles() { return { ok: true, value: { paths: [], truncated: false } }; },
    };
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return [workspace]; },
      async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    };

    const result = await new SearchService(repository, adapter).searchText(
      { clientId: 'test', clientName: 'test' },
      workspace.id,
      { query: 'needle', regex: true, maxResults: 200 },
    );

    expect(result).toEqual({ ok: true, value: { matches: [], truncated: false } });
    expect(receivedRoot).toBe(workspace.realRootPath);
    expect(receivedRegex).toBe(true);
  });

  it('uses the parent directory as ripgrep cwd when text search path is a file', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lnwjing-search-file-'));
    try {
      const filePath = path.join(workspaceRoot, 'fixture.ts');
      await writeFile(filePath, 'needle', 'utf8');
      const canonicalRoot = await realpath(workspaceRoot);
      const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: workspaceRoot, realRootPath: canonicalRoot, createdAt: new Date(0).toISOString() };
      let receivedRoot = '';
      let receivedTarget: string | undefined;
      const adapter: SearchAdapter = {
        async searchText(request) {
          receivedRoot = request.rootPath;
          receivedTarget = request.targetPath;
          return { ok: true, value: { matches: [], truncated: false } };
        },
        async searchFiles() { return { ok: true, value: { paths: [], truncated: false } }; },
      };
      const repository: WorkspaceRepository = {
        async list(): Promise<Workspace[]> { return [workspace]; },
        async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
        async insert(): Promise<void> {},
        async delete(): Promise<void> {},
      };

      const result = await new SearchService(repository, adapter).searchText(
        { clientId: 'test', clientName: 'test' },
        workspace.id,
        { query: 'needle', path: filePath, discovery: 'explicit' },
      );

      expect(result).toEqual({ ok: true, value: { matches: [], truncated: false } });
      expect(receivedRoot).toBe(canonicalRoot);
      expect(receivedTarget).toBe('fixture.ts');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('passes automatic versus explicit discovery through to the search adapter', async () => {
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: 'C:\\workspace', realRootPath: 'C:\\workspace', createdAt: new Date(0).toISOString() };
    const discoveryModes: string[] = [];
    const adapter: SearchAdapter = {
      async searchText(request) { discoveryModes.push(request.discovery ?? 'automatic'); return { ok: true, value: { matches: [], truncated: false } }; },
      async searchFiles(request) { discoveryModes.push(request.discovery ?? 'automatic'); return { ok: true, value: { paths: [], truncated: false } }; },
    };
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return [workspace]; },
      async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    };
    const service = new SearchService(repository, adapter);

    await service.searchText({ clientId: 'test', clientName: 'test' }, workspace.id, { query: 'needle' });
    await service.searchFiles({ clientId: 'test', clientName: 'test' }, workspace.id, { discovery: 'explicit' });

    expect(discoveryModes).toEqual(['automatic', 'explicit']);
  });

  it('forwards the MCP invocation abort signal to process-backed text search', async () => {
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: 'C:\\workspace', realRootPath: 'C:\\workspace', createdAt: new Date(0).toISOString() };
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return [workspace]; },
      async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    };
    const adapter: SearchAdapter = {
      async searchText(request) { return { ok: true, value: { matches: [], truncated: request.signal?.aborted === true } }; },
      async searchFiles() { return { ok: true, value: { paths: [], truncated: false } }; },
    };
    const controller = new AbortController();
    controller.abort();

    await expect(new SearchService(repository, adapter).searchText(
      { clientId: 'test', clientName: 'test' },
      workspace.id,
      { query: 'needle' },
      controller.signal,
    )).resolves.toEqual({ ok: true, value: { matches: [], truncated: true } });
  });

  it('uses an explicit external absolute path as the ripgrep root under Full Bypass', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lnwjing-search-workspace-'));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'lnwjing-search-outside-'));
    try {
      const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: workspaceRoot, realRootPath: workspaceRoot, createdAt: new Date(0).toISOString() };
      let receivedRoot = '';
      const adapter: SearchAdapter = {
        async searchText(request) { receivedRoot = request.rootPath; return { ok: true, value: { matches: [], truncated: false } }; },
        async searchFiles() { return { ok: true, value: { paths: [], truncated: false } }; },
      };
      const repository: WorkspaceRepository = {
        async list(): Promise<Workspace[]> { return [workspace]; },
        async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
        async insert(): Promise<void> {},
        async delete(): Promise<void> {},
      };
      const authorization = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;
      const service = new SearchService(repository, adapter);
      await expect(service.searchText(
        { clientId: 'test', clientName: 'test' },
        workspace.id,
        { query: 'needle', path: outsideRoot, discovery: 'explicit' },
      )).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });

      const result = await service.searchText(
        { clientId: 'test', clientName: 'test' },
        undefined,
        { query: 'needle', path: outsideRoot, discovery: 'explicit' },
        undefined,
        authorization,
      );

      expect(result).toEqual({ ok: true, value: { matches: [], truncated: false } });
      expect(receivedRoot).toBe(await realpath(outsideRoot));
    } finally {
      await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(outsideRoot, { recursive: true, force: true })]);
    }
  });

  it('rejects an oversized result limit at the application boundary', async () => {
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return []; },
      async get(): Promise<Workspace | null> { return null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    };
    const adapter: SearchAdapter = {
      async searchText() { return { ok: true, value: { matches: [], truncated: false } }; },
      async searchFiles() { return { ok: true, value: { paths: [], truncated: false } }; },
    };

    const result = await new SearchService(repository, adapter).searchText(
      { clientId: 'test', clientName: 'test' },
      'workspace-1',
      { query: 'needle', maxResults: 501 },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
