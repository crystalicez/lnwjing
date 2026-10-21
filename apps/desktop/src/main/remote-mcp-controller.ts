import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InstallOperationPhase, RemoteMcpStatus, RemoteMcpTransport } from '@lnwjing/ipc-contracts';
import type { SecretProtector } from '@lnwjing/shared';

export type TokenEndpointAuthMethod = 'none' | 'client_secret_post';

interface RegisteredClient {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly clientName: string | null;
  readonly tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  readonly clientSecret: string | null;
  readonly trusted: boolean;
  readonly registeredAt: number;
}

export interface RemoteMcpPersistedState {
  readonly schemaVersion: 1 | 2 | 3;
  readonly desiredRunning: boolean;
  /** schema v1 only: learned runtime origin; never reused as launch configuration. */
  readonly publicOrigin?: string | null;
  /** schema v2+: explicit user-configured public origin. v1/v2 always migrate to ngrok transport. */
  readonly configuredPublicOrigin?: string | null;
  /** schema v3 transport selection. Older schemas intentionally default to ngrok. */
  readonly transport?: RemoteMcpTransport;
  /** v3 compatibility slot preserving the ngrok static domain while another transport is selected. */
  readonly configuredNgrokOrigin?: string | null;
  /** v3 external reverse-proxy origin shared by Cloudflare and Custom URL modes. */
  readonly configuredExternalOrigin?: string | null;
  /** Stable loopback OAuth gateway port used only by externally managed Cloudflare/custom transports. */
  readonly externalGatewayPort?: number | null;
  /** schema v3 persists both trusted and pending DCR registrations inside encrypted state. */
  readonly registeredClients?: ReadonlyArray<{
    readonly clientId: string;
    readonly redirectUris: readonly string[];
    readonly clientName: string | null;
    readonly tokenEndpointAuthMethod: TokenEndpointAuthMethod;
    readonly clientSecret: string | null;
    readonly trusted: boolean;
    readonly registeredAt: number;
  }>;
  /** Legacy compatibility projection retained for schema v1/v2 readers and tests. */
  readonly trustedClients: ReadonlyArray<{
    readonly clientId: string;
    readonly redirectUris: readonly string[];
    readonly clientName: string | null;
    readonly tokenEndpointAuthMethod: TokenEndpointAuthMethod;
    readonly clientSecret: string | null;
  }>;
  readonly refreshGrants: ReadonlyArray<{
    readonly refreshToken: string;
    readonly clientId: string;
    readonly expiresAt: number;
  }>;
}

export interface RemoteMcpStatePersistence {
  load(): Promise<RemoteMcpPersistedState | null>;
  save(state: RemoteMcpPersistedState): Promise<void>;
}

interface AuthorizationCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly expiresAt: number;
}

interface AccessGrant {
  readonly clientId: string;
  readonly expiresAt: number;
}

export interface NgrokProcessSnapshot {
  readonly processId: number;
  readonly parentProcessId: number;
  readonly parentAlive: boolean;
  readonly commandLine: string;
}

interface NgrokTunnelSnapshot {
  readonly publicUrl: string;
  readonly target: string;
}

export interface RemoteMcpControllerOptions {
  readonly dataPath: string;
  readonly getLocalMcpUrl: () => Promise<string | null>;
  readonly ensureLocalMcpUrl?: () => Promise<string | null>;
  readonly now?: () => number;
  readonly persistence?: RemoteMcpStatePersistence;
  readonly secretProtector?: SecretProtector;
  readonly onInstallProgress?: (phase: InstallOperationPhase) => void;
}

const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_MS = 8 * 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const LOCAL_APPROVAL_TTL_MS = 60_000;
const MAX_PENDING_LOCAL_APPROVALS = 8;
const UNTRUSTED_CLIENT_TTL_MS = 10 * 60_000;
const MAX_UNTRUSTED_CLIENTS = 64;
const MAX_TRUSTED_CLIENTS = 32;
const MAX_AUTH_CODES = 128;
const MAX_ACCESS_TOKENS = 256;
const MAX_REFRESH_TOKENS = 128;
const REMOTE_MCP_RECONNECT_BASE_DELAY_MS = 2_000;
const REMOTE_MCP_RECONNECT_MAX_DELAY_MS = 30_000;
const CHATGPT_OAUTH_CALLBACK_PATHS = new Set(['/aip/oauth/callback', '/connector_platform_oauth_redirect']);
const CHATGPT_OAUTH_DYNAMIC_CALLBACK_PATH = /^\/connector\/oauth\/[A-Za-z0-9_-]+$/;

export class RemoteMcpController {
  private readonly dataPath: string;
  private readonly getLocalMcpUrl: () => Promise<string | null>;
  private readonly ensureLocalMcpUrl: () => Promise<string | null>;
  private readonly now: () => number;
  private readonly persistence: RemoteMcpStatePersistence;
  private readonly secretProtector?: SecretProtector;
  private readonly onInstallProgress?: (phase: InstallOperationPhase) => void;
  private persistenceLoaded = false;
  private persistenceLoad: Promise<void> | null = null;
  private desiredRunning = false;
  private transport: RemoteMcpTransport = 'ngrok';
  private externalGatewayPort: number | null = null;
  private gateway: Server | null = null;
  private gatewayUrl: string | null = null;
  private publicOrigin: string | null = null;
  private configuredNgrokOrigin: string | null = null;
  private configuredExternalOrigin: string | null = null;
  private ngrok: ChildProcess | null = null;
  private ngrokPath: string | null = null;
  private ngrokProbeAt = 0;
  private runState: RemoteMcpStatus['state'] = 'stopped';
  private message: string | null = null;
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly authCodes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, AccessGrant>();
  private readonly refreshTokens = new Map<string, AccessGrant>();
  private readonly localApprovalServers = new Set<Server>();
  private authorizationGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private startOperation: Promise<RemoteMcpStatus> | null = null;

  public constructor(options: RemoteMcpControllerOptions) {
    this.dataPath = options.dataPath;
    this.getLocalMcpUrl = options.getLocalMcpUrl;
    this.ensureLocalMcpUrl = options.ensureLocalMcpUrl ?? options.getLocalMcpUrl;
    this.now = options.now ?? Date.now;
    if (options.secretProtector !== undefined) this.secretProtector = options.secretProtector;
    if (options.onInstallProgress !== undefined) this.onInstallProgress = options.onInstallProgress;
    this.persistence = options.persistence ?? createRemoteMcpStatePersistence(options.dataPath, options.secretProtector);
  }

  private configuredOriginForTransport(transport: RemoteMcpTransport = this.transport): string | null {
    if (transport === 'ngrok') return this.configuredNgrokOrigin;
    if (transport === 'cloudflare' || transport === 'custom') return this.configuredExternalOrigin;
    return null;
  }

