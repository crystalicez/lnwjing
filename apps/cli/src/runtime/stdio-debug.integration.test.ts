import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { actorForRequestScope, createStdioRequestScope, ToolRegistry, type ToolRegistryOptions } from '@lnwjing/mcp-server';
import { permissionProfiles } from '@lnwjing/permissions';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@lnwjing/storage';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('STDIO host-owned debugger lifetime', () => {
  it('shares sessions across request registries and closes every debugger socket on real runtime shutdown', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-stdio-debug-'));
    const root = await realpath(directory);
    const workspace = { id: 'stdio-debug-workspace', displayName: 'STDIO debug fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString() };
    const database = new SqliteDatabase(path.join(directory, 'lnwjing.sqlite'));
    await new SqliteWorkspaceRepository(database).insert(workspace);
    database.close();
    const sockets = new Set<Socket>();
    const requests: string[] = [];
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
      let buffer = Buffer.alloc(0);
      let sequence = 0;
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd < 0) break;
          const length = /Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString('ascii'));
          if (length?.[1] === undefined) throw new Error('Fixture DAP frame lacks content length');
          const byteLength = Number(length[1]);
          const end = headerEnd + 4 + byteLength;
          if (buffer.byteLength < end) break;
          const message: unknown = JSON.parse(buffer.subarray(headerEnd + 4, end).toString('utf8'));
          if (!isRecord(message) || typeof message.seq !== 'number' || message.type !== 'request' || typeof message.command !== 'string') throw new Error('Fixture received an invalid DAP request');
          buffer = buffer.subarray(end);
          requests.push(message.command);
          const payload = Buffer.from(JSON.stringify({ seq: ++sequence, type: 'response', request_seq: message.seq, command: message.command, success: true, body: message.command === 'threads' ? { threads: [{ id: 1, name: '  ไทย 😀  ' }] } : {} }), 'utf8');
          socket.write(Buffer.concat([Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, 'ascii'), payload]));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Fixture adapter port is unavailable');
    const runtime = createStdioMcpRuntime(directory, workspace, false, { fullBypassAll: true, checkpointEncryptionKey: Buffer.alloc(32, 0x6d) });
    try {
      const requestActor = actorForRequestScope(runtime.actor, createStdioRequestScope());
      const options: ToolRegistryOptions = { profileProvider: () => permissionProfiles.full, authorizationModeProvider: () => 'full_bypass' };
      const first = new ToolRegistry(runtime.services, requestActor, options);
      const attached = await first.invoke('debug_attach', { workspaceId: workspace.id, endpoint: `tcp://127.0.0.1:${address.port}`, timeoutMs: 2000 });
      expect(attached.isError).not.toBe(true);
      if (!isRecord(attached.structuredContent) || !isRecord(attached.structuredContent.session) || typeof attached.structuredContent.session.sessionId !== 'string') throw new Error('Fixture attach did not return a session handle');
      const session = attached.structuredContent.session.sessionId;
      const next = new ToolRegistry(runtime.services, requestActor, options);
      const observed = await next.invoke('debug_step', { workspaceId: workspace.id, session_id: session, action: 'threads' });
      expect(observed.structuredContent).toMatchObject({ response: { body: { threads: [{ id: 1, name: '  ไทย 😀  ' }] } } });
      expect(requests).toEqual(['initialize', 'attach', 'threads']);
      await runtime.close();
      await vi.waitFor(() => expect(sockets.size).toBe(0));
      const count = requests.length;
      const closed = await runtime.services.debugSessions?.attach({ clientId: requestActor.clientId, sessionId: requestActor.sessionId ?? '', workspaceId: workspace.id }, { endpoint: `tcp://127.0.0.1:${address.port}` });
      expect(closed).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'DAP session service is closed' } });
      expect(requests).toHaveLength(count);
    } finally {
      await runtime.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      expect(path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('lnwjing-stdio-debug-')).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
