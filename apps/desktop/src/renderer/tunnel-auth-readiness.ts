import type { TunnelStatus } from '@lnwjing/ipc-contracts';

/**
 * Backward-compatible renderer helpers. New Desktop builds emit auth-neutral
 * fields; older fixtures/clients fall back to the legacy hasApiKey signal.
 */
export function tunnelAuthReady(tunnel: TunnelStatus): boolean {
  return tunnel.authReady ?? tunnel.auth?.authReady ?? tunnel.hasApiKey;
}

export function tunnelRuntimeCredentialAvailable(tunnel: TunnelStatus): boolean {
  return tunnel.runtimeCredentialAvailable
    ?? tunnel.auth?.runtimeCredentialAvailable
    ?? tunnel.authReady
    ?? tunnel.hasApiKey;
}

export function tunnelHasLegacyApiKey(tunnel: TunnelStatus): boolean {
  return tunnel.auth?.hasLegacyApiKey ?? tunnel.hasApiKey;
}