  public async status(): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    const localMcpUrl = await this.getLocalMcpUrl().catch(() => null);
    let executable: string | null = null;
    let automaticInstaller: Awaited<ReturnType<typeof resolveNgrokAutomaticInstaller>> = null;
    if (this.transport === 'ngrok') {
      const probeNow = this.now();
      if (this.ngrokProbeAt === 0 || probeNow - this.ngrokProbeAt >= 30_000) {
        this.ngrokPath = await resolveManagedNgrokExecutable(this.dataPath);
        this.ngrokProbeAt = probeNow;
      }
      executable = this.ngrokPath;
      automaticInstaller = await resolveNgrokAutomaticInstaller();
    }
    const hasAuthtoken = await this.hasAuthtoken();
    const configuredGatewayUrl = (this.transport === 'cloudflare' || this.transport === 'custom') && this.externalGatewayPort !== null
      ? `http://127.0.0.1:${this.externalGatewayPort}`
      : null;
    return {
      state: this.runState,
      provider: this.transport,
      transport: this.transport,
      installed: this.transport === 'ngrok' ? executable !== null : true,
      automaticInstallAvailable: this.transport === 'ngrok' && automaticInstaller !== null,
      automaticInstallMethod: this.transport === 'ngrok' ? automaticInstaller?.method ?? null : null,
      hasAuthtoken,
      ngrokPath: this.transport === 'ngrok' ? executable : null,
      localMcpUrl,
      localGatewayUrl: this.gatewayUrl,
      configuredGatewayUrl,
      publicMcpUrl: this.transport === 'local' || this.publicOrigin === null ? null : `${this.publicOrigin}/mcp`,
      configuredPublicOrigin: this.configuredOriginForTransport(),
      oauthProtected: this.transport !== 'local',
      oauthConnected: this.transport === 'local' ? false : this.hasTrustedClient(),
      autoStartEnabled: this.desiredRunning,
      message: this.message,
    };
  }

  public async installProvider(): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    if (this.transport !== 'ngrok') {
      throw new Error('ngrok installation is available only when the Remote MCP transport is set to ngrok.');
    }
    this.onInstallProgress?.('preparing');
    const existing = await resolveManagedNgrokExecutable(this.dataPath);
    if (existing !== null) {
      this.ngrokPath = existing;
      this.message = 'ngrok is already installed';
      return this.status();
    }
    const installer = await resolveNgrokAutomaticInstaller();
    if (installer === null) {
      throw new Error(process.platform === 'linux'
        ? 'Automatic ngrok installation is disabled on Linux because the official Apt/Snap methods may require elevated system package changes. Install ngrok from the official ngrok Linux page, then retry.'
        : process.platform === 'darwin'
          ? 'Automatic ngrok installation requires Homebrew on macOS. Install ngrok from the official ngrok macOS page, then retry.'
          : 'Automatic ngrok installation is unavailable on this host. Install ngrok from the official ngrok download page, then retry.');
    }
    this.runState = 'installing';
    this.onInstallProgress?.('installing');
    this.message = installer.method === 'windows_store'
      ? 'Installing ngrok from Microsoft Store via WinGet…'
      : 'Installing ngrok with Homebrew…';
    try {
      await runCommand(installer.executable, installer.args, 180_000);
      this.onInstallProgress?.('finalizing');
      const installed = await resolveManagedNgrokExecutable(this.dataPath);
      if (installed === null) throw new Error('ngrok installation completed but no runnable target-native ngrok executable could be resolved');
      this.ngrokPath = installed;
      this.runState = 'stopped';
      this.message = installer.method === 'windows_store'
        ? 'ngrok installed from the official Microsoft Store package'
        : 'ngrok installed with the official Homebrew formula';
      return this.status();
    } catch (error) {
      this.runState = 'error';
      this.message = errorMessage(error);
      throw error;
    }
  }

  public async saveAuthtoken(raw: string): Promise<RemoteMcpStatus> {
    const token = raw.trim();
    if (token.length < 16 || /\s/.test(token)) throw new Error('Enter a valid ngrok authtoken');
    await this.ensurePersistenceLoaded();
    if (!this.persistenceLoaded) throw new Error('Saved Remote MCP state could not be loaded; the ngrok authtoken was not changed. Retry after secure storage is available.');
    await mkdir(this.secretDir(), { recursive: true });
    if (this.secretProtector === undefined) throw new Error('Secure secret provider was not injected before saving the ngrok authtoken');
    const encrypted = await this.secretProtector.encrypt('tunnel_api_key', token);
    await writeFile(this.secretPath(), encrypted, { encoding: 'utf8', mode: 0o600 });
    await this.persistState();
    this.message = 'ngrok authtoken saved securely.';
    return this.status();
  }

  public async savePublicOrigin(raw: string): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    if (!this.persistenceLoaded) throw new Error('Saved Remote MCP state could not be loaded; the public origin was not changed. Retry after secure storage is available.');
    if (this.runState === 'running' || this.runState === 'starting') throw new Error('Stop MCP connectivity before changing the public origin.');
    if (this.transport === 'local') throw new Error('Local MCP does not use a public origin. Select ngrok, Cloudflare, or Custom URL first.');
    const configuredPublicOrigin = normalizeConfiguredPublicOrigin(raw);
    if (this.transport === 'ngrok') this.configuredNgrokOrigin = configuredPublicOrigin;
    else this.configuredExternalOrigin = configuredPublicOrigin;
    await this.persistState();
    if (this.transport === 'ngrok') {
      this.message = configuredPublicOrigin === null
        ? 'Static ngrok domain cleared. Remote MCP will let ngrok choose the public URL at startup.'
        : `Remote MCP will request ${configuredPublicOrigin} on the next ngrok start.`;
    } else {
      this.message = configuredPublicOrigin === null
        ? 'External public URL cleared. Configure an HTTPS public origin before starting this transport.'
        : `${this.transport === 'cloudflare' ? 'Cloudflare' : 'Custom URL'} public origin saved. Configure the external proxy to forward to the stable local gateway URL shown by lnwjing.`;
    }
    return this.status();
  }

  public async setTransport(transport: RemoteMcpTransport): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    if (!this.persistenceLoaded) throw new Error('Saved Remote MCP state could not be loaded; the transport was not changed. Retry after secure storage is available.');
    if (this.runState === 'running' || this.runState === 'starting' || this.runState === 'installing') throw new Error('Stop MCP connectivity before changing the transport.');
    if ((transport === 'cloudflare' || transport === 'custom') && this.externalGatewayPort === null) {
      this.externalGatewayPort = await reserveLoopbackPort();
    }
    this.transport = transport;
    await this.persistState();
    this.message = transport === 'ngrok'
      ? 'ngrok selected. Existing ngrok authtoken, static domain, OAuth trust, and tunnel behavior are preserved.'
      : transport === 'cloudflare'
        ? 'Cloudflare selected. lnwjing will run the OAuth gateway locally without starting ngrok; your Cloudflare tunnel must forward the configured HTTPS origin to the stable local gateway URL.'
        : transport === 'custom'
          ? 'Custom URL selected. lnwjing will run the OAuth gateway locally without starting ngrok; your reverse proxy must forward the configured HTTPS origin to the stable local gateway URL.'
          : 'Local MCP selected. lnwjing will start the local MCP listener directly with no ngrok or public OAuth gateway.';
    return this.status();
  }

  public async resetOAuthTrust(): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    this.clearReconnectTimer(true);
    this.authorizationGeneration += 1;
    await this.closeLocalApprovalServers();
    for (const [clientId, client] of this.clients) this.clients.set(clientId, { ...client, trusted: false, registeredAt: this.now() });
    this.authCodes.clear();
    this.accessTokens.clear();
    this.refreshTokens.clear();
    await this.persistState();
    this.message = 'ChatGPT authorization was reset. The next supported ChatGPT OAuth connection requires explicit local approval before it is trusted.';
    return this.status();
  }

  public async autoStartIfDesired(): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    if (!this.desiredRunning) return this.status();
    return this.start();
  }

  public async start(): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    this.clearReconnectTimer();
    if (this.runState === 'running') return this.status();
    if (this.startOperation !== null) return this.startOperation;

    const operation = this.startInternal();
    this.startOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.startOperation === operation) this.startOperation = null;
    }
  }

  private async startInternal(): Promise<RemoteMcpStatus> {
    this.runState = 'starting';
    this.message = this.transport === 'local' ? 'Starting Local MCP…' : 'Starting protected Remote MCP…';
    try {
      const localMcpUrl = await this.ensureLocalMcpUrl();
      if (localMcpUrl === null) throw new Error('Local MCP is unavailable. Start the lnwjing MCP listener first.');

      if (this.transport === 'local') {
        this.publicOrigin = null;
        this.runState = 'running';
        this.desiredRunning = true;
        this.reconnectAttempts = 0;
        await this.persistState();
        this.message = 'Local MCP is online directly. ngrok and the public OAuth gateway are not used in Local MCP mode.';
        return this.status();
      }

      if (this.transport === 'cloudflare' || this.transport === 'custom') {
        const externalOrigin = this.configuredExternalOrigin;
        if (externalOrigin === null) {
          throw new Error(`${this.transport === 'cloudflare' ? 'Cloudflare' : 'Custom URL'} transport requires a configured public HTTPS origin.`);
        }
        const requestedPort = this.externalGatewayPort ?? 0;
        try {
          await this.startGateway(requestedPort);
        } catch (error) {
          if (requestedPort === 0) throw error;
          this.externalGatewayPort = await reserveLoopbackPort();
          await this.persistState();
          await this.startGateway(this.externalGatewayPort);
        }
        if (this.gatewayUrl === null) throw new Error('Remote MCP gateway did not start');
        if (this.externalGatewayPort === null) {
          const parsedGateway = new URL(this.gatewayUrl);
          const selectedPort = Number.parseInt(parsedGateway.port, 10);
          if (!Number.isInteger(selectedPort) || selectedPort <= 0 || selectedPort > 65_535) throw new Error('Remote MCP gateway selected an invalid loopback port');
          this.externalGatewayPort = selectedPort;
          await this.persistState();
        }
        this.publicOrigin = externalOrigin;
        const verified = await verifyExternalPublicOrigin(externalOrigin, 8_000);
        if (!verified) {
          throw new Error(`${this.transport === 'cloudflare' ? 'Cloudflare' : 'Custom URL'} public origin is not forwarding to the lnwjing OAuth gateway yet. Configure ${this.publicOrigin} to forward to ${this.gatewayUrl} and start again.`);
        }
        this.runState = 'running';
        this.desiredRunning = true;
        this.reconnectAttempts = 0;
        await this.persistState();
        this.message = `${this.transport === 'cloudflare' ? 'Cloudflare' : 'Custom URL'} Remote MCP is online through ${this.publicOrigin}. lnwjing did not start or modify ngrok.`;
        return this.status();
      }

      let executable = this.ngrokPath ?? await resolveManagedNgrokExecutable(this.dataPath);
      if (executable === null) {
        await this.installProvider();
        executable = this.ngrokPath ?? await resolveManagedNgrokExecutable(this.dataPath);
        this.runState = 'starting';
      }
      if (executable === null) throw new Error('ngrok installation/repair completed but no runnable ngrok executable was found');
      this.ngrokPath = executable;
      const authtoken = await this.loadAuthtoken();
      if (authtoken === null) throw new Error('ngrok authtoken is not configured');
      const recoveredStaleNgrok = await recoverStaleLnwjingNgrokRuntime();
      if (recoveredStaleNgrok) this.message = 'Recovered a stale lnwjing ngrok runtime from a previous Desktop session';
      await this.startGateway();
      if (this.gatewayUrl === null) throw new Error('Remote MCP gateway did not start');
      this.publicOrigin = null;
      let lastNgrokDiagnostic: string | null = null;
      let ngrokDiagnosticBuffer = '';
      const configuredNgrokOrigin = this.configuredNgrokOrigin;
      const child = spawn(executable, buildNgrokHttpArgs(this.gatewayUrl, configuredNgrokOrigin), {
        env: { ...process.env, NGROK_AUTHTOKEN: authtoken },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.ngrok = child;
      const captureDiagnostic = (chunk: Buffer | string): void => {
        ngrokDiagnosticBuffer = `${ngrokDiagnosticBuffer}${String(chunk)}`.slice(-64 * 1024);
        const diagnostic = extractNgrokDiagnostic(ngrokDiagnosticBuffer);
        if (diagnostic !== null) {
          lastNgrokDiagnostic = diagnostic;
          this.message = diagnostic;
        }
      };
      child.stdout?.on('data', captureDiagnostic);
      child.stderr?.on('data', captureDiagnostic);
      const exitPromise = new Promise<string>((resolve) => {
        let settled = false;
        const fail = (message: string): void => {
          if (settled) return;
          settled = true;
          const unexpectedOwnedExit = this.ngrok === child && this.runState !== 'stopped';
          if (unexpectedOwnedExit) {
            this.runState = 'error';
            this.message = message;
          }
          this.publicOrigin = null;
          if (this.ngrok === child) this.ngrok = null;
          if (unexpectedOwnedExit) this.scheduleReconnect(message);
          resolve(message);
        };
        child.once('error', (error) => { fail(`ngrok failed to start: ${redactNgrokError(errorMessage(error))}`); });
        child.once('exit', (code) => { fail(formatNgrokExitMessage(code, lastNgrokDiagnostic)); });
      });
      const outcome = await Promise.race([
        waitForNgrokPublicOrigin(15_000, this.gatewayUrl).then((origin) => ({ kind: 'origin' as const, origin })),
        exitPromise.then((message) => ({ kind: 'exit' as const, message })),
      ]);
      if (outcome.kind === 'exit') throw new Error(withStableOriginHint(outcome.message, configuredNgrokOrigin));
      if (outcome.origin === null) throw new Error(withStableOriginHint(this.message ?? 'ngrok started but no public HTTPS endpoint was reported', configuredNgrokOrigin));
      const origin = enforceStablePublicOrigin(outcome.origin, configuredNgrokOrigin);
      this.publicOrigin = origin;
      this.runState = 'running';
      this.desiredRunning = true;
      this.reconnectAttempts = 0;
      await this.persistState();
      this.message = this.hasTrustedClient()
        ? 'Remote MCP is online. ChatGPT authorization is trusted; unexpected Remote MCP transport exits will reconnect automatically.'
        : 'Remote MCP is online. Connect the published lnwjing app from ChatGPT; supported ChatGPT OAuth clients complete through a local Desktop handoff without manual code entry.';
      return this.status();
    } catch (error) {
      await this.stopOwnedRuntime();
      this.runState = 'error';
      const message = errorMessage(error);
      this.message = message;
      if (this.transport === 'ngrok') this.scheduleReconnect(message);
      throw error;
    }
  }

  public async stop(): Promise<RemoteMcpStatus> {
    await this.ensurePersistenceLoaded();
    this.clearReconnectTimer(true);
    this.runState = 'stopped';
    this.desiredRunning = false;
    this.message = 'Remote MCP stopped. Automatic start is disabled until you start it again.';
    await this.stopOwnedRuntime();
    await this.persistState();
    return this.status();
  }

  public async close(): Promise<void> {
    this.clearReconnectTimer(true);
    this.runState = 'stopped';
    await this.stopOwnedRuntime();
  }

  private async startGateway(port = 0): Promise<void> {
    if (this.gateway !== null) return;
    const server = createServer((request, response) => {
      void this.handleGatewayRequest(request, response).catch((error: unknown) => {
        if (!response.headersSent) json(response, 500, { error: 'server_error', error_description: errorMessage(error) });
        else response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('Remote MCP gateway could not resolve its loopback port');
    }
    this.gateway = server;
    this.gatewayUrl = `http://127.0.0.1:${address.port}`;
  }

  private async handleGatewayRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.pruneOAuthState();
    const url = new URL(request.url ?? '/', this.publicOrigin ?? this.gatewayUrl ?? 'http://127.0.0.1');
    if (request.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) {
      const origin = this.requirePublicOrigin();
      json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'] });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      const origin = this.requirePublicOrigin();
      json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/register') {
      let body: Record<string, unknown>;
      try {
        body = await readJson(request, 64 * 1024);
      } catch {
        json(response, 400, { error: 'invalid_client_metadata', error_description: 'Registration body must be a valid JSON object.' });
        return;
      }
      const requestedRedirectUris = body.redirect_uris;
      if (!Array.isArray(requestedRedirectUris)
        || requestedRedirectUris.length === 0
        || requestedRedirectUris.length > 16
        || requestedRedirectUris.some((entry) => typeof entry !== 'string' || entry.length > 2_048 || !isSafeRedirectUri(entry))) {
        json(response, 400, { error: 'invalid_redirect_uri' });
        return;
      }
      const redirectUris = [...new Set(requestedRedirectUris as string[])];
      const requestedAuthMethod = body.token_endpoint_auth_method ?? 'none';
      if (requestedAuthMethod !== 'none' && requestedAuthMethod !== 'client_secret_post') {
        json(response, 400, { error: 'invalid_client_metadata', error_description: 'Unsupported token_endpoint_auth_method.' });
        return;
      }
      if (!isSupportedRegistrationStringArray(body.grant_types, ['authorization_code', 'refresh_token'])
        || !isSupportedRegistrationStringArray(body.response_types, ['code'])) {
        json(response, 400, { error: 'invalid_client_metadata', error_description: 'Unsupported OAuth client metadata.' });
        return;
      }
      const tokenEndpointAuthMethod: TokenEndpointAuthMethod = requestedAuthMethod;
      this.pruneOAuthState();
      const untrustedClientCount = [...this.clients.values()].filter((client) => !client.trusted).length;
      if (untrustedClientCount >= MAX_UNTRUSTED_CLIENTS) {
        json(response, 429, { error: 'temporarily_unavailable', error_description: 'Too many pending OAuth client registrations. Retry after older registrations expire.' });
        return;
      }
      const clientId = token(24);
      const clientSecret = tokenEndpointAuthMethod === 'client_secret_post' ? token(32) : null;
      const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : null;
      this.clients.set(clientId, { clientId, redirectUris, clientName, tokenEndpointAuthMethod, clientSecret, trusted: false, registeredAt: this.now() });
      try {
        // DCR registration must be durable before HTTP 201 so ChatGPT can reuse client_id after restart/update.
        await this.persistState();
      } catch (error) {
        this.clients.delete(clientId);
        throw error;
      }
      const registration: Record<string, unknown> = {
        client_id: clientId,
        client_id_issued_at: Math.floor(this.now() / 1_000),
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      };
      if (clientName !== null) registration.client_name = clientName;
      if (clientSecret !== null) {
        registration.client_secret = clientSecret;
        registration.client_secret_expires_at = 0;
      }
      json(response, 201, registration);
      return;
    }
    if (url.pathname === '/oauth/authorize' && (request.method === 'GET' || request.method === 'POST')) {
      const params = request.method === 'POST' ? new URLSearchParams(await readText(request, 32 * 1024)) : url.searchParams;
      await this.handleAuthorize(params, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      await this.handleToken(new URLSearchParams(await readText(request, 32 * 1024)), response);
      return;
    }
    if (url.pathname === '/mcp') {
      const bearer = parseBearer(request.headers.authorization);
      if (bearer === null || !this.validAccessToken(bearer)) {
        const origin = this.requirePublicOrigin();
        response.statusCode = 401;
        response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
        response.end('Unauthorized');
        return;
      }
      const localMcpUrl = await this.ensureLocalMcpUrl().catch(() => null);
      if (localMcpUrl === null) {
        json(response, 503, { error: 'local_mcp_unavailable', error_description: 'The local lnwjing MCP listener could not be started for this Remote MCP request.' });
        return;
      }
      await proxyMcp(request, response, localMcpUrl);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      html(response, 200, '<h1>lnwjing Remote MCP</h1><p>OAuth-protected MCP endpoint is online.</p>');
      return;
    }
    response.statusCode = 404;
    response.end('Not found');
  }

  private async handleAuthorize(params: URLSearchParams, response: ServerResponse): Promise<void> {
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const state = params.get('state') ?? '';
    const challenge = params.get('code_challenge') ?? '';
    const method = params.get('code_challenge_method') ?? '';
    if (params.get('response_type') !== 'code' || challenge.length < 32 || challenge.length > 256 || method !== 'S256') {
      json(response, 400, { error: 'invalid_request' });
      return;
    }
    let client = this.clients.get(clientId);
    if (client === undefined && canRecoverLegacyChatGptClient(params, this.requirePublicOrigin())) {
      this.pruneOAuthState();
      const untrustedClientCount = [...this.clients.values()].filter((candidate) => !candidate.trusted).length;
      if (untrustedClientCount >= MAX_UNTRUSTED_CLIENTS) {
        json(response, 429, { error: 'temporarily_unavailable', error_description: 'Too many pending OAuth client registrations. Retry after older registrations expire.' });
        return;
      }
      client = {
        clientId,
        redirectUris: [redirectUri],
        clientName: 'ChatGPT (recovered registration)',
        tokenEndpointAuthMethod: 'none',
        clientSecret: null,
        trusted: false,
        registeredAt: this.now(),
      };
      this.clients.set(clientId, client);
      try {
        await this.persistState();
      } catch (error) {
        this.clients.delete(clientId);
        throw error;
      }
    }
    if (client === undefined || !client.redirectUris.includes(redirectUri)) {
      json(response, 400, { error: 'invalid_request' });
      return;
    }
    if (isRecognizedChatGptClient(client) && !client.trusted) {
      const localApprovalUrl = await this.startChatGptLocalApproval({ clientId, redirectUri, state, challenge });
      response.statusCode = 302;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Location', localApprovalUrl);
      response.end();
      return;
    }
    if (!client.trusted) {
      json(response, 403, {
        error: 'access_denied',
        error_description: 'This OAuth client is not supported by lnwjing Desktop. Connect from ChatGPT so authorization can complete through the local Desktop handoff.',
      });
      return;
    }
    this.redirectAuthorizationCode({ clientId, redirectUri, state, challenge }, response);
  }

  private redirectAuthorizationCode(input: { readonly clientId: string; readonly redirectUri: string; readonly state: string; readonly challenge: string }, response: ServerResponse): void {
    this.pruneOAuthState();
    if (this.authCodes.size >= MAX_AUTH_CODES) {
      json(response, 503, { error: 'temporarily_unavailable', error_description: 'Too many active OAuth authorization requests. Retry after an earlier request expires.' });
      return;
    }
    const code = token(32);
    this.authCodes.set(code, { clientId: input.clientId, redirectUri: input.redirectUri, codeChallenge: input.challenge, expiresAt: this.now() + CODE_TTL_MS });
    const destination = new URL(input.redirectUri);
    destination.searchParams.set('code', code);
    if (input.state.length > 0) destination.searchParams.set('state', input.state);
    response.statusCode = 302;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Location', destination.toString());
    response.end();
  }

  private async startChatGptLocalApproval(input: { readonly clientId: string; readonly redirectUri: string; readonly state: string; readonly challenge: string }): Promise<string> {
    if (this.localApprovalServers.size >= MAX_PENDING_LOCAL_APPROVALS) {
      const oldest = this.localApprovalServers.values().next().value as Server | undefined;
      if (oldest?.listening === true) await new Promise<void>((resolve) => oldest.close(() => resolve()));
    }
    const approvalToken = token(32);
    const approvalPath = `/oauth/chatgpt-local-approve/${approvalToken}`;
    const generation = this.authorizationGeneration;
    let consumed = false;
    const server = createServer((request, response) => {
      void (async (): Promise<void> => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== approvalPath || (request.method !== 'GET' && request.method !== 'POST')) {
          response.statusCode = 404;
          response.end('Not found');
          return;
        }
        if (consumed || generation !== this.authorizationGeneration) {
          response.statusCode = 410;
          response.end('Approval expired');
          return;
        }
        const client = this.clients.get(input.clientId);
        if (client === undefined || !isRecognizedChatGptClient(client) || !client.redirectUris.includes(input.redirectUri)) {
          response.statusCode = 410;
          response.end('Approval expired');
          return;
        }
        if (request.method === 'GET') {
          const displayName = escapeHtml(client.clientName ?? 'ChatGPT');
          const callback = escapeHtml(input.redirectUri);
          html(response, 200, `<!doctype html><meta charset="utf-8"><title>Approve lnwjing connection</title><style>body{font-family:system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;line-height:1.5}code{overflow-wrap:anywhere}button{font:inherit;padding:10px 18px}</style><main><h1>Approve ChatGPT connection?</h1><p>lnwjing received a first-use OAuth request.</p><p><strong>Client:</strong> ${displayName}</p><p><strong>Callback:</strong> <code>${callback}</code></p><form method="post"><button type="submit">Approve connection</button></form><p>Close this window to deny the request.</p></main>`);
          return;
        }
        this.pruneOAuthState();
        const trustedCount = [...this.clients.values()].filter((candidate) => candidate.trusted).length;
        if (trustedCount >= MAX_TRUSTED_CLIENTS) {
          html(response, 429, '<h1>OAuth trust limit reached</h1><p>Reset Remote MCP OAuth trust before approving another client.</p>');
          return;
        }
        consumed = true;
        this.clients.set(input.clientId, { ...client, trusted: true });
        this.message = 'ChatGPT authorized after explicit local approval. This OAuth connection is remembered for future starts.';
        await this.persistState();
        this.redirectAuthorizationCode(input, response);
        const cleanup = setTimeout(() => { if (server.listening) server.close(); }, 1_000);
        cleanup.unref();
      })().catch((error: unknown) => {
        if (!response.headersSent) json(response, 500, { error: 'server_error', error_description: errorMessage(error) });
        else response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('ChatGPT local approval could not resolve its loopback port');
    }
    this.localApprovalServers.add(server);
    const timer = setTimeout(() => server.close(), LOCAL_APPROVAL_TTL_MS);
    timer.unref();
    server.once('close', () => {
      clearTimeout(timer);
      this.localApprovalServers.delete(server);
    });
    return `http://127.0.0.1:${address.port}${approvalPath}`;
  }

  private async handleToken(params: URLSearchParams, response: ServerResponse): Promise<void> {
    const grantType = params.get('grant_type');
    const clientId = params.get('client_id') ?? '';
    const client = this.clients.get(clientId);
    if (client === undefined || !verifyClientAuthentication(client, params.get('client_secret'))) {
      json(response, 401, { error: 'invalid_client' });
      return;
    }
    if (grantType === 'authorization_code') {
      const code = params.get('code') ?? '';
      const grant = this.authCodes.get(code);
      this.authCodes.delete(code);
      const verifier = params.get('code_verifier') ?? '';
      if (grant === undefined || grant.expiresAt <= this.now() || grant.clientId !== clientId || grant.redirectUri !== (params.get('redirect_uri') ?? '') || !verifyPkce(verifier, grant.codeChallenge)) {
        json(response, 400, { error: 'invalid_grant' }); return;
      }
      await this.issueTokens(clientId, response);
      return;
    }
    if (grantType === 'refresh_token') {
      const refresh = params.get('refresh_token') ?? '';
      const grant = this.refreshTokens.get(refresh);
      if (grant === undefined || grant.expiresAt <= this.now() || grant.clientId !== clientId) {
        json(response, 400, { error: 'invalid_grant' }); return;
      }
      this.refreshTokens.delete(refresh);
      await this.issueTokens(clientId, response);
      return;
    }
    json(response, 400, { error: 'unsupported_grant_type' });
  }

  private async issueTokens(clientId: string, response: ServerResponse): Promise<void> {
    this.pruneOAuthState();
    if (this.accessTokens.size >= MAX_ACCESS_TOKENS || this.refreshTokens.size >= MAX_REFRESH_TOKENS) {
      json(response, 503, { error: 'temporarily_unavailable', error_description: 'OAuth token capacity is temporarily exhausted. Retry after an older grant expires.' });
      return;
    }
    const access = token(32);
    const refresh = token(32);
    this.accessTokens.set(access, { clientId, expiresAt: this.now() + ACCESS_TTL_MS });
    this.refreshTokens.set(refresh, { clientId, expiresAt: this.now() + REFRESH_TTL_MS });
    await this.persistState();
    json(response, 200, { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh });
  }

  private validAccessToken(value: string): boolean {
    const grant = this.accessTokens.get(value);
    if (grant === undefined) return false;
    if (grant.expiresAt <= this.now()) { this.accessTokens.delete(value); return false; }
    return true;
  }

  private pruneOAuthState(): void {
    const now = this.now();
    for (const [clientId, client] of this.clients) {
      if (!client.trusted && client.registeredAt + UNTRUSTED_CLIENT_TTL_MS <= now) this.clients.delete(clientId);
    }
    for (const [code, grant] of this.authCodes) {
      if (grant.expiresAt <= now || !this.clients.has(grant.clientId)) this.authCodes.delete(code);
    }
    for (const [accessToken, grant] of this.accessTokens) {
      if (grant.expiresAt <= now || !this.clients.has(grant.clientId)) this.accessTokens.delete(accessToken);
    }
    for (const [refreshToken, grant] of this.refreshTokens) {
      if (grant.expiresAt <= now || !this.clients.has(grant.clientId)) this.refreshTokens.delete(refreshToken);
    }
  }

  private requirePublicOrigin(): string {
    if (this.publicOrigin === null) throw new Error('Remote MCP public URL is not ready');
    return this.publicOrigin;
  }

  private hasTrustedClient(): boolean {
    for (const client of this.clients.values()) if (client.trusted) return true;
    return false;
  }

  private async ensurePersistenceLoaded(): Promise<void> {
    if (this.persistenceLoaded) return;
    this.persistenceLoad ??= this.loadPersistedAuthorization();
    try {
      await this.persistenceLoad;
    } finally {
      this.persistenceLoad = null;
    }
  }

  private async loadPersistedAuthorization(): Promise<void> {
    let state: RemoteMcpPersistedState | null = null;
    try {
      state = await this.persistence.load();
    } catch (error) {
      this.message = `Saved Remote MCP authorization could not be loaded: ${errorMessage(error)}`;
      // Keep writes disabled and allow a later retry. A failed decryption is
      // not an empty account and must never replace saved clients/grants.
      return;
    }
    this.persistenceLoaded = true;
    if (state === null) return;
    this.desiredRunning = state.desiredRunning;
    this.transport = state.schemaVersion === 3 && isRemoteMcpTransport(state.transport) ? state.transport : 'ngrok';
    this.externalGatewayPort = state.schemaVersion === 3 && isValidGatewayPort(state.externalGatewayPort) ? state.externalGatewayPort : null;
    const legacyConfiguredOrigin = state.schemaVersion >= 2 ? state.configuredPublicOrigin ?? null : null;
    const explicitNgrokOrigin = state.schemaVersion === 3 ? state.configuredNgrokOrigin ?? null : null;
    const explicitExternalOrigin = state.schemaVersion === 3 ? state.configuredExternalOrigin ?? null : null;
    this.configuredNgrokOrigin = explicitNgrokOrigin ?? (this.transport === 'ngrok' || this.transport === 'local' ? legacyConfiguredOrigin : null);
    this.configuredExternalOrigin = explicitExternalOrigin ?? (this.transport === 'cloudflare' || this.transport === 'custom' || this.transport === 'local' ? legacyConfiguredOrigin : null);
    const now = this.now();
    for (const client of state.registeredClients ?? []) {
      if (!client.trusted && client.registeredAt + UNTRUSTED_CLIENT_TTL_MS <= now) continue;
      this.clients.set(client.clientId, { ...client, redirectUris: [...client.redirectUris] });
    }
    for (const client of state.trustedClients.slice(0, MAX_TRUSTED_CLIENTS)) {
      if (!this.clients.has(client.clientId)) this.clients.set(client.clientId, { ...client, trusted: true, registeredAt: now });
    }
    this.pruneOAuthState();
    const trustedClientIds = new Set([...this.clients.values()].filter((client) => client.trusted).map((client) => client.clientId));
    for (const grant of state.refreshGrants.slice(0, MAX_REFRESH_TOKENS)) {
      if (grant.expiresAt > now && trustedClientIds.has(grant.clientId)) {
        this.refreshTokens.set(grant.refreshToken, { clientId: grant.clientId, expiresAt: grant.expiresAt });
      }
    }
  }

  private async persistState(): Promise<void> {
    if (!this.persistenceLoaded) return;
    this.pruneOAuthState();
    const now = this.now();
    const registeredClients = [...this.clients.values()]
      .filter((client) => client.trusted || client.registeredAt + UNTRUSTED_CLIENT_TTL_MS > now)
      .slice(0, MAX_TRUSTED_CLIENTS + MAX_UNTRUSTED_CLIENTS)
      .map(({ clientId, redirectUris, clientName, tokenEndpointAuthMethod, clientSecret, trusted, registeredAt }) => ({
        clientId, redirectUris: [...redirectUris], clientName, tokenEndpointAuthMethod, clientSecret, trusted, registeredAt,
      }));
    const trustedClients = registeredClients
      .filter((client) => client.trusted)
      .slice(0, MAX_TRUSTED_CLIENTS)
      .map(({ clientId, redirectUris, clientName, tokenEndpointAuthMethod, clientSecret }) => ({ clientId, redirectUris, clientName, tokenEndpointAuthMethod, clientSecret }));
    const trustedClientIds = new Set(trustedClients.map((client) => client.clientId));
    const refreshGrants = [...this.refreshTokens.entries()]
      .filter(([, grant]) => grant.expiresAt > now && trustedClientIds.has(grant.clientId))
      .slice(-MAX_REFRESH_TOKENS)
      .map(([refreshToken, grant]) => ({ refreshToken, clientId: grant.clientId, expiresAt: grant.expiresAt }));
    await this.persistence.save({
      schemaVersion: 3,
      desiredRunning: this.desiredRunning,
      transport: this.transport,
      externalGatewayPort: this.externalGatewayPort,
      configuredPublicOrigin: this.configuredOriginForTransport(),
      configuredNgrokOrigin: this.configuredNgrokOrigin,
      configuredExternalOrigin: this.configuredExternalOrigin,
      registeredClients,
      trustedClients,
      refreshGrants,
    });
  }

  private secretDir(): string { return path.join(this.dataPath, 'remote-mcp'); }
  private secretPath(): string { return path.join(this.secretDir(), 'ngrok-authtoken.secret'); }
  private async hasAuthtoken(): Promise<boolean> { return (await this.loadAuthtoken().catch(() => null)) !== null; }
  private async loadAuthtoken(): Promise<string | null> {
    if (this.secretProtector === undefined) return null;
    try {
      const encrypted = await readFile(this.secretPath(), 'utf8');
      const decrypted = await this.secretProtector.decrypt('tunnel_api_key', encrypted.trim());
      const value = decrypted.plainText.trim();
      return value.length > 0 ? value : null;
    } catch { return null; }
  }

  private clearReconnectTimer(resetAttempts = false): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (resetAttempts) this.reconnectAttempts = 0;
  }

  private scheduleReconnect(reason: string): void {
    if (this.transport !== 'ngrok') return;
    if (!this.desiredRunning || this.runState === 'stopped' || this.runState === 'running' || this.runState === 'starting') return;
    if (this.reconnectTimer !== null) {
      this.message = `Remote MCP disconnected: ${reason}. Automatic reconnect is already scheduled (attempt ${this.reconnectAttempts})…`;
      return;
    }
    const attempt = this.reconnectAttempts + 1;
    const delayMs = Math.min(REMOTE_MCP_RECONNECT_MAX_DELAY_MS, REMOTE_MCP_RECONNECT_BASE_DELAY_MS * (2 ** Math.min(this.reconnectAttempts, 4)));
    this.reconnectAttempts = attempt;
    this.message = `Remote MCP disconnected: ${reason}. Reconnecting automatically in ${Math.ceil(delayMs / 1_000)}s (attempt ${attempt})…`;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.desiredRunning || this.runState === 'stopped' || this.runState === 'running' || this.runState === 'starting') return;
      void this.start().catch(() => undefined);
    }, delayMs);
  }

  private async closeLocalApprovalServers(): Promise<void> {
    const servers = [...this.localApprovalServers];
    this.localApprovalServers.clear();
    await Promise.all(servers.map(async (server) => {
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }));
  }

  private async stopOwnedRuntime(): Promise<void> {
    this.authorizationGeneration += 1;
    await this.closeLocalApprovalServers();
    const child = this.ngrok;
    this.ngrok = null;
    this.publicOrigin = null;
    if (child !== null && child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_500); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
    const server = this.gateway;
    this.gateway = null;
    this.gatewayUrl = null;
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.authCodes.clear();
    this.accessTokens.clear();
  }
}

function createRemoteMcpStatePersistence(dataPath: string, secretProtector?: SecretProtector): RemoteMcpStatePersistence {
  const directory = path.join(dataPath, 'remote-mcp');
  const filename = path.join(directory, 'oauth-state.secret');
  return {
    load: async (): Promise<RemoteMcpPersistedState | null> => {
      let encrypted: string;
      try {
        encrypted = await readFile(filename, 'utf8');
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
      if (secretProtector === undefined) throw new Error('Secure secret provider was not injected before reading Remote MCP state');
      const plainText = (await secretProtector.decrypt('tunnel_api_key', encrypted.trim())).plainText;
      return normalizePersistedState(JSON.parse(plainText) as unknown);
    },
    save: async (state: RemoteMcpPersistedState): Promise<void> => {
      await mkdir(directory, { recursive: true });
      if (secretProtector === undefined) throw new Error('Secure secret provider was not injected before saving Remote MCP state');
      const encrypted = await secretProtector.encrypt('tunnel_api_key', JSON.stringify(state));
      await writeFile(filename, encrypted, { encoding: 'utf8', mode: 0o600 });
    },
  };
}

function normalizePersistedState(value: unknown): RemoteMcpPersistedState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ((record.schemaVersion !== 1 && record.schemaVersion !== 2 && record.schemaVersion !== 3) || typeof record.desiredRunning !== 'boolean') return null;
  const schemaVersion = record.schemaVersion;
  const registeredById = new Map<string, RegisteredClient>();
  if (schemaVersion === 3 && Array.isArray(record.registeredClients)) {
    for (const entry of record.registeredClients.slice(0, MAX_TRUSTED_CLIENTS + MAX_UNTRUSTED_CLIENTS)) {
      const client = normalizePersistedRegisteredClient(entry, false);
      if (client !== null) registeredById.set(client.clientId, client);
    }
  }
  const legacyClients = Array.isArray(record.trustedClients) ? record.trustedClients : [];
  for (const entry of legacyClients.slice(0, MAX_TRUSTED_CLIENTS)) {
    const client = normalizePersistedRegisteredClient(entry, true);
    if (client !== null && !registeredById.has(client.clientId)) registeredById.set(client.clientId, client);
  }
  const registeredClients = [...registeredById.values()];
  const trustedClients = registeredClients
    .filter((client) => client.trusted)
    .slice(0, MAX_TRUSTED_CLIENTS)
    .map(({ clientId, redirectUris, clientName, tokenEndpointAuthMethod, clientSecret }) => ({
      clientId, redirectUris: [...redirectUris], clientName, tokenEndpointAuthMethod, clientSecret,
    }));
  const legacyConfiguredOrigin = schemaVersion >= 2 ? normalizePublicOrigin(record.configuredPublicOrigin) : null;
  const transport: RemoteMcpTransport = schemaVersion === 3 && isRemoteMcpTransport(record.transport) ? record.transport : 'ngrok';
  const explicitNgrokOrigin = schemaVersion === 3 ? normalizePublicOrigin(record.configuredNgrokOrigin) : null;
  const explicitExternalOrigin = schemaVersion === 3 ? normalizePublicOrigin(record.configuredExternalOrigin) : null;
  const configuredNgrokOrigin = explicitNgrokOrigin ?? (transport === 'ngrok' || transport === 'local' ? legacyConfiguredOrigin : null);
  const configuredExternalOrigin = explicitExternalOrigin ?? (transport === 'cloudflare' || transport === 'custom' || transport === 'local' ? legacyConfiguredOrigin : null);
  const configuredPublicOrigin = transport === 'ngrok' ? configuredNgrokOrigin : transport === 'cloudflare' || transport === 'custom' ? configuredExternalOrigin : null;
  const externalGatewayPort = schemaVersion === 3 && isValidGatewayPort(record.externalGatewayPort) ? record.externalGatewayPort : null;
  const trustedClientIds = new Set(trustedClients.map((client) => client.clientId));
  const grants = Array.isArray(record.refreshGrants) ? record.refreshGrants : [];
  const refreshGrants = grants.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const grant = entry as Record<string, unknown>;
    if (typeof grant.refreshToken !== 'string' || grant.refreshToken.length < 32 || grant.refreshToken.length > 256) return [];
    if (typeof grant.clientId !== 'string' || !trustedClientIds.has(grant.clientId)) return [];
    if (typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt)) return [];
    return [{ refreshToken: grant.refreshToken, clientId: grant.clientId, expiresAt: grant.expiresAt }];
  }).slice(-MAX_REFRESH_TOKENS);
  return {
    schemaVersion: 3,
    desiredRunning: record.desiredRunning,
    transport,
    externalGatewayPort,
    configuredPublicOrigin,
    configuredNgrokOrigin,
    configuredExternalOrigin,
    registeredClients,
    trustedClients,
    refreshGrants,
  };
}

