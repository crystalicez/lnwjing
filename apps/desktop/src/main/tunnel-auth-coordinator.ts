import type { TunnelAuthMode, TunnelAuthStatus } from '@lnwjing/ipc-contracts';
import type { TunnelAuthDiagnostics, TunnelAuthProvider, TunnelRuntimeCredential } from './tunnel-auth.js';

export interface TunnelAuthModeStore {
  get(): TunnelAuthMode | null;
  set(mode: TunnelAuthMode): void;
}

export interface TunnelOAuthLifecycleProvider extends TunnelAuthProvider {
  logout(): Promise<void>;
}

/**
 * Selects one active tunnel auth mechanism while retaining the inactive legacy
 * secret for explicit rollback. No provider switch is committed until the new
 * provider can return a valid runtime credential.
 */
export class TunnelAuthCoordinator implements TunnelAuthProvider {
  public constructor(
    private readonly legacy: TunnelAuthProvider,
    private readonly oauth: TunnelOAuthLifecycleProvider,
    private readonly modeStore: TunnelAuthModeStore,
  ) {}

  public mode(): TunnelAuthMode {
    return this.modeStore.get() ?? 'legacy_api_key';
  }

  public async status(): Promise<TunnelAuthStatus> {
    const [legacyStatus, oauthStatus] = await Promise.all([this.legacy.status(), this.oauth.status()]);
    const active = this.mode() === 'oauth' ? oauthStatus : legacyStatus;
    return {
      ...active,
      hasLegacyApiKey: legacyStatus.hasLegacyApiKey,
    };
  }

  public async getRuntimeCredential(): Promise<TunnelRuntimeCredential | null> {
    return this.mode() === 'oauth'
      ? this.oauth.getRuntimeCredential()
      : this.legacy.getRuntimeCredential();
  }

  public diagnostics(): TunnelAuthDiagnostics {
    const mode = this.mode();
    if (mode === 'oauth') {
      return this.oauth.diagnostics?.() ?? {
        mode,
        refreshAttemptCount: 0,
        refreshSuccessCount: 0,
        refreshFailureCount: 0,
        cacheHitCount: 0,
        lastRefreshStartedAt: null,
        lastRefreshCompletedAt: null,
        lastRefreshResult: 'never',
        lastRefreshError: null,
        lastCredentialExpiresAt: null,
      };
    }
    return {
      mode,
      refreshAttemptCount: 0,
      refreshSuccessCount: 0,
      refreshFailureCount: 0,
      cacheHitCount: 0,
      lastRefreshStartedAt: null,
      lastRefreshCompletedAt: null,
      lastRefreshResult: 'never',
      lastRefreshError: null,
      lastCredentialExpiresAt: null,
    };
  }

  public async saveLegacyApiKey(apiKey: string): Promise<void> {
    await this.legacy.saveLegacyApiKey(apiKey);
  }

  /** Commit OAuth mode only after its runtime credential is already usable. */
  public async switchToOAuth(): Promise<TunnelRuntimeCredential> {
    const credential = await this.oauth.getRuntimeCredential();
    if (credential === null || credential.value.trim().length === 0) {
      throw new Error('OAuth tunnel authentication is not ready');
    }
    this.modeStore.set('oauth');
    return credential;
  }

  /** Rollback is allowed only while the original legacy secret is still usable. */
  public async switchToLegacy(): Promise<TunnelRuntimeCredential> {
    const credential = await this.legacy.getRuntimeCredential();
    if (credential === null || credential.value.trim().length === 0) {
      throw new Error('Legacy Runtime API key is unavailable; rollback cannot be completed');
    }
    this.modeStore.set('legacy_api_key');
    return credential;
  }

  public async logoutOAuth(): Promise<void> {
    const legacyCredential = await this.legacy.getRuntimeCredential();
    await this.oauth.logout();
    if (this.mode() !== 'oauth') return;
    if (legacyCredential !== null && legacyCredential.value.trim().length > 0) {
      this.modeStore.set('legacy_api_key');
    }
  }
}
