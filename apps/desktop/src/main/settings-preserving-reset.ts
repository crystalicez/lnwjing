import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GlobalStorageQuotaReservations, assertNoActiveSqliteClientsSync } from '@lnwjing/storage';

interface PreservedFile {
  readonly relative: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface SnapshotManifest {
  readonly version: 1;
  readonly nonce: string;
  readonly databaseSha256: string;
  readonly files: readonly PreservedFile[];
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
const DROPPED_EPHEMERAL_SETTINGS = new Set([
  'selected_workspace_id', 'active_workspace_ids', 'work_log_cleared_at',
  'watcher_access_token_v1', 'watcher_instance_id_v1', 'backup_restore_notice_v1',
]);

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
    snapshotProfileSettings(profile, path.join(snapshotDirectory, 'settings.sqlite'), nonce);
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
      version: 1, nonce,
      databaseSha256: digest(readFileSync(path.join(snapshotDirectory, 'settings.sqlite'))),
      files,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  }

  const manifest = verifySnapshot(snapshotDirectory, nonce);
  // A fresh source must be free of cooperating SQLite clients, including
  // standalone STDIO. Do not delete any profile with a live client lease.
  if (sourceExists) {
    assertNoActiveSqliteClientsSync(path.join(profile, 'backups'));
    assertNoActiveQuotaReservations(profile);
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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

function snapshotProfileSettings(profile: string, destination: string, nonce: string): void {
  const dbFile = safeRelativeFile(profile, 'lnwjing.sqlite');
  if (!existsSync(dbFile)) throw new Error('Cannot preserve settings: application database does not exist');
  const original = lstatSync(dbFile);
  if (!original.isFile() || original.isSymbolicLink()) throw new Error('Application database is not a regular file');
  const source = new DatabaseSync(dbFile, { readOnly: true, timeout: 3000 });
  try {
    if ((source.prepare('PRAGMA quick_check').get() as Record<string, string>).quick_check !== 'ok') {
      throw new Error('Cannot preserve settings from an unhealthy database');
    }
    const rows = source.prepare('SELECT key,value FROM settings').all() as Array<{ key: unknown; value: unknown }>;
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
        if (!DROPPED_EPHEMERAL_SETTINGS.has(row.key)) insert.run(row.key, row.value);
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
  } finally { source.close(); }
}

function verifySnapshot(directory: string, nonce: string): SnapshotManifest {
  const marker = path.join(directory, 'manifest.json');
  const info = lstatSync(marker);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024) {
    throw new Error('Settings reset manifest is invalid');
  }
  const raw: unknown = JSON.parse(readFileSync(marker, 'utf8'));
  if (typeof raw !== 'object' || raw === null || !('version' in raw) || raw.version !== 1
    || !('nonce' in raw) || raw.nonce !== nonce || !('files' in raw) || !Array.isArray(raw.files)
    || raw.files.length > SNAPSHOT_FILES.length || !('databaseSha256' in raw)
    || typeof raw.databaseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.databaseSha256)) {
    throw new Error('Settings reset manifest does not match this request');
  }
  const manifest = raw as unknown as SnapshotManifest;
  const dbFile = safeRelativeFile(directory, 'settings.sqlite');
  if (!existsSync(dbFile) || !lstatSync(dbFile).isFile() || digest(readFileSync(dbFile)) !== manifest.databaseSha256) {
    throw new Error('Settings snapshot integrity failure; profile was not erased');
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const id = db.prepare('SELECT nonce FROM reset_meta').get() as { nonce: string } | undefined;
    if (id?.nonce !== nonce) throw new Error('Settings snapshot ownership mismatch');
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