function normalizePersistedRegisteredClient(value: unknown, trustedFallback: boolean): RegisteredClient | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const client = value as Record<string, unknown>;
  if (typeof client.clientId !== 'string' || client.clientId.length === 0 || client.clientId.length > 256) return null;
  const redirectUris = Array.isArray(client.redirectUris)
    ? client.redirectUris.filter((uri): uri is string => typeof uri === 'string' && isSafeRedirectUri(uri)).slice(0, 16)
    : [];
  if (redirectUris.length === 0) return null;
  const clientName = typeof client.clientName === 'string' ? client.clientName.slice(0, 120) : null;
  const tokenEndpointAuthMethod: TokenEndpointAuthMethod = client.tokenEndpointAuthMethod === 'client_secret_post' ? 'client_secret_post' : 'none';
  const clientSecret = tokenEndpointAuthMethod === 'client_secret_post' && typeof client.clientSecret === 'string' && client.clientSecret.length >= 32 && client.clientSecret.length <= 256
    ? client.clientSecret
    : null;
  if (tokenEndpointAuthMethod === 'client_secret_post' && clientSecret === null) return null;
  const trusted = typeof client.trusted === 'boolean' ? client.trusted : trustedFallback;
  const registeredAt = typeof client.registeredAt === 'number' && Number.isFinite(client.registeredAt) && client.registeredAt >= 0
    ? client.registeredAt
    : 0;
  return { clientId: client.clientId, redirectUris, clientName, tokenEndpointAuthMethod, clientSecret, trusted, registeredAt };
}

