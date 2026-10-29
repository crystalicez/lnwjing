import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SearchService, type SearchAdapter } from './search-service.js';
import type { WorkspaceRepository, Workspace } from '@lnwjing/workspace';

describe('SearchService', () => {
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
