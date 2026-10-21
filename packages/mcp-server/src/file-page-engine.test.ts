import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjing/domain';
import type { McpApplicationServices } from './tools/tool-types.js';
import { FilePageEngine, type FilePageContinuation, type FilePageRequest } from './file-page-engine.js';
import { ContinuationStore } from './continuation-store.js';

const actor = { clientId: 'page-test', clientName: 'page-test' };

function services(): McpApplicationServices {
  return {
    file: {
      async readFile(_actor, _workspaceId, request): Promise<ReturnType<typeof ok>> {
        const lines = ['one', 'two', 'three', 'four', 'five'];
        const start = request.startLine ?? 1;
        const end = Math.min(request.endLine ?? lines.length, lines.length);
        return ok({
          path: request.path,
          content: lines.slice(start - 1, end).join('\n'),
          startLine: start,
          endLine: end,
          encoding: 'utf8' as const,
          byteLength: lines.slice(start - 1, end).join('\n').length,
        });
      },
    },
  };
}

describe('file page engine', () => {
  it('returns deterministic chunks and resumes from the next line', async () => {
    const engine = new FilePageEngine(services(), actor);
    const request: FilePageRequest = { workspaceId: 'workspace-1', path: 'src/file.ts', pageSize: 2 };
    const first = await engine.readPage(request);

    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;
    expect(first.value).toMatchObject({ path: 'src/file.ts', startLine: 1, endLine: 2, content: 'one\ntwo', hasMore: true });

    const second = await engine.continue(first.value.continuationToken, 2);
    expect(second).toMatchObject({ ok: true, value: { startLine: 3, endLine: 4, content: 'three\nfour', hasMore: true } });
    if (!second.ok || second.value.continuationToken === undefined) return;

    const last = await engine.continue(second.value.continuationToken, 2);
    expect(last).toEqual({
      ok: true,
      value: {
        path: 'src/file.ts',
        startLine: 5,
        endLine: 5,
        content: 'five',
        encoding: 'utf8',
        byteLength: 4,
        hasMore: false,
      },
    });
  });

  it('scopes shared continuation state to the owning session without consuming another session token', async () => {
    const shared = new ContinuationStore<FilePageContinuation>();
    const owner = new FilePageEngine(services(), { ...actor, sessionId: 'session-a' }, shared);
    const other = new FilePageEngine(services(), { ...actor, sessionId: 'session-b' }, shared);
    const recreatedOwner = new FilePageEngine(services(), { ...actor, sessionId: 'session-a' }, shared);

    const first = await owner.readPage({ workspaceId: 'workspace-1', path: 'src/file.ts', pageSize: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;

    expect(await other.continue(first.value.continuationToken, 2)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(await recreatedOwner.continue(first.value.continuationToken, 2)).toMatchObject({
      ok: true,
      value: { startLine: 3, endLine: 4, content: 'three\nfour' },
    });
  });

  it('rejects an unknown continuation token without changing the source read contract', async () => {
    const result = await new FilePageEngine(services(), actor).continue('missing-token');

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
