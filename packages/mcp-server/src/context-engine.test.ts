import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@lnwjing/domain';
import type { McpApplicationServices } from './tools/tool-types.js';
import { ContextEngine, type ScanContinuation, type WorkspaceContextRequest } from './context-engine.js';
import { ContinuationStore } from './continuation-store.js';
import { workspaceFullScanSchema } from './tools/schemas.js';

const actor = { clientId: 'context-test', clientName: 'context-test' };

function services(): McpApplicationServices {
  return {
    workspaceInfo: {
      async list(): Promise<ReturnType<typeof ok>> {
        return ok([{ id: 'workspace-1' }, { id: 'workspace-2' }]);
      },
    },
    search: {
      async searchText(_actor, workspaceId, request): Promise<ReturnType<typeof ok>> {
        void request;
        return ok({
          matches: workspaceId === 'workspace-1'
            ? [
              { path: 'src/auth/login.ts', line: 4, text: 'export function login() {}' },
              { path: '.env', line: 1, text: 'LOGIN_SECRET=present' },
              { path: 'node_modules/pkg/index.js', line: 1, text: 'login dependency' },
            ]
            : [{ path: 'dist/login.js', line: 1, text: 'login build' }],
          truncated: false,
        });
      },
      async searchFiles(_actor, workspaceId): Promise<ReturnType<typeof ok>> {
        return ok({
          paths: workspaceId === 'workspace-1'
            ? ['src/auth/login.ts', '.env', '.git/config', 'node_modules/pkg/index.js']
            : ['dist/login.js'],
          truncated: false,
        });
      },
    },
    file: {
      async readFile(_actor, workspaceId, request): Promise<ReturnType<typeof ok>> {
        return ok({
          path: request.path,
          content: `export function ${request.path.replace(/[^a-z]/gi, '')}() {}\nLOGIN_SECRET=present`,
          startLine: 1,
          endLine: 2,
          encoding: 'utf8' as const,
          ...(workspaceId === undefined ? {} : { byteLength: 64 }),
        });
      },
    },
    git: {
      async status(): Promise<ReturnType<typeof ok>> {
        return ok({ entries: [{ path: 'src/auth/login.ts', index: 'M', worktree: ' ' }] });
      },
    },
  };
}

