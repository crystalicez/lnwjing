import { describe, expect, it } from 'vitest';
import type { TunnelStatus } from '@lnwjing/ipc-contracts';
import { tunnelAuthPresentation } from '../src/renderer/tunnel-auth-presentation.js';

function tunnel(overrides: Partial<TunnelStatus> = {}): TunnelStatus {
  return {
    state: 'stopped',
    source: 'desktop',
    hasApiKey: false,
    clientPath: null,
    profileExists: false,
    message: null,
    logPath: null,
    persistent: null,
    ...overrides,
  };
}

describe('tunnel auth presentation', () => {
  it('keeps legacy Runtime API key presentation for old status payloads', () => {
    expect(tunnelAuthPresentation(tunnel())).toMatchObject({
      mode: 'legacy_api_key',
      badge: 'API KEY',
      titleKey: 'tunnel.title',
      needCredentialKey: 'tunnel.needKey',
      logTabKey: 'live.tabTunnel',
      logWaitingKey: 'live.waitingTunnel',
    });
  });

  it('switches the complete presentation surface to OAuth when auth mode is OAuth', () => {
    expect(tunnelAuthPresentation(tunnel({
      authReady: true,
      runtimeCredentialAvailable: true,
      auth: {
        mode: 'oauth',
        authReady: true,
        runtimeCredentialAvailable: true,
        hasLegacyApiKey: true,
        accountLabel: 'Signed-in account',
        organizationId: null,
        workspaceId: null,
        expiresAt: null,
        requiresUserAction: false,
        message: null,
      },
    }))).toMatchObject({
      mode: 'oauth',
      badge: 'OAUTH',
      titleKey: 'tunnel.oauthTitle',
      needCredentialKey: 'tunnel.oauthNeedLogin',
      logTabKey: 'live.tabOAuth',
      logWaitingKey: 'live.waitingOAuth',
    });
  });
});
