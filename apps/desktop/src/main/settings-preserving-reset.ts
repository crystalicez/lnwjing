import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GlobalStorageQuotaReservations, assertNoActiveSqliteClientsSync } from '@lnwjing/storage';

interface PreservedFile {
  readonly relative: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface SnapshotManifest {
  readonly version: 1 | 2;
  readonly nonce: string;
  readonly databaseSha256: string;
  readonly files: readonly PreservedFile[];
  /** Persistent paths relative to profile; verified against current workspace state before cleanup. */
  readonly protectedProjects?: readonly string[];
}
const SNAPSHOT_FILES = [
  'Local State',
  'checkpoint-master.key',
  'checkpoint-master.key.migration.json',
  '.stdio-profile-ready.v1',
  'remote-mcp/oauth-state.secret',
  'remote-mcp/ngrok-authtoken.secret',
  'lnwjing.runtime.secret',
  'tunnel-client/lnwjing.runtime.secret',
  'tunnel-client/lnwjing.oauth.session.secret',
  'tunnel-client/lnwjing.yaml',
  'tunnel-client/health/lnwjing.url',
] as const;
const MAX_PRESERVED_FILE_BYTES = 16 * 1024 ** 2;
const MAX_SETTING_BYTES = 32 * 1024 ** 2;
const PROTECTED_PROJECTS_SETTING_KEY = 'reset_protected_project_roots_v1';
const MAX_PROTECTED_PROJECTS = 512;
// User repositories in app-managed roots can be touched later by normal cache,
// backup, log or process maintenance, even if this reset preserves their files.
// Such layouts are not safe to support without moving the repository itself.
const UNSAFE_PROJECT_TOP_LEVEL = new Set([
  'cache', 'code cache', 'gpucache', 'dawncache', 'shadercache', 'workspace-index',
  'logs', 'diagnostics', 'crash-dumps', 'backups', 'recovery-trash',
  'background-tasks', 'native-managed-git', 'native-managed-processes',
  'remote-mcp', 'tunnel-client', 'lnwjing.sqlite', 'local state',
  'checkpoint-master.key', 'global-quota-reservations-v2.sqlite',
  'workspace-writer-leases.sqlite',
]);
const DROPPED_EPHEMERAL_SETTINGS = new Set([
  'selected_workspace_id', 'active_workspace_ids', 'work_log_cleared_at',
  'watcher_access_token_v1', 'watcher_instance_id_v1', 'backup_restore_notice_v1',
]);

/** Distinguish protected user-owned projects from unrelated reset failures. */
export class ProtectedProjectInsideProfileError extends Error {
  constructor(readonly projectPath: string, readonly profilePath: string) {
    super('Cannot clear profile: a registered project directory is inside the profile.'
      + `\nProject: ${projectPath}\nProfile: ${profilePath}`
      + '\nMove the project directory outside the profile before retrying. Removing its registration alone does not protect its files.');
    this.name = 'ProtectedProjectInsideProfileError';
  }
}

/** Check before queuing shutdown so an unsafe reset cannot strand the UI. */
export function preflightSettingsPreservingResetSync(profile: string): void {
  if (!existsSync(profile)) throw new Error('Cannot preserve settings: profile directory does not exist');
  assertRealDirectory(profile);
  const databaseFile = safeRelativeFile(profile, 'lnwjing.sqlite');
  if (!existsSync(databaseFile)) throw new Error('Cannot preserve settings: application database does not exist');
  const database = new DatabaseSync(databaseFile, { readOnly: true, timeout: 3000 });
  try {
    // Keep the interactive preflight bounded: a full SQLite quick_check can
    // scan gigabytes and freeze the Desktop main thread. The offline reset
    // still performs quick_check before it snapshots or erases anything.
    for (const table of ['settings', 'workspaces']) {
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) === undefined) {
        throw new Error(`Cannot safely reset a profile without its ${table} table`);
      }
    }
    collectProtectedProjects(database, profile);
  } finally {
    database.close();
  }
}

/**
 * Only cancel a blocked request while the original, healthy database still
 * proves a user project resides in this profile. Never discard a snapshot
 * whose owner does not match the pending reset nonce.
 */
