import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildTunnelOAuthAuthorizationUrl, createTunnelOAuthLoginTransaction, parseTunnelOAuthCallback, type TunnelOAuthLoginTransaction } from './tunnel-oauth-core.js';
import { TunnelAuthCoordinator } from './tunnel-auth-coordinator.js';
import { OAuthTunnelAuthProvider, type TunnelOAuthProvisioningBackend } from './tunnel-oauth-provider.js';

export type TunnelOAuthLoginState = 'idle' | 'waiting_for_browser' | 'exchanging' | 'completed' | 'failed';

export interface TunnelOAuthLoginStatus {
  readonly state: TunnelOAuthLoginState;
  readonly available: boolean;
  readonly providerId: string | null;
  readonly authorizationUrl: string | null;
  readonly message: string | null;
}

export interface TunnelOAuthLoginManagerOptions {
  readonly backend: TunnelOAuthProvisioningBackend;
  readonly provider: OAuthTunnelAuthProvider;
  readonly coordinator: TunnelAuthCoordinator;
  /** Restart/reconcile the same persistent Tunnel ID after an auth-mode change. */
  readonly onAuthModeChanged?: (mode: 'legacy_api_key' | 'oauth') => Promise<void>;
  readonly timeoutMs?: number;
}

interface InFlightLogin {
  readonly server: Server;
  readonly transaction: TunnelOAuthLoginTransaction;
  readonly authorizationUrl: string;
  readonly timeout: ReturnType<typeof setTimeout>;
}

/** Main-process-only OAuth loopback orchestration. Renderer never submits callbacks or tokens. */
export class TunnelOAuthLoginManager {
  private inFlight: InFlightLogin | null = null;
  private state: TunnelOAuthLoginState = 'idle';
  private message: string | null = null;

  public constructor(private readonly options: TunnelOAuthLoginManagerOptions) {}

  public status(): TunnelOAuthLoginStatus {
    const descriptor = this.options.backend.descriptor;
    const available = descriptor.enabled && descriptor.supportsTunnelProvisioning;
    return {
      state: this.state,
      available,
      providerId: descriptor.id || null,
      authorizationUrl: this.inFlight?.authorizationUrl ?? null,
      message: available ? this.message : 'OpenAI Secure MCP Tunnel OAuth provisioning is not supported by the configured provider',
    };
  }

  public async begin(): Promise<TunnelOAuthLoginStatus> {
    const descriptor = this.options.backend.descriptor;
    if (!descriptor.enabled || !descriptor.supportsTunnelProvisioning) return this.status();
    if (this.inFlight !== null) return this.status();

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo | null;
    if (address === null || typeof address.port !== 'number') {
      server.close();
      throw new Error('Could not allocate OAuth loopback callback port');
    }
    const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
    const transaction = createTunnelOAuthLoginTransaction(redirectUri);
    const authorizationUrl = buildTunnelOAuthAuthorizationUrl(descriptor, transaction);
    const timeout = setTimeout(() => {
      this.failInFlight('OAuth login timed out');
    }, Math.max(30_000, Math.min(15 * 60_000, this.options.timeoutMs ?? 5 * 60_000)));
    timeout.unref?.();
    this.inFlight = { server, transaction, authorizationUrl, timeout };
    this.state = 'waiting_for_browser';
    this.message = null;

    server.on('request', (request, response) => {
      void this.handleRequest(request.method ?? 'GET', request.url ?? '/', response);
    });
    server.on('error', (error) => this.failInFlight(error.message));
    return this.status();
  }

  public cancel(): void {
    if (this.inFlight === null) return;
    this.closeInFlight();
    this.state = 'idle';
    this.message = 'OAuth login cancelled';
  }

  private async handleRequest(method: string, rawUrl: string, response: import('node:http').ServerResponse): Promise<void> {
    const active = this.inFlight;
    if (active === null) {
      response.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('OAuth login is no longer active.');
      return;
    }
    try {
      if (method.toUpperCase() !== 'GET') throw new Error('OAuth callback must use GET');
      const callbackUrl = new URL(rawUrl, active.transaction.redirectUri).toString();
      const callback = parseTunnelOAuthCallback(callbackUrl, active.transaction);
      this.state = 'exchanging';
      const previousMode = this.options.coordinator.mode();
      await this.options.provider.activateFromAuthorizationCode({
        code: callback.code,
        verifier: active.transaction.verifier,
        redirectUri: active.transaction.redirectUri,
      });
      await this.options.coordinator.switchToOAuth();
      try {
        await this.options.onAuthModeChanged?.('oauth');
      } catch (cause: unknown) {
        if (previousMode === 'legacy_api_key') {
          await this.options.coordinator.switchToLegacy();
          await this.options.onAuthModeChanged?.('legacy_api_key');
        }
        throw cause;
      }
      this.state = 'completed';
      this.message = 'OAuth tunnel authentication activated';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<!doctype html><meta charset="utf-8"><title>lnwjing</title><p>Authentication completed. You can return to lnwjing.</p>');
      this.closeInFlight();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'OAuth login failed';
      this.state = 'failed';
      this.message = message;
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('OAuth login failed. Return to lnwjing for details.');
      this.closeInFlight();
    }
  }

  private failInFlight(message: string): void {
    this.state = 'failed';
    this.message = message;
    this.closeInFlight();
  }

  private closeInFlight(): void {
    const active = this.inFlight;
    this.inFlight = null;
    if (active === null) return;
    clearTimeout(active.timeout);
    active.server.close();
  }
}
