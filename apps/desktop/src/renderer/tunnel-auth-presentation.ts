import type { TunnelAuthMode, TunnelAuthStatus } from '@lnwjing/ipc-contracts';
import type { MessageKey } from './i18n/messages.js';

export interface TunnelAuthPresentation {
  readonly mode: TunnelAuthMode;
  readonly isOAuth: boolean;
  readonly badge: 'OAUTH' | 'API KEY';
  readonly titleKey: MessageKey;
  readonly startKey: MessageKey;
  readonly stopKey: MessageKey;
  readonly needCredentialKey: MessageKey;
  readonly runningKey: MessageKey;
  readonly runningExternalKey: MessageKey;
  readonly incompleteExternalKey: MessageKey;
  readonly stoppedKey: MessageKey;
  readonly startingKey: MessageKey;
  readonly errorKey: MessageKey;
  readonly transportHintKey: MessageKey | null;
  readonly logTabKey: MessageKey;
  readonly logSubtitleKey: MessageKey;
  readonly logWaitingKey: MessageKey;
}

export function tunnelAuthMode(tunnel: { readonly auth?: TunnelAuthStatus | undefined }): TunnelAuthMode {
  return tunnel.auth?.mode ?? 'legacy_api_key';
}

export function tunnelAuthPresentation(tunnel: { readonly auth?: TunnelAuthStatus | undefined }): TunnelAuthPresentation {
  if (tunnelAuthMode(tunnel) === 'oauth') {
    return {
      mode: 'oauth',
      isOAuth: true,
      badge: 'OAUTH',
      titleKey: 'tunnel.oauthTitle',
      startKey: 'tunnel.oauthStart',
      stopKey: 'tunnel.oauthStop',
      needCredentialKey: 'tunnel.oauthNeedLogin',
      runningKey: 'tunnel.oauthRunning',
      runningExternalKey: 'tunnel.oauthRunningExternal',
      incompleteExternalKey: 'tunnel.oauthIncompleteExternal',
      stoppedKey: 'tunnel.oauthStopped',
      startingKey: 'tunnel.oauthStarting',
      errorKey: 'tunnel.oauthError',
      transportHintKey: 'tunnel.oauthTransportHint',
      logTabKey: 'live.tabOAuth',
      logSubtitleKey: 'live.subtitleOAuth',
      logWaitingKey: 'live.waitingOAuth',
    };
  }
  return {
    mode: 'legacy_api_key',
    isOAuth: false,
    badge: 'API KEY',
    titleKey: 'tunnel.title',
    startKey: 'tunnel.start',
    stopKey: 'tunnel.stop',
    needCredentialKey: 'tunnel.needKey',
    runningKey: 'tunnel.running',
    runningExternalKey: 'tunnel.runningExternal',
    incompleteExternalKey: 'tunnel.incompleteExternal',
    stoppedKey: 'tunnel.stopped',
    startingKey: 'tunnel.starting',
    errorKey: 'tunnel.error',
    transportHintKey: null,
    logTabKey: 'live.tabTunnel',
    logSubtitleKey: 'live.subtitle',
    logWaitingKey: 'live.waitingTunnel',
  };
}
