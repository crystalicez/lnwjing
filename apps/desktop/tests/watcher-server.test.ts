import { get } from 'node:http';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  startWatcherServer,
  type WatcherActivityEvent,
  type WatcherSnapshot,
} from '../src/main/watcher-server.js';

function snapshot(activity: readonly WatcherActivityEvent[]): WatcherSnapshot {
  return {
    protocolVersion: 1,
    serverTime: new Date().toISOString(),
    runtime: { version: 'test', status: 'running', activeOperations: 0 },
    instance: { id: 'instance-1', name: 'test-host', platform: 'windows' },
    goal: null,
    workspaces: [
      { id: 'workspace-a', name: 'project-a', selected: true, activeOperations: 1, goals: [], git: { branch: 'dev', commit: 'abc123', clean: false, changedFiles: 2 } },
      { id: 'workspace-b', name: 'project-b', selected: false, activeOperations: 1, goals: [
        { id: 'goal-b', key: 'parallel-goal', status: 'running', currentTask: 'Ship in parallel', blockers: [], milestones: [], workspaceId: 'workspace-b', workspaceName: 'project-b' },
      ], git: { branch: 'feature', commit: 'def456', clean: true, changedFiles: 0 } },
    ],
    agents: [],
    activity,
    git: { branch: 'dev', commit: 'abc123', clean: true, changedFiles: 0 },
  };
}

function pairingResponse(url: URL, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
  });
}

