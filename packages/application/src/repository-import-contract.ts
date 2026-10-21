import { isIP } from 'node:net';
import { appError, err, ok, type Result } from '@lnwjing/domain';

/**
 * The public contract deliberately contains no Git arguments, environment,
 * authentication, absolute paths, or user-provided process configuration.
 */
export interface RepositoryImportRequest {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly url: string;
  readonly destination: string;
  readonly commit: string;
}

const KEYS = new Set(['workspaceId', 'requestId', 'url', 'destination', 'commit']);
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SEGMENT = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Reject rather than normalize potentially ambiguous or credential-bearing caller input. */
export function parseRepositoryImportRequest(input: unknown): Result<RepositoryImportRequest> {
  const refuse = (): Result<RepositoryImportRequest> =>
    err(appError('INVALID_INPUT', 'Repository import parameters are invalid; use a clean HTTPS URL, new relative destination and full commit'));
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return refuse();
  const value = input as Record<string, unknown>;
  if (Reflect.ownKeys(value).length !== KEYS.size || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !KEYS.has(key))) return refuse();
  const { workspaceId, requestId, url, destination, commit } = value;
  if (typeof workspaceId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(workspaceId)
    || typeof requestId !== 'string' || !REQUEST_ID.test(requestId)
    || typeof url !== 'string' || !isCleanGitHttpsUrl(url)
    || typeof destination !== 'string' || !isSafeImportRelativePath(destination)
    || typeof commit !== 'string' || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(commit)) return refuse();

  return ok({ workspaceId, requestId: requestId.toLowerCase(), url, destination, commit: commit.toLowerCase() });
}

export function isCleanGitHttpsUrl(value: string): boolean {
  // Reject percent-encoded path confusion, URL fragments, query-secret channels
  // and URL-parser repair of control characters or backslashes.
  if (value.length > 2048 || !/^https:\/\/[^\s\\%?#@]+\/[^\s\\%?#@]+$/i.test(value)) return false;
  if (/\s/.test(value) || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== ''
      || parsed.search !== '' || parsed.hash !== '' || parsed.hostname === '' || parsed.hostname.endsWith('.')
      || parsed.hostname === 'localhost' || isIP(parsed.hostname) !== 0
      || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(parsed.hostname)) return false;
    return parsed.href === value;
  } catch {
    return false;
  }
}

export function isSafeImportRelativePath(value: string): boolean {
  if (value.length < 1 || value.length > 1024 || value.includes('\\') || value.startsWith('/')
    || value.startsWith('.') || value.endsWith('/') || value.includes('//')) return false;
  const segments = value.split('/');
  return segments.every((segment) =>
    segment.length > 0 && segment.length <= 120 && SEGMENT.test(segment)
    && segment !== '.' && segment !== '..' && !segment.endsWith('.')
    && !WINDOWS_DEVICE.test(segment) && segment.toLowerCase() !== '.git');
}