export function cancelBlockedSettingsPreservingResetSync(profile: string, nonce: string): boolean {
  try {
    preflightSettingsPreservingResetSync(profile);
    return false;
  } catch (error: unknown) {
    if (!(error instanceof ProtectedProjectInsideProfileError)) throw error;
  }
  const stage = path.join(path.dirname(profile), `.${path.basename(profile)}.factory-reset-settings`);
  if (existsSync(stage)) {
    assertRealDirectory(stage);
    // Once cleanup began, the immutable snapshot may be the only remaining
    // copy of Settings. Never erase it just to reopen the original profile.
    if (existsSync(path.join(stage, 'cleanup-started'))) {
      throw new Error('Cannot cancel a partially applied settings reset; retain its snapshot for recovery');
    }
    const owner = path.join(stage, 'owner.txt');
    if (!existsSync(owner) || !lstatSync(owner).isFile() || lstatSync(owner).isSymbolicLink()
      || readFileSync(owner, 'utf8') !== nonce) {
      throw new Error('Blocked settings reset snapshot ownership is unverified; pending reset was retained');
    }
    rmSync(stage, { recursive: true, force: true });
  }
  return true;
}

/**
 * The only post-shutdown profile wipe that retains user configuration.
 * A sibling snapshot is committed and validated before deleting ANY source
 * data. If the operation is interrupted, the same nonce replays the snapshot.
 */
export function applySettingsPreservingResetSync(profile: string, nonce: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nonce)) {
    throw new Error('Invalid settings-preserving reset nonce');
  }
  const parent = path.dirname(profile);
  const snapshotDirectory = path.join(parent, `.${path.basename(profile)}.factory-reset-settings`);
  const manifestPath = path.join(snapshotDirectory, 'manifest.json');
  const sourceExists = existsSync(profile);
  if (sourceExists) {
    assertRealDirectory(profile);
    // Reject before copying Settings. Otherwise a later retry could replay
    // stale preferences from a snapshot taken while another writer was active.
    assertNoActiveSqliteClientsSync(path.join(profile, 'backups'));
    assertNoActiveQuotaReservations(profile);
  }
  const stageExists = existsSync(snapshotDirectory);
  if (stageExists) assertRealDirectory(snapshotDirectory);

  // An incomplete stage is safe to discard only if the original profile is
  // still intact. A completed stage is never re-snapshotted during a retry.
  if (!existsSync(manifestPath)) {
    if (!sourceExists) throw new Error('Original profile is missing and the settings snapshot is incomplete');
    if (stageExists) {
      const owner = path.join(snapshotDirectory, 'owner.txt');
      if (!existsSync(owner) || !lstatSync(owner).isFile()
        || readFileSync(owner, 'utf8') !== nonce) {
        throw new Error('Incomplete settings reset snapshot belongs to a different request');
      }
      rmSync(snapshotDirectory, { recursive: true, force: true });
    }
    mkdirSync(snapshotDirectory, { mode: 0o700 });
    writeFileSync(path.join(snapshotDirectory, 'owner.txt'), nonce, { flag: 'wx', mode: 0o600 });
    const protectedProjects = snapshotProfileSettings(profile, path.join(snapshotDirectory, 'settings.sqlite'), nonce);
    const files: PreservedFile[] = [];
    for (const relative of SNAPSHOT_FILES) {
      const source = safeRelativeFile(profile, relative);
      if (!existsSync(source)) continue;
      const metadata = lstatSync(source);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PRESERVED_FILE_BYTES) {
        throw new Error('Unsafe or oversized saved settings dependency: ' + relative);
      }
      const destination = path.join(snapshotDirectory, 'files', relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      const copied = readFileSync(destination);
      if (copied.byteLength !== metadata.size) throw new Error('Settings dependency changed during snapshot');
      files.push({ relative, bytes: copied.byteLength, sha256: digest(copied) });
    }
    const manifest: SnapshotManifest = {
      version: 2, nonce,
      databaseSha256: digest(readFileSync(path.join(snapshotDirectory, 'settings.sqlite'))),
      files, protectedProjects,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  }

  const manifest = verifySnapshot(snapshotDirectory, nonce);
  // A fresh source must be free of cooperating SQLite clients, including
  // standalone STDIO. Do not delete any profile with a live client lease.
  if (sourceExists) {
    assertNoActiveSqliteClientsSync(path.join(profile, 'backups'));
    assertNoActiveQuotaReservations(profile);
    // A newly registered project cannot be erased using an earlier snapshot;
    // every nested protected root must already be in this immutable manifest.
    const startMarker = path.join(snapshotDirectory, 'cleanup-started');
    const cleanupStarted = existsSync(startMarker);
    if (cleanupStarted && (!lstatSync(startMarker).isFile() || lstatSync(startMarker).isSymbolicLink()
      || readFileSync(startMarker, 'utf8') !== nonce)) {
      throw new Error('Settings reset cleanup marker ownership is invalid');
    }
    assertCurrentProtectedProjectsMatchSnapshot(profile, manifest, cleanupStarted);
    if (!cleanupStarted) writeFileSync(startMarker, nonce, { flag: 'wx', mode: 0o600 });
    pruneProfileExceptProjects(profile, manifest.version === 2 ? manifest.protectedProjects ?? [] : []);
  }
  mkdirSync(profile, { recursive: true });
  const sourceDb = new DatabaseSync(path.join(snapshotDirectory, 'settings.sqlite'), { readOnly: true });
  try {
    const records = sourceDb.prepare('SELECT key,value FROM settings').all() as Array<{ key: string; value: string }>;
    const restoredDb = new DatabaseSync(path.join(profile, 'lnwjing.sqlite'));
    try {
      restoredDb.exec('CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); BEGIN IMMEDIATE');
      const insert = restoredDb.prepare('INSERT INTO settings(key,value) VALUES (?,?)');
      for (const row of records) insert.run(row.key, row.value);
      restoredDb.exec('COMMIT');
      if ((restoredDb.prepare('PRAGMA quick_check').get() as Record<string, string>).quick_check !== 'ok') {
        throw new Error('Restored settings database failed integrity check');
      }
    } finally { restoredDb.close(); }
    const quota = sourceDb.prepare('SELECT limit_bytes,reserve_bytes FROM quota_policy').get() as
      { limit_bytes: number; reserve_bytes: number } | undefined;
    if (quota !== undefined) new GlobalStorageQuotaReservations(profile).configure({
      limitBytes: quota.limit_bytes, criticalReserveBytes: quota.reserve_bytes,
    });
  } finally { sourceDb.close(); }
  for (const file of manifest.files) {
    const target = path.join(profile, file.relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(snapshotDirectory, 'files', file.relative), target);
    if (digest(readFileSync(target)) !== file.sha256) throw new Error('Restored settings dependency failed verification');
  }
  rmSync(snapshotDirectory, { recursive: true, force: true });
}