describe('Watcher server', () => {
  it('keeps two local watcher instances available when default ports collide', async () => {
    const create = (port: number, pairingPort: number, token: string): ReturnType<typeof startWatcherServer> => startWatcherServer({
      port, pairingPort, accessToken: token, fallbackOnPortInUse: true,
      buildSnapshot: async (events) => snapshot(events),
      subscribeActivity: (): (() => void) => (): void => undefined,
    });
    const firstToken = 'watcher-first-token-0123456789abcdef';
    const secondToken = 'watcher-second-token-0123456789abcdef';
    const first = await create(0, 0, firstToken);
    try {
      const second = await create(Number(first.endpoint.port), Number(first.pairingEndpoint.port), secondToken);
      try {
        expect(second.endpoint.port).not.toBe(first.endpoint.port);
        expect(second.pairingEndpoint.port).not.toBe(first.pairingEndpoint.port);
        const firstSnapshot = await fetch(new URL('/api/v1/snapshot', first.endpoint), {
          headers: { Authorization: `Bearer ${firstToken}` },
        });
        const secondSnapshot = await fetch(new URL('/api/v1/snapshot', second.endpoint), {
          headers: { Authorization: `Bearer ${secondToken}` },
        });
        expect(firstSnapshot.status).toBe(200);
        expect(secondSnapshot.status).toBe(200);
        const leaked = await fetch(new URL('/api/v1/snapshot', first.endpoint), {
          headers: { Authorization: `Bearer ${secondToken}` },
        });
        expect(leaked.status).toBe(401);
        const pairing = await fetch(second.pairingEndpoint).then(response => response.json()) as { endpoint: string; token: string };
        expect(pairing.token).toBe(secondToken);
        expect(pairing.endpoint).toBe(second.endpoint.origin);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it('does not change an explicitly configured Watcher port after a collision', async () => {
    const first = await startWatcherServer({
      port: 0, pairingPort: 0, accessToken: 'watcher-explicit-one-0123456789abcdef',
      buildSnapshot: async activity => snapshot(activity),
      subscribeActivity: (): (() => void) => (): void => undefined,
    });
    try {
      await expect(startWatcherServer({
        port: Number(first.endpoint.port), pairingPort: 0,
        accessToken: 'watcher-explicit-two-0123456789abcdef',
        buildSnapshot: async activity => snapshot(activity),
        subscribeActivity: (): (() => void) => (): void => undefined,
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect((await fetch(new URL('/api/v1/snapshot', first.endpoint), {
        headers: { Authorization: 'Bearer watcher-explicit-one-0123456789abcdef' },
      })).status).toBe(200);
    } finally {
      await first.close();
    }
  });

  it('allows automatic pairing fallback with an explicit API port, but never moves explicit pairing', async () => {
    const create = (pairingPort: number, apiFallback: boolean, pairingFallback: boolean, token: string): ReturnType<typeof startWatcherServer> => startWatcherServer({
      port: 0, pairingPort, accessToken: token,
      fallbackOnPortInUse: apiFallback, fallbackOnPairingPortInUse: pairingFallback,
      buildSnapshot: async activity => snapshot(activity),
      subscribeActivity: (): (() => void) => (): void => undefined,
    });
    const first = await create(0, false, false, 'watcher-mixed-one-0123456789abcdef');
    try {
      const second = await create(Number(first.pairingEndpoint.port), false, true, 'watcher-mixed-two-0123456789abcdef');
      try {
        expect(second.pairingEndpoint.port).not.toBe(first.pairingEndpoint.port);
        const pairing = await fetch(second.pairingEndpoint).then(response => response.json()) as { token: string };
        expect(pairing.token).toBe('watcher-mixed-two-0123456789abcdef');
      } finally {
        await second.close();
      }
      await expect(create(Number(first.pairingEndpoint.port), true, false,
        'watcher-mixed-explicit-0123456789abcdef')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await first.close();
    }
  });

  it('rejects rebinding Host and foreign Origin before disclosing the pairing token', async () => {
    const token = 'watcher-test-token-0123456789abcdef';
    const server = await startWatcherServer({
      port: 0, pairingPort: 0, accessToken: token,
      buildSnapshot: async (events) => snapshot(events),
      subscribeActivity: (): (() => void) => (): void => undefined,
    });
    try {
      for (const headers of [
        { Host: 'attacker.example' },
        { Host: `127.0.0.1:${server.pairingEndpoint.port}`, Origin: 'https://attacker.example' },
        { Host: `127.0.0.1:${server.pairingEndpoint.port}`, Origin: 'null' },
      ]) {
        const denied = await pairingResponse(server.pairingEndpoint, headers);
        expect(denied.status).toBe(403);
        expect(denied.body).not.toContain(token);
      }
      const accepted = await pairingResponse(server.pairingEndpoint, {
        Host: `localhost:${server.pairingEndpoint.port}`,
        Origin: `http://localhost:${server.pairingEndpoint.port}`,
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body).toContain(token);
    } finally {
      await server.close();
    }
  });

  it('keeps pairing local, requires bearer auth for snapshots, and streams only after websocket auth', async () => {
    const token = 'watcher-test-token-0123456789abcdef';
    let publish: ((event: WatcherActivityEvent) => void) | null = null;
    const server = await startWatcherServer({
      port: 0,
      pairingPort: 0,
      accessToken: token,
      buildSnapshot: async (activity) => snapshot(activity),
      subscribeActivity(listener): () => void {
        publish = listener;
        return () => { publish = null; };
      },
    });

    try {
      const unauthorized = await fetch(new URL('/api/v1/snapshot', server.endpoint));
      expect(unauthorized.status).toBe(401);

      const pair = await fetch(server.pairingEndpoint).then((response) => response.json()) as { token: string; endpoint: string };
      expect(pair.token).toBe(token);
      expect(pair.endpoint).toBe(server.endpoint.toString().replace(/\/$/, ''));

      const pairingPage = await fetch(server.pairingEndpoint, { headers: { Accept: 'text/html' } });
      expect(pairingPage.headers.get('content-type')).toContain('text/html');
      expect(pairingPage.headers.get('cache-control')).toBe('no-store');
      const pairingHtml = await pairingPage.text();
      expect(pairingHtml).toContain('Copy Session token');
      expect(pairingHtml).toContain(token);
      expect(pairingHtml).toContain(pair.endpoint);

      const authorized = await fetch(new URL('/api/v1/snapshot', server.endpoint), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toMatchObject({
        protocolVersion: 1,
        instance: { id: 'instance-1' },
        workspaces: [
          { id: 'workspace-a', name: 'project-a', activeOperations: 1 },
          { id: 'workspace-b', name: 'project-b', goals: [{ id: 'goal-b', key: 'parallel-goal' }] },
        ],
      });

      const socketUrl = new URL('/api/v1/events', server.endpoint);
      socketUrl.protocol = 'ws:';
      const socket = new WebSocket(socketUrl);

      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const ready = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Watcher authentication acknowledgement was not delivered')), 1_000);
        socket.once('message', (raw) => {
          clearTimeout(timeout);
          resolve(JSON.parse(raw.toString()) as unknown);
        });
      });
      socket.send(JSON.stringify({ type: 'auth', token }));
      await expect(ready).resolves.toEqual({ type: 'ready', protocolVersion: 1 });

      const received = new Promise<WatcherActivityEvent>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Watcher event was not delivered')), 1_000);
        socket.once('message', (raw) => {
          clearTimeout(timeout);
          resolve(JSON.parse(raw.toString()) as WatcherActivityEvent);
        });
      });

      const event: WatcherActivityEvent = {
        id: 'event-1',
        timestamp: new Date().toISOString(),
        kind: 'project_test',
        status: 'running',
        actor: '@lnwjing',
        summary: 'Running project test',
        workspaceId: 'workspace-b',
      };
      publish?.(event);
      await expect(received).resolves.toEqual(event);
      socket.close();
    } finally {
      await server.close();
    }
  });
});
