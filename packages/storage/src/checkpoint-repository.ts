import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Checkpoint, CheckpointFile, CheckpointRepository } from '@lnwjing/workspace';
import type { SqliteDatabase } from './database.js';
import type { CheckpointPayloadCipher } from './checkpoint-cipher.js';

interface CheckpointRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly created_at: string;
  readonly files_json: string;
}

export class SqliteCheckpointRepository implements CheckpointRepository {
  private cachedByteCount: {
    readonly bytes: number;
    readonly connection: DatabaseSync;
    readonly dataVersion: number;
    readonly totalChanges: number;
  } | null = null;

  private checkpointByteState(): { readonly bytes: number; readonly dataVersion: number; readonly totalChanges: number } {
    const connection = this.database.connection;
    // data_version detects other connections; total_changes detects raw SQL on
    // this connection. Both are metadata reads, not scans. Connection identity
    // also protects against an atomic profile restore reopening SQLite.
    const dataVersion = (connection.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
    const totalChanges = (connection.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    if (this.cachedByteCount !== null && this.cachedByteCount.connection === connection
      && this.cachedByteCount.dataVersion === dataVersion && this.cachedByteCount.totalChanges === totalChanges) {
      return this.cachedByteCount;
    }
    const row = connection.prepare('SELECT COALESCE(SUM(length(CAST(files_json AS BLOB))), 0) AS bytes FROM checkpoints').get() as { bytes: number };
    this.cachedByteCount = { bytes: row.bytes, connection, dataVersion, totalChanges };
    return this.cachedByteCount;
  }

  public constructor(
    private readonly database: SqliteDatabase,
    private readonly cipher?: CheckpointPayloadCipher,
  ) {
    this.encryptLegacyRowsAtRest();
  }

  public async insert(checkpoint: Checkpoint): Promise<void> {
    this.database.connection.prepare(
      'INSERT INTO checkpoints (id, workspace_id, created_at, files_json) VALUES (?, ?, ?, ?)',
    ).run(checkpoint.id, checkpoint.workspaceId, checkpoint.createdAt, this.encodeFiles(checkpoint.files));
    this.cachedByteCount = null;
  }

  public async get(id: string): Promise<Checkpoint | null> {
    const row = this.database.connection.prepare(
      'SELECT id, workspace_id, created_at, files_json FROM checkpoints WHERE id = ?',
    ).get(id);
    return this.toCheckpoint(row);
  }

  public async list(workspaceId: string, limit = 100): Promise<Checkpoint[]> {
    const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
    const rows = this.database.connection.prepare(
      'SELECT id, workspace_id, created_at, files_json FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ).all(workspaceId, boundedLimit);
    return rows.flatMap((row) => {
      const checkpoint = this.toCheckpoint(row);
      return checkpoint === null ? [] : [checkpoint];
    });
  }

  /**
   * Bounded age pruning, preserving the newest checkpoint of each workspace.
   * Callers must hold a verified backup/retention gate before invoking this.
   */
  public async deleteOlderThan(cutoffIso: string): Promise<number> {
    if (!Number.isFinite(Date.parse(cutoffIso))) throw new Error('Checkpoint retention cutoff is invalid');
    const result = this.database.connection.prepare(`
      DELETE FROM checkpoints WHERE id IN (
        SELECT older.id FROM checkpoints older
        WHERE older.created_at < ?
          AND EXISTS (
            SELECT 1 FROM checkpoints newer
            WHERE newer.workspace_id = older.workspace_id
              AND (newer.created_at > older.created_at
                OR (newer.created_at = older.created_at AND newer.id > older.id))
          )
        ORDER BY older.created_at ASC, older.id ASC LIMIT 128
      )
    `).run(cutoffIso);
    this.cachedByteCount = null;
    return Number(result.changes);
  }

  /** Metadata-only eligibility check to avoid full backup when nothing expires. */
  public hasExpiredCleanupCandidates(cutoffIso: string): boolean {
    if (!Number.isFinite(Date.parse(cutoffIso))) throw new Error('Checkpoint retention cutoff is invalid');
    return this.database.connection.prepare(`
      SELECT 1 FROM checkpoints older
      WHERE older.created_at < ?
        AND EXISTS (
          SELECT 1 FROM checkpoints newer WHERE newer.workspace_id = older.workspace_id
            AND (newer.created_at > older.created_at
              OR (newer.created_at = older.created_at AND newer.id > older.id))
        ) LIMIT 1
    `).get(cutoffIso) !== undefined;
  }

  public async deleteAll(): Promise<number> {
    const deleted = Number(this.database.connection.prepare('DELETE FROM checkpoints').run().changes);
    this.cachedByteCount = null;
    return deleted;
  }

  /**
   * On-demand budget preview. Never reads or decrypts checkpoint payloads.
   * Only checkpoints older than deleteBefore are candidates, with the newest
   * snapshot of every workspace and explicitly referenced IDs always retained.
   */
  public planStorageBudget(options: {
    readonly maxBytes: number;
    readonly deleteBefore: string;
    readonly protectedIds?: ReadonlySet<string>;
  }): { readonly totalBytes: number; readonly candidateBytes: number; readonly checkpointIds: readonly string[]; readonly previewToken: string } {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || !Number.isFinite(Date.parse(options.deleteBefore))) {
      throw new Error('Invalid checkpoint storage budget');
    }
    // Aggregate inside SQLite rather than materializing all checkpoint rows
    // and their metadata into Node. Preview is capped at 256 candidates.
    const state = this.checkpointByteState();
    const totalBytes = state.bytes;
    const needToReclaim = totalBytes - options.maxBytes;
    // For destructive cleanup, refuse a stale snapshot even if an UPDATE
    // preserves payload length and all candidate IDs. data_version catches
    // other connections, total_changes catches same-connection SQL.
    const seal = (ids: readonly string[], bytes: number): string => createHash('sha256')
      .update(JSON.stringify([options.maxBytes, options.deleteBefore, totalBytes, bytes,
        state.dataVersion, state.totalChanges, ids])).digest('hex');
    if (needToReclaim <= 0) return { totalBytes, candidateBytes: 0, checkpointIds: [], previewToken: seal([], 0) };
    const candidates = this.database.connection.prepare(`
      SELECT older.id, length(CAST(older.files_json AS BLOB)) AS bytes
      FROM checkpoints older
      WHERE older.created_at < ?
        AND EXISTS (
          SELECT 1 FROM checkpoints newer WHERE newer.workspace_id = older.workspace_id
            AND (newer.created_at > older.created_at
              OR (newer.created_at = older.created_at AND newer.id > older.id))
        )
      ORDER BY older.created_at ASC, older.id ASC LIMIT 256
    `).all(options.deleteBefore) as { id: string; bytes: number }[];
    const checkpointIds: string[] = [];
    let candidateBytes = 0;
    for (const candidate of candidates) {
      if (options.protectedIds?.has(candidate.id)) continue;
      if (candidateBytes >= needToReclaim) break;
      checkpointIds.push(candidate.id);
      candidateBytes += candidate.bytes;
    }
    return { totalBytes, candidateBytes, checkpointIds, previewToken: seal(checkpointIds, candidateBytes) };
  }

  /** No silent cleanup: require an actual verified backup and a reference fence. */
  public async applyStorageBudget(options: {
    readonly maxBytes: number;
    readonly deleteBefore: string;
    readonly protectedIds: ReadonlySet<string>;
    readonly userConfirmed: boolean;
    readonly expectedPreviewToken: string;
    readonly resolveProtectedIds?: () => ReadonlySet<string>;
    readonly createVerifiedBackup: () => Promise<{ readonly verified: true; readonly id: string }>;
  }): Promise<{ readonly deleted: number; readonly plannedBytes: number }> {
    if (!options.userConfirmed) throw new Error('Checkpoint storage cleanup requires explicit confirmation');
    if (!/^[0-9a-f]{64}$/.test(options.expectedPreviewToken)) throw new Error('Checkpoint cleanup requires a valid preview token');
    if (options.protectedIds === undefined || typeof options.protectedIds.has !== 'function') {
      throw new Error('Checkpoint storage cleanup requires an explicit protected-ID reference fence');
    }
    const preview = this.planStorageBudget(options);
    if (preview.previewToken !== options.expectedPreviewToken) throw new Error('Checkpoint cleanup preview is stale; preview again');
    if (preview.checkpointIds.length === 0) return { deleted: 0, plannedBytes: 0 };
    const backup = await options.createVerifiedBackup();
    if (backup?.verified !== true || typeof backup.id !== 'string' || backup.id.length === 0) {
      throw new Error('Checkpoint storage cleanup requires a verified backup');
    }
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE;');
    try {
      const currentProtected = options.resolveProtectedIds?.() ?? options.protectedIds;
      const plan = this.planStorageBudget({ ...options, protectedIds: currentProtected });
      if (plan.previewToken !== options.expectedPreviewToken) throw new Error('Checkpoint cleanup preview changed; preview again');
      const remove = connection.prepare('DELETE FROM checkpoints WHERE id = ? AND created_at < ?');
      let deleted = 0;
      for (const id of plan.checkpointIds) {
        deleted += Number(remove.run(id, options.deleteBefore).changes);
      }
      connection.exec('COMMIT;');
      this.cachedByteCount = null;
      return { deleted, plannedBytes: plan.candidateBytes };
    } catch (error) {
      connection.exec('ROLLBACK;');
      throw error;
    }
  }

  private toCheckpoint(value: unknown): Checkpoint | null {
    if (!this.isCheckpointRow(value)) return null;
    let files: unknown;
    try {
      const decoded = this.decodeFiles(value.files_json);
      files = JSON.parse(decoded) as unknown;
      if (this.cipher !== undefined && !this.cipher.isEncrypted(value.files_json)) {
        this.database.connection.prepare('UPDATE checkpoints SET files_json = ? WHERE id = ? AND files_json = ?').run(
          this.cipher.encrypt(decoded), value.id, value.files_json,
        );
        this.cachedByteCount = null;
      }
    } catch {
      return null;
    }
    if (!Array.isArray(files) || !files.every(isCheckpointFile)) return null;
    return { id: value.id, workspaceId: value.workspace_id, createdAt: value.created_at, files };
  }

  private encryptLegacyRowsAtRest(): void {
    if (this.cipher === undefined) return;
    // Complete mandatory encryption migration with bounded 8-row transactions.
    // Plaintext must not remain at rest after startup; separate commits avoid
    // one unbounded SQLite WAL transaction on large legacy profiles.
    const marker = 'checkpoint_cipher_legacy_encryption_v1';
    const connection = this.database.connection;
    if (connection.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(marker)) return;
    const select = connection.prepare(`
      SELECT id, files_json FROM checkpoints
      WHERE id > ?
        AND substr(files_json, 1, 22) != 'lnwjing:checkpoint:v1:'
        AND substr(files_json, 1, 21) != 'lnwjud:checkpoint:v1:'
        AND substr(files_json, 1, 25) != 'lnwjing:checkpoint:v2:br:'
      ORDER BY id LIMIT 8
    `);
    const update = connection.prepare('UPDATE checkpoints SET files_json = ? WHERE id = ? AND files_json = ?');
    let afterId = '';
    while (true) {
      const rows = select.all(afterId);
      if (rows.length === 0) {
        connection.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(marker);
        return;
      }
      connection.exec('BEGIN IMMEDIATE;');
      try {
        for (const row of rows) {
          if (!isLegacyPayloadRow(row)) continue;
          afterId = row.id;
          if (!this.cipher.isEncrypted(row.files_json)) {
            update.run(this.cipher.encrypt(row.files_json), row.id, row.files_json);
          }
        }
        connection.exec('COMMIT;');
      } catch (error) {
        connection.exec('ROLLBACK;');
        throw error;
      }
      if (rows.length < 8) {
        connection.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(marker);
        return;
      }
    }
    // Single-item get() still upgrades late-imported plaintext on demand.
  }

  private encodeFiles(files: readonly CheckpointFile[]): string {
    const serialized = JSON.stringify(files);
    return this.cipher === undefined ? serialized : this.cipher.encrypt(serialized);
  }

  private decodeFiles(payload: string): string {
    if (this.cipher === undefined || !this.cipher.isEncrypted(payload)) return payload;
    return this.cipher.decrypt(payload);
  }

  private isCheckpointRow(value: unknown): value is CheckpointRow {
    if (typeof value !== 'object' || value === null || !('id' in value) || !('workspace_id' in value) || !('created_at' in value) || !('files_json' in value)) return false;
    return typeof value.id === 'string' && typeof value.workspace_id === 'string' && typeof value.created_at === 'string' && typeof value.files_json === 'string';
  }
}

function isCheckpointFile(value: unknown): value is CheckpointFile {
  if (typeof value !== 'object' || value === null || !('path' in value) || !('content' in value) || !('contentSha256' in value) || !('size' in value)) return false;
  return typeof value.path === 'string' && typeof value.content === 'string' && typeof value.contentSha256 === 'string' && typeof value.size === 'number';
}

function isLegacyPayloadRow(value: unknown): value is { readonly id: string; readonly files_json: string } {
  return typeof value === 'object' && value !== null && 'id' in value && 'files_json' in value
    && typeof value.id === 'string' && typeof value.files_json === 'string';
}
