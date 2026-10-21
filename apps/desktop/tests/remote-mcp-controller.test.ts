import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_REMOTE_MCP_STATUS, type RemoteMcpStatus } from '@lnwjing/ipc-contracts';
import { createExplicitKeySecretProtector } from '@lnwjing/shared';
import { buildNgrokHttpArgs, enforceStablePublicOrigin, extractNgrokDiagnostic, formatNgrokExitMessage, normalizeConfiguredPublicOrigin, posixExecutableCandidates, RemoteMcpController, resolveManagedNgrokExecutable, resolveNgrokExecutable, selectRecoverableStaleNgrokProcess, verifyExternalPublicOrigin, type RemoteMcpPersistedState } from '../src/main/remote-mcp-controller.js';

interface RemoteMcpTestAccess {
  gatewayUrl: string | null;
  publicOrigin: string | null;
  configuredNgrokOrigin: string | null;
  configuredExternalOrigin: string | null;
  runState: 'stopped' | 'installing' | 'starting' | 'running' | 'error';
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  clients: Map<string, unknown>;
  authCodes: Map<string, { readonly clientId: string; readonly expiresAt: number }>;
  accessTokens: Map<string, { readonly clientId: string; readonly expiresAt: number }>;
  refreshTokens: Map<string, { readonly clientId: string; readonly expiresAt: number }>;
  ensurePersistenceLoaded(): Promise<void>;
  scheduleReconnect(reason: string): void;
  startInternal(): Promise<RemoteMcpStatus>;
  startGateway(): Promise<void>;
}

const UNUSED_DATA_PATH = path.join(os.tmpdir(), 'lnwjing-remote-mcp-test-unused', String(process.pid));
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await rm(UNUSED_DATA_PATH, { recursive: true, force: true });
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function completeChatGptLocalApproval(response: Response, publicOrigin: string, redirectUri: string, state: string): Promise<string> {
  expect(response.status).toBe(302);
  const localApproval = new URL(response.headers.get('location')!);
  expect(localApproval.protocol).toBe('http:');
  expect(localApproval.hostname).toBe('127.0.0.1');
  expect(localApproval.pathname).toMatch(/^\/oauth\/chatgpt-local-approve\/[A-Za-z0-9_-]+$/);
  expect(localApproval.searchParams.get('code')).toBeNull();

  const publicReplay = await fetch(`${publicOrigin}${localApproval.pathname}`, { redirect: 'manual' });
  expect(publicReplay.status).toBe(404);

  const confirmation = await fetch(localApproval, { redirect: 'manual' });
  expect(confirmation.status).toBe(200);
  expect(await confirmation.text()).toContain('Approve ChatGPT connection?');

  const approved = await fetch(localApproval, { method: 'POST', redirect: 'manual' });
  expect(approved.status).toBe(302);
  const callback = new URL(approved.headers.get('location')!);
  expect(callback.origin + callback.pathname).toBe(redirectUri);
  expect(callback.searchParams.get('state')).toBe(state);
  const code = callback.searchParams.get('code');
  expect(code).toBeTruthy();

  const replay = await fetch(localApproval, { redirect: 'manual' });
  expect(replay.status).toBe(410);
  return code!;
}

