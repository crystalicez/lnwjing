import { appError, err, ok, type InvocationAuthorization, type Result } from '@lnwjing/domain';
import {
  comparableHostPath,
  WorkspacePathGuard,
  type ResolvedWorkspacePath,
  type Workspace,
} from '@lnwjing/workspace';

export function createGuardedWriteValidator(
  guard: WorkspacePathGuard,
  workspace: Workspace,
  inputPath: string,
  initial: ResolvedWorkspacePath,
  authorization?: InvocationAuthorization,
): () => Promise<Result<void>> {
  const expected = comparableHostPath(initial.realPath ?? initial.absolutePath);

  return async (): Promise<Result<void>> => {
    const current = await guard.resolveForWrite(workspace, inputPath, authorization);
    if (!current.ok) return current;

    const actual = comparableHostPath(current.value.realPath ?? current.value.absolutePath);
    if (expected === null || actual === null || actual !== expected) {
      return err(appError('CONFLICT', 'File mutation destination changed after validation', true));
    }
    return ok(undefined);
  };
}
