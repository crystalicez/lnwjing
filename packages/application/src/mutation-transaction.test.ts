import { describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@lnwjing/domain';
import { runMutationTransaction } from './mutation-transaction.js';

describe('runMutationTransaction', () => {
  it('rolls back the final completed side effect when cancellation wins during its commit', async () => {
    const events: string[] = [];
    let aborted = false;
    const result = await runMutationTransaction([{
      label: 'only',
      async commit(): Promise<Result<void>> {
        events.push('commit:only');
        aborted = true;
        return ok(undefined);
      },
      async rollback(): Promise<Result<void>> {
        events.push('rollback:only');
        return ok(undefined);
      },
    }], {
      shouldAbort: (): boolean => aborted,
      abortedResult: (): Result<void> => err(appError('PROCESS_TIMEOUT', 'cancelled', true)),
    });

    expect(events).toEqual(['commit:only', 'rollback:only']);
    expect(result).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });

  it('reports an explicit rollback failure instead of returning the original error as if state were clean', async () => {
    const events: string[] = [];
    const result = await runMutationTransaction([
      {
        label: 'first',
        async commit(): Promise<Result<void>> {
          events.push('commit:first');
          return ok(undefined);
        },
        async rollback(): Promise<Result<void>> {
          events.push('rollback:first');
          return err(appError('INTERNAL_ERROR', 'rollback blocked', true));
        },
      },
      {
        label: 'second',
        async commit(): Promise<Result<void>> {
          events.push('commit:second');
          return err(appError('CONFLICT', 'second commit failed', true));
        },
        async rollback(): Promise<Result<void>> {
          events.push('rollback:second');
          return ok(undefined);
        },
      },
    ]);

    expect(events).toEqual(['commit:first', 'commit:second', 'rollback:first']);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        recoverable: true,
        details: {
          originalCode: 'CONFLICT',
          rollbackCode: 'INTERNAL_ERROR',
          rollbackFailureCount: 1,
        },
      },
    });
    if (result.ok) throw new Error('expected rollback failure');
    expect(result.error.message).toContain('automatic rollback was incomplete');
  });
});
