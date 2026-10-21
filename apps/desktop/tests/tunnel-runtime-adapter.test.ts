import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  TunnelRuntimeAdapter,
  parseNativeRuntimeStatus,
  type TunnelRuntimeExecutor,
} from '../src/main/tunnel-runtime-adapter.js';

function executor(responses: Readonly<Record<string, { stdout?: string; stderr?: string; error?: string }>>): TunnelRuntimeExecutor {
  return vi.fn(async (_executable: string, args: readonly string[], _options: ExecFileOptionsWithStringEncoding) => {
    void _options;
    const key = args.join(' ');
    const response = responses[key];
    if (response === undefined) throw Object.assign(new Error(`unexpected command: ${key}`), { stdout: '', stderr: '' });
    if (response.error !== undefined) throw Object.assign(new Error(response.error), { stdout: response.stdout ?? '', stderr: response.stderr ?? response.error });
    return { stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
  });
}

describe('TunnelRuntimeAdapter', () => {
  it('retires only a stopped stale alias and restores profile, health, log, and unrelated files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-stopped-alias-'));
    try {
      await mkdir(path.join(root, 'health'), { recursive: true });
      const profile = 'health:\n  url_file: health/lnwjing.url\n';
      await writeFile(path.join(root, 'lnwjing.yaml'), profile);
      await writeFile(path.join(root, 'lnwjing-tunnel.log'), 'original-log');
      await writeFile(path.join(root, 'health', 'lnwjing.url'), 'http://127.0.0.1:7777');
      await writeFile(path.join(root, 'other.yaml'), 'must-stay');
      let removed = false;
      const commands: string[] = [];
      const execute: TunnelRuntimeExecutor = async (_executable, args): Promise<{ stdout: string; stderr: string }> => {
        const command = args.join(' ');
        commands.push(command);
        if (command === 'runtimes status lnwjing --json') {
          if (removed) throw Object.assign(new Error('alias lnwjing is not known'), { stdout: '', stderr: 'alias lnwjing is not known' });
          return { stdout: JSON.stringify({ exists: true, tunnel_id: 'tunnel_oldalias12345', process_running: false }), stderr: '' };
        }
        if (command === 'runtimes rm lnwjing --json') {
          removed = true;
          await rm(path.join(root, 'lnwjing.yaml'));
          await rm(path.join(root, 'lnwjing-tunnel.log'));
          await rm(path.join(root, 'health', 'lnwjing.url'));
          return { stdout: '{"removed":true}', stderr: '' };
        }
        throw new Error('Unexpected CLI command');
      };
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'fixture.exe', profileDirectory: root, environment: {}, execute });
      await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).resolves.toBeUndefined();
      expect(commands).toContain('runtimes rm lnwjing --json');
      expect(commands).not.toContain('runtimes stop lnwjing --json');
      await expect(adapter.status(true)).resolves.toMatchObject({ exists: false });
      await expect(readFile(path.join(root, 'lnwjing.yaml'), 'utf8')).resolves.toBe(profile);
      await expect(readFile(path.join(root, 'lnwjing-tunnel.log'), 'utf8')).resolves.toBe('original-log');
      await expect(readFile(path.join(root, 'health', 'lnwjing.url'), 'utf8')).resolves.toBe('http://127.0.0.1:7777');
      await expect(readFile(path.join(root, 'other.yaml'), 'utf8')).resolves.toBe('must-stay');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers the protected profile when native rm fails after deleting a local artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-rm-failure-'));
    try {
      await writeFile(path.join(root, 'lnwjing.yaml'), 'tunnel_id: tunnel_newalias12345\n');
      await writeFile(path.join(root, 'unrelated.yaml'), 'keep');
      let rmCalled = false;
      const adapter = new TunnelRuntimeAdapter({
        clientPath: 'fixture.exe', profileDirectory: root, environment: {},
        execute: async (_exe, args): Promise<{ stdout: string; stderr: string }> => {
          const command = args.join(' ');
          if (command === 'runtimes status lnwjing --json') {
            return { stdout: JSON.stringify({ tunnel_id: 'tunnel_oldalias12345', process_running: false }), stderr: '' };
          }
          if (command === 'runtimes rm lnwjing --json') {
            rmCalled = true;
            await rm(path.join(root, 'lnwjing.yaml'));
            throw Object.assign(new Error('simulated local cleanup failure'), { stderr: 'simulated local cleanup failure', stdout: '' });
          }
          throw new Error('Unexpected command');
        },
      });
      await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).rejects.toThrow('simulated local cleanup failure');
      expect(rmCalled).toBe(true);
      await expect(readFile(path.join(root, 'lnwjing.yaml'), 'utf8')).resolves.toBe('tunnel_id: tunnel_newalias12345\n');
      await expect(readFile(path.join(root, 'unrelated.yaml'), 'utf8')).resolves.toBe('keep');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a profile health reference outside the owned directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-health-escape-'));
    try {
      await writeFile(path.join(root, 'lnwjing.yaml'), 'health:\n  url_file: ../other.url\n');
      const calls: string[] = [];
      const adapter = new TunnelRuntimeAdapter({
        clientPath: 'fixture.exe', profileDirectory: root, environment: {},
        execute: async (_exe, args): Promise<{ stdout: string; stderr: string }> => {
          const command = args.join(' ');
          calls.push(command);
          if (command === 'runtimes status lnwjing --json') {
            return { stdout: JSON.stringify({ tunnel_id: 'tunnel_oldalias12345', process_running: false }), stderr: '' };
          }
          throw new Error('Must not run rm for escaped health artifact');
        },
      });
      await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).rejects.toThrow('escapes');
      expect(calls).not.toContain('runtimes rm lnwjing --json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a running mismatched alias without any CLI rm or stop side effect', async () => {
    const calls: string[] = [];
    const adapter = new TunnelRuntimeAdapter({
      clientPath: 'fixture.exe', profileDirectory: 'profile', environment: {},
      execute: async (_exe, args): Promise<{ stdout: string; stderr: string }> => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'runtimes status lnwjing --json') {
          return { stdout: JSON.stringify({ tunnel_id: 'tunnel_oldalias12345', process_running: true, pid: 954321 }), stderr: '' };
        }
        throw new Error('Unsafe command requested');
      },
    });
    await expect(adapter.retireStoppedAlias('tunnel_oldalias12345')).rejects.toThrow('active or its identity changed');
    expect(calls).toEqual(['runtimes status lnwjing --json']);
  });

  it('detects official managed runtimes and refuses to infer strict A/B zero downtime', async () => {
    const execute = executor({
      '--version': { stdout: '0.0.11+fixture\n' },
      'runtimes --help': { stdout: 'Available Commands:\n  connect\n  status\n  stop\n' },
      'runtimes connect --help': { stdout: '--alias --tunnel-id --runtime-api-key --mcp-server-url' },
      'health --help': { stdout: '/healthz /readyz --require-control-plane-poll' },
    });
    const adapter = new TunnelRuntimeAdapter({
      clientPath: 'C:\\tools\\tunnel-client.exe',
      profileDirectory: 'C:\\profile',
      environment: {},
      execute,
    });

    await expect(adapter.capabilities()).resolves.toEqual(expect.objectContaining({
      clientVersion: '0.0.11+fixture',
      nativeRuntimes: true,
      managedConnect: true,
      healthProbe: true,
      pollHealthGate: true,
      readyBeforeRetire: false,
      strictZeroDowntime: false,
    }));
  });

  it('maps unknown alias status to a missing runtime instead of throwing', async () => {
    const execute = executor({
      'runtimes status lnwjing --json': { error: 'alias lnwjing is not known; run create or connect first' },
    });
    const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });
    await expect(adapter.status()).resolves.toMatchObject({ exists: false, running: false });
  });

  it('uses loopback health routes after the first managed-runtime status instead of polling the CLI every healthy cycle', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/healthz' || request.url === '/readyz') {
        response.statusCode = 200;
        response.end('ok');
        return;
      }
      if (request.url === '/api/status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ control_plane_tunnel_id: 'tunnel_fixture012345' }));
        return;
      }
      if (request.url === '/api/system') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          proxy_health: [{
            health_state: 'healthy',
            route: { kind: 'control_plane', route_mode: 'proxy' },
            last_check: '2026-05-08T00:00:00Z',
          }],
        }));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP health server');
      const healthUrl = `http://127.0.0.1:${address.port}`;
      const execute = executor({
        'runtimes status lnwjing --json': {
          stdout: JSON.stringify({
            tunnel_id: 'tunnel_fixture012345',
            process_running: true,
            healthy: true,
            ready: true,
            control_plane_poll_health: { state: 'healthy' },
            health_url: healthUrl,
          }),
        },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });

      await expect(adapter.status()).resolves.toMatchObject({ running: true, healthUrl });
      await expect(adapter.status()).resolves.toMatchObject({ running: true, healthy: true, ready: true, pollHealthy: true });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('uses the live admin MCP target when persisted runtime status reports a newer port', async () => {
    const staleMcpServerUrl = 'http://127.0.0.1:59159/mcp';
    const configuredMcpServerUrl = 'http://127.0.0.1:61572/mcp';
    const server = createServer((request, response) => {
      if (request.url === '/healthz' || request.url === '/readyz') {
        response.statusCode = 200;
        response.end('ok');
        return;
      }
      if (request.url === '/api/status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          control_plane_tunnel_id: 'tunnel_fixture012345',
          mcp_server_url: staleMcpServerUrl,
        }));
        return;
      }
      if (request.url === '/api/system') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          proxy_health: [{ health_state: 'healthy', route: { kind: 'control_plane' } }],
        }));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP health server');
      const execute = executor({
        'runtimes status lnwjing --json': {
          stdout: JSON.stringify({
            tunnel_id: 'tunnel_fixture012345',
            process_running: true,
            target_value: configuredMcpServerUrl,
            health_url: `http://127.0.0.1:${address.port}`,
          }),
        },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });

      await expect(adapter.status()).resolves.toMatchObject({ mcpServerUrl: staleMcpServerUrl });
      await expect(adapter.status()).resolves.toMatchObject({ mcpServerUrl: staleMcpServerUrl });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('maps v0.0.14 control-plane unhealthy state without spawning a second CLI status', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/healthz' || request.url === '/readyz') {
        response.statusCode = 200;
        response.end('ok');
        return;
      }
      if (request.url === '/api/status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ control_plane_tunnel_id: 'tunnel_fixture012345' }));
        return;
      }
      if (request.url === '/api/system') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          proxy_health: [{
            health_state: 'unhealthy',
            route: { kind: 'control_plane', route_mode: 'proxy' },
          }],
        }));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP health server');
      const healthUrl = `http://127.0.0.1:${address.port}`;
      const execute = executor({
        'runtimes status lnwjing --json': {
          stdout: JSON.stringify({ tunnel_id: 'tunnel_fixture012345', process_running: true, healthy: true, ready: true, health_url: healthUrl }),
        },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });

      await adapter.status();
      await expect(adapter.status()).resolves.toMatchObject({ running: true, healthy: true, ready: true, pollHealthy: false });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('supports the newer control-plane health endpoint when the v0.0.14 system snapshot is unavailable', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/healthz' || request.url === '/readyz') {
        response.statusCode = 200;
        response.end('ok');
        return;
      }
      if (request.url === '/api/status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ control_plane_tunnel_id: 'tunnel_fixture012345' }));
        return;
      }
      if (request.url === '/api/system') {
        response.statusCode = 404;
        response.end('missing');
        return;
      }
      if (request.url === '/health/control-plane') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'ok', state: 'polling' }));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP health server');
      const healthUrl = `http://127.0.0.1:${address.port}`;
      const execute = executor({
        'runtimes status lnwjing --json': {
          stdout: JSON.stringify({ tunnel_id: 'tunnel_fixture012345', process_running: true, healthy: true, ready: true, health_url: healthUrl }),
        },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });

      await adapter.status();
      await expect(adapter.status()).resolves.toMatchObject({ running: true, healthy: true, ready: true, pollHealthy: true });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('falls back to authoritative CLI status when the cached admin URL belongs to a different tunnel', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/healthz' || request.url === '/readyz') {
        response.statusCode = 200;
        response.end('ok');
        return;
      }
      if (request.url === '/api/status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ control_plane_tunnel_id: 'tunnel_other012345' }));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP health server');
      const healthUrl = `http://127.0.0.1:${address.port}`;
      const execute = executor({
        'runtimes status lnwjing --json': {
          stdout: JSON.stringify({ tunnel_id: 'tunnel_fixture012345', process_running: true, healthy: true, ready: true, health_url: healthUrl }),
        },
      });
      const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute });

      await adapter.status();
      await expect(adapter.status()).resolves.toMatchObject({ running: true, tunnelId: 'tunnel_fixture012345' });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('verifies the managed runtime is actually stopped instead of trusting the stop command exit code', async () => {
    let statusCalls = 0;
    const execute: TunnelRuntimeExecutor = vi.fn(async (_executable, args) => {
      const key = args.join(' ');
      if (key === 'runtimes stop lnwjing --json') return { stdout: JSON.stringify({ alias: 'lnwjing' }), stderr: '' };
      if (key === 'runtimes status lnwjing --json') {
        statusCalls += 1;
        return {
          stdout: JSON.stringify({
            tunnel_id: 'tunnel_fixture012345',
            process: { running: statusCalls < 2, pid: statusCalls < 2 ? 1234 : null },
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${key}`);
    });
    const adapter = new TunnelRuntimeAdapter({
      clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute,
      stopVerifyAttempts: 3, stopVerifyIntervalMs: 0,
    });

    await expect(adapter.stop('tunnel_fixture012345')).resolves.toMatchObject({ running: false });
    expect(statusCalls).toBe(2);
  });

  it('fails loudly when the managed runtime remains live after an explicit stop', async () => {
    const execute: TunnelRuntimeExecutor = vi.fn(async (_executable, args) => {
      const key = args.join(' ');
      if (key === 'runtimes stop lnwjing --json') return { stdout: JSON.stringify({ alias: 'lnwjing' }), stderr: '' };
      if (key === 'runtimes status lnwjing --json') return { stdout: JSON.stringify({ tunnel_id: 'tunnel_fixture012345', process: { running: true, pid: 1234 } }), stderr: '' };
      throw new Error(`unexpected command: ${key}`);
    });
    const adapter = new TunnelRuntimeAdapter({
      clientPath: 'client.exe', profileDirectory: 'profile', environment: {}, execute,
      stopVerifyAttempts: 2, stopVerifyIntervalMs: 0,
    });

    await expect(adapter.stop('tunnel_fixture012345')).rejects.toThrow('still running after stop');
  });

  it('connects the same tunnel with an environment key reference and no literal secret in argv', async () => {
    const tunnelId = 'tunnel_0123456789abcdef';
    const mcpServerUrl = 'http://127.0.0.1:18765/mcp';
    const execute = executor({
      [`runtimes connect --alias lnwjing --tunnel-id ${tunnelId} --runtime-api-key env:CONTROL_PLANE_API_KEY --mcp-server-url ${mcpServerUrl} --profile lnwjing --profile-dir C:\\profile --json`]: {
        stdout: JSON.stringify({ tunnel_id: tunnelId, process: { running: true, pid: 1234 }, health: { healthy: true, ready: true }, control_plane: { poll_healthy: true }, mcp_server_url: mcpServerUrl }),
      },
    });
    const environment = { CONTROL_PLANE_API_KEY: 'secret-must-stay-in-env' };
    const processGuard = vi.fn(async () => undefined);
    const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'C:\\profile', environment, execute, processGuard });

    await expect(adapter.connect({ tunnelId, mcpServerUrl })).resolves.toMatchObject({
      running: true,
      healthy: true,
      ready: true,
      pollHealthy: true,
      tunnelId,
      mcpServerUrl,
    });
    const call = vi.mocked(execute).mock.calls[0];
    expect(call?.[1]).not.toContain(environment.CONTROL_PLANE_API_KEY);
    expect(call?.[1]).toContain('env:CONTROL_PLANE_API_KEY');
  });

  it.runIf(process.platform === 'win32')('does not report a successful connect while an old Windows process still needs retirement', async () => {
    const tunnelId = 'tunnel_0123456789abcdef';
    const mcpServerUrl = 'http://127.0.0.1:18765/mcp';
    const execute = executor({
      [`runtimes connect --alias lnwjing --tunnel-id ${tunnelId} --runtime-api-key env:CONTROL_PLANE_API_KEY --mcp-server-url ${mcpServerUrl} --profile lnwjing --profile-dir C:\\profile --json`]: {
        stdout: JSON.stringify({ tunnel_id: tunnelId, process: { running: true, pid: 1234 }, mcp_server_url: mcpServerUrl }),
      },
    });
    const processGuard = vi.fn(async () => { throw new Error('Could not verify tunnel-client PID 99'); });
    const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'C:\\profile', environment: {}, execute, processGuard });

    await expect(adapter.connect({ tunnelId, mcpServerUrl })).rejects.toThrow(/Restart Windows.*PID 99/);
    expect(processGuard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tunnelId, keepPid: 1234 }));
  });

  it.runIf(process.platform === 'win32')('checks for orphaned Windows processes after the official alias stops', async () => {
    const tunnelId = 'tunnel_0123456789abcdef';
    const execute = executor({
      'runtimes stop lnwjing --json': { stdout: JSON.stringify({ alias: 'lnwjing' }) },
      'runtimes status lnwjing --json': { stdout: JSON.stringify({ tunnel_id: tunnelId, process: { running: false } }) },
    });
    const processGuard = vi.fn(async () => undefined);
    const adapter = new TunnelRuntimeAdapter({ clientPath: 'client.exe', profileDirectory: 'C:\\profile', environment: {}, execute, processGuard });

    await expect(adapter.stop(tunnelId)).resolves.toMatchObject({ running: false });
    expect(processGuard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tunnelId, keepPid: null }));
  });
});

describe('parseNativeRuntimeStatus', () => {
  it('normalizes nested JSON fields from runtime status output', () => {
    expect(parseNativeRuntimeStatus(JSON.stringify({
      alias: 'lnwjing',
      tunnel: { id: 'tunnel_fixture012345' },
      process: { running: true, pid: 7654 },
      health: { healthy: true, ready: true, ui_url: 'http://127.0.0.1:9123/ui' },
      control_plane: { poll_healthy: true },
      mcp: { server_url: 'http://127.0.0.1:18765/mcp' },
    }))).toEqual(expect.objectContaining({
      exists: true,
      running: true,
      healthy: true,
      ready: true,
      pollHealthy: true,
      tunnelId: 'tunnel_fixture012345',
      mcpServerUrl: 'http://127.0.0.1:18765/mcp',
      pid: 7654,
      uiUrl: 'http://127.0.0.1:9123/ui',
    }));
  });

  it('understands tunnel-client 0.0.12 target_value and explicit unknown poll-health state', () => {
    expect(parseNativeRuntimeStatus(JSON.stringify({
      alias: 'lnwjing',
      tunnel_id: 'tunnel_fixture012345',
      healthy: true,
      ready: true,
      runtime_state: 'ready',
      process_running: true,
      target_kind: 'server_url',
      target_value: 'http://127.0.0.1:18765/mcp',
      process: {
        pid: 21980,
        running: true,
        target_kind: 'server_url',
        target_value: 'http://127.0.0.1:18765/mcp',
      },
      control_plane_poll_health: {
        state: 'unknown',
        reason: 'no live admin UI system snapshot',
      },
    }))).toEqual(expect.objectContaining({
      exists: true,
      running: true,
      healthy: true,
      ready: true,
      pollHealthy: null,
      tunnelId: 'tunnel_fixture012345',
      mcpServerUrl: 'http://127.0.0.1:18765/mcp',
      pid: 21980,
    }));
  });

  it('parses the real tunnel-client 0.0.13 stopped-status shape without treating unknown poll health as failure', () => {
    expect(parseNativeRuntimeStatus(JSON.stringify({
      admin_profile: 'default',
      alias: 'lnwjing',
      control_plane_poll_health: {
        reason: 'no live admin UI system snapshot',
        state: 'unknown',
      },
      healthy: false,
      local: {
        control_plane_poll_health: {
          reason: 'no live admin UI system snapshot',
          state: 'unknown',
        },
        process_running: false,
        runtime_state: 'stopped',
      },
      process: {
        mode: 'stopped',
        target_kind: 'server_url',
        target_value: 'http://127.0.0.1:18765/mcp',
        tunnel_id: 'tunnel_fixture013345',
      },
      process_running: false,
      profile_exists: true,
      ready: false,
      runtime_state: 'stopped',
      tunnel_id: 'tunnel_fixture013345',
      ui_url: '',
    }))).toEqual(expect.objectContaining({
      exists: true,
      running: false,
      healthy: false,
      ready: false,
      pollHealthy: null,
      tunnelId: 'tunnel_fixture013345',
      mcpServerUrl: 'http://127.0.0.1:18765/mcp',
      pid: null,
      uiUrl: null,
    }));
  });
});
