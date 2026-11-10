import path from 'node:path';
import type { ProfileStorageInventory } from './profile-storage-inventory.js';

/**
 * Share an in-flight, off-main profile walk ONLY among quota admissions which
 * observed the same ledger generation. A settled result is never cached:
 * each later admission sees new files, not a possibly outdated inventory.
 *
 * Revision-fencing matters: a committed/released writer or policy update
 * increments the ledger generation and MUST trigger its own scan. Coalescing
 * across revisions would let a scan started before a write be reused after
 * that write finished, potentially undercounting profile storage.
 */
const inFlight = new Map<string, Promise<ProfileStorageInventory>>();

export function coalesceQuotaInventory(
  profileRoot: string,
  revision: number,
  scan: () => Promise<ProfileStorageInventory>,
): Promise<ProfileStorageInventory> {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    return Promise.reject(new Error('Invalid global quota inventory generation'));
  }
  const key = JSON.stringify([path.resolve(profileRoot), revision]);
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;

  // Defer scanning to the next microtask so even a synchronously throwing
  // scanner results in a rejected shared promise that gets cleaned up.
  const pending = Promise.resolve().then(scan);
  inFlight.set(key, pending);
  const clear = (): void => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  };
  void pending.then(clear, clear);
  return pending;
}