describe('Remote MCP ngrok runtime', () => {
  it('starts without --url before a stable public origin has been learned', () => {
    const gateway = 'http://127.0.0.1:32123';
    expect(buildNgrokHttpArgs(gateway)).toEqual(['http', gateway, '--metadata=lnwjing-remote-mcp', '--log=stdout', '--log-format=json']);
    expect(buildNgrokHttpArgs(gateway).some((value) => value.startsWith('--web-addr') || value === '--url')).toBe(false);
  });

  it('reuses a remembered ngrok public origin with the v3 --url flag', () => {
    const gateway = 'http://127.0.0.1:32123';
    expect(buildNgrokHttpArgs(gateway, 'https://steady.ngrok-free.app')).toEqual([
      'http', gateway, '--url', 'https://steady.ngrok-free.app', '--metadata=lnwjing-remote-mcp', '--log=stdout', '--log-format=json',
    ]);
  });

  it('normalizes only explicit public ngrok domains and rejects unsafe values', () => {
    expect(normalizeConfiguredPublicOrigin('steady.ngrok-free.app')).toBe('https://steady.ngrok-free.app');
    expect(normalizeConfiguredPublicOrigin(' https://steady.ngrok-free.app/ ')).toBe('https://steady.ngrok-free.app');
    expect(normalizeConfiguredPublicOrigin('')).toBeNull();
    expect(() => normalizeConfiguredPublicOrigin('http://steady.ngrok-free.app')).toThrow(/valid HTTPS/i);
    expect(() => normalizeConfiguredPublicOrigin('https://steady.ngrok-free.app/path')).toThrow(/valid HTTPS/i);
    expect(() => normalizeConfiguredPublicOrigin('https://127.0.0.1')).toThrow(/public hostname/i);
  });

  it('accepts the configured ngrok origin but rejects silent public URL drift', () => {
    expect(enforceStablePublicOrigin('https://steady.ngrok-free.app/', null)).toBe('https://steady.ngrok-free.app');
    expect(enforceStablePublicOrigin('https://steady.ngrok-free.app', 'https://steady.ngrok-free.app')).toBe('https://steady.ngrok-free.app');
    expect(() => enforceStablePublicOrigin('https://changed.ngrok-free.app', 'https://steady.ngrok-free.app')).toThrow(/explicitly configured/i);
    expect(() => enforceStablePublicOrigin('http://steady.ngrok-free.app', null)).toThrow(/invalid public HTTPS origin/i);
  });

  it('parses POSIX PATH with POSIX semantics even when the test host is Windows', () => {
    expect(posixExecutableCandidates('ngrok', 'linux', { PATH: '/custom/bin:relative:/opt/tools' })).toEqual([
      '/custom/bin/ngrok',
      '/opt/tools/ngrok',
      '/usr/local/bin/ngrok',
      '/usr/bin/ngrok',
      '/snap/bin/ngrok',
    ]);
    expect(posixExecutableCandidates('brew', 'darwin', { PATH: '/custom/bin;/wrong/windows-style:/usr/local/bin' })).toEqual([
      '/custom/bin;/wrong/windows-style/brew',
      '/usr/local/bin/brew',
      '/opt/homebrew/bin/brew',
    ]);
  });

  it.each(['darwin', 'linux'] as const)('resolves a validated ngrok executable from the %s PATH without Windows tools on a POSIX host', async (platform) => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-ngrok-path-'));
    try {
      const executable = path.join(root, 'ngrok');
      await writeFile(executable, 'fixture', 'utf8');
      await chmod(executable, 0o755).catch(() => undefined);
      const canonical = await realpath(executable);
      const runner = vi.fn(async (command: string, args: readonly string[]): Promise<string> => {
        expect(command).toBe(canonical);
        expect(args).toEqual(['version']);
        return 'ngrok version 3.30.0';
      });
      await expect(resolveNgrokExecutable(platform, { PATH: root }, runner)).resolves.toBe(canonical);
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prefers a validated user-owned managed ngrok copy on Windows', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-managed-ngrok-'));
    try {
      const managed = path.join(root, 'runtime-tools', 'ngrok', 'ngrok.exe');
      await mkdir(path.dirname(managed), { recursive: true });
      await writeFile(managed, 'fixture', 'utf8');
      const runner = vi.fn(async (command: string, args: readonly string[]): Promise<string> => {
        expect(command).toBe(managed);
        expect(args).toEqual(['version']);
        return 'ngrok version 3.30.0';
      });
      await expect(resolveManagedNgrokExecutable(root, 'win32', {}, runner)).resolves.toBe(managed);
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the actionable ngrok diagnostic instead of replacing it with exit 1', () => {
    const diagnostic = extractNgrokDiagnostic('ERROR:  unknown flag: --web-addr');
    expect(diagnostic).toBe('ERROR:  unknown flag: --web-addr');
    expect(formatNgrokExitMessage(1, diagnostic)).toBe('ngrok stopped unexpectedly (exit 1): ERROR:  unknown flag: --web-addr');
  });

  it('extracts JSON ngrok errors and redacts token-like values', () => {
    const diagnostic = extractNgrokDiagnostic(JSON.stringify({ lvl: 'eror', msg: 'authentication failed token=super-secret-value' }));
    expect(diagnostic).toContain('authentication failed');
    expect(diagnostic).not.toContain('super-secret-value');
  });

  it('prefers the actual ERR_NGROK failure over split ERROR markers and docs URLs', () => {
    const diagnostic = extractNgrokDiagnostic([
      'ERROR:',
      JSON.stringify({ lvl: 'eror', msg: 'session closing', err: "failed to start tunnel: The endpoint 'https://example.ngrok-free.dev' is already online. ERR_NGROK_334" }),
      'ERROR:  https://ngrok.com/docs/errors/err_ngrok_334',
    ].join('\n'));
    expect(diagnostic).toContain('failed to start tunnel');
    expect(diagnostic).toContain('ERR_NGROK_334');
    expect(diagnostic).not.toBe('ERROR:');
    expect(diagnostic).not.toContain('/docs/errors/');
  });

  it('recovers only one orphaned lnwjing-style ngrok process for the exact dead gateway target', () => {
    const target = 'http://127.0.0.1:54894';
    const orphan = { processId: 13164, parentProcessId: 14372, parentAlive: false, commandLine: `C:\\WindowsApps\\ngrok.exe http ${target} --metadata=lnwjing-remote-mcp --log=stdout --log-format=json` };
    expect(selectRecoverableStaleNgrokProcess([orphan], target)).toEqual(orphan);
    expect(selectRecoverableStaleNgrokProcess([{ ...orphan, parentAlive: true }], target)).toBeNull();
    expect(selectRecoverableStaleNgrokProcess([{ ...orphan, commandLine: `ngrok.exe http ${target} --log=stdout --log-format=json` }], target)).toBeNull();
    expect(selectRecoverableStaleNgrokProcess([{ ...orphan, commandLine: `ngrok.exe http ${target}` }], target)).toBeNull();
    expect(selectRecoverableStaleNgrokProcess([orphan], 'http://127.0.0.1:60000')).toBeNull();
    expect(selectRecoverableStaleNgrokProcess([orphan, { ...orphan, processId: 13165 }], target)).toBeNull();
    const pinnedOrphan = { ...orphan, processId: 20100, commandLine: `ngrok.exe http ${target} --url https://steady.ngrok-free.app --metadata=lnwjing-remote-mcp --log=stdout --log-format=json` };
    expect(selectRecoverableStaleNgrokProcess([pinnedOrphan], target)).toEqual(pinnedOrphan);
    const posixOrphan = { ...orphan, processId: 20101, commandLine: `/opt/homebrew/bin/ngrok http ${target} --url https://steady.ngrok-free.app --metadata=lnwjing-remote-mcp --log=stdout --log-format=json` };
    expect(selectRecoverableStaleNgrokProcess([posixOrphan], target)).toEqual(posixOrphan);
  });
});

