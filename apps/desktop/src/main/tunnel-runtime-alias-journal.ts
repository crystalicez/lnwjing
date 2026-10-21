import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface AliasArtifact {
  readonly file: string;
  readonly data: Buffer;
  readonly mode: number;
}

interface StoredArtifact {
  readonly file: string;
  readonly backup: string;
  readonly sha256: string;
  readonly mode: number;
}

interface JournalManifest {
  readonly version: 1;
  readonly profileDirectory: string;
  readonly artifacts: readonly StoredArtifact[];
}

const JOURNAL_NAME = 'tunnel-alias-retirement-v1';

/** A durable, lnwjing-specific sibling of app data; factory reset must not erase pending recovery. */
export function tunnelAliasRecoveryDirectory(dataPath: string): string {
  const absolute = path.resolve(dataPath);
  return path.join(path.dirname(absolute), `.${path.basename(absolute)}.tunnel-alias-recovery`);
}
const MAX_MANIFEST_BYTES = 32768;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

function hash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function trustedDirectory(directory: string): Promise<boolean> {
  const stat = await lstat(directory).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (stat === null) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Untrusted Tunnel recovery directory');
  return true;
}

function ownedArtifact(profileDirectory: string, file: string): boolean {
  const rel = path.relative(profileDirectory, file);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  const normalized = rel.split(path.sep).join('/');
  return [
    'lnwjing.yaml', 'lnwjing-tunnel.log', 'lnwjing.runtime.secret', 'lnwjing.oauth.session.secret',
  ].includes(normalized) || /^health\/[a-zA-Z0-9_.-]{1,128}$/.test(normalized);
}

/**
 * Delete only journal-owned regular files. A foreign entry or reparse point is
 * a conflict, never permission to recursively delete an unknown directory.
 */
async function discardOwnedJournal(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^(?:manifest\.json|artifact-[0-7])$/.test(entry.name)) {
      throw new Error('Tunnel recovery journal contains unowned files; refusing cleanup');
    }
  }
  for (const entry of entries) await unlink(path.join(directory, entry.name));
  await rmdir(directory);
}

/** Crash-recoverable local-only journal; never stores the remote Tunnel credentials in logs. */
export class TunnelAliasRetirementJournal {
  private readonly directory: string;
  private readonly profileDirectory: string;

  public constructor(recoveryDirectory: string, profileDirectory: string) {
    this.directory = path.join(path.resolve(recoveryDirectory), JOURNAL_NAME);
    this.profileDirectory = path.resolve(profileDirectory);
    if (this.directory === this.profileDirectory || this.directory.startsWith(`${this.profileDirectory}${path.sep}`)) {
      throw new Error('Tunnel recovery journal cannot reside inside the shared profile directory');
    }
  }

  public async prepare(originals: readonly AliasArtifact[]): Promise<void> {
    await this.recover();
    const parent = path.dirname(this.directory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!await trustedDirectory(parent)) throw new Error('Tunnel recovery directory is unavailable');
    await mkdir(this.directory, { mode: 0o700 });
    const records: StoredArtifact[] = [];
    try {
      for (const [index, artifact] of originals.entries()) {
        if (!ownedArtifact(this.profileDirectory, artifact.file) || artifact.data.byteLength > MAX_ARTIFACT_BYTES) {
          throw new Error('Unsafe Tunnel journal artifact');
        }
        const backup = `artifact-${index}`;
        await writeFile(path.join(this.directory, backup), artifact.data, { flag: 'wx', mode: 0o600, flush: true });
        records.push({ file: artifact.file, backup, sha256: hash(artifact.data), mode: artifact.mode });
      }
      const manifest: JournalManifest = { version: 1, profileDirectory: this.profileDirectory, artifacts: records };
      await writeFile(path.join(this.directory, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600, flush: true });
    } catch (error) {
      // Manifest is written last; without it the destructive CLI was never invoked.
      await discardOwnedJournal(this.directory);
      throw error;
    }
  }

  public async recover(): Promise<void> {
    if (!await trustedDirectory(this.directory)) return;
    const marker = path.join(this.directory, 'manifest.json');
    const metadata = await lstat(marker).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (metadata === null) {
      // A crash during backup preparation precedes CLI mutation.
      await discardOwnedJournal(this.directory);
      return;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MANIFEST_BYTES) {
      throw new Error('Untrusted Tunnel alias recovery manifest');
    }
    const manifest = JSON.parse(await readFile(marker, 'utf8')) as JournalManifest;
    if (manifest.version !== 1 || manifest.profileDirectory !== this.profileDirectory
      || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 8) {
      throw new Error('Tunnel alias recovery manifest does not match this profile');
    }
    // The native CLI may remove the owned profile directory itself. Recreate
    // only the exact profile root, never follow a junction or another owner.
    if (!await trustedDirectory(this.profileDirectory)) {
      await mkdir(this.profileDirectory, { mode: 0o700 });
      if (!await trustedDirectory(this.profileDirectory)) {
        throw new Error('Tunnel profile root could not be safely restored');
      }
    }
    for (const [index, record] of manifest.artifacts.entries()) {
      if (!record || typeof record.file !== 'string' || !path.isAbsolute(record.file)
        || !ownedArtifact(this.profileDirectory, record.file) || record.backup !== `artifact-${index}`
        || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)
        || !Number.isInteger(record.mode) || record.mode < 0 || record.mode > 0o777) {
        throw new Error('Tunnel alias recovery record is untrusted');
      }
      const backupPath = path.join(this.directory, record.backup);
      const stat = await lstat(backupPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES) {
        throw new Error('Tunnel alias backup is untrusted');
      }
      const data = await readFile(backupPath);
      if (hash(data) !== record.sha256) throw new Error('Tunnel alias backup checksum mismatch');
      for (let parent = path.dirname(record.file); parent !== this.profileDirectory; parent = path.dirname(parent)) {
        const relative = path.relative(this.profileDirectory, parent);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error('Tunnel alias recovery path escapes profile');
        }
        const exists = await trustedDirectory(parent);
        if (!exists) await mkdir(parent, { mode: 0o700 });
      }
      const current = await lstat(record.file).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (current !== null) {
        if (!current.isFile() || current.isSymbolicLink() || current.size > MAX_ARTIFACT_BYTES
          || hash(await readFile(record.file)) !== record.sha256) {
          throw new Error('Tunnel recovery refuses to overwrite concurrently modified profile data');
        }
      } else {
        await writeFile(record.file, data, { flag: 'wx', mode: record.mode, flush: true });
      }
    }
    // Durable originals were restored before discarding their recovery records.
    await discardOwnedJournal(this.directory);
  }
}