function snapshotProfileSettings(profile: string, destination: string, nonce: string): string[] {
  const dbFile = safeRelativeFile(profile, 'lnwjing.sqlite');
  if (!existsSync(dbFile)) throw new Error('Cannot preserve settings: application database does not exist');
  const original = lstatSync(dbFile);
  if (!original.isFile() || original.isSymbolicLink()) throw new Error('Application database is not a regular file');
  const source = new DatabaseSync(dbFile, { readOnly: true, timeout: 3000 });
  try {
    if ((source.prepare('PRAGMA quick_check').get() as Record<string, string>).quick_check !== 'ok') {
      throw new Error('Cannot preserve settings from an unhealthy database');
    }
    const protectedProjects = collectProtectedProjects(source, profile);
    const rows = source.prepare('SELECT key,value FROM settings').iterate() as Iterable<{ key: unknown; value: unknown }>;
    const saved = new DatabaseSync(destination);
    try {
      saved.exec('CREATE TABLE settings(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);'
        + 'CREATE TABLE reset_meta(nonce TEXT NOT NULL);'
        + 'CREATE TABLE quota_policy(limit_bytes INTEGER NOT NULL,reserve_bytes INTEGER NOT NULL);'
        + 'BEGIN IMMEDIATE');
      saved.prepare('INSERT INTO reset_meta(nonce) VALUES (?)').run(nonce);
      const insert = saved.prepare('INSERT INTO settings(key,value) VALUES (?,?)');
      let size = 0;
      for (const row of rows) {
        if (typeof row.key !== 'string' || typeof row.value !== 'string') throw new Error('Invalid stored Settings record');
        size += Buffer.byteLength(row.key) + Buffer.byteLength(row.value);
        if (size > MAX_SETTING_BYTES) throw new Error('Settings snapshot exceeds safe size');
        if (!DROPPED_EPHEMERAL_SETTINGS.has(row.key) && row.key !== PROTECTED_PROJECTS_SETTING_KEY) insert.run(row.key, row.value);
      }
      if (protectedProjects.length > 0) {
        insert.run(PROTECTED_PROJECTS_SETTING_KEY, JSON.stringify(protectedProjects));
      }
      const ledgerFile = safeRelativeFile(profile, 'global-quota-reservations-v2.sqlite');
      if (existsSync(ledgerFile)) {
        const ledger = new DatabaseSync(ledgerFile, { readOnly: true });
        try {
          const active = (ledger.prepare('SELECT COUNT(*) AS count FROM quota_reservations').get() as { count: number }).count;
          if (active !== 0) throw new Error('Stop active profile quota writers before resetting data');
          const policy = ledger.prepare('SELECT limit_bytes,reserve_bytes FROM quota_state WHERE id=1').get() as
            { limit_bytes: number; reserve_bytes: number } | undefined;
          if (policy !== undefined && policy.limit_bytes > 0) {
            saved.prepare('INSERT INTO quota_policy(limit_bytes,reserve_bytes) VALUES (?,?)')
              .run(policy.limit_bytes, policy.reserve_bytes);
          }
        } finally { ledger.close(); }
      }
      saved.exec('COMMIT');
    } finally { saved.close(); }
    return protectedProjects;
  } finally { source.close(); }
}

/**
 * A project beneath the profile remains user-owned even after the workspaces
 * table is reset. Keep an independent, persistent guard in preserved Settings,
 * otherwise a second reset could delete the previously unregistered project.
 */
function collectProtectedProjects(database: DatabaseSync, profile: string): string[] {
  const protectedPaths: string[] = [];
  const saved = database.prepare('SELECT value FROM settings WHERE key=?')
    .get(PROTECTED_PROJECTS_SETTING_KEY) as { value: unknown } | undefined;
  if (saved !== undefined) {
    if (typeof saved.value !== 'string' || saved.value.length > 256 * 1024) {
      throw new Error('Stored protected project roots are invalid');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(saved.value); }
    catch { throw new Error('Stored protected project roots cannot be decoded'); }
    if (!Array.isArray(parsed) || parsed.length > MAX_PROTECTED_PROJECTS) {
      throw new Error('Stored protected project roots are invalid');
    }
    for (const entry of parsed) protectedPaths.push(validateProtectedRelativePath(entry));
  }
  const profileReal = realpathSync(profile);
  const rows = database.prepare('SELECT root_path, real_root_path FROM workspaces').iterate() as
    Iterable<{ root_path: unknown; real_root_path: unknown }>;
  for (const row of rows) {
    for (const candidate of [row.root_path, row.real_root_path]) {
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) {
        throw new Error('Unsafe registered project root prevents profile reset');
      }
      // Profile itself or its parent cannot be treated as removable application
      // storage while the entire profile is a registered user-owned project.
      if (isWithinDirectory(candidate, profile)) {
        throw new ProtectedProjectInsideProfileError(candidate, profile);
      }
      if (isWithinDirectory(profile, candidate)) {
        protectedPaths.push(firstRedirectedAncestor(profile, path.relative(profile, candidate)));
      }
      try {
        const actual = realpathSync(candidate);
        if (isWithinDirectory(actual, profileReal)) {
          throw new ProtectedProjectInsideProfileError(candidate, profile);
        }
        if (isWithinDirectory(profileReal, actual)) {
          protectedPaths.push(firstRedirectedAncestor(profile, path.relative(profileReal, actual)));
        }
      } catch (error: unknown) {
        if (!isMissingPath(error)) throw error;
      }
    }
  }
  return minimizeProtectedPaths(protectedPaths);
}

function validateProtectedRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || value.includes('\0') || path.isAbsolute(value)) {
    throw new Error('Invalid protected project path in reset metadata');
  }
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('Invalid protected project path in reset metadata');
  }
  if (UNSAFE_PROJECT_TOP_LEVEL.has(parts[0]!.toLowerCase())) {
    throw new Error('User project is inside an automatically managed lnwjing directory; move the project outside this directory before reset');
  }
  return parts.join(path.sep);
}

function minimizeProtectedPaths(paths: readonly string[]): string[] {
  const ordered = [...new Set(paths.map(validateProtectedRelativePath))]
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const result: string[] = [];
  for (const entry of ordered) {
    if (result.some((ancestor) => isWithinDirectory(ancestor, entry))) continue;
    result.push(entry);
    if (result.length > MAX_PROTECTED_PROJECTS) throw new Error('Too many protected projects for safe reset');
  }
  return result;
}

function firstRedirectedAncestor(profile: string, relative: string): string {
  const parts = validateProtectedRelativePath(relative).split(path.sep);
  let current = profile;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink()) return parts.slice(0, index + 1).join(path.sep);
      if (!entry.isDirectory()) {
        throw new Error('Registered project has an unsafe non-directory root or ancestor');
      }
    } catch (error: unknown) {
      if (isMissingPath(error)) break;
      throw error;
    }
  }
  return parts.join(path.sep);
}

/** Preserve protected subtrees in place; do not copy, traverse, or rename them. */
function pruneProfileExceptProjects(profile: string, protectedProjects: readonly string[]): void {
  const protectedAbsolute = protectedProjects.map((relative) =>
    path.join(profile, validateProtectedRelativePath(relative)));
  const visit = (target: string): void => {
    if (protectedAbsolute.some((protectedPath) => isWithinDirectory(target, protectedPath))) {
      if (protectedAbsolute.some((protectedPath) => isWithinDirectory(protectedPath, target))) return;
      const entry = lstatSync(target);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('Protected project ancestor became redirected during reset');
      }
      const actual = realpathSync(target);
      if (!isWithinDirectory(realpathSync(profile), actual)) {
        throw new Error('Protected project ancestor escaped the profile');
      }
      for (const child of readdirSync(target)) visit(path.join(target, child));
      return;
    }
    // fs.rm removes a symlink/junction entry itself, not its external target.
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  for (const entry of readdirSync(profile)) visit(path.join(profile, entry));
}

function assertCurrentProtectedProjectsMatchSnapshot(
  profile: string, manifest: SnapshotManifest, cleanupStarted: boolean,
): void {
  const databaseFile = safeRelativeFile(profile, 'lnwjing.sqlite');
  if (!existsSync(databaseFile)) {
    if (cleanupStarted) return; // Interrupted prune: immutable snapshot owns the protection list.
    throw new Error('Cannot safely erase a profile with a missing workspace database');
  }
  const database = new DatabaseSync(databaseFile, { readOnly: true, timeout: 3000 });
  try {
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspaces'").get() === undefined) {
      // A previously interrupted restore may contain only a Settings table.
      if (!cleanupStarted && manifest.version === 2 && manifest.protectedProjects?.length) {
        const restored = database.prepare('SELECT value FROM settings WHERE key=?')
          .get(PROTECTED_PROJECTS_SETTING_KEY) as { value: string } | undefined;
        if (restored?.value !== JSON.stringify(manifest.protectedProjects)) {
          throw new Error('Protected project roots are missing from partially restored Settings');
        }
      }
      return;
    }
    const current = collectProtectedProjects(database, profile);
    const saved = manifest.version === 2 ? manifest.protectedProjects ?? [] : [];
    for (const entry of current) {
      if (!saved.some((protectedPath) => isWithinDirectory(
        path.join(profile, protectedPath), path.join(profile, entry)))) {
        throw new Error('A new protected project was registered after snapshot; restart the reset safely');
      }
    }
  } finally { database.close(); }
}

function isWithinDirectory(parent: string, candidate: string): boolean {
  const root = process.platform === 'win32' ? path.resolve(parent).toLowerCase() : path.resolve(parent);
  const target = process.platform === 'win32' ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function verifySnapshot(directory: string, nonce: string): SnapshotManifest {
  const marker = path.join(directory, 'manifest.json');
  const info = lstatSync(marker);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) {
    throw new Error('Settings reset manifest is invalid');
  }
  const raw: unknown = JSON.parse(readFileSync(marker, 'utf8'));
  if (typeof raw !== 'object' || raw === null || !('version' in raw) || (raw.version !== 1 && raw.version !== 2)
    || !('nonce' in raw) || raw.nonce !== nonce || !('files' in raw) || !Array.isArray(raw.files)
    || raw.files.length > SNAPSHOT_FILES.length || !('databaseSha256' in raw)
    || typeof raw.databaseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.databaseSha256)) {
    throw new Error('Settings reset manifest does not match this request');
  }
  const manifest = raw as unknown as SnapshotManifest;
  if (manifest.version === 2) {
    if (!Array.isArray(manifest.protectedProjects)
      || manifest.protectedProjects.length > MAX_PROTECTED_PROJECTS
      || manifest.protectedProjects.some((entry) => typeof entry !== 'string')) {
      throw new Error('Settings snapshot has invalid protected project metadata');
    }
    const canonical = minimizeProtectedPaths(manifest.protectedProjects);
    if (JSON.stringify(canonical) !== JSON.stringify(manifest.protectedProjects)) {
      throw new Error('Settings snapshot has noncanonical protected project metadata');
    }
  }
  const dbFile = safeRelativeFile(directory, 'settings.sqlite');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (existsSync(dbFile + suffix)) throw new Error('Settings snapshot has an unverified SQLite journal');
  }
  if (!existsSync(dbFile) || !lstatSync(dbFile).isFile() || digest(readFileSync(dbFile)) !== manifest.databaseSha256) {
    throw new Error('Settings snapshot integrity failure; profile was not erased');
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const id = db.prepare('SELECT nonce FROM reset_meta').get() as { nonce: string } | undefined;
    if (id?.nonce !== nonce) throw new Error('Settings snapshot ownership mismatch');
    if (manifest.version === 2) {
      const row = db.prepare('SELECT value FROM settings WHERE key=?')
        .get(PROTECTED_PROJECTS_SETTING_KEY) as { value: unknown } | undefined;
      const protectedProjects = manifest.protectedProjects ?? [];
      if (protectedProjects.length === 0 ? row !== undefined
        : row?.value !== JSON.stringify(protectedProjects)) {
        throw new Error('Settings snapshot protected project metadata does not match Settings');
      }
    }
    if ((db.prepare('PRAGMA quick_check').get() as Record<string, string>).quick_check !== 'ok') {
      throw new Error('Settings snapshot database is corrupt');
    }
  } finally { db.close(); }
  const known = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file !== 'object' || file === null || !SNAPSHOT_FILES.includes(file.relative as typeof SNAPSHOT_FILES[number])
      || known.has(file.relative) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || file.bytes > MAX_PRESERVED_FILE_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Settings snapshot contains an unexpected dependency');
    }
    known.add(file.relative);
    const filename = safeRelativeFile(directory, path.join('files', file.relative));
    if (!existsSync(filename) || !lstatSync(filename).isFile() || statSync(filename).size !== file.bytes
      || digest(readFileSync(filename)) !== file.sha256) {
      throw new Error('Settings dependency snapshot is corrupt');
    }
  }
  return manifest;
}

function assertNoActiveQuotaReservations(profile: string): void {
  const ledgerFile = safeRelativeFile(profile, 'global-quota-reservations-v2.sqlite');
  if (!existsSync(ledgerFile)) return;
  const ledger = new DatabaseSync(ledgerFile, { readOnly: true });
  try {
    const total = ledger.prepare('SELECT COUNT(*) AS count FROM quota_reservations').get() as { count: number };
    if (total.count !== 0) throw new Error('Active profile quota reservations prevent settings-preserving reset');
  } finally { ledger.close(); }
}

function safeRelativeFile(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Unsafe settings dependency path');
  let current = root;
  for (const part of rel.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    if (existsSync(current)) assertRealDirectory(current);
  }
  if (existsSync(target)) {
    const entry = lstatSync(target);
    if (entry.isSymbolicLink()) throw new Error('Settings dependency is redirected');
  }
  return target;
}

function assertRealDirectory(directory: string): void {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Reset path is not a direct directory');
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