describe('context engine', () => {
  it('scans multiple workspaces serially instead of contending for the one disk lease', async () => {
    let active = 0;
    let peak = 0;
    const scanFiles = vi.fn().mockImplementation(async (_actor, workspaceId: string): Promise<ReturnType<typeof ok>> => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
      return ok({ paths: [`${workspaceId}.ts`], truncated: false });
    });
    const engine = new ContextEngine({
      workspaceInfo: { list: async (): Promise<ReturnType<typeof ok>> => ok([{ id: 'a' }, { id: 'b' }, { id: 'c' }]) },
      search: { scanFiles, searchFiles: vi.fn(), searchText: vi.fn() },
    }, actor);
    const result = await engine.fullScan({ pageSize: 10 });
    expect(result).toMatchObject({ ok: true, value: {
      scannedWorkspaces: 3, searchTruncated: false, hasMore: false, completeness: 'complete',
    } });
    if (result.ok) expect(result.value.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(peak).toBe(1);
    expect(scanFiles).toHaveBeenCalledTimes(3);
  });

  it('defaults full scans to automatic filtering and preserves explicit opt-in', async () => {
    expect(workspaceFullScanSchema.parse({}).includeIgnored).toBe(false);
    const searchFiles = vi.fn().mockResolvedValue(ok({ paths: ['src/index.ts'], truncated: false }));
    const engine = new ContextEngine({ search: { searchFiles } }, actor);
    expect((await engine.fullScan({ workspaceId: 'workspace-1' })).ok).toBe(true);
    expect(searchFiles).toHaveBeenLastCalledWith(actor, 'workspace-1', expect.objectContaining({ discovery: 'automatic' }));
    expect((await engine.fullScan({ workspaceId: 'workspace-1', includeIgnored: true })).ok).toBe(true);
    expect(searchFiles).toHaveBeenLastCalledWith(actor, 'workspace-1', expect.objectContaining({ discovery: 'explicit' }));
  });


  it('uses exhaustive discovery when the requested context mode is exhaustive', async () => {
    const searchText = vi.fn().mockResolvedValue(ok({ matches: [], truncated: false }));
    const searchFiles = vi.fn().mockResolvedValue(ok({ paths: [], truncated: false }));
    const engine = new ContextEngine({ search: { searchText, searchFiles } }, actor);
    await engine.collect({ workspaceId: 'workspace-1', query: 'needle', mode: 'exhaustive' });
    expect(searchText).toHaveBeenCalledWith(actor, 'workspace-1', expect.objectContaining({ discovery: 'explicit' }));
    expect(searchFiles).toHaveBeenCalledWith(actor, 'workspace-1', expect.objectContaining({ discovery: 'explicit' }));
  });

  it('deduplicates Windows dot and separator aliases while retaining the original path and text', async () => {
    const base = services();
    const readFile = vi.fn().mockImplementation(async (_actor, _workspaceId, request) => ok({ path: request.path, content: '  ไทย 😀\tneedle  \n', startLine: 1, endLine: 2, encoding: 'utf8' }));
    const engine = new ContextEngine({ ...base, platform: 'win32', file: { readFile }, search: {
      searchText: vi.fn().mockResolvedValue(ok({ matches: [{ path: '.\\ไทย😀.ts', line: 1, text: '  ไทย 😀\tneedle  ' }], truncated: false })),
      searchFiles: vi.fn().mockResolvedValue(ok({ paths: ['ไทย😀.ts', '.\\ไทย😀.ts'], truncated: false })),
    }, git: { status: vi.fn().mockResolvedValue(ok({ entries: [] })) } }, actor);
    const result = await engine.collect({ query: 'needle', workspaceId: 'workspace-1', mode: 'exhaustive' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toHaveLength(1);
    expect(result.value.files[0]?.path).toBe('.\\ไทย😀.ts');
    expect(result.value.matches[0]?.text).toBe('  ไทย 😀\tneedle  ');
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('preserves distinct POSIX case and backslash filenames and the original Git path', async () => {
    const base = services();
    const engine = new ContextEngine({ ...base, platform: 'linux', search: {
      searchText: vi.fn().mockResolvedValue(ok({ matches: [], truncated: false })),
      searchFiles: vi.fn().mockResolvedValue(ok({ paths: ['src/A.ts', 'src/a.ts', 'src\\A.ts'], truncated: false })),
    }, git: { status: vi.fn().mockResolvedValue(ok({ entries: [{ path: 'OnlyGitUpper.ts', index: 'M', worktree: ' ' }] })) } }, actor);
    const result = await engine.collect({ query: 'needle', workspaceId: 'workspace-1', mode: 'exhaustive' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.map((file) => file.path)).toEqual(expect.arrayContaining(['src/A.ts', 'src/a.ts', 'src\\A.ts', 'OnlyGitUpper.ts']));
    expect(result.value.files).toHaveLength(4);
  });

  it('retains partial source observations through pages and does not invent a page for truncated searches', async () => {
    const base = services();
    const engine = new ContextEngine({ ...base, search: {
      searchText: vi.fn().mockResolvedValue(err({ code: 'PROCESS_TIMEOUT', message: 'private-provider-secret', recoverable: true })),
      searchFiles: vi.fn().mockResolvedValue(ok({ paths: ['one.ts', 'two.ts'], truncated: true })),
    }, git: { status: vi.fn().mockResolvedValue(ok({ entries: [] })) } }, actor);
    const first = await engine.collect({ query: 'needle', workspaceId: 'workspace-1', pageSize: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;
    expect(first.value).toMatchObject({ completeness: 'partial', searchTruncated: true, observations: expect.arrayContaining([
      { workspaceId: 'workspace-1', source: 'text_search', state: 'unavailable', error: { code: 'PROCESS_TIMEOUT' } },
      { workspaceId: 'workspace-1', source: 'file_search', state: 'truncated', observedItems: 2 },
    ]) });
    const next = await engine.continue(first.value.continuationToken, 1);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value).toMatchObject({ completeness: 'partial', searchTruncated: true, hasMore: false });
    expect(next.value.continuationToken).toBeUndefined();
    expect(JSON.stringify([first, next])).not.toContain('private-provider-secret');
  });

  it('distinguishes unknown or unavailable searches from a successful empty search across workspaces', async () => {
    const base = services();
    const engine = new ContextEngine({ ...base, search: {
      searchText: vi.fn().mockImplementation(async (_actor, workspaceId) => workspaceId === 'workspace-1' ? ok({ matches: [], truncated: false }) : { ok: true, value: { matches: null, truncated: false } }),
      searchFiles: vi.fn().mockImplementation(async (_actor, workspaceId) => workspaceId === 'workspace-1' ? ok({ paths: ['one.ts'], truncated: false }) : err({ code: 'EXECUTABLE_NOT_FOUND', message: 'secret-error', recoverable: true })),
    }, git: { status: vi.fn().mockResolvedValue(ok({ entries: [] })) } }, actor);
    const result = await engine.collect({ query: 'needle' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ completeness: 'partial', hasMore: false, observations: expect.arrayContaining([
      { workspaceId: 'workspace-2', source: 'text_search', state: 'unknown', error: { code: 'INTERNAL_ERROR' } },
      { workspaceId: 'workspace-2', source: 'file_search', state: 'unavailable', error: { code: 'EXECUTABLE_NOT_FOUND' } },
    ]) });
    const absent = await new ContextEngine({ file: base.file }, actor).collect({ query: 'needle', workspaceId: 'workspace-1' });
    expect(absent).toMatchObject({ ok: true, value: { files: [], completeness: 'unavailable', hasMore: false } });
  });

  it('retains complete scan pages with partial provider evidence and no empty truncation continuation', async () => {
    const engine = new ContextEngine({ ...services(), search: {
      searchFiles: vi.fn().mockImplementation(async (_actor, workspaceId) => workspaceId === 'workspace-1' ? ok({ paths: ['one.ts', './one.ts', 'two.ts'], truncated: true }) : Promise.reject(new Error('private-scan-secret'))),
    } }, actor);
    const first = await engine.fullScan({ pageSize: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;
    expect(first.value).toMatchObject({ scannedFiles: 2, scannedWorkspaces: 1, completeness: 'partial', searchTruncated: true });
    const next = await engine.continueFullScan(first.value.continuationToken, 10);
    expect(next).toMatchObject({ ok: true, value: { hasMore: false, searchTruncated: true, completeness: 'partial' } });
    if (next.ok) expect(next.value.continuationToken).toBeUndefined();
    expect(JSON.stringify([first, next])).not.toContain('private-scan-secret');
  });

  it('keeps independent snapshot data and sanitizes provider read errors and malformed values', async () => {
    const base = services();
    const engine = new ContextEngine({ ...base, workspaceInfo: { info: vi.fn().mockRejectedValue(new Error('private-snapshot-secret')) }, projectSnapshot: {
      snapshot: vi.fn().mockResolvedValue(ok({ name: 'ไทย 😀', opaque: { whitespace: '  unchanged\t' } })),
    }, file: { readFile: vi.fn().mockImplementation(async (_actor, _workspaceId, request) => request.path === 'invalid.ts' ? ok({ content: null }) : err({ code: 'PERMISSION_DENIED', message: 'private-read-secret', recoverable: false })) } }, actor);
    const snapshot = await engine.snapshot('workspace-1');
    expect(snapshot).toMatchObject({ ok: true, value: { project: { name: 'ไทย 😀', opaque: { whitespace: '  unchanged\t' } }, completeness: 'partial' } });
    const many = await engine.readMany({ workspaceId: 'workspace-1', files: [{ path: 'denied.ts' }, { path: 'invalid.ts' }] });
    expect(many).toMatchObject({ ok: true, value: { failedFiles: 2, completeness: 'unknown' } });
    expect(JSON.stringify([snapshot, many])).not.toMatch(/private-(read|snapshot)-secret/);
  });

  it('reports source failures for searchAll without reporting an unknown failure as more results', async () => {
    const engine = new ContextEngine({ ...services(), search: {
      searchText: vi.fn().mockRejectedValue(new Error('private-search-secret')),
      searchFiles: vi.fn().mockResolvedValue(err({ code: 'EXECUTABLE_NOT_FOUND', message: 'private-path-secret', recoverable: true })),
    } }, actor);
    const result = await engine.searchAll({ query: 'needle', workspaceId: 'workspace-1' });
    expect(result).toMatchObject({ ok: true, value: { matches: [], paths: [], scannedWorkspaces: 0, hasMore: false, completeness: 'unknown', observations: [
      { workspaceId: 'workspace-1', source: 'text_search', state: 'unknown', error: { code: 'INTERNAL_ERROR' } },
      { workspaceId: 'workspace-1', source: 'file_search', state: 'unavailable', error: { code: 'EXECUTABLE_NOT_FOUND' } },
    ] } });
    expect(JSON.stringify(result)).not.toContain('private-');
  });

  it('sanitizes failed context reads and keeps their observation in the next page', async () => {
    const engine = new ContextEngine({ ...services(), search: {
      searchText: vi.fn().mockResolvedValue(ok({ matches: [], truncated: false })),
      searchFiles: vi.fn().mockResolvedValue(ok({ paths: ['a.ts', 'b.ts'], truncated: false })),
    }, file: { readFile: vi.fn().mockResolvedValue(err({ code: 'PERMISSION_DENIED', message: 'private-read-provider-secret', recoverable: false })) } }, actor);
    const first = await engine.collect({ query: 'needle', workspaceId: 'workspace-1', pageSize: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;
    expect(first.value.files[0]).toMatchObject({ readState: 'unavailable', snippets: [], error: { code: 'PERMISSION_DENIED', message: 'File read failed' } });
    const next = await engine.continue(first.value.continuationToken);
    expect(next).toMatchObject({ ok: true, value: { completeness: 'partial', observations: expect.arrayContaining([
      { workspaceId: 'workspace-1', source: 'file_read', path: first.value.files[0]?.path, state: 'unavailable', error: { code: 'PERMISSION_DENIED' } },
    ]) } });
    expect(JSON.stringify([first, next])).not.toContain('private-read-provider-secret');
  });

  it('does not create a continuation when truncation leaves no buffered candidates', async () => {
    const engine = new ContextEngine({ ...services(), search: {
      searchText: vi.fn().mockResolvedValue(ok({ matches: [], truncated: true })),
      searchFiles: vi.fn().mockResolvedValue(ok({ paths: [], truncated: true })),
    } }, actor);
    const collect = await engine.collect({ query: 'needle', workspaceId: 'workspace-1' });
    const scan = await engine.fullScan({ workspaceId: 'workspace-1' });
    for (const result of [collect, scan]) {
      expect(result).toMatchObject({ ok: true, value: { completeness: 'partial', hasMore: false, searchTruncated: true } });
      if (result.ok) expect(result.value.continuationToken).toBeUndefined();
    }
  });

  it('uses normalized Windows prefixes only for fresh index scans and preserves original case', async () => {
    const status = vi.fn().mockResolvedValue(ok({ freshness: 'watching_clean', snapshot: { entries: [
      { kind: 'file', relativePath: 'Src/Upper.ts' }, { kind: 'file', relativePath: 'elsewhere.ts' },
    ] } }));
    const searchFiles = vi.fn().mockResolvedValue(ok({ paths: ['fallback.ts'], truncated: false }));
    const engine = new ContextEngine({ platform: 'win32', workspaceIndex: { status }, search: { searchFiles } }, actor);
    const indexed = await engine.fullScan({ workspaceId: 'workspace-1', path: '.\\SRC', includeIgnored: false });
    expect(indexed).toMatchObject({ ok: true, value: { completeness: 'complete', files: [{ path: 'Src/Upper.ts' }], observations: [{ source: 'index', state: 'complete' }] } });
    expect(searchFiles).not.toHaveBeenCalled();
    status.mockResolvedValueOnce(ok({ freshness: 'unverified', snapshot: { entries: [{ kind: 'file', relativePath: 'stale.ts' }] } }));
    const stale = await engine.fullScan({ workspaceId: 'workspace-1', includeIgnored: false });
    expect(stale).toMatchObject({ ok: true, value: { completeness: 'complete', files: [{ path: 'fallback.ts' }] } });
    await engine.fullScan({ workspaceId: 'workspace-1', glob: '*.ts', includeIgnored: false });
    expect(searchFiles).toHaveBeenCalledTimes(2);
    expect(searchFiles).toHaveBeenLastCalledWith(actor, 'workspace-1', expect.objectContaining({ glob: '*.ts' }));
    await engine.fullScan({ workspaceId: 'workspace-1', path: 'C:\\Workspace\\Src', includeIgnored: false });
    await engine.fullScan({ workspaceId: 'workspace-1', path: '..\\Outside', includeIgnored: false });
    expect(searchFiles).toHaveBeenCalledTimes(4);
    expect(searchFiles).toHaveBeenLastCalledWith(actor, 'workspace-1', expect.objectContaining({ path: '..\\Outside' }));
  });

  it('falls back to actual filename search after an index provider throws', async () => {
    const engine = new ContextEngine({ workspaceIndex: { status: vi.fn().mockRejectedValue(new Error('private-index-secret')) }, search: {
      searchFiles: vi.fn().mockResolvedValue(ok({ paths: ['fresh.ts'], truncated: false })),
    } }, actor);
    expect(await engine.fullScan({ workspaceId: 'workspace-1', includeIgnored: false })).toMatchObject({ ok: true, value: { completeness: 'complete', files: [{ path: 'fresh.ts' }] } });
  });

  it('preserves method receivers and rejects malformed workspace discovery with a stable error', async () => {
    const workspaceInfo = { ids: ['workspace-1'], async list(): Promise<ReturnType<typeof ok<Array<{ id: string }>>>> { return ok(this.ids.map((id) => ({ id }))); } };
    const engine = new ContextEngine({ ...services(), workspaceInfo }, actor);
    expect((await engine.searchAll({ query: 'needle' })).ok).toBe(true);
    const malformed = new ContextEngine({ workspaceInfo: { list: vi.fn().mockResolvedValue(ok([{ id: 'workspace-1' }, { wrong: 'private-list-secret' }])) } }, actor);
    expect(await malformed.collect({ query: 'needle' })).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Workspace listing failed', recoverable: true } });
  });

  it('keeps valid opaque snapshot keys and successful file metadata without rewriting them', async () => {
    const project = JSON.parse('{"name":"ไทย 😀","__proto__":{"custom":"  preserved\\t"},"constructor":"original"}');
    const file = JSON.parse('{"path":"ไทย😀.ts","content":"  original\\t\\r\\n","startLine":1,"endLine":2,"encoding":"utf8","custom":{"opaque":"  kept\\t"},"__proto__":{"custom":"unchanged"}}');
    const engine = new ContextEngine({
      workspaceInfo: { info: vi.fn().mockResolvedValue(ok({ id: 'workspace-1' })) },
      projectSnapshot: { snapshot: vi.fn().mockResolvedValue(ok(project)) },
      file: { readFile: vi.fn().mockResolvedValue(ok(file)) },
    }, actor);
    const snapshot = await engine.snapshot('workspace-1');
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.project).toEqual(project);
      expect(Object.hasOwn(snapshot.value.project ?? {}, '__proto__')).toBe(true);
    }
    const reads = await engine.readMany({ workspaceId: 'workspace-1', files: [{ path: file.path }] });
    expect(reads).toMatchObject({ ok: true, value: { completeness: 'complete', files: [{ result: file }] } });
    if (reads.ok) expect(Object.hasOwn(reads.value.files[0]?.result ?? {}, '__proto__')).toBe(true);
  });

  it('aggregates matches across workspaces, ranks candidates, and filters vendor/build paths by default', async () => {
    const request: WorkspaceContextRequest = {
      query: 'login',
      mode: 'optimized',
      pageSize: 20,
    };
    const result = await new ContextEngine(services(), actor).collect(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.files.map((file) => file.path);
    expect(paths).toContain('.env');
    expect(paths).not.toContain('.git/config');
    expect(paths).not.toContain('node_modules/pkg/index.js');
    expect(paths).not.toContain('dist/login.js');
    expect(paths[0]).toBe('src/auth/login.ts');
    expect(result.value.files[0]?.reason).toContain('text match');
    expect(result.value.symbols.length).toBeGreaterThan(0);
    expect(result.value.matchedFiles).toBeGreaterThanOrEqual(2);

    const explicit = await new ContextEngine(services(), actor).collect({ ...request, includeIgnored: true });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    const explicitPaths = explicit.value.files.map((file) => file.path);
    expect(explicitPaths).toContain('.git/config');
    expect(explicitPaths).toContain('node_modules/pkg/index.js');
    expect(explicitPaths).toContain('dist/login.js');
  });

  it('returns a continuation token without discarding candidates outside the response page', async () => {
    const engine = new ContextEngine(services(), actor);
    const first = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });

    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;
    expect(first.value.files).toHaveLength(1);
    expect(first.value.hasMore).toBe(true);

    const next = await engine.continue(first.value.continuationToken, 1);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.files).toHaveLength(1);
    expect(next.value.files[0]?.path).not.toBe(first.value.files[0]?.path);
  });

  it('filters clean-index files with the live-search visibility policy', async () => {
    const filterSearchPaths = vi.fn().mockResolvedValue(['src/main.ts']);
    const engine = new ContextEngine({
      workspaceIndex: { status: vi.fn().mockResolvedValue(ok({
        freshness: 'watching_clean',
        snapshot: { entries: [
          { kind: 'file', relativePath: 'src/main.ts' },
          { kind: 'file', relativePath: '.env' },
        ] },
      })) },
      search: {
        filterSearchPaths,
        searchFiles: vi.fn().mockResolvedValue(ok({ paths: [], truncated: false })),
        searchText: vi.fn().mockResolvedValue(ok({ matches: [], truncated: false })),
      },
    }, actor);
    const result = await engine.fullScan({ workspaceId: 'workspace-1' });
    expect(result).toMatchObject({ ok: true, value: { completeness: 'complete', files: [{ path: 'src/main.ts' }] } });
    expect(filterSearchPaths).toHaveBeenCalledWith('workspace-1', ['.env', 'src/main.ts']);
  });

  it('paginates a full inventory beyond the 500-result interactive search cap', async () => {
    const paths = Array.from({ length: 751 }, (_, i) => `src/file-${String(i).padStart(4, '0')}.ts`);
    const scanFiles = vi.fn().mockResolvedValue(ok({ paths, truncated: false }));
    const searchFiles = vi.fn().mockResolvedValue(ok({ paths: paths.slice(0, 500), truncated: true }));
    const engine = new ContextEngine({ search: {
      scanFiles,
      searchFiles,
      searchText: vi.fn().mockResolvedValue(ok({ matches: [], truncated: false })),
    } }, actor);
    const collected: string[] = [];
    let token: string | undefined;
    const first = await engine.fullScan({ workspaceId: 'workspace-1', pageSize: 200 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    collected.push(...first.value.files.map((file) => file.path));
    expect(first.value.completeness).toBe('complete');
    token = first.value.continuationToken;
    while (token !== undefined) {
      const page = await engine.continueFullScan(token, 200);
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      collected.push(...page.value.files.map((file) => file.path));
      token = page.value.continuationToken;
    }
    expect(collected).toEqual(paths);
    expect(scanFiles).toHaveBeenCalledOnce();
    expect(searchFiles).not.toHaveBeenCalled();
  });

  it('reports when an inventory cannot fit its in-memory continuation budget', async () => {
    const store = new ContinuationStore<ScanContinuation>({
      maxWeight: 1, weightOf: (): number => 2,
    });
    const engine = new ContextEngine({
      search: { scanFiles: vi.fn().mockResolvedValue(ok({ paths: ['one.ts', 'two.ts'], truncated: false })),
        searchText: vi.fn(), searchFiles: vi.fn() },
    }, actor, undefined, undefined, store);
    const result = await engine.fullScan({ workspaceId: 'workspace-1', pageSize: 1 });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: true } });
    expect(store.size()).toBe(0);
  });

  it('preserves the full-scan continuation and cursor when the disk lease is busy', async () => {
    let failOnce = true;
    const seenOffsets: number[] = [];
    const scanFilesPage = vi.fn(async (
      _actor: unknown, _workspaceId: string, _request: unknown, _pageSize: number,
      cursor?: { frames: Array<{ offset: number }> },
    ): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> => {
      if (cursor === undefined) return ok({
        paths: ['a.ts'],
        cursor: { rootPath: 'fixture', frames: [{ relativePath: '', offset: 1, entries: [] }] },
      });
      seenOffsets.push(cursor.frames[0]!.offset);
      if (failOnce) {
        failOnce = false;
        cursor.frames[0]!.offset = 999;
        return err({ code: 'CONFLICT', message: 'Disk lease busy', recoverable: true });
      }
      return ok({ paths: ['b.ts'] });
    });
    const engine = new ContextEngine({
      search: { scanFilesPage, scanFiles: vi.fn(), searchFiles: vi.fn(), searchText: vi.fn() },
    }, actor);
    const first = await engine.fullScan({ workspaceId: 'w', pageSize: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;
    const token = first.value.continuationToken;
    const busy = await engine.continueFullScan(token, 1);
    expect(busy).toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: true } });
    const resumed = await engine.continueFullScan(token, 1);
    expect(resumed).toMatchObject({ ok: true, value: {
      files: [{ workspaceId: 'w', path: 'b.ts' }], scannedFiles: 2,
      hasMore: false, completeness: 'complete',
    } });
    expect(seenOffsets).toEqual([1, 1]);
    expect(scanFilesPage).toHaveBeenCalledTimes(3);
    await expect(engine.continueFullScan(token)).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    });
  });

  it('does not mislabel an in-memory inventory budget failure as a retryable disk stall', async () => {
    const store = new ContinuationStore<ScanContinuation>({
      maxWeight: 1_024, weightOf: (value): number => value.estimatedBytes,
    });
    const smallCursor = { rootPath: 'fixture', frames: [{ relativePath: '', offset: 1, entries: [] }] };
    const largeCursor = { rootPath: 'fixture', frames: [{
      relativePath: '', offset: 2,
      entries: Array.from({ length: 100 }, (_, index) => ({ name: `entry-${index}.ts`, type: 'file' })),
    }] };
    const scanFilesPage = vi.fn()
      .mockResolvedValueOnce(ok({ paths: ['first.ts'], cursor: smallCursor }))
      .mockResolvedValueOnce(ok({ paths: ['second.ts'], cursor: largeCursor }));
    const engine = new ContextEngine({
      search: { scanFilesPage, scanFiles: vi.fn(), searchFiles: vi.fn(), searchText: vi.fn() },
    }, actor, undefined, undefined, store);
    const first = await engine.fullScan({ workspaceId: 'w', pageSize: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;
    const token = first.value.continuationToken;
    expect(await engine.continueFullScan(token, 1)).toMatchObject({
      ok: false, error: { code: 'CONFLICT', details: { reason: 'memory_budget' } },
    });
    expect(scanFilesPage).toHaveBeenCalledTimes(2);
    expect(await engine.continueFullScan(token, 1)).toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    });
  });

  it('keeps the same continuation usable after a cancelled inventory page', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const scanFilesPage = vi.fn(async (
      _actor: unknown, _workspaceId: string, _request: unknown, _size: number,
      cursor?: { frames: Array<{ offset: number }> },
    ): Promise<ReturnType<typeof ok>> => {
      if (cursor === undefined) return ok({
        paths: ['first.ts'], cursor: { rootPath: 'fixture', frames: [{ relativePath: '', offset: 1, entries: [] }] },
      });
      attempts += 1;
      if (attempts === 1) {
        controller.abort();
        throw new Error('cancelled while reading directory');
      }
      return ok({ paths: ['last.ts'] });
    });
    const engine = new ContextEngine({
      search: { scanFilesPage, scanFiles: vi.fn(), searchFiles: vi.fn(), searchText: vi.fn() },
    }, actor);
    const initial = await engine.fullScan({ workspaceId: 'w', pageSize: 1 });
    expect(initial.ok).toBe(true);
    if (!initial.ok || initial.value.continuationToken === undefined) return;
    const token = initial.value.continuationToken;
    await expect(engine.continueFullScan(token, 1, controller.signal)).resolves.toMatchObject({
      ok: false, error: { code: 'PROCESS_TIMEOUT', recoverable: true },
    });
    await expect(engine.continueFullScan(token, 1)).resolves.toMatchObject({
      ok: true, value: { files: [{ workspaceId: 'w', path: 'last.ts' }], completeness: 'complete' },
    });
    expect(attempts).toBe(2);
  });

  it('marks remaining workspaces pending and preserves failed-source evidence', async () => {
    const scanFilesPage = vi.fn().mockImplementation(async (_actor, workspaceId: string): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> =>
      workspaceId === 'a'
        ? ok({ paths: ['a.ts'] })
        : err({ code: 'PERMISSION_DENIED', message: 'private-error', recoverable: false }));
    const engine = new ContextEngine({
      workspaceInfo: { list: async (): Promise<ReturnType<typeof ok>> => ok([{ id: 'a' }, { id: 'b' }]) },
      search: { scanFilesPage, scanFiles: vi.fn(), searchFiles: vi.fn(), searchText: vi.fn() },
    }, actor);
    const first = await engine.fullScan({ pageSize: 1 });
    expect(first).toMatchObject({ ok: true, value: { hasMore: true, completeness: 'partial', scannedWorkspaces: 1 } });
    if (!first.ok || first.value.continuationToken === undefined) return;
    const second = await engine.continueFullScan(first.value.continuationToken, 1);
    expect(second).toMatchObject({ ok: true, value: { hasMore: false, completeness: 'partial', scannedWorkspaces: 1, observations: expect.arrayContaining([
      { workspaceId: 'b', source: 'file_search', state: 'unavailable', error: { code: 'PERMISSION_DENIED' } },
    ]) } });
    expect(JSON.stringify(second)).not.toContain('private-error');
    expect(scanFilesPage).toHaveBeenCalledTimes(2);
  });

  it('continues discovery past 100,000 files without rewalking the provider', async () => {
    const total = 100_501;
    const paths = Array.from({ length: total }, (_, i) => `src/file-${i.toString().padStart(6, '0')}.ts`);
    const scanFilesPage = vi.fn().mockImplementation(async (
      _actor: unknown, _workspaceId: string, _request: unknown, size: number,
      cursor?: { frames: Array<{ offset: number }> },
    ): Promise<ReturnType<typeof ok>> => {
      const offset = cursor?.frames[0]?.offset ?? 0;
      const end = Math.min(total, offset + size);
      return ok({
        paths: paths.slice(offset, end),
        ...(end < total ? { cursor: { rootPath: 'fixture', frames: [{ relativePath: '', offset: end, entries: [] }] } } : {}),
      });
    });
    const inventory = new ContextEngine({
      search: { scanFilesPage, scanFiles: vi.fn(), searchFiles: vi.fn(), searchText: vi.fn() },
    }, actor);
    let token: string | undefined;
    let totalRead = 0;
    let last;
    const first = await inventory.fullScan({ workspaceId: 'huge', pageSize: 500 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    totalRead += first.value.files.length;
    token = first.value.continuationToken;
    const firstPage: string | undefined = first.value.files[0]?.path;
    while (token !== undefined) {
      const result = await inventory.continueFullScan(token, 500);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      totalRead += result.value.files.length;
      last = result.value;
      token = result.value.continuationToken;
    }
    expect(firstPage).toBe(paths[0]);
    expect(totalRead).toBe(total);
    expect(last).toMatchObject({ scannedFiles: total, completeness: 'complete', hasMore: false, searchTruncated: false });
    expect(scanFilesPage).toHaveBeenCalledTimes(Math.ceil(total / 500));
  });

  it('keeps one inventory array across pages instead of copying every remaining file', async () => {
    // No 30k-file disk fixture: the inventory lives entirely in memory.
    const paths = Array.from({ length: 30_001 }, (_, i) => `src/file-${String(i).padStart(5, '0')}.ts`);
    const scanFiles = vi.fn().mockResolvedValue(ok({ paths, truncated: false }));
    const store = new ContinuationStore<ScanContinuation>();
    const engine = new ContextEngine({ search: {
      scanFiles, searchFiles: vi.fn(), searchText: vi.fn(),
    } }, actor, undefined, undefined, store);
    const first = await engine.fullScan({ workspaceId: 'workspace-1', pageSize: 200 });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;
    const firstToken = first.value.continuationToken;
    const firstState = store.take(`${actor.clientId.length}:${actor.clientId}:${firstToken}`);
    expect(firstState?.nextIndex).toBe(200);
    expect(firstState?.files).toHaveLength(paths.length);
    if (firstState === undefined) return;
    store.set(`${actor.clientId.length}:${actor.clientId}:${firstToken}`, firstState);

    const second = await engine.continueFullScan(firstToken, 200);
    expect(second.ok).toBe(true);
    if (!second.ok || second.value.continuationToken === undefined) return;
    expect(second.value.files[0]?.path).toBe(paths[200]);
    const secondState = store.take(`${actor.clientId.length}:${actor.clientId}:${second.value.continuationToken}`);
    expect(secondState?.files).toBe(firstState.files);
    expect(secondState?.nextIndex).toBe(400);
    expect(scanFiles).toHaveBeenCalledTimes(1);
  });

  it('supports cross-workspace search, paged full scans, and parallel many-file reads', async () => {
    const engine = new ContextEngine(services(), actor);
    const search = await engine.searchAll({ query: 'login' });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.value.scannedWorkspaces).toBe(2);
    expect(search.value.paths).toEqual(expect.arrayContaining([
      { workspaceId: 'workspace-1', path: 'src/auth/login.ts' },
    ]));
    expect(search.value.paths).not.toContainEqual({ workspaceId: 'workspace-1', path: '.git/config' });
    expect(search.value.paths).not.toContainEqual({ workspaceId: 'workspace-2', path: 'dist/login.js' });

    const explicitSearch = await engine.searchAll({ query: 'login', includeIgnored: true });
    expect(explicitSearch.ok).toBe(true);
    if (!explicitSearch.ok) return;
    expect(explicitSearch.value.paths).toEqual(expect.arrayContaining([
      { workspaceId: 'workspace-1', path: '.git/config' },
      { workspaceId: 'workspace-2', path: 'dist/login.js' },
    ]));

    const scan = await engine.fullScan({ workspaceId: 'workspace-1', pageSize: 1 });
    expect(scan.ok).toBe(true);
    if (!scan.ok || scan.value.continuationToken === undefined) return;
    expect(scan.value.files).toHaveLength(1);
    const scanNext = await engine.continueFullScan(scan.value.continuationToken, 10);
    expect(scanNext.ok).toBe(true);
    if (!scanNext.ok) return;
    expect(scanNext.value.files.length).toBeGreaterThan(0);

    const many = await engine.readMany({ workspaceId: 'workspace-1', files: [{ path: '.env' }, { path: 'dist/login.js' }] });
    expect(many.ok).toBe(true);
    if (!many.ok) return;
    expect(many.value.totalFiles).toBe(2);
    expect(many.value.failedFiles).toBe(0);
  });

  it('uses the context ledger to avoid resending unchanged files', async () => {
    const engine = new ContextEngine(services(), actor);
    const first = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });
    const second = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.files[0]?.delivery).toBe('content');
    expect(second.value.files[0]?.delivery).toBe('unchanged');
    expect(second.value.files[0]?.unchangedSince).toBeDefined();
    expect(second.value.economy?.ledgerHits).toBeGreaterThan(0);
    expect(second.value.economy?.previouslySeenBytesAvoided).toBeGreaterThan(0);
  });

  it('does not emit base64 binary payloads as text context', async () => {
    const base = services();
    const engine = new ContextEngine({
      ...base,
      file: {
        async readFile(_actor, _workspaceId, request): Promise<ReturnType<typeof ok>> {
          return ok({
            path: request.path,
            content: 'AAECAw==',
            startLine: 1,
            endLine: 1,
            encoding: 'base64' as const,
            mimeType: 'application/octet-stream',
            byteLength: 4,
          });
        },
      },
    }, actor);

    const result = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files[0]).toMatchObject({ delivery: 'metadata', snippets: [], symbols: [], summary: { lineCount: 0 } });
    expect(JSON.stringify(result.value.files[0])).not.toContain('AAECAw==');
  });

  it('bounds concurrent context file reads', async () => {
    let activeReads = 0;
    let peakReads = 0;
    const base = services();
    const engine = new ContextEngine({
      ...base,
      file: {
        async readFile(_actor, _workspaceId, request): Promise<ReturnType<typeof ok>> {
          activeReads += 1;
          peakReads = Math.max(peakReads, activeReads);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeReads -= 1;
          return ok({ path: request.path, content: '', startLine: 1, endLine: 1, encoding: 'utf8' as const });
        },
      },
    }, actor);

    const result = await engine.readMany({
      workspaceId: 'workspace-1',
      files: Array.from({ length: 20 }, (_, index) => ({ path: `file-${index}.txt` })),
    });

    expect(result.ok).toBe(true);
    expect(peakReads).toBeGreaterThan(1);
    expect(peakReads).toBeLessThanOrEqual(8);
  });
});
