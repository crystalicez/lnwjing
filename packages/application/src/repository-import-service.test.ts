import { describe, expect, it, vi } from 'vitest';
import { ok } from '@lnwjing/domain';
import { RepositoryImportService } from './repository-import-service.js';

const accepted = {
  workspaceId: 'ws1',
  requestId: 'dab2a2bf-4f7e-4fae-bd68-01f9bc3d6a27',
  url: 'https://github.com/example/repository.git',
  commit: 'a'.repeat(40),
  destination: 'clones/repository',
};
const actor = { clientId: 'client1', clientName: 'agent', sessionId: 'session1' };

describe('RepositoryImportService', () => {
  it('refuses unauthorized start before touching workspace or runtime', async () => {
    const workspaces = { get: vi.fn(async () => ({ id: 'ws1', realRootPath: 'E:\\sandbox' })) };
    const runtime = {
      start: vi.fn(async () => ok({ task_id: 'task' })),
      status: vi.fn(async () => ok({ state: 'running' })),
      cancel: vi.fn(async () => ok({ state: 'cancelled' })),
    };
    const service = new RepositoryImportService(workspaces as never, runtime);
    expect(await service.start(actor, accepted)).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(workspaces.get).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });
  it('forwards an exact bounded request and authenticated owner only when authorized', async () => {
    const ws = { id: 'ws1', rootPath: 'E:\\sandbox', realRootPath: 'E:\\sandbox', kind: 'project' as const };
    const workspaces = { get: vi.fn(async () => ws) };
    const runtime = {
      start: vi.fn(async () => ok({ task_id: 'task-1', state: 'running' })),
      status: vi.fn(async () => ok({ state: 'running' })),
      cancel: vi.fn(async () => ok({ state: 'cancelled' })),
    };
    const service = new RepositoryImportService(workspaces as never, runtime);
    const result = await service.start(actor, accepted, undefined, { mode: 'standard', applicationApproved: true, bypassApplicationAuthorization: false, source: 'host_approval' });
    expect(result).toMatchObject({ ok: true, value: { task_id: 'task-1' } });
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      request: accepted,
      owner: { clientId: 'client1', sessionId: 'session1', workspaceId: 'ws1' },
      workspaceRoot: ws.realRootPath,
    }), undefined);
  });
  it('prevalidates credentials and extra parameters without looking up a workspace', async () => {
    const workspaces = { get: vi.fn() };
    const runtime = { start: vi.fn(), status: vi.fn(), cancel: vi.fn() };
    const service = new RepositoryImportService(workspaces as never, runtime as never);
    const result = await service.start(actor, { ...accepted, url: 'https://user:secret@github.com/repo', environment: { TOKEN: 'secret' } }, undefined, { mode: 'standard', applicationApproved: true, bypassApplicationAuthorization: false, source: 'host_approval' });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(workspaces.get).not.toHaveBeenCalled();
  });
  it('rejects invalid handle ownership fields for status and cancellation', async () => {
    const workspaces = { get: vi.fn() };
    const runtime = { start: vi.fn(), status: vi.fn(), cancel: vi.fn() };
    const service = new RepositoryImportService(workspaces as never, runtime as never);
    expect(await service.status(actor, 'ws1', '../secret')).toMatchObject({ ok: false });
    expect(await service.cancel(actor, 'ws1', '../secret')).toMatchObject({ ok: false });
    expect(runtime.status).not.toHaveBeenCalled();
    expect(runtime.cancel).not.toHaveBeenCalled();
  });
});