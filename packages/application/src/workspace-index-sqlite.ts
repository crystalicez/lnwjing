import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isHostPathWithin } from '@lnwjing/workspace';
import {
  JsonWorkspaceIndexStore, isIndexMetadata, isSnapshot, snapshotMetadata,
  type WorkspaceIndexEntry, type WorkspaceIndexMetadata, type WorkspaceIndexMutation,
  type WorkspaceIndexSnapshot, type WorkspaceIndexStore,
} from './workspace-index.js';
import { withWorkspaceIndexMutex } from './workspace-index-mutex.js';

const SCHEMA_VERSION = 1;
const VERSION_COLUMN = 'user_version';

interface TextRow { readonly payload: string }
interface IndexedRow extends TextRow { readonly relative_path: string; readonly fingerprint: string }
interface EntryRow { readonly relative_path: string; readonly fingerprint: string }
interface SqliteIndexMetadata extends WorkspaceIndexMetadata { readonly legacyIdentity: string | null }

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Opt-in, transactionally persisted incremental index. The legacy JSON file is
 * imported without deletion so a preview run never destroys the old index.
 * Only explicit opt-in runtimes may use this store; do not run mixed modes
 * against the same data root until a fully coordinated migration ships.
 */
export class SqliteWorkspaceIndexStore implements WorkspaceIndexStore {
  private readonly legacy: JsonWorkspaceIndexStore;

  public constructor(private readonly directory: string) {
    this.legacy = new JsonWorkspaceIndexStore(directory);
  }

