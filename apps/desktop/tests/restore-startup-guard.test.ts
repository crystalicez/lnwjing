import { describe, expect, it } from 'vitest';
import { assertRestoreReadyBeforeSecrets } from '../src/main/restore-startup-guard.js';

describe('fail-closed secret startup after a database restore', () => {
  it('blocks credential/key startup on partial cross-host quarantine', () => {
    expect(() => assertRestoreReadyBeforeSecrets({
      error: 'SQLite restore recovery blocked: Cross-host credential quarantine failed',
    })).toThrow(/restore must be resolved before secret storage opens/i);
  });

  it('blocks even recoverable interrupted restores until the next clean startup', () => {
    expect(() => assertRestoreReadyBeforeSecrets({ error: 'Recovered original database after interrupted SQLite restore' }))
      .toThrow(/restore must be resolved/i);
  });

  it('allows only a clean no-op or completed restore', () => {
    expect(() => assertRestoreReadyBeforeSecrets({})).not.toThrow();
  });
});
