import { TextDecoder } from 'node:util';
import { appError, err, ok, type Result } from '@lnwjing/domain';

const decoder = new TextDecoder('utf-8', { fatal: true });
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const COMPONENT = /^[a-zA-Z0-9._-]+$/;

export interface VerifiedImportTree {
  readonly fileCount: number;
  readonly entryBytes: number;
}

/**
 * Read `git ls-tree -r -z --full-tree <full-sha>` as bytes, BEFORE checkout.
 * A conservative Windows-compatible subset is deliberate: no executable
 * transformations, symlink targets, submodules, ACL streams or NTFS aliases.
 */
export function validateRepositoryImportTree(
  input: Uint8Array,
  options: { readonly maxFiles?: number; readonly maxBytes?: number } = {},
): Result<VerifiedImportTree> {
  const refuse = (): Result<VerifiedImportTree> => err(appError('INVALID_INPUT', 'Repository tree contains unsafe or unsupported entries'));
  const maxFiles = options.maxFiles ?? 80_000;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || !Number.isInteger(maxBytes) || maxBytes < 1
    || input.byteLength > maxBytes || input.byteLength === 0 || input[input.byteLength - 1] !== 0) return refuse();
  const files = new Set<string>();
  const directories = new Map<string, string>();
  let count = 0;
  let cursor = 0;
  while (cursor < input.byteLength) {
    const end = input.indexOf(0, cursor);
    if (end <= cursor || end < 0 || ++count > maxFiles) return refuse();
    let record: string;
    try {
      record = decoder.decode(input.subarray(cursor, end));
    } catch {
      return refuse();
    }
    const parsed = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/i.exec(record);
    if (!parsed || parsed[3] === undefined || parsed[3].length > 4096) return refuse();
    const segments = parsed[3].split('/');
    if (segments.length > 128) return refuse();
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i]!;
      if (!COMPONENT.test(name) || name === '.' || name === '..' || name.endsWith('.')
        || DEVICE.test(name) || name.toLowerCase() === '.git'
        || name.toLowerCase() === '.gitmodules' || name.toLowerCase().startsWith('.lnwjing')) return refuse();
      const prefix = segments.slice(0, i + 1).join('/');
      const folded = prefix.toLowerCase();
      if (i === segments.length - 1) {
        if (files.has(folded) || directories.has(folded)) return refuse();
        files.add(folded);
      } else {
        if (files.has(folded)) return refuse();
        if (directories.has(folded) && directories.get(folded) !== prefix) return refuse();
        directories.set(folded, prefix);
      }
    }
    cursor = end + 1;
  }
  return ok({ fileCount: count, entryBytes: input.byteLength });
}
