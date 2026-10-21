import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileService, SearchService } from '@lnwjing/application';
import { type Workspace, type WorkspaceRepository } from '@lnwjing/workspace';
import { ContextEngine } from './context-engine.js';

describe('ContextEngine with actual file and search providers', () => {
  it('reads one Thai and emoji filename exactly once and keeps whitespace through the actual providers', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-context-provider-'));
    const root = await realpath(temporaryRoot);
    const filename = "ไทย 😀 Space's.ts";
    const content = 'export const needle = "ไทย 😀";  \n\t  needle  \n';
    try {
      await writeFile(path.join(root, filename), content, 'utf8');
      await writeFile(path.join(root, '.env'), 'CONTEXT_FIXTURE_TOKEN=private-fixture', 'utf8');
      const workspace: Workspace = { id: 'context-live', displayName: 'Context fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
      const repository: WorkspaceRepository = {
        async list() { return [workspace]; },
        async get(id) { return id === workspace.id ? workspace : null; },
        async insert() {},
        async delete() {},
      };
      const actor = { clientId: 'context-live-client', clientName: 'Context provider fixture', sessionId: 'context-live-session' };
      const search = new SearchService(repository);
      const text = await search.searchText(actor, workspace.id, { query: 'needle' });
      const inventory = await search.searchFiles(actor, workspace.id, {});
      expect(text.ok).toBe(true);
      expect(inventory.ok).toBe(true);
      if (!text.ok || !inventory.ok) return;
      expect(text.value.matches).toHaveLength(2);
      expect(text.value.matches[1]?.text).toBe('\t  needle  ');
      expect(inventory.value.paths).toContain(filename);
      const engine = new ContextEngine({ platform: process.platform, search, file: new FileService(repository) }, actor);
      const collected = await engine.collect({ workspaceId: workspace.id, query: 'needle', mode: 'exhaustive' });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;
      expect(collected.value.files.filter((file) => file.error === undefined)).toHaveLength(1);
      expect(collected.value.files[0]?.path).toBe(text.value.matches[0]?.path);
      expect(collected.value.matches.map((match) => match.text)).toEqual(['export const needle = "ไทย 😀";  ', '\t  needle  ']);
      const reads = await engine.readMany({ workspaceId: workspace.id, files: [{ path: filename }, { path: '.env' }] });
      expect(reads).toMatchObject({ ok: true, value: { totalFiles: 2, failedFiles: 1, completeness: 'partial', files: [
        { path: filename, result: { content } },
        { path: '.env', error: { code: 'SECRET_ACCESS_DENIED', message: 'File read failed' } },
      ] } });
      expect(JSON.stringify(reads)).not.toContain('private-fixture');
    } finally {
      const resolvedCleanup = await realpath(temporaryRoot);
      expect(resolvedCleanup === root && path.dirname(root) === await realpath(os.tmpdir()) && path.basename(root).startsWith('lnwjing-context-provider-')).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  });
});