function isRemoteMcpTransport(value: unknown): value is RemoteMcpTransport {
  return value === 'ngrok' || value === 'cloudflare' || value === 'custom' || value === 'local';
}

function isValidGatewayPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

export function normalizeConfiguredPublicOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const origin = normalizePublicOrigin(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  if (origin === null) throw new Error('Enter a valid HTTPS public domain or hostname without a path, query, fragment, credentials, or port.');
  const hostname = new URL(origin).hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || hostname.startsWith('127.')) throw new Error('The public origin must use a public hostname, not localhost or loopback.');
  return origin;
}

function normalizePublicOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0 || url.port.length > 0 || url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) return null;
    return url.origin;
  } catch { return null; }
}

export function enforceStablePublicOrigin(value: unknown, configuredOrigin: string | null): string {
  const origin = normalizePublicOrigin(value);
  if (origin === null) throw new Error('ngrok reported an invalid public HTTPS origin');
  if (configuredOrigin !== null && origin !== configuredOrigin) {
    throw new Error(`ngrok reported ${origin}, but Remote MCP was explicitly configured to use ${configuredOrigin}. Remote MCP stopped instead of silently changing the endpoint.`);
  }
  return origin;
}

function withStableOriginHint(message: string, configuredOrigin: string | null): string {
  return configuredOrigin === null
    ? message
    : `${message} The configured Remote MCP domain ${configuredOrigin} was explicitly requested. Verify that it is reserved in your ngrok account or clear the configured domain; lnwjing will not silently change it.`;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === 'ENOENT';
}