  private async legacyIdentity(workspaceId: string): Promise<string | null> {
    const filename = path.join(this.directory, `${encodeURIComponent(workspaceId)}.json`);
    try {
      const details = await stat(filename, { bigint: true });
      return [details.dev, details.ino, details.size, details.mtimeNs, details.ctimeNs, details.birthtimeNs].join(':');
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async assertLegacyUnchanged(workspaceId: string, metadata: SqliteIndexMetadata): Promise<void> {
    if (metadata.legacyIdentity !== await this.legacyIdentity(workspaceId)) {
      throw new Error('Mixed JSON/SQLite workspace index writers detected; stop old runtimes and rebuild in an isolated profile');
    }
  }

  public isInternalPath(absolutePath: string): boolean {
    return isHostPathWithin(path.resolve(this.directory), path.resolve(absolutePath));
  }

  public load(workspaceId: string): Promise<WorkspaceIndexSnapshot | null> {
    return this.readSnapshot(workspaceId, false);
  }

  public async loadMetadata(workspaceId: string): Promise<WorkspaceIndexMetadata | null> {
    await this.ensureImported(workspaceId, false);
    if (!await this.initialized(workspaceId)) return null;
    const database = this.openReadOnly(workspaceId);
    try {
      const row = database.prepare('SELECT payload FROM metadata WHERE id = 1').get() as TextRow | undefined;
      if (row === undefined) return null;
      const metadata = this.parseMetadata(row.payload, workspaceId);
      await this.assertLegacyUnchanged(workspaceId, metadata);
      return metadata;
    } finally {
      database.close();
    }
  }

  public withMutation<T>(
    workspaceId: string, mutate: (scope: WorkspaceIndexMutation) => Promise<T>, signal?: AbortSignal,
  ): Promise<T> {
    return withWorkspaceIndexMutex(this.directory, workspaceId, async () => {
      await this.ensureImported(workspaceId, true);
      return mutate({
        load: () => this.readSnapshot(workspaceId, true),
        save: async (snapshot) => {
          if (snapshot.workspaceId !== workspaceId || !isSnapshot(snapshot)) {
            throw new Error('Workspace index mutation belongs to another workspace or is invalid');
          }
          signal?.throwIfAborted();
          await this.writeSnapshot(snapshot, signal);
        },
        delete: () => this.clear(workspaceId),
      });
    }, { ...(signal === undefined ? {} : { signal }) });
  }

  private filePath(workspaceId: string): string {
    return path.join(this.directory, `${encodeURIComponent(workspaceId)}.sqlite`);
  }

  private openReadOnly(workspaceId: string): DatabaseSync {
    return new DatabaseSync(this.filePath(workspaceId), { readOnly: true, timeout: 5_000 });
  }

  private async initialized(workspaceId: string): Promise<boolean> {
    try {
      await stat(this.filePath(workspaceId));
    } catch (error: unknown) {
      if (isMissing(error)) return false;
      throw error;
    }
    const database = this.openReadOnly(workspaceId);
    try {
      const row = database.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
      const version = row?.[VERSION_COLUMN];
      if (version === 0) return false; // Interrupted first transaction: retry from the untouched JSON.
      if (version !== SCHEMA_VERSION) throw new Error('Workspace index SQLite schema is unsupported');
      return true;
    } finally {
      database.close();
    }
  }

  private async ensureImported(workspaceId: string, alreadyLocked: boolean): Promise<void> {
    if (await this.initialized(workspaceId)) return;
    const migrate = async (): Promise<void> => {
      if (await this.initialized(workspaceId)) return;
      const existing = await this.legacy.load(workspaceId);
      if (existing !== null) await this.writeSnapshot(existing);
    };
    if (alreadyLocked) await migrate();
    else await withWorkspaceIndexMutex(this.directory, workspaceId, migrate);
  }

  private parseMetadata(raw: string, workspaceId: string): SqliteIndexMetadata {
    const value: unknown = JSON.parse(raw);
    const claimedIdentity = typeof value === 'object' && value !== null && 'identity' in value
      ? value.identity : null;
    if (typeof claimedIdentity !== 'string' || !isIndexMetadata(value, workspaceId, claimedIdentity)) {
      throw new Error('Workspace index metadata is corrupt; rebuild from source to recover');
    }
    if (!('legacyIdentity' in value)
      || (value.legacyIdentity !== null && typeof value.legacyIdentity !== 'string')) {
      throw new Error('Workspace index preview metadata is missing its legacy safety fence');
    }
    return value as SqliteIndexMetadata;
  }

  private async readSnapshot(workspaceId: string, alreadyLocked: boolean): Promise<WorkspaceIndexSnapshot | null> {
    await this.ensureImported(workspaceId, alreadyLocked);
    if (!await this.initialized(workspaceId)) return null;
    const database = this.openReadOnly(workspaceId);
    let transaction = false;
    try {
      database.exec('BEGIN');
      transaction = true;
      const record = database.prepare('SELECT payload FROM metadata WHERE id = 1').get() as TextRow | undefined;
      if (record === undefined) {
        database.exec('COMMIT');
        transaction = false;
        return null;
      }
      const metadata = this.parseMetadata(record.payload, workspaceId);
      await this.assertLegacyUnchanged(workspaceId, metadata);
      const rows = database.prepare('SELECT relative_path, fingerprint, payload FROM entries ORDER BY relative_path').all() as unknown as IndexedRow[];
      const entries = rows.map((row) => {
        const fingerprint = createHash('sha256').update(row.payload).digest('hex');
        if (fingerprint !== row.fingerprint) {
          throw new Error('Workspace index SQLite entry fingerprint mismatch; rebuild from source');
        }
        const entry: unknown = JSON.parse(row.payload);
        if (typeof entry !== 'object' || entry === null || !('relativePath' in entry)
          || entry.relativePath !== row.relative_path) {
          throw new Error('Workspace index SQLite row path does not match its payload');
        }
        return entry as WorkspaceIndexEntry;
      }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      const snapshot: WorkspaceIndexSnapshot = {
        version: 1, discoveryPolicyRevision: 1, workspaceId: metadata.workspaceId,
        rootPath: metadata.rootPath, indexedAt: metadata.indexedAt, entries,
      };
      if (!isSnapshot(snapshot) || entries.length !== metadata.entryCount) {
        throw new Error('Workspace index SQLite entries are corrupt; rebuild the index to recover');
      }
      database.exec('COMMIT');
      transaction = false;
      return snapshot;
    } finally {
      if (transaction) {
        try { database.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      }
      database.close();
    }
  }

  private async writeSnapshot(snapshot: WorkspaceIndexSnapshot, signal?: AbortSignal): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const database = new DatabaseSync(this.filePath(snapshot.workspaceId), { timeout: 10_000 });
    let transaction = false;
    try {
      database.exec('PRAGMA journal_mode=WAL');
      database.exec('BEGIN IMMEDIATE');
      transaction = true;
      database.exec('CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)');
      database.exec('CREATE TABLE IF NOT EXISTS entries (relative_path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL) WITHOUT ROWID');
      const current = database.prepare('SELECT relative_path, fingerprint FROM entries').all() as unknown as EntryRow[];
      const existing = new Map(current.map((row) => [row.relative_path, row.fingerprint]));
      const upsert = database.prepare('INSERT INTO entries (relative_path, fingerprint, payload) VALUES (?, ?, ?) ON CONFLICT(relative_path) DO UPDATE SET fingerprint = excluded.fingerprint, payload = excluded.payload');
      const remove = database.prepare('DELETE FROM entries WHERE relative_path = ?');
      if (new Set(snapshot.entries.map((entry) => entry.relativePath)).size !== snapshot.entries.length) {
        throw new Error('Duplicate workspace index paths are not allowed');
      }
      for (const entry of snapshot.entries) {
        signal?.throwIfAborted();
        const content = JSON.stringify(entry);
        const fingerprint = createHash('sha256').update(content).digest('hex');
        if (existing.get(entry.relativePath) !== fingerprint) upsert.run(entry.relativePath, fingerprint, content);
        existing.delete(entry.relativePath);
      }
      for (const removed of existing.keys()) {
        signal?.throwIfAborted();
        remove.run(removed);
      }
      const generation = snapshotMetadata(snapshot, '', (entry) =>
        !this.isInternalPath(path.resolve(snapshot.rootPath, entry.relativePath)));
      const previousMetadata = database.prepare('SELECT payload FROM metadata WHERE id = 1').get() as TextRow | undefined;
      const legacyIdentity = previousMetadata === undefined
        ? await this.legacyIdentity(snapshot.workspaceId)
        : this.parseMetadata(previousMetadata.payload, snapshot.workspaceId).legacyIdentity;
      if (previousMetadata !== undefined) {
        await this.assertLegacyUnchanged(snapshot.workspaceId, this.parseMetadata(previousMetadata.payload, snapshot.workspaceId));
      }
      const metadata = { ...generation, identity: generation.generation, legacyIdentity };
      database.prepare('INSERT INTO metadata (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
        .run(JSON.stringify(metadata));
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      signal?.throwIfAborted();
      database.exec('COMMIT');
      transaction = false;
    } finally {
      if (transaction) {
        try { database.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      }
      database.close();
    }
  }

  private async clear(workspaceId: string): Promise<void> {
    if (!await this.initialized(workspaceId)) return;
    const database = new DatabaseSync(this.filePath(workspaceId), { timeout: 10_000 });
    let transaction = false;
    try {
      database.exec('BEGIN IMMEDIATE');
      transaction = true;
      database.exec('DELETE FROM entries; DELETE FROM metadata');
      database.exec('COMMIT');
      transaction = false;
      // Keep SQLite free pages for reuse; VACUUM would rewrite the entire file
      // for every project deletion and can create avoidable disk bursts.
    } finally {
      if (transaction) {
        try { database.exec('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      database.close();
    }
  }
}
