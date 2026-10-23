import {
  createDesktopRuntime as createProductionDesktopRuntime,
  type DesktopRuntime,
} from '../src/main/desktop-services.js';

export type { DesktopRuntime };

/**
 * Disposable Desktop integration runtimes must provide their own key.
 * The production composition root remains fail-closed if no protected key is supplied.
 * This constant is TEST-ONLY; never export it into shipped Desktop/CLI bundles.
 */
export function createDesktopRuntime(...args: Parameters<typeof createProductionDesktopRuntime>): DesktopRuntime {
  const [dataRoot, options] = args;
  return createProductionDesktopRuntime(dataRoot, {
    ...options,
    ...(options?.checkpointEncryptionKey === undefined && options?.checkpointCipher === undefined
      ? { checkpointEncryptionKey: Buffer.alloc(32, 0x42) }
      : {}),
  });
}