const NGROK_OWNERSHIP_METADATA = 'lnwjing-remote-mcp';

export function buildNgrokHttpArgs(gatewayUrl: string, publicOrigin: string | null = null): string[] {
  return ['http', gatewayUrl, ...(publicOrigin === null ? [] : ['--url', publicOrigin]), `--metadata=${NGROK_OWNERSHIP_METADATA}`, '--log=stdout', '--log-format=json'];
}

type NgrokInstaller = Readonly<{
  method: 'windows_store' | 'homebrew';
  executable: string;
  args: readonly string[];
}>;

export async function resolveNgrokExecutable(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  runner: typeof runCommand = runCommand,
): Promise<string | null> {
  if (platform === 'win32') {
    let output: string;
    try {
      output = await runner('where.exe', ['ngrok.exe'], 5_000);
    } catch { return null; }
    const candidates = [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0))];
    for (const candidate of candidates) {
      try {
        const version = await runner(candidate, ['version'], 5_000);
        if (/\bngrok\s+version\b/i.test(version)) return candidate;
      } catch { /* Ignore stale App Execution Aliases and try the next candidate. */ }
    }
    return null;
  }
  if (platform !== 'darwin' && platform !== 'linux') return null;

  const candidates = posixExecutableCandidates('ngrok', platform, environment);
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const metadata = await stat(canonical);
      if (!metadata.isFile() || (metadata.mode & 0o111) === 0) continue;
      const version = await runner(canonical, ['version'], 5_000);
      if (/\bngrok\s+version\b/i.test(version)) return canonical;
    } catch { /* Ignore missing/stale package-manager links and try the next candidate. */ }
  }
  return null;
}

