import { lstatSync } from 'node:fs';
import path from 'node:path';

/**
 * A pending offline profile wipe is a barrier for every runtime writer.
 * Only the Desktop reset bootstrap may reconcile it before secret creation.
 */
export function assertNoPendingProfileResetSync(profileRoot: string): void {
  if (!path.isAbsolute(profileRoot)) throw new Error('Profile reset guard requires an absolute data path');
  const full = path.resolve(profileRoot);
  const marker = path.join(path.dirname(full), `.${path.basename(full)}.factory-reset.pending`);
  try {
    lstatSync(marker);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('A profile reset is pending. Open lnwjing Desktop to finish it before starting MCP or creating secrets.');
}
