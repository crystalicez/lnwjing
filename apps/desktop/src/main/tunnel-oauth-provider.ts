import type { TunnelAuthStatus } from '@lnwjing/ipc-contracts';
import type { TunnelAuthDiagnostics, TunnelAuthProvider, TunnelNetworkErrorDiagnostic, TunnelNetworkErrorCategory, TunnelRuntimeCredential } from './tunnel-auth.js';
import type { TunnelOAuthProviderDescriptor } from './tunnel-oauth-core.js';
import { TunnelOAuthSessionStore, type TunnelOAuthStoredSession } from './tunnel-oauth-store.js';

export interface TunnelOAuthProvisionedCredential {
  readonly runtimeCredential: string;
  readonly expiresAt: string | null;
  readonly tunnelId: string;
  readonly accountId: string | null;
  readonly accountLabel: string | null;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
}

export interface TunnelOAuthExchangeResult {
  readonly refreshToken: string;
  readonly provisioned: TunnelOAuthProvisionedCredential;
}

export interface TunnelOAuthProvisioningBackend {
  readonly descriptor: TunnelOAuthProviderDescriptor;
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly verifier: string;
    readonly redirectUri: string;
  }): Promise<TunnelOAuthExchangeResult>;
  refreshAndProvision(session: TunnelOAuthStoredSession): Promise<TunnelOAuthProvisionedCredential>;
  revoke?(session: TunnelOAuthStoredSession): Promise<void>;
}

export interface OAuthTunnelAuthProviderOptions {
  readonly backend: TunnelOAuthProvisioningBackend;
  readonly sessionStore: TunnelOAuthSessionStore;
  readonly expectedTunnelId?: () => string | null;
  readonly now?: () => Date;
}

/**
 * OAuth-backed runtime credential provider. It is intentionally backend-agnostic:
 * production activation requires an explicitly supported provisioning backend.
 * Access/runtime credentials remain memory-only; only a DPAPI-protected refresh
 * session is persisted by TunnelOAuthSessionStore.
 */
export class OAuthTunnelAuthProvider implements TunnelAuthProvider {
  private cachedCredential: TunnelOAuthProvisionedCredential | null = null;
  private refreshAttemptCount = 0;
  private refreshSuccessCount = 0;
  private refreshFailureCount = 0;
  private cacheHitCount = 0;
  private lastRefreshStartedAt: string | null = null;
  private lastRefreshCompletedAt: string | null = null;
  private lastRefreshResult: TunnelAuthDiagnostics['lastRefreshResult'] = 'never';
  private lastRefreshError: TunnelNetworkErrorDiagnostic | null = null;

  public constructor(private readonly options: OAuthTunnelAuthProviderOptions) {}

  public async status(): Promise<TunnelAuthStatus> {
    const session = await this.options.sessionStore.read().catch(() => null);
    const descriptor = this.options.backend.descriptor;
    if (!descriptor.enabled || !descriptor.supportsTunnelProvisioning) {
      return this.unavailableStatus(session, 'OAuth tunnel provisioning is not supported by the configured provider');
    }
    if (session === null) {
      return {
        mode: 'oauth', authReady: false, runtimeCredentialAvailable: false, hasLegacyApiKey: false,
        accountLabel: null, organizationId: null, workspaceId: null, expiresAt: null,
        requiresUserAction: true, message: 'Sign in to use OAuth tunnel authentication',
      };
    }
    const cached = this.cachedCredential;
    const cachedUsable = cached !== null && !isExpiredSoon(cached.expiresAt, this.now());
    return {
      mode: 'oauth',
      authReady: true,
      runtimeCredentialAvailable: cachedUsable,
      hasLegacyApiKey: false,
      accountLabel: session.accountLabel,
      organizationId: session.organizationId,
      workspaceId: session.workspaceId,
      expiresAt: cached?.expiresAt ?? null,
      requiresUserAction: false,
      message: cachedUsable ? null : 'OAuth session is available; runtime credential will be refreshed before use',
    };
  }

  public async getRuntimeCredential(): Promise<TunnelRuntimeCredential | null> {
    const descriptor = this.options.backend.descriptor;
    if (!descriptor.enabled || !descriptor.supportsTunnelProvisioning) return null;
    const cached = this.cachedCredential;
    if (cached !== null && !isExpiredSoon(cached.expiresAt, this.now())) {
      this.assertTunnelIdentity(cached.tunnelId);
      this.cacheHitCount += 1;
      return { value: cached.runtimeCredential, authMode: 'oauth', expiresAt: cached.expiresAt };
    }
    const session = await this.options.sessionStore.read();
    if (session === null) return null;
    this.refreshAttemptCount += 1;
    this.lastRefreshStartedAt = this.now().toISOString();
    this.lastRefreshCompletedAt = null;
    this.lastRefreshError = null;
    try {
      const provisioned = await this.options.backend.refreshAndProvision(session);
      this.validateProvisioned(provisioned);
      this.assertTunnelIdentity(provisioned.tunnelId);
      this.cachedCredential = provisioned;
      this.refreshSuccessCount += 1;
      this.lastRefreshResult = 'success';
      this.lastRefreshCompletedAt = this.now().toISOString();
      return { value: provisioned.runtimeCredential.trim(), authMode: 'oauth', expiresAt: provisioned.expiresAt };
    } catch (error: unknown) {
      this.refreshFailureCount += 1;
      this.lastRefreshResult = 'failure';
      this.lastRefreshCompletedAt = this.now().toISOString();
      this.lastRefreshError = oauthRefreshErrorDiagnostic(error);
      throw error;
    }
  }