describe('Remote MCP OAuth gateway', () => {
  it('does not overwrite unreadable authorization and retries loading after secure storage recovers', async () => {
    const state: RemoteMcpPersistedState = {
      schemaVersion: 2, desiredRunning: true, configuredPublicOrigin: 'https://steady.ngrok-free.app',
      trustedClients: [{ clientId: 'saved-client', clientName: 'Saved client', redirectUris: ['https://example.com/callback'], tokenEndpointAuthMethod: 'none', clientSecret: null }],
      refreshGrants: [{ clientId: 'saved-client', refreshToken: 'r'.repeat(40), expiresAt: Date.parse('2099-01-01') }],
    };
    let locked = true;
    const load = vi.fn(async () => {
      if (locked) throw new Error('Secure storage is locked');
      return state;
    });
    const save = vi.fn(async () => undefined);
    const controller = new RemoteMcpController({ dataPath: UNUSED_DATA_PATH, getLocalMcpUrl: async (): Promise<null> => null, persistence: { load, save } });
    const internal = controller as unknown as RemoteMcpTestAccess & { ensurePersistenceLoaded(): Promise<void>; persistState(): Promise<void> };
    await internal.ensurePersistenceLoaded();
    await internal.persistState();
    expect(save).not.toHaveBeenCalled();
    locked = false;
    await Promise.all([internal.ensurePersistenceLoaded(), internal.ensurePersistenceLoaded()]);
    expect(internal.configuredNgrokOrigin).toBe('https://steady.ngrok-free.app');
    expect(internal.configuredExternalOrigin).toBeNull();
    await internal.persistState();
    expect(load).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 3,
      desiredRunning: true,
      transport: 'ngrok',
      externalGatewayPort: null,
      configuredPublicOrigin: 'https://steady.ngrok-free.app',
      configuredNgrokOrigin: 'https://steady.ngrok-free.app',
      configuredExternalOrigin: null,
      trustedClients: state.trustedClients,
      refreshGrants: state.refreshGrants,
      registeredClients: [expect.objectContaining({ clientId: 'saved-client', trusted: true })],
    }));
  });

  it('migrates schema-1 state without treating an observed runtime origin as configured', async () => {
    const load = vi.fn(async (): Promise<RemoteMcpPersistedState> => ({
      schemaVersion: 1,
      desiredRunning: false,
      publicOrigin: 'https://observed.ngrok-free.app',
      trustedClients: [],
      refreshGrants: [],
    }));
    const save = vi.fn(async () => undefined);
    const controller = new RemoteMcpController({ dataPath: UNUSED_DATA_PATH, getLocalMcpUrl: async (): Promise<null> => null, persistence: { load, save } });
    const internal = controller as unknown as RemoteMcpTestAccess & { ensurePersistenceLoaded(): Promise<void>; persistState(): Promise<void> };
    await internal.ensurePersistenceLoaded();
    expect(internal.configuredNgrokOrigin).toBeNull();
    expect(internal.configuredExternalOrigin).toBeNull();
    await internal.persistState();
    expect(save).toHaveBeenCalledWith({ schemaVersion: 3, desiredRunning: false, transport: 'ngrok', externalGatewayPort: null, configuredPublicOrigin: null, configuredNgrokOrigin: null, configuredExternalOrigin: null, registeredClients: [], trustedClients: [], refreshGrants: [] });
  });

  it('ignores an invalid legacy observed public origin from encrypted schema-1 state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-remote-mcp-invalid-origin-'));
    try {
      const secretProtector = createExplicitKeySecretProtector(Buffer.alloc(32, 0x52));
      const directory = path.join(root, 'remote-mcp');
      await mkdir(directory, { recursive: true });
      const encrypted = await secretProtector.encrypt('tunnel_api_key', JSON.stringify({
        schemaVersion: 1,
        desiredRunning: false,
        publicOrigin: 'https://steady.ngrok-free.app/path?bad=1',
        trustedClients: [],
        refreshGrants: [],
      }));
      await writeFile(path.join(directory, 'oauth-state.secret'), encrypted, 'utf8');
      const controller = new RemoteMcpController({ dataPath: root, getLocalMcpUrl: async (): Promise<null> => null, secretProtector });
      const internal = controller as unknown as RemoteMcpTestAccess & { ensurePersistenceLoaded(): Promise<void> };
      await internal.ensurePersistenceLoaded();
      expect(internal.configuredNgrokOrigin).toBeNull();
      expect(internal.configuredExternalOrigin).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists only an explicitly configured static domain', async () => {
    const load = vi.fn(async (): Promise<RemoteMcpPersistedState> => ({ schemaVersion: 2, desiredRunning: false, configuredPublicOrigin: null, trustedClients: [], refreshGrants: [] }));
    const save = vi.fn(async () => undefined);
    const controller = new RemoteMcpController({ dataPath: UNUSED_DATA_PATH, getLocalMcpUrl: async (): Promise<null> => null, persistence: { load, save } });
    const status = await controller.savePublicOrigin('steady.ngrok-free.app');
    expect(status.configuredPublicOrigin).toBe('https://steady.ngrok-free.app');
    expect(save).toHaveBeenCalledWith({ schemaVersion: 3, desiredRunning: false, transport: 'ngrok', externalGatewayPort: null, configuredPublicOrigin: 'https://steady.ngrok-free.app', configuredNgrokOrigin: 'https://steady.ngrok-free.app', configuredExternalOrigin: null, registeredClients: [], trustedClients: [], refreshGrants: [] });
  });

  it('does not replace the ngrok authtoken when encrypted Remote MCP state cannot be loaded', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-remote-mcp-token-load-failure-'));
    try {
      const save = vi.fn(async () => undefined);
      const controller = new RemoteMcpController({
        dataPath: root,
        getLocalMcpUrl: async (): Promise<null> => null,
        persistence: { load: async (): Promise<RemoteMcpPersistedState | null> => { throw new Error('Secure storage is locked'); }, save },
        secretProtector: createExplicitKeySecretProtector(Buffer.alloc(32, 0x53)),
      });
      await expect(controller.saveAuthtoken('a'.repeat(24))).rejects.toThrow(/authtoken was not changed/i);
      expect(save).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an explicitly configured static domain when the ngrok authtoken is saved again', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-remote-mcp-origin-token-update-'));
    try {
      const state: RemoteMcpPersistedState = { schemaVersion: 2, desiredRunning: false, configuredPublicOrigin: 'https://steady.ngrok-free.app', trustedClients: [], refreshGrants: [] };
      const load = vi.fn(async () => state);
      const save = vi.fn(async () => undefined);
      const controller = new RemoteMcpController({
        dataPath: root,
        getLocalMcpUrl: async (): Promise<null> => null,
        persistence: { load, save },
        secretProtector: createExplicitKeySecretProtector(Buffer.alloc(32, 0x51)),
      });
      await controller.saveAuthtoken('a'.repeat(24));
      expect(save).toHaveBeenCalledWith({ schemaVersion: 3, desiredRunning: false, transport: 'ngrok', externalGatewayPort: null, configuredPublicOrigin: 'https://steady.ngrok-free.app', configuredNgrokOrigin: 'https://steady.ngrok-free.app', configuredExternalOrigin: null, registeredClients: [], trustedClients: [], refreshGrants: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the legacy ngrok domain while Cloudflare uses an independent external origin', async () => {
    let persisted: RemoteMcpPersistedState | null = {
      schemaVersion: 2, desiredRunning: false, configuredPublicOrigin: 'https://steady.ngrok-free.app',
      trustedClients: [], refreshGrants: [],
    };
    const save = vi.fn(async (state: RemoteMcpPersistedState): Promise<void> => { persisted = state; });
    const controller = new RemoteMcpController({
      dataPath: UNUSED_DATA_PATH,
      getLocalMcpUrl: async (): Promise<string> => 'http://127.0.0.1:32123/mcp',
      persistence: { load: async (): Promise<RemoteMcpPersistedState | null> => persisted, save },
    });
    const selected = await controller.setTransport('cloudflare');
    expect(selected.transport).toBe('cloudflare');
    expect(selected.configuredPublicOrigin).toBeNull();
    expect(selected.configuredGatewayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(selected.ngrokPath).toBeNull();

    const external = await controller.savePublicOrigin('https://mcp.example.com');
    expect(external.configuredPublicOrigin).toBe('https://mcp.example.com');
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      schemaVersion: 3,
      transport: 'cloudflare',
      configuredPublicOrigin: 'https://mcp.example.com',
      configuredNgrokOrigin: 'https://steady.ngrok-free.app',
      configuredExternalOrigin: 'https://mcp.example.com',
      externalGatewayPort: expect.any(Number),
    }));

    expect((await controller.setTransport('ngrok')).configuredPublicOrigin).toBe('https://steady.ngrok-free.app');
    expect((await controller.setTransport('cloudflare')).configuredPublicOrigin).toBe('https://mcp.example.com');
  });

  it('never installs ngrok when Cloudflare, Custom URL, or Local MCP is selected', async () => {
    for (const transport of ['cloudflare', 'custom', 'local'] as const) {
      let persisted: RemoteMcpPersistedState | null = {
        schemaVersion: 3,
        desiredRunning: false,
        transport,
        externalGatewayPort: transport === 'local' ? null : 18766,
        configuredPublicOrigin: transport === 'local' ? null : 'https://mcp.example.com',
        registeredClients: [], trustedClients: [], refreshGrants: [],
      };
      const controller = new RemoteMcpController({
        dataPath: UNUSED_DATA_PATH,
        getLocalMcpUrl: async (): Promise<null> => null,
        persistence: {
          load: async (): Promise<RemoteMcpPersistedState | null> => persisted,
          save: async (state: RemoteMcpPersistedState): Promise<void> => { persisted = state; },
        },
      });
      await expect(controller.installProvider()).rejects.toThrow(/only when.*transport.*ngrok/i);
      expect((await controller.status()).transport).toBe(transport);
    }
  });

  it('verifies external OAuth metadata against the exact configured origin', async () => {
    const fetcher = vi.fn(async (): Promise<Response> => new Response(JSON.stringify({
      issuer: 'https://mcp.example.com',
      authorization_endpoint: 'https://mcp.example.com/oauth/authorize',
      token_endpoint: 'https://mcp.example.com/oauth/token',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(verifyExternalPublicOrigin('https://mcp.example.com', 1_000, fetcher as typeof fetch)).resolves.toBe(true);
    const wrong = vi.fn(async (): Promise<Response> => new Response(JSON.stringify({ issuer: 'https://evil.example' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(verifyExternalPublicOrigin('https://mcp.example.com', 1_000, wrong as typeof fetch)).resolves.toBe(false);
  });

  it('keeps schema-v2 users on ngrok and allows opt-in Local MCP without ngrok', async () => {
    let persisted: RemoteMcpPersistedState | null = {
      schemaVersion: 2, desiredRunning: false, configuredPublicOrigin: 'https://steady.ngrok-free.app',
      trustedClients: [], refreshGrants: [],
    };
    const save = vi.fn(async (state: RemoteMcpPersistedState): Promise<void> => { persisted = state; });
    const ensureLocalMcpUrl = vi.fn(async (): Promise<string> => 'http://127.0.0.1:32123/mcp');
    const controller = new RemoteMcpController({
      dataPath: UNUSED_DATA_PATH,
      getLocalMcpUrl: async (): Promise<string> => 'http://127.0.0.1:32123/mcp',
      ensureLocalMcpUrl,
      persistence: { load: async (): Promise<RemoteMcpPersistedState | null> => persisted, save },
    });
    expect((await controller.status()).transport).toBe('ngrok');
    const selected = await controller.setTransport('local');
    expect(selected.transport).toBe('local');
    expect(selected.configuredPublicOrigin).toBeNull();
    expect(selected.configuredGatewayUrl).toBeNull();
    const running = await controller.start();
    expect(running).toMatchObject({ state: 'running', transport: 'local', oauthProtected: false, publicMcpUrl: null, localMcpUrl: 'http://127.0.0.1:32123/mcp' });
    expect(ensureLocalMcpUrl).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 3, transport: 'local', configuredPublicOrigin: null, configuredNgrokOrigin: 'https://steady.ngrok-free.app', configuredExternalOrigin: null }));
    await controller.stop();
    expect((await controller.setTransport('ngrok')).configuredPublicOrigin).toBe('https://steady.ngrok-free.app');
  });

  it('persists pending DCR before 201 and restores it after Desktop restart', async () => {
    let persisted: RemoteMcpPersistedState | null = null;
    const persistence = {
      load: async (): Promise<RemoteMcpPersistedState | null> => persisted,
      save: vi.fn(async (state: RemoteMcpPersistedState): Promise<void> => { persisted = structuredClone(state); }),
    };
    const redirectUri = 'https://chatgpt.com/connector/oauth/plugin-persisted_123';
    const first = new RemoteMcpController({ dataPath: UNUSED_DATA_PATH, getLocalMcpUrl: async (): Promise<string> => 'http://127.0.0.1:32123/mcp', persistence });
    const firstInternal = first as unknown as RemoteMcpTestAccess;
    await firstInternal.ensurePersistenceLoaded();
    await firstInternal.startGateway();
    firstInternal.publicOrigin = firstInternal.gatewayUrl;
    firstInternal.runState = 'running';
    const registration = await fetch(firstInternal.gatewayUrl! + '/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [redirectUri] }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { client_id: string };
    expect(persisted).toMatchObject({ schemaVersion: 3, transport: 'ngrok', registeredClients: [expect.objectContaining({ clientId: registered.client_id, trusted: false })] });
    persisted = { ...persisted!, desiredRunning: true };
    await first.close();

    const second = new RemoteMcpController({ dataPath: UNUSED_DATA_PATH, getLocalMcpUrl: async (): Promise<string> => 'http://127.0.0.1:32123/mcp', persistence });
    const startSpy = vi.spyOn(second, 'start').mockResolvedValue({ ...EMPTY_REMOTE_MCP_STATUS, state: 'running', provider: 'ngrok', transport: 'ngrok' });
    await second.autoStartIfDesired();
    expect(startSpy).toHaveBeenCalledOnce();
    startSpy.mockRestore();
    const secondInternal = second as unknown as RemoteMcpTestAccess;
    await secondInternal.ensurePersistenceLoaded();
    await secondInternal.startGateway();
    secondInternal.publicOrigin = secondInternal.gatewayUrl;
    secondInternal.runState = 'running';
    const verifier = 'p'.repeat(64);
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const authorize = new URL(secondInternal.gatewayUrl! + '/oauth/authorize');
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', registered.client_id);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('state', 'persisted-state');
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    const approval = await fetch(authorize, { redirect: 'manual' });
    expect(approval.status).toBe(302);
    expect(new URL(approval.headers.get('location')!).hostname).toBe('127.0.0.1');
    await second.close();
  });

  it('recovers a lost legacy ChatGPT client only with exact resource and still requires local approval', async () => {
    const controller = new RemoteMcpController({
      dataPath: UNUSED_DATA_PATH,
      getLocalMcpUrl: async (): Promise<string> => 'http://127.0.0.1:32123/mcp',
      persistence: { load: async (): Promise<null> => null, save: async (): Promise<void> => undefined },
    });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway();
    internal.publicOrigin = internal.gatewayUrl;
    internal.runState = 'running';
    const origin = internal.gatewayUrl!;
    const redirectUri = 'https://chatgpt.com/connector/oauth/plugin-recover_123';
    const challenge = createHash('sha256').update('r'.repeat(64), 'ascii').digest('base64url');
    const buildAuthorize = (resource: string): URL => {
      const url = new URL(origin + '/oauth/authorize');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', 'lost_client_1234567890');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', 'legacy-recovery-state');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('resource', resource);
      return url;
    };
    expect((await fetch(buildAuthorize(origin + '/wrong'), { redirect: 'manual' })).status).toBe(400);
    expect(internal.clients.size).toBe(0);
    const recovered = await fetch(buildAuthorize(origin + '/mcp'), { redirect: 'manual' });
    expect(recovered.status).toBe(302);
    const localApproval = new URL(recovered.headers.get('location')!);
    expect(localApproval.hostname).toBe('127.0.0.1');
    expect(localApproval.searchParams.get('code')).toBeNull();
    expect(internal.clients.size).toBe(1);
    await controller.close();
  });

  it('deduplicates concurrent Remote MCP starts and releases the start gate after completion', async () => {
    let resolveStart: ((status: RemoteMcpStatus) => void) | undefined;
    const pendingStart = new Promise<RemoteMcpStatus>((resolve) => { resolveStart = resolve; });
    const runningStatus = { ...EMPTY_REMOTE_MCP_STATUS, state: 'running' as const, oauthConnected: true, autoStartEnabled: true };
    const controller = new RemoteMcpController({
      dataPath: UNUSED_DATA_PATH,
      getLocalMcpUrl: async (): Promise<null> => null,
      persistence: { load: async (): Promise<null> => null, save: async (): Promise<void> => undefined },
    });
    const internal = controller as unknown as RemoteMcpTestAccess;
    const startInternalSpy = vi.spyOn(internal, 'startInternal').mockReturnValue(pendingStart);
    try {
      const first = controller.start();
      const second = controller.start();
      await vi.waitFor(() => expect(startInternalSpy).toHaveBeenCalledTimes(1));

      resolveStart?.(runningStatus);
      await expect(Promise.all([first, second])).resolves.toEqual([runningStatus, runningStatus]);

      await expect(controller.start()).resolves.toEqual(runningStatus);
      expect(startInternalSpy).toHaveBeenCalledTimes(2);
    } finally {
      startInternalSpy.mockRestore();
      await controller.close();
    }
  });

  it('retries desired Remote MCP before first trusted client and manual stop cancels the pending retry', async () => {
    vi.useFakeTimers();
    const persisted: RemoteMcpPersistedState = {
      schemaVersion: 2,
      desiredRunning: true,
      configuredPublicOrigin: null,
      trustedClients: [],
      refreshGrants: [],
    };
    const controller = new RemoteMcpController({
      dataPath: UNUSED_DATA_PATH,
      getLocalMcpUrl: async (): Promise<null> => null,
      persistence: { load: async (): Promise<RemoteMcpPersistedState> => persisted, save: async (): Promise<void> => undefined },
    });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.ensurePersistenceLoaded();
    const runningStatus = { ...EMPTY_REMOTE_MCP_STATUS, state: 'running' as const, oauthConnected: false, autoStartEnabled: true };
    const statusSpy = vi.spyOn(controller, 'status').mockResolvedValue(runningStatus);
    const startSpy = vi.spyOn(controller, 'start').mockImplementation(async () => {
      internal.runState = 'running';
      return runningStatus;
    });
    try {
      internal.runState = 'error';
      internal.scheduleReconnect('ngrok exited unexpectedly');
      expect(internal.reconnectTimer).not.toBeNull();
      expect(internal.reconnectAttempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(startSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(startSpy).toHaveBeenCalledTimes(1);

      internal.runState = 'error';
      internal.scheduleReconnect('ngrok exited again');
      expect(internal.reconnectTimer).not.toBeNull();
      await controller.stop();
      expect(internal.reconnectTimer).toBeNull();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(startSpy).toHaveBeenCalledTimes(1);
    } finally {
      startSpy.mockRestore();
      statusSpy.mockRestore();
      await controller.close();
      vi.useRealTimers();
    }
  });

  it('keeps status reads side-effect-free and does not ensure-start Local MCP', async () => {
    let statusReads = 0;
    let ensureStarts = 0;
    const controller = new RemoteMcpController({
      dataPath: 'C:\\tmp\\lnwjing-remote-mcp-status-test',
      getLocalMcpUrl: async (): Promise<null> => {
        statusReads += 1;
        return null;
      },
      ensureLocalMcpUrl: async (): Promise<string> => {
        ensureStarts += 1;
        return 'http://127.0.0.1:32123/mcp';
      },
    });

    const status = await controller.status();

    expect(status.localMcpUrl).toBeNull();
    expect(statusReads).toBe(1);
    expect(ensureStarts).toBe(0);
  });

  it('requires explicit first-use local approval, then reauthorizes a trusted ChatGPT client without another approval hop and proxies authorized /mcp requests', async () => {
    let upstreamAuthorization: string | undefined;
    const firstUpstreamOrigin = await listen(createServer((request, response) => {
      upstreamAuthorization = request.headers.authorization;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, source: 'first', path: request.url }));
    }));
    const secondUpstreamOrigin = await listen(createServer((request, response) => {
      upstreamAuthorization = request.headers.authorization;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, source: 'second', path: request.url }));
    }));
    let localMcpUrl: string | null = `${firstUpstreamOrigin}/mcp`;
    const recoveredLocalMcpUrl = `${secondUpstreamOrigin}/mcp`;
    const ensureLocalMcpUrl = vi.fn(async (): Promise<string> => localMcpUrl ?? recoveredLocalMcpUrl);
    const controller = new RemoteMcpController({
      dataPath: 'C:\\tmp\\lnwjing-remote-mcp-test',
      getLocalMcpUrl: async (): Promise<string | null> => localMcpUrl,
      ensureLocalMcpUrl,
    });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway();
    expect(internal.gatewayUrl).not.toBeNull();
    internal.publicOrigin = internal.gatewayUrl;
    internal.runState = 'running';
    const origin = internal.gatewayUrl!;

    const unauthorized = await fetch(`${origin}/mcp`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');

    const redirectUri = 'https://chatgpt.com/connector/oauth/plugin-fixture_123';
    const registration = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [redirectUri] }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { client_id: string };

    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const authorize = new URL(`${origin}/oauth/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', registered.client_id);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('state', 'fixture-state');
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    const approvalRedirect = await fetch(authorize, { redirect: 'manual' });
    const code = await completeChatGptLocalApproval(approvalRedirect, origin, redirectUri, 'fixture-state');

    const trustedReauthorize = await fetch(authorize, { redirect: 'manual' });
    expect(trustedReauthorize.status).toBe(302);
    const trustedReauthorizeLocation = new URL(trustedReauthorize.headers.get('location')!);
    expect(trustedReauthorizeLocation.origin + trustedReauthorizeLocation.pathname).toBe(redirectUri);
    expect(trustedReauthorizeLocation.searchParams.get('code')).toBeTruthy();

    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: code!, client_id: registered.client_id,
        redirect_uri: redirectUri, code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    expect(tokens.access_token.length).toBeGreaterThan(30);
    expect(tokens.refresh_token.length).toBeGreaterThan(30);

    const authorized = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ ok: true, source: 'first', path: '/mcp' });
    expect(upstreamAuthorization).toBeUndefined();

    localMcpUrl = null;
    const recovered = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ ok: true, source: 'second', path: '/mcp' });
    expect(ensureLocalMcpUrl).toHaveBeenCalledTimes(2);
    expect(upstreamAuthorization).toBeUndefined();

    await controller.close();
  });

  it.each([
    'https://chatgpt.com.evil.example/aip/oauth/callback',
    'https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector/oauth/plugin/extra',
  ])('fails closed for clients that do not match the exact ChatGPT callback contract: %s', async (redirectUri) => {
    const upstreamOrigin = await listen(createServer((_request, response) => response.end('{}')));
    const controller = new RemoteMcpController({ dataPath: 'C:\\tmp\\lnwjing-remote-mcp-unsupported-client-test', getLocalMcpUrl: async (): Promise<string> => `${upstreamOrigin}/mcp` });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway();
    internal.publicOrigin = internal.gatewayUrl;
    internal.runState = 'running';
    const origin = internal.gatewayUrl!;

    const registration = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [redirectUri] }),
    });
    const registered = await registration.json() as { client_id: string };
    const verifier = 'f'.repeat(64);
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const authorize = new URL(`${origin}/oauth/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', registered.client_id);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('state', 'unsupported-state');
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');

    const rejected = await fetch(authorize, { redirect: 'manual' });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toEqual({
      error: 'access_denied',
      error_description: 'This OAuth client is not supported by lnwjing Desktop. Connect from ChatGPT so authorization can complete through the local Desktop handoff.',
    });
    await controller.close();
  });

  it('accepts ChatGPT-style DCR metadata with client_secret_post and validates the client secret at the token endpoint', async () => {
    const upstreamOrigin = await listen(createServer((_request, response) => response.end('{}')));
    const controller = new RemoteMcpController({ dataPath: 'C:\\tmp\\lnwjing-remote-mcp-chatgpt-dcr-test', getLocalMcpUrl: async (): Promise<string> => `${upstreamOrigin}/mcp` });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway();
    internal.publicOrigin = internal.gatewayUrl;
    const origin = internal.gatewayUrl!;
    const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';

    const registration = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as {
      client_id: string;
      client_secret: string;
      client_id_issued_at: number;
      client_secret_expires_at: number;
      token_endpoint_auth_method: string;
      grant_types: string[];
      response_types: string[];
    };
    expect(registered.client_id.length).toBeGreaterThan(20);
    expect(registered.client_secret.length).toBeGreaterThan(30);
    expect(registered.client_id_issued_at).toBeGreaterThan(0);
    expect(registered.client_secret_expires_at).toBe(0);
    expect(registered.token_endpoint_auth_method).toBe('client_secret_post');
    expect(registered.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(registered.response_types).toEqual(['code']);

    const verifier = 's'.repeat(64);
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const approvalRedirect = await fetch(`${origin}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        response_type: 'code', client_id: registered.client_id, redirect_uri: redirectUri,
        state: 'chatgpt-fixture-state', code_challenge: challenge, code_challenge_method: 'S256',
      }),
    });
    const code = await completeChatGptLocalApproval(approvalRedirect, origin, redirectUri, 'chatgpt-fixture-state');

    const missingSecret = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, client_id: registered.client_id, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    expect(missingSecret.status).toBe(401);
    expect(await missingSecret.json()).toEqual({ error: 'invalid_client' });

    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: code!, client_id: registered.client_id, client_secret: registered.client_secret,
        redirect_uri: redirectUri, code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    expect(tokens.access_token.length).toBeGreaterThan(30);
    expect(tokens.refresh_token.length).toBeGreaterThan(30);
    await controller.close();
  });

  it('bounds unauthenticated DCR state and prunes expired OAuth state', async () => {
    const upstreamOrigin = await listen(createServer((_request, response) => response.end('{}')));
    let now = 1_800_000_000_000;
    const controller = new RemoteMcpController({
      dataPath: 'C:\\tmp\\lnwjing-remote-mcp-dcr-bound-test',
      getLocalMcpUrl: async (): Promise<string> => `${upstreamOrigin}/mcp`,
      now: (): number => now,
    });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway();
    internal.publicOrigin = internal.gatewayUrl;
    const origin = internal.gatewayUrl!;
    const register = async (): Promise<Response> => fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }),
    });

    for (let index = 0; index < 64; index += 1) expect((await register()).status).toBe(201);
    expect(internal.clients.size).toBe(64);
    const rejected = await register();
    expect(rejected.status).toBe(429);
    await expect(rejected.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });

    now += 10 * 60_000 + 1;
    const recovered = await register();
    expect(recovered.status).toBe(201);
    const recoveredClient = await recovered.json() as { client_id: string };
    expect(internal.clients.size).toBe(1);

    internal.authCodes.set('expired-code', { clientId: recoveredClient.client_id, expiresAt: now - 1 });
    internal.authCodes.set('live-code', { clientId: recoveredClient.client_id, expiresAt: now + 60_000 });
    internal.accessTokens.set('expired-access', { clientId: recoveredClient.client_id, expiresAt: now - 1 });
    internal.accessTokens.set('live-access', { clientId: recoveredClient.client_id, expiresAt: now + 60_000 });
    internal.refreshTokens.set('expired-refresh', { clientId: recoveredClient.client_id, expiresAt: now - 1 });
    internal.refreshTokens.set('live-refresh', { clientId: recoveredClient.client_id, expiresAt: now + 60_000 });

    expect((await fetch(`${origin}/.well-known/oauth-authorization-server`)).status).toBe(200);
    expect([...internal.authCodes.keys()]).toEqual(['live-code']);
    expect([...internal.accessTokens.keys()]).toEqual(['live-access']);
    expect([...internal.refreshTokens.keys()]).toEqual(['live-refresh']);
    await controller.close();
  });

  it('returns an OAuth client-metadata error instead of HTTP 500 for malformed DCR JSON', async () => {
    const upstreamOrigin = await listen(createServer((_request, response) => response.end('{}')));
    const controller = new RemoteMcpController({ dataPath: 'C:\\tmp\\lnwjing-remote-mcp-malformed-dcr-test', getLocalMcpUrl: async (): Promise<string> => `${upstreamOrigin}/mcp` });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway();
    internal.publicOrigin = internal.gatewayUrl;
    const response = await fetch(`${internal.gatewayUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_client_metadata', error_description: 'Registration body must be a valid JSON object.' });
    await controller.close();
  });

  it('rejects insecure non-loopback OAuth redirect URIs', async () => {
    const upstreamOrigin = await listen(createServer((_request, response) => response.end('{}')));
    const controller = new RemoteMcpController({ dataPath: 'C:\\tmp\\lnwjing-remote-mcp-test-2', getLocalMcpUrl: async (): Promise<string> => `${upstreamOrigin}/mcp` });
    const internal = controller as unknown as RemoteMcpTestAccess;
    await internal.startGateway();
    internal.publicOrigin = internal.gatewayUrl;
    const response = await fetch(`${internal.gatewayUrl}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://attacker.example/callback'] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_redirect_uri' });
    await controller.close();
  });
});
