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
    readonly revision: number;
  } | null = null;

  private checkpointByteState(): { readonly bytes: number; readonly revision: number } {
    const connection = this.database.connection;
    // SQLite triggers increment this one-row stamp only for checkpoint-table
    // writes, including raw UPDATEs that leave payload length unchanged.
    // Reading the stamp is constant-cost and avoids repeated payload scans.
    const revision = (connection.prepare(
      'SELECT revision FROM checkpoint_storage_revision WHERE id = 1',
    ).get() as { revision: number } | undefined)?.revision;
    if (revision === undefined || !Number.isSafeInteger(revision)) {
      throw new Error('Checkpoint storage revision is unavailable or invalid');
    }
    if (this.cachedByteCount !== null && this.cachedByteCount.connection === connection
      && this.cachedByteCount.revision === revision) {
      return this.cachedByteCount;
    }
    if (!this.storageMetadataStatus().complete) throw new Error('Checkpoint storage metadata requires preparation');
    const row = connection.prepare(
      'SELECT payload_bytes AS bytes FROM checkpoint_storage_totals WHERE id = 1',
    ).get() as { bytes: number } | undefined;
    if (row === undefined || !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
      throw new Error('Checkpoint storage size rollup is unavailable or invalid');
    }
    this.cachedByteCount = { bytes: row.bytes, connection, revision };
    return this.cachedByteCount;
  }

  /** Constant-payload-I/O metadata readiness and encrypted format check. */
  public storageMetadataStatus(): { readonly complete: boolean; readonly indexed: number; readonly total: number; readonly hasCompressedV2: boolean } {
    const connection = this.database.connection;
    const state = connection.prepare(`
      SELECT indexed_count, compressed_v2_count,
        (SELECT COUNT(*) FROM checkpoints) AS checkpoint_count
      FROM checkpoint_storage_totals WHERE id = 1
    `).get() as { indexed_count: number; compressed_v2_count: number; checkpoint_count: number } | undefined;
    if (state === undefined || !Number.isSafeInteger(state.indexed_count)
      || !Number.isSafeInteger(state.checkpoint_count)
      || !Number.isSafeInteger(state.compressed_v2_count) || state.indexed_count < 0
      || state.checkpoint_count < 0 || state.compressed_v2_count < 0
      || state.compressed_v2_count > state.indexed_count) {
      throw new Error('Checkpoint storage metadata rollup is unavailable or invalid');
    }
    return {
      complete: state.indexed_count === state.checkpoint_count, indexed: state.indexed_count,
      total: state.checkpoint_count, hasCompressedV2: state.compressed_v2_count > 0,
    };
  }

  /** Explicit, cooperative one-time metadata fill; never during startup. */
  public async prepareStorageMetadata(): Promise<void> {
    const connection = this.database.connection;
    if (this.storageMetadataStatus().complete) return;
    let cursor = '';
    const select = connection.prepare(`
      SELECT c.id, c.workspace_id, c.created_at,
        length(CAST(c.files_json AS BLOB)) AS bytes,
        CASE WHEN substr(c.files_json,1,25) = 'lnwjing:checkpoint:v2:br:' THEN 1 ELSE 0 END AS compressed
      FROM checkpoints c
      WHERE c.id > ? AND NOT EXISTS (
        SELECT 1 FROM checkpoint_storage_meta m WHERE m.checkpoint_id = c.id)
      ORDER BY c.id ASC LIMIT 32
    `);
    const insert = connection.prepare(`
      INSERT OR IGNORE INTO checkpoint_storage_meta
        (checkpoint_id,workspace_id,created_at,payload_bytes,compressed_v2)
      VALUES (?,?,?,?,?)
    `);
    while (true) {
      const rows = select.all(cursor) as { id: string; workspace_id: string; created_at: string; bytes: number; compressed: number }[];
      if (rows.length === 0) break;
      connection.exec('BEGIN IMMEDIATE;');
      try {
        for (const row of rows) {
          insert.run(row.id, row.workspace_id, row.created_at, row.bytes, row.compressed);
          cursor = row.id;
        }
        connection.exec('COMMIT;');
      } catch (error) {
        connection.exec('ROLLBACK;');
        throw error;
      }
      this.cachedByteCount = null;
      if (rows.length < 32) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!this.storageMetadataStatus().complete) {
      throw new Error('Checkpoint metadata changed during preparation; retry preview');
    }
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
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE;');
    try {
      this.assertNoPersistedCleanupReferences();
      const result = connection.prepare(`
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
      connection.exec('COMMIT;');
      this.cachedByteCount = null;
      return Number(result.changes);
    } catch (error) {
      connection.exec('ROLLBACK;');
      throw error;
    }
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

  /**
   * Fail closed if Goal evidence or audit mutation receipts still reference
   * checkpoints. Call before an expensive backup, then recheck inside the
   * SQLite write transaction to cover competing Desktop/STDIO writers.
   */
  public assertNoPersistedCleanupReferences(): void {
    const connection = this.database.connection;
    if (connection.prepare('SELECT 1 FROM goal_checkpoints LIMIT 1').get() !== undefined) {
      throw new Error('Checkpoint cleanup blocked by persisted Goal evidence references');
    }
    if (connection.prepare(`
      SELECT 1 FROM audit_events
      WHERE json_type(metadata_json, '$.mutationReceipt.checkpointId') = 'text'
      LIMIT 1
    `).get() !== undefined) {
      throw new Error('Checkpoint cleanup blocked by persisted audit mutation references');
    }
  }

  public async deleteAll(): Promise<number> {
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE;');
    try {
      this.assertNoPersistedCleanupReferences();
      const deleted = Number(connection.prepare('DELETE FROM checkpoints').run().changes);
      connection.exec('COMMIT;');
      this.cachedByteCount = null;
      return deleted;
    } catch (error) {
      connection.exec('ROLLBACK;');
      throw error;
    }
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
    // A checkpoint-only revision prevents over-deletion after a same-length
    // payload update without expiring approvals on unrelated audit/settings.
    const seal = (ids: readonly string[], bytes: number): string => createHash('sha256')
      .update(JSON.stringify([options.maxBytes, options.deleteBefore, totalBytes, bytes,
        state.revision, ids])).digest('hex');
    if (needToReclaim <= 0) return { totalBytes, candidateBytes: 0, checkpointIds: [], previewToken: seal([], 0) };
    const pageSize = 256;
    const maxInspected = 4_096;
    const select = this.database.connection.prepare(`
      SELECT older.checkpoint_id AS id, older.created_at AS createdAt, older.payload_bytes AS bytes
      FROM checkpoint_storage_meta older INDEXED BY idx_checkpoint_meta_created
      WHERE (? = 1 OR (older.created_at, older.checkpoint_id) > (?, ?))
        AND older.created_at < ?
        AND EXISTS (
          SELECT 1 FROM checkpoints newer WHERE newer.workspace_id = older.workspace_id
            AND (newer.created_at > older.created_at
              OR (newer.created_at = older.created_at AND newer.id > older.checkpoint_id))
        )
      ORDER BY older.created_at ASC, older.checkpoint_id ASC LIMIT ?
    `);
    const checkpointIds: string[] = [];
    let candidateBytes = 0;
    let cursorCreatedAt = '';
    let cursorId = '';
    let inspected = 0;
    while (checkpointIds.length < pageSize && candidateBytes < needToReclaim) {
      if (inspected >= maxInspected) {
        throw new Error('Checkpoint cleanup preview exceeds the bounded protected-row scan; refine the cutoff or references');
      }
      const limit = Math.min(pageSize, maxInspected - inspected);
      const candidates = select.all(inspected === 0 ? 1 : 0, cursorCreatedAt, cursorId, options.deleteBefore, limit) as {
        id: string; createdAt: string; bytes: number;
      }[];
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        cursorCreatedAt = candidate.createdAt;
        cursorId = candidate.id;
        inspected += 1;
        if (options.protectedIds?.has(candidate.id)) continue;
        checkpointIds.push(candidate.id);
        candidateBytes += candidate.bytes;
        if (checkpointIds.length >= pageSize || candidateBytes >= needToReclaim) break;
      }
      if (candidates.length < limit) break;
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
