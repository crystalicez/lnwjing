import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjing/domain';
import { hostPathApi, isAbsoluteHostPath, resolveHostPath } from '@lnwjing/workspace';

/**
 * Single exact-target probe. No registration, directory enumeration, shell,
 * workspace index, lease acquisition or filesystem write is performed here.
 * This is advisory only: registration must independently revalidate the path.
 */
export interface WorkspacePathPreflightResult {
  readonly status: 'VERIFIED' | 'NOT_FOUND' | 'DENIED' | 'CONFLICT' | 'UNVERIFIABLE' | 'UNSUPPORTED';
  readonly checkedAt: string;
  readonly checkedIdentity: string;
  readonly pathScope: 'exact_target';
  readonly limitations: readonly string[];
  readonly path: string;
  readonly exists: boolean;
  readonly kind: 'directory' | 'file' | 'other' | 'missing' | 'unknown';
  readonly canonicalPath?: string;
  readonly reparseChain: 'CLEAR' | 'CONFLICT' | 'UNKNOWN';
  readonly effectiveAccess: 'READ_WRITE' | 'READ_ONLY' | 'DENIED' | 'UNKNOWN';
}

export async function preflightWorkspacePath(
  requestedPath: string,
  userConfirmed: boolean,
  authorization?: InvocationAuthorization,
  platform: NodeJS.Platform = process.platform,
): Promise<Result<WorkspacePathPreflightResult>> {
  if (!isApplicationAuthorized(authorization, userConfirmed)) {
    return err(appError('PERMISSION_REQUIRED', 'Explicit authorization is required for an unregistered exact-path probe'));
  }
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.length > 4096
      || requestedPath.includes('\0') || !isAbsoluteHostPath(requestedPath, platform)) {
    return err(appError('INVALID_INPUT', 'Preflight requires a single absolute host path'));
  }
  const resolved = resolveHostPath(requestedPath, platform);
  if (resolved === null) return err(appError('INVALID_INPUT', 'Foreign host path syntax is not supported'));
  const api = hostPathApi(platform);
  const root = api.parse(resolved).root;
  if (!root) return err(appError('INVALID_INPUT', 'Path has no verified root'));
  const segments = resolved.slice(root.length).split(api.sep).filter(Boolean);
  const evidence = {
    checkedAt: new Date().toISOString(),
    checkedIdentity: platform === 'win32' ? 'UNKNOWN' : typeof process.getuid === 'function' ? `uid:${process.getuid()}` : 'UNKNOWN',
    pathScope: 'exact_target' as const,
    limitations: platform === 'win32'
      ? ['Windows effective ACL and complete reparse-chain identity cannot be proven by this read-only runtime; registration must revalidate']
      : ['Advisory time-of-check snapshot only; registration must independently revalidate'],
  };
  let current = root;
  let targetType: WorkspacePathPreflightResult['kind'] = 'unknown';
  try {
    for (let i = 0; i <= segments.length; i += 1) {
      if (i > 0) current = api.join(current, segments[i - 1]!);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(current);
      } catch (failure: unknown) {
        const code = nodeErrorCode(failure);
        if (code === 'ENOENT') return ok({ ...evidence, path: resolved, status: 'NOT_FOUND', exists: false, kind: 'missing', reparseChain: 'UNKNOWN', effectiveAccess: 'UNKNOWN' });
        if (code === 'EACCES' || code === 'EPERM') return ok({ ...evidence, path: resolved, status: 'DENIED', exists: false, kind: 'unknown', reparseChain: 'UNKNOWN', effectiveAccess: 'DENIED' });
        return ok({ ...evidence, path: resolved, status: 'UNVERIFIABLE', exists: false, kind: 'unknown', reparseChain: 'UNKNOWN', effectiveAccess: 'UNKNOWN' });
      }
      if (info.isSymbolicLink()) return ok({ ...evidence, path: resolved, status: 'CONFLICT', exists: true, kind: 'unknown', reparseChain: 'CONFLICT', effectiveAccess: 'UNKNOWN' });
      if (i < segments.length && !info.isDirectory()) return ok({ ...evidence, path: resolved, status: 'CONFLICT', exists: false, kind: 'unknown', reparseChain: 'CONFLICT', effectiveAccess: 'UNKNOWN' });
      const canonical = await realpath(current);
      const same = platform === 'win32'
        ? api.normalize(canonical).toLowerCase() === api.normalize(current).toLowerCase()
        : api.normalize(canonical) === api.normalize(current);
      if (!same) return ok({ ...evidence, path: resolved, status: 'CONFLICT', exists: true, kind: 'unknown', reparseChain: 'CONFLICT', effectiveAccess: 'UNKNOWN' });
      if (i === segments.length) targetType = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    }
    // fs.access is scoped to the actual runtime identity. It is not a complete
    // Windows effective-ACL/reparse-proof API; never claim Windows VERIFIED.
    let effectiveAccess: WorkspacePathPreflightResult['effectiveAccess'] = 'UNKNOWN';
    try {
      await access(resolved, constants.R_OK | constants.W_OK);
      effectiveAccess = platform === 'win32' ? 'UNKNOWN' : 'READ_WRITE';
    } catch {
      try {
        await access(resolved, constants.R_OK);
        effectiveAccess = platform === 'win32' ? 'UNKNOWN' : 'READ_ONLY';
      } catch {
        effectiveAccess = platform === 'win32' ? 'UNKNOWN' : 'DENIED';
      }
    }
    return ok({
      ...evidence,
      path: resolved,
      status: platform === 'win32' ? 'UNVERIFIABLE' : effectiveAccess === 'DENIED' ? 'DENIED' : 'VERIFIED',
      exists: true,
      kind: targetType,
      canonicalPath: await realpath(resolved),
      reparseChain: platform === 'win32' ? 'UNKNOWN' : 'CLEAR',
      effectiveAccess,
    });
  } catch {
    return ok({ ...evidence, path: resolved, status: 'UNVERIFIABLE', exists: false, kind: 'unknown', reparseChain: 'UNKNOWN', effectiveAccess: 'UNKNOWN' });
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}