export async function resolveManagedNgrokExecutable(
  dataPath: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  runner: typeof runCommand = runCommand,
): Promise<string | null> {
  if (platform !== 'win32') return resolveNgrokExecutable(platform, environment, runner);
  const managed = path.join(dataPath, 'runtime-tools', 'ngrok', 'ngrok.exe');
  try {
    const version = await runner(managed, ['version'], 5_000);
    if (/\bngrok\s+version\b/i.test(version)) return managed;
  } catch { /* Missing or invalid managed copy; resolve an official source below. */ }

  try {
    const installLocation = (await runner('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$pkg = Get-AppxPackage -Name ngrok.ngrok -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1; if ($null -ne $pkg) { [Console]::Out.Write($pkg.InstallLocation) }",
    ], 8_000)).trim();
    if (installLocation.length > 0) {
      const source = path.join(installLocation, 'ngrok.exe');
      const version = await runner(source, ['version'], 5_000);
      if (/\bngrok\s+version\b/i.test(version)) {
        await mkdir(path.dirname(managed), { recursive: true });
        await copyFile(source, managed);
        const managedVersion = await runner(managed, ['version'], 5_000);
        if (/\bngrok\s+version\b/i.test(managedVersion)) return managed;
      }
    }
  } catch { /* Fall back to an already-runnable PATH/App Execution Alias candidate. */ }

  return resolveNgrokExecutable(platform, environment, runner);
}