  public diagnostics(): TunnelAuthDiagnostics {
    return {
      mode: 'oauth',
      refreshAttemptCount: this.refreshAttemptCount,
      refreshSuccessCount: this.refreshSuccessCount,
      refreshFailureCount: this.refreshFailureCount,
      cacheHitCount: this.cacheHitCount,
      lastRefreshStartedAt: this.lastRefreshStartedAt,
      lastRefreshCompletedAt: this.lastRefreshCompletedAt,
      lastRefreshResult: this.lastRefreshResult,
      lastRefreshError: this.lastRefreshError,
      lastCredentialExpiresAt: this.cachedCredential?.expiresAt ?? null,
    };
  }

  public async saveLegacyApiKey(): Promise<void> {
    throw new Error('Legacy Runtime API keys cannot be saved through the OAuth auth provider');
  }

  public async activateFromAuthorizationCode(input: {
    readonly code: string;
    readonly verifier: string;
    readonly redirectUri: string;
  }): Promise<TunnelOAuthProvisionedCredential> {
    const descriptor = this.options.backend.descriptor;
    if (!descriptor.enabled || !descriptor.supportsTunnelProvisioning) {
      throw new Error('OAuth tunnel provisioning is not available from this provider');
    }
    const result = await this.options.backend.exchangeAuthorizationCode(input);
    this.validateProvisioned(result.provisioned);
    this.assertTunnelIdentity(result.provisioned.tunnelId);
    const now = this.now().toISOString();
    await this.options.sessionStore.write({
      schemaVersion: 1,
      providerId: descriptor.id,
      refreshToken: requiredSecret(result.refreshToken, 'OAuth refresh token'),
      accountId: result.provisioned.accountId,
      accountLabel: result.provisioned.accountLabel,
      organizationId: result.provisioned.organizationId,
      workspaceId: result.provisioned.workspaceId,
      createdAt: now,
      updatedAt: now,
    });
    this.cachedCredential = result.provisioned;
    return result.provisioned;
  }

  public async logout(): Promise<void> {
    const session = await this.options.sessionStore.read().catch(() => null);
    if (session !== null && this.options.backend.revoke !== undefined) await this.options.backend.revoke(session);
    this.cachedCredential = null;
    await this.options.sessionStore.clear();
  }

  private assertTunnelIdentity(tunnelId: string): void {
    const expected = this.options.expectedTunnelId?.()?.trim() ?? '';
    if (expected.length > 0 && expected !== tunnelId.trim()) {
      throw new Error('AUTH_ORG_MISMATCH: OAuth provisioning resolved a different Tunnel ID than the saved persistent identity');
    }
  }

  private validateProvisioned(value: TunnelOAuthProvisionedCredential): void {
    if (!/^tunnel_[A-Za-z0-9_-]{8,128}$/.test(value.tunnelId.trim())) throw new Error('OAuth provisioning returned an invalid Tunnel ID');
    requiredSecret(value.runtimeCredential, 'OAuth-provisioned runtime credential');
    if (value.expiresAt !== null && Number.isNaN(Date.parse(value.expiresAt))) throw new Error('OAuth provisioning returned an invalid credential expiry');
  }

  private unavailableStatus(session: TunnelOAuthStoredSession | null, message: string): TunnelAuthStatus {
    return {
      mode: 'oauth', authReady: false, runtimeCredentialAvailable: false, hasLegacyApiKey: false,
      accountLabel: session?.accountLabel ?? null,
      organizationId: session?.organizationId ?? null,
      workspaceId: session?.workspaceId ?? null,
      expiresAt: null, requiresUserAction: true, message,
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function oauthRefreshErrorDiagnostic(error: unknown): TunnelNetworkErrorDiagnostic {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const message = (error instanceof Error ? error.message : String(error)).trim().slice(0, 512) || 'OAuth refresh failed';
  const rawCode = typeof record.code === 'string' ? record.code.trim() : '';
  const status = typeof record.status === 'number' ? record.status : typeof record.statusCode === 'number' ? record.statusCode : null;
  const code = rawCode.length > 0 ? rawCode.slice(0, 64) : status === null ? null : `HTTP_${status}`;
  const haystack = `${code ?? ''} ${message}`.toUpperCase();
  let category: TunnelNetworkErrorCategory = 'unknown';
  if (/ECONNRESET|EPIPE|SOCKET.*CLOSED/.test(haystack)) category = 'connection_reset';
  else if (/ETIMEDOUT|ESOCKETTIMEDOUT|TIMEOUT|ABORT/.test(haystack)) category = 'timeout';
  else if (/ENOTFOUND|EAI_AGAIN|DNS/.test(haystack)) category = 'dns';
  else if (/CERT_|TLS|SSL|ERR_TLS|ERR_SSL/.test(haystack)) category = 'tls';
  else if (/ECONNREFUSED/.test(haystack)) category = 'connection_refused';
  else if (status !== null || /\bHTTP[_ -]?\d{3}\b/.test(haystack)) category = 'http';
  return { code, category, message };
}

function isExpiredSoon(expiresAt: string | null, now: Date): boolean {
  if (expiresAt === null) return false;
  return Date.parse(expiresAt) <= now.getTime() + 60_000;
}

function requiredSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} is empty`);
  return trimmed;
}
