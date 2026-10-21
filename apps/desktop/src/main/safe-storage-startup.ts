import type { CheckpointPayloadCipher } from '@lnwjing/storage';

const MACOS_ASYNC_SAFE_STORAGE_SETTLE_MS = 2_000;

export interface MacosAsyncSafeStorageStartupOptions {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly release: string;
  readonly isPackaged: boolean;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface Macos26E2eSecretOptions {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly release: string;
  readonly isPackaged: boolean;
  readonly e2eFixture: boolean;
  readonly ephemeralSecrets: boolean;
}

export interface SecureStorageStartupStatus {
  readonly secure: boolean;
  readonly backend: string;
  readonly reason?: string;
}

export function shouldDegradeUnavailableSecureStorage(
  platform: NodeJS.Platform,
  status: SecureStorageStartupStatus,
): boolean {
  return platform === 'linux' && !status.secure;
}

export function createUnavailableCheckpointCipher(message: string): CheckpointPayloadCipher {
  const unavailable = (): never => { throw new Error(message); };
  return { encrypt: unavailable, decrypt: unavailable, isEncrypted: () => true };
}

/**
 * Hosted macOS 26 arm64 runners do not expose a usable login Keychain to the
 * packaged smoke process. Keep the compatibility test deterministic with an
 * in-memory fixture provider; production launches never opt into this path.
 */
export function shouldUseMacos26E2eSecrets(options: Macos26E2eSecretOptions): boolean {
  const darwinMajor = Number.parseInt(options.release.split('.')[0] ?? '', 10);
  return options.isPackaged
    && options.platform === 'darwin'
    && options.arch === 'arm64'
    && Number.isInteger(darwinMajor)
    && darwinMajor >= 25
    && options.e2eFixture
    && options.ephemeralSecrets;
}

/**
 * Electron's macOS Keychain provider initializes lazily after app.ready. On
 * packaged macOS 26 Apple Silicon hosts, probing it immediately can leave both
 * safeStorage APIs pending. Electron issue #51759 documents the same startup
 * race and a two-second initialization window.
 *
 * CI also supplies an unlocked disposable default Keychain. Neither the delay
 * nor that Keychain is sufficient alone, so keep this delay scoped to the one
 * host combination where both conditions are required.
 */
export async function waitForMacosAsyncSafeStorageStartup(
  options: MacosAsyncSafeStorageStartupOptions,
): Promise<void> {
  const darwinMajor = Number.parseInt(options.release.split('.')[0] ?? '', 10);
  const affected = options.isPackaged
    && options.platform === 'darwin'
    && options.arch === 'arm64'
    && Number.isInteger(darwinMajor)
    && darwinMajor >= 25;
  if (!affected) return;

  const sleep = options.sleep ?? ((milliseconds: number): Promise<void> => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  await sleep(MACOS_ASYNC_SAFE_STORAGE_SETTLE_MS);
}
