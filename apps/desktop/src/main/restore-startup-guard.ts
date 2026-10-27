/**
 * Restore and secret-key mutation must share a fail-closed startup boundary.
 * An interrupted rollback may have moved checkpoint-master.key already.
 * Never create a replacement key until the restore is explicitly resolved.
 */
export function assertRestoreReadyBeforeSecrets(result: { readonly error?: string }): void {
  if (result.error !== undefined) {
    throw new Error('SQLite restore must be resolved before secret storage opens: ' + result.error);
  }
}