async function resolveNgrokAutomaticInstaller(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  runner: typeof runCommand = runCommand,
): Promise<NgrokInstaller | null> {
  if (platform === 'win32') {
    try {
      const output = await runner('where.exe', ['winget.exe'], 5_000);
      const winget = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
      return winget === undefined ? null : {
        method: 'windows_store', executable: winget,
        args: ['install', 'ngrok', '-s', 'msstore', '--accept-package-agreements', '--accept-source-agreements', '--silent'],
      };
    } catch { return null; }
  }
  if (platform !== 'darwin') return null;
  for (const candidate of posixExecutableCandidates('brew', 'darwin', environment)) {
    try {
      const canonical = await realpath(candidate);
      const metadata = await stat(canonical);
      if (!metadata.isFile() || (metadata.mode & 0o111) === 0) continue;
      await runner(canonical, ['--version'], 5_000);
      return { method: 'homebrew', executable: canonical, args: ['install', 'ngrok'] };
    } catch { /* Try the next standard Homebrew location. */ }
  }
  return null;
}

export function posixExecutableCandidates(name: string, platform: 'darwin' | 'linux', environment: NodeJS.ProcessEnv): string[] {
  const fromPath = (environment.PATH ?? '').split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && path.posix.isAbsolute(entry))
    .map((entry) => path.posix.join(entry, name));
  const standard = platform === 'darwin'
    ? [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]
    : [`/usr/local/bin/${name}`, `/usr/bin/${name}`, `/snap/bin/${name}`];
  return [...new Set([...fromPath, ...standard])];
}

export function selectRecoverableStaleNgrokProcess(processes: readonly NgrokProcessSnapshot[], target: string): NgrokProcessSnapshot | null {
  const normalizedTarget = target.trim().toLowerCase();
  const matches = processes.filter((entry) => {
    if (entry.parentAlive || entry.processId <= 0) return false;
    const commandLine = entry.commandLine.trim().toLowerCase().replace(/\s+/g, ' ');
    return /(?:^|[\\/\s])ngrok(?:\.exe)?(?:\s|$)/i.test(commandLine)
      && commandLine.includes(` http ${normalizedTarget} `)
      && commandLine.includes(`--metadata=${NGROK_OWNERSHIP_METADATA}`)
      && commandLine.includes('--log=stdout')
      && commandLine.includes('--log-format=json');
  });
  return matches.length === 1 ? matches[0] ?? null : null;
}

async function recoverStaleLnwjingNgrokRuntime(): Promise<boolean> {
  const tunnels = await readNgrokTunnelSnapshots();
  if (tunnels.length === 0) return false;
  const processes = await readNgrokProcessSnapshots();
  for (const tunnel of tunnels) {
    if (!isLoopbackHttpTarget(tunnel.target)) continue;
    if (await isHttpTargetReachable(tunnel.target)) continue;
    const stale = selectRecoverableStaleNgrokProcess(processes, tunnel.target);
    if (stale === null) continue;
    try { process.kill(stale.processId); } catch { continue; }
    const deadline = Date.now() + 2_500;
    while (Date.now() < deadline && isProcessAlive(stale.processId)) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!isProcessAlive(stale.processId)) return true;
  }
  return false;
}

async function readNgrokTunnelSnapshots(): Promise<NgrokTunnelSnapshot[]> {
  try {
    const response = await fetch(NGROK_API, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return [];
    const body = await response.json() as { tunnels?: Array<{ public_url?: unknown; config?: { addr?: unknown } }> };
    return (body.tunnels ?? []).flatMap((entry) => {
      const publicUrl = typeof entry.public_url === 'string' ? entry.public_url : null;
      const target = typeof entry.config?.addr === 'string' ? entry.config.addr : null;
      return publicUrl !== null && publicUrl.startsWith('https://') && target !== null ? [{ publicUrl, target }] : [];
    });
  } catch { return []; }
}

async function readNgrokProcessSnapshots(): Promise<NgrokProcessSnapshot[]> {
  if (process.platform !== 'win32') return readPosixNgrokProcessSnapshots();
  const systemRoot = process.env.SystemRoot?.trim() || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '$items = @(Get-CimInstance Win32_Process -Filter "Name=\'ngrok.exe\'" | ForEach-Object { [pscustomobject]@{ ProcessId=[int]$_.ProcessId; ParentProcessId=[int]$_.ParentProcessId; ParentAlive=[bool](Get-Process -Id ([int]$_.ParentProcessId) -ErrorAction SilentlyContinue); CommandLine=[string]$_.CommandLine } }); ConvertTo-Json -Compress -InputObject $items';
  try {
    const output = await runCommand(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], 5_000);
    if (output.trim().length === 0) return [];
    const parsed = JSON.parse(output) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((entry): NgrokProcessSnapshot[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const processId = Number(record.ProcessId);
      const parentProcessId = Number(record.ParentProcessId);
      if (!Number.isInteger(processId) || !Number.isInteger(parentProcessId)) return [];
      return [{
        processId,
        parentProcessId,
        parentAlive: record.ParentAlive === true,
        commandLine: typeof record.CommandLine === 'string' ? record.CommandLine : '',
      }];
    });
  } catch { return []; }
}

