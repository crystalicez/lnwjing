import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 1_500;

/**
 * Opt-in policy: skip an automatic snapshot only if every file is exactly
 * recoverable as a tracked Git HEAD blob. Otherwise fail closed to the regular
 * encrypted checkpoint. No Git index, ref, stash or working-tree mutation.
 *
 * The current HEAD/objects must remain available for a future Git-based undo;
 * this mode deliberately does not create a checkpoint entry for skipped files.
 */
export async function canRecoverEntirelyFromGit(
  workspaceRoot: string,
  relativePaths: readonly string[],
): Promise<boolean> {
  if (relativePaths.length === 0 || relativePaths.length > 20) return false;
  const root = path.resolve(workspaceRoot);
  // A large multi-file patch must not wait on dozens of Git subprocesses.
  // An expired probe falls back to a normal durable checkpoint.
  const signal = AbortSignal.timeout(3_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await run('git', ['--no-optional-locks', '-C', root, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024,
      windowsHide: true,
      env,
      signal,
    });
    return stdout.trim();
  };
  try {
    const repositoryRoot = await git('rev-parse', '--show-toplevel');
    const canonical = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
    if (canonical(await realpath(repositoryRoot)) !== canonical(await realpath(root))) return false;
    for (const file of relativePaths) {
      if (path.isAbsolute(file) || !file || file.includes('\0')) return false;
      const absolute = path.resolve(root, file);
      const rel = path.relative(root, absolute);
      if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return false;
      const stats = await lstat(absolute, { bigint: true });
      if (!stats.isFile() || stats.isSymbolicLink()) return false;
      if (canonical(await realpath(absolute)) !== canonical(absolute)) return false;
      const gitPath = rel.split(path.sep).join('/');
      await git('ls-files', '--error-unmatch', '--', gitPath);
      const committedHash = await git('rev-parse', '--verify', 'HEAD:' + gitPath);
      const workingHash = await git('hash-object', '--no-filters', '--', gitPath);
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(committedHash) || workingHash !== committedHash) return false;
      const after = await lstat(absolute, { bigint: true });
      if (stats.size !== after.size || stats.mtimeNs !== after.mtimeNs
        || stats.ctimeNs !== after.ctimeNs || stats.ino !== after.ino) return false;
    }
    return !signal.aborted;
  } catch {
    // Missing Git, untracked/dirty/ignored files, timeout, symlink and corrupt
    // repositories all use the existing checkpoint path.
    return false;
  }
}
