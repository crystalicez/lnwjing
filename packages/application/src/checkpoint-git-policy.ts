import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 1_500;
const PROBE_TIMEOUT_MS = 3_000;
const MAX_PATHS = 20;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PINNED_GIT_HEADS_PER_REPOSITORY = 64;
const MAX_GIT_PREIMAGE_BYTES_PER_FILE = 16n * 1024n * 1024n;
const MAX_GIT_PREIMAGE_BYTES_PER_CALL = 32n * 1024n * 1024n;

/**
 * Skip encrypted snapshots only when all pre-mutation file bytes match Git
 * HEAD blobs AND a dedicated lnwjing recovery ref pins that exact commit.
 * The pin survives normal Git GC and branch rewrites; it never mutates HEAD,
 * the index or tracked worktree. Up to 64 distinct commits are pinned per repo
 * to bound retained history. When saturated, fall back to normal checkpoints.
 * The pin is a manual Git recovery reference, not a one-click Undo entry.
 */
export async function canRecoverEntirelyFromGit(workspaceRoot: string, relativePaths: readonly string[]): Promise<boolean> {
  if (relativePaths.length === 0 || relativePaths.length > MAX_PATHS) return false;
  const root = path.resolve(workspaceRoot);
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  // A unique non-existent directory disables reference-transaction hooks.
  // Git-aware may create recovery refs but must not trigger user hooks.
  const disabledHooksPath = path.join(root, '.git', '.lnwjing-hooks-disabled-' + randomUUID());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_NAMESPACE: undefined,
    GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
  };
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await run('git', ['-c', 'core.hooksPath=' + disabledHooksPath,
      '--no-optional-locks', '--literal-pathspecs', '-C', root, ...args], {
      timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, env, signal,
    });
    return stdout;
  };
  const canonical = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  try {
    const [repositoryRoot, headCommit, ...extra] = (await git('rev-parse', '--show-toplevel', '--verify', 'HEAD')).trim().split(/\r?\n/);
    if (extra.length > 0 || repositoryRoot === undefined
      || headCommit === undefined || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headCommit)) return false;
    if (canonical(await realpath(repositoryRoot)) !== canonical(await realpath(root))) return false;
    const recoveryRef = 'refs/lnwjing/recovery/' + headCommit;

    const candidates: Array<{ absolute: string; gitPath: string }> = [];
    for (const file of relativePaths) {
      if (!file || path.isAbsolute(file) || file.includes('\0')) return false;
      const absolute = path.resolve(root, file);
      const rel = path.relative(root, absolute);
      if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
      if (canonical(await realpath(absolute)) !== canonical(absolute)) return false;
      candidates.push({ absolute, gitPath: rel.split(path.sep).join('/') });
    }
    // One ls-tree for all paths, rather than 2-3 Git child processes PER file.
    const listing = await git('ls-tree', '-rz', headCommit, '--', ...candidates.map((c) => c.gitPath));
    const blobs = new Map<string, { oid: string; mode: string }>();
    for (const entry of listing.split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      if (tab < 0) return false;
      const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(entry.slice(0, tab));
      if (!match || blobs.has(entry.slice(tab + 1))) return false;
      blobs.set(entry.slice(tab + 1), { mode: match[1]!, oid: match[2]! });
    }
    if (blobs.size !== new Set(candidates.map((c) => c.gitPath)).size) return false;

    const objectIds: string[] = [];
    let hashedBytes = 0n;
    for (const candidate of candidates) {
      if (signal.aborted) return false;
      const committed = blobs.get(candidate.gitPath);
      if (committed === undefined) return false;
      const before = await lstat(candidate.absolute, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) return false;
      // Avoid streaming multi-GiB files just to decide whether to snapshot.
      // Large/expensive probes use the ordinary checkpoint path immediately.
      if (before.size > MAX_GIT_PREIMAGE_BYTES_PER_FILE
        || hashedBytes + before.size > MAX_GIT_PREIMAGE_BYTES_PER_CALL) return false;
      hashedBytes += before.size;
      const hash = createHash(committed.oid.length === 64 ? 'sha256' : 'sha1');
      hash.update('blob ' + before.size + '\0');
      for await (const chunk of createReadStream(candidate.absolute)) {
        if (signal.aborted) return false;
        hash.update(chunk);
      }
      if (hash.digest('hex') !== committed.oid) return false;
      const after = await lstat(candidate.absolute, { bigint: true });
      if (before.size !== after.size || before.ino !== after.ino
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return false;
      objectIds.push(committed.oid);
    }

    // ls-tree can report object IDs even if a loose/packed blob is missing.
    // Verify locally available blob headers without Git network fetches.
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['-c', 'core.hooksPath=' + disabledHooksPath,
        '--no-optional-locks', '-C', root, 'cat-file', '--batch-check'], {
        env, windowsHide: true, signal,
      });
      let stdout = '';
      let settled = false;
      const fail = (error: Error): void => { if (!settled) { settled = true; reject(error); } };
      child.on('error', fail);
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString('utf8');
        if (stdout.length > MAX_OUTPUT_BYTES) { child.kill(); fail(new Error('Git batch object output too large')); }
      });
      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          if (code === 0) resolve(stdout);
          else reject(new Error('Git object lookup failed'));
        }
      });
      child.stdin.on('error', fail);
      child.stdin.end([...new Set(objectIds), recoveryRef].join('\n') + '\n');
    });
    const wanted = [...new Set(objectIds)];
    const lines = output.trimEnd().split('\n');
    if (lines.length !== wanted.length + 1) return false;
    for (let i = 0; i < wanted.length; i += 1) {
      const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/.exec(lines[i]!);
      if (!match || match[1] !== wanted[i]) return false;
    }
    // A ref pins the exact commit, protecting this pre-edit version from
    // normal Git GC even after the user rewrites branches. Do not silently
    // overwrite an existing ref that points elsewhere.
    const existingPin = lines.at(-1)!;
    if (existingPin !== recoveryRef + ' missing') {
      if (!existingPin.startsWith(headCommit + ' commit ')) return false;
    } else {
      const refs = (await git('for-each-ref', '--count=' + (MAX_PINNED_GIT_HEADS_PER_REPOSITORY + 1),
        '--format=%(refname)', 'refs/lnwjing/recovery/')).trim();
      if (refs.length > 0 && refs.split(/\r?\n/).length >= MAX_PINNED_GIT_HEADS_PER_REPOSITORY) return false;
      const emptyOid = '0'.repeat(headCommit.length);
      await git('update-ref', recoveryRef, headCommit, emptyOid);
    }
    return !signal.aborted;
  } catch {
    // Failed verification always uses the encrypted checkpoint path.
    return false;
  }
}
