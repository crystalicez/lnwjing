import { appError, err, ok, type Result } from '@lnwjing/domain';

export interface MutationTransactionStep {
  readonly label: string;
  commit(): Promise<Result<void>>;
  rollback(): Promise<Result<void>>;
}

export interface MutationTransactionOptions {
  readonly shouldAbort?: () => boolean;
  readonly abortedResult?: () => Result<never>;
}

export async function runMutationTransaction(
  steps: readonly MutationTransactionStep[],
  options: MutationTransactionOptions = {},
): Promise<Result<void>> {
  const completed: MutationTransactionStep[] = [];

  for (const step of steps) {
    if (options.shouldAbort?.() === true) {
      return rollbackCompleted(completed, options.abortedResult?.() ?? err(appError('PROCESS_TIMEOUT', 'Mutation was cancelled before the next side effect', true)));
    }

    const committed = await step.commit();
    if (!committed.ok) return rollbackCompleted(completed, committed);
    completed.push(step);
    if (options.shouldAbort?.() === true) {
      return rollbackCompleted(completed, options.abortedResult?.() ?? err(appError('PROCESS_TIMEOUT', 'Mutation was cancelled after a side effect completed', true)));
    }
  }

  return ok(undefined);
}

async function rollbackCompleted(
  completed: readonly MutationTransactionStep[],
  cause: Result<void>,
): Promise<Result<void>> {
  if (cause.ok || completed.length === 0) return cause;

  const failures: { readonly label: string; readonly code: string; readonly message: string }[] = [];
  for (const step of [...completed].reverse()) {
    const rolledBack = await step.rollback();
    if (!rolledBack.ok) failures.push({ label: step.label, code: rolledBack.error.code, message: rolledBack.error.message });
  }
  if (failures.length === 0) return cause;

  const first = failures[0]!;
  return err({
    code: 'INTERNAL_ERROR',
    message: `Mutation failed and automatic rollback was incomplete for ${first.label}: ${first.message}`,
    recoverable: true,
    details: {
      originalCode: cause.error.code,
      rollbackCode: first.code,
      rollbackFailureCount: failures.length,
    },
  });
}