async function readPosixNgrokProcessSnapshots(): Promise<NgrokProcessSnapshot[]> {
  try {
    const output = await runCommand('/bin/ps', ['-axo', 'pid=,ppid=,command='], 5_000);
    return output.split(/\r?\n/).flatMap((line): NgrokProcessSnapshot[] => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return [];
      const processId = Number(match[1]);
      const parentProcessId = Number(match[2]);
      const commandLine = match[3];
      if (!Number.isInteger(processId) || !Number.isInteger(parentProcessId)
        || !/(?:^|[\\/\s])ngrok(?:\s|$)/i.test(commandLine)) return [];
      return [{ processId, parentProcessId, parentAlive: isProcessAlive(parentProcessId), commandLine }];
    });
  } catch { return []; }
}

function isLoopbackHttpTarget(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port.length > 0;
  } catch { return false; }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Could not reserve a loopback gateway port');
    return address.port;
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function isHttpTargetReachable(value: string): Promise<boolean> {
  try {
    await fetch(value, { redirect: 'manual', signal: AbortSignal.timeout(900) });
    return true;
  } catch { return false; }
}

export async function verifyExternalPublicOrigin(
  value: string,
  timeoutMs = 8_000,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const origin = normalizePublicOrigin(value);
  if (origin === null) return false;
  try {
    const response = await fetcher(`${origin}/.well-known/oauth-authorization-server`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return false;
    const body = await response.json() as { issuer?: unknown; authorization_endpoint?: unknown; token_endpoint?: unknown };
    return body.issuer === origin
      && body.authorization_endpoint === `${origin}/oauth/authorize`
      && body.token_endpoint === `${origin}/oauth/token`;
  } catch { return false; }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForNgrokPublicOrigin(timeoutMs: number, expectedTarget: string): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(NGROK_API, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) {
        const body = await response.json() as { tunnels?: Array<{ public_url?: unknown; forwards_to?: unknown; config?: { addr?: unknown } }> };
        const httpsTunnels = (body.tunnels ?? []).filter((entry): entry is { public_url: string; forwards_to?: unknown; config?: { addr?: unknown } } => typeof entry.public_url === 'string' && entry.public_url.startsWith('https://'));
        const exact = httpsTunnels.find((entry) => entry.forwards_to === expectedTarget || entry.config?.addr === expectedTarget);
        const selected = exact ?? (httpsTunnels.length === 1 ? httpsTunnels[0] : undefined);
        if (selected !== undefined) return selected.public_url.replace(/\/$/, '');
      }
    } catch { /* retry while ngrok boots */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function proxyMcp(request: IncomingMessage, response: ServerResponse, target: string): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ['host', 'authorization', 'origin', 'content-length', 'connection', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].includes(name.toLowerCase())) continue;
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else headers.set(name, value);
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBuffer(request, 4 * 1024 * 1024);
  const upstreamBody = body === undefined ? undefined : new Uint8Array(body);
  const upstream = await fetch(target, { method: request.method ?? 'GET', headers, ...(upstreamBody === undefined ? {} : { body: upstreamBody }) });
  response.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) response.setHeader(name, value);
  });
  if (upstream.body === null) { response.end(); return; }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) await new Promise<void>((resolve) => response.once('drain', resolve));
    }
  } finally { reader.releaseLock(); }
  response.end();
}

async function readJson(request: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const text = await readText(request, max);
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('JSON object required');
  return value as Record<string, unknown>;
}

async function readText(request: IncomingMessage, max: number): Promise<string> { return (await readBuffer(request, max)).toString('utf8'); }
async function readBuffer(request: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > max) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
}
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function html(response: ServerResponse, status: number, body: string, formActionOrigins: readonly string[] = []): void {
  const formActions = ["'self'", ...formActionOrigins.map((origin) => new URL(origin).origin)].join(' ');
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${formActions}; base-uri 'none'; frame-ancestors 'none'`);
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(body);
}

function token(bytes: number): string { return randomBytes(bytes).toString('base64url'); }
function verifyPkce(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const actual = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return actual.length === challenge.length && timingSafeEqual(Buffer.from(actual), Buffer.from(challenge));
}
function parseBearer(value: string | undefined): string | null {
  const match = /^Bearer\s+([^\s]+)$/i.exec(value ?? '');
  return match?.[1] ?? null;
}
function isSupportedRegistrationStringArray(value: unknown, supported: readonly string[]): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && supported.includes(entry));
}
function verifyClientAuthentication(client: RegisteredClient, providedSecret: string | null): boolean {
  if (client.tokenEndpointAuthMethod === 'none') return true;
  if (client.clientSecret === null || providedSecret === null) return false;
  const expected = Buffer.from(client.clientSecret, 'utf8');
  const actual = Buffer.from(providedSecret, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function isRecognizedChatGptClient(client: RegisteredClient): boolean {
  return client.redirectUris.length > 0 && client.redirectUris.every(isRecognizedChatGptRedirectUri);
}

function canRecoverLegacyChatGptClient(params: URLSearchParams, publicOrigin: string): boolean {
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const state = params.get('state') ?? '';
  const resource = params.get('resource') ?? '';
  const challenge = params.get('code_challenge') ?? '';
  return params.get('response_type') === 'code'
    && params.get('code_challenge_method') === 'S256'
    && /^[A-Za-z0-9_-]{16,256}$/.test(clientId)
    && challenge.length >= 32 && challenge.length <= 256
    && state.length > 0 && state.length <= 2_048
    && isRecognizedChatGptRedirectUri(redirectUri)
    && resource === `${publicOrigin}/mcp`;
}

function isRecognizedChatGptRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'chatgpt.com'
      && url.username.length === 0
      && url.password.length === 0
      && url.search.length === 0
      && url.hash.length === 0
      && (CHATGPT_OAUTH_CALLBACK_PATHS.has(url.pathname) || CHATGPT_OAUTH_DYNAMIC_CALLBACK_PATH.test(url.pathname));
  } catch { return false; }
}

function isSafeRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash.length > 0 || url.username.length > 0 || url.password.length > 0) return false;
    return url.protocol === 'https:' || ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.protocol === 'http:');
  } catch { return false; }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function redactNgrokError(value: string): string { return value.replace(/(authtoken|token)[=:"'\s]+[^\s,"']+/gi, '$1=[redacted]').slice(0, 500); }

export function extractNgrokDiagnostic(value: string): string | null {
  const redacted = redactNgrokError(value.trim());
  if (redacted.length === 0) return null;
  const lines = redacted.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  let bestScore = -1;
  let bestMessage: string | null = null;
  const consider = (raw: string, level = ''): void => {
    const message = redactNgrokError(raw.trim());
    if (message.length === 0 || /^ERROR:\s*$/i.test(message) || /^https?:\/\/ngrok\.com\/docs\/errors\//i.test(message)) return;
    let score = 0;
    if (/ERR_NGROK_\d+/i.test(message)) score += 100;
    if (/failed to start tunnel/i.test(message)) score += 80;
    if (/authentication|authtoken|unknown flag|failed|fatal/i.test(message)) score += 50;
    if (/^ERROR:/i.test(message)) score += 20;
    if (['error', 'eror', 'crit', 'fatal'].includes(level)) score += 10;
    if (score <= 0) return;
    if (score > bestScore || (score === bestScore && message.length > (bestMessage?.length ?? 0))) {
      bestScore = score;
      bestMessage = message;
    }
  };
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const level = typeof parsed.lvl === 'string' ? parsed.lvl.toLowerCase() : typeof parsed.level === 'string' ? parsed.level.toLowerCase() : '';
      for (const candidate of [parsed.err, parsed.message, parsed.msg]) {
        if (typeof candidate === 'string') consider(candidate, level);
      }
    } catch { consider(line); }
  }
  return bestMessage;
}

export function formatNgrokExitMessage(code: number | null, diagnostic: string | null): string {
  const prefix = `ngrok stopped unexpectedly (exit ${code ?? 'unknown'})`;
  return diagnostic === null ? prefix : `${prefix}: ${diagnostic}`;
}

function runCommand(executable: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${executable} timed out`)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${executable} exited with code ${code ?? 'unknown'}`));
    });
  });
}
