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

  public async deleteOlderThan(cutoffIso: string): Promise<number> {
    if (!Number.isFinite(Date.parse(cutoffIso))) throw new Error('Checkpoint retention cutoff is invalid');
    const result = this.database.connection.prepare('DELETE FROM checkpoints WHERE created_at < ?').run(cutoffIso);
    return Number(result.changes);
  }

  public async deleteAll(): Promise<number> {
    return Number(this.database.connection.prepare('DELETE FROM checkpoints').run().changes);
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
  }): { readonly totalBytes: number; readonly candidateBytes: number; readonly checkpointIds: readonly string[] } {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || !Number.isFinite(Date.parse(options.deleteBefore))) {
      throw new Error('Invalid checkpoint storage budget');
    }
    const rows = this.database.connection.prepare(
      'SELECT id, workspace_id, created_at, length(CAST(files_json AS BLOB)) AS bytes FROM checkpoints ORDER BY workspace_id, created_at DESC, id DESC',
    ).all() as { id: string; workspace_id: string; created_at: string; bytes: number }[];
    const latestByWorkspace = new Set<string>();
    let totalBytes = 0;
    const candidates: typeof rows = [];
    for (const row of rows) {
      totalBytes += row.bytes;
      if (!latestByWorkspace.has(row.workspace_id)) {
        latestByWorkspace.add(row.workspace_id);
        continue;
      }
      if (row.created_at >= options.deleteBefore || options.protectedIds?.has(row.id)) continue;
      candidates.push(row);
    }
    const needToReclaim = totalBytes - options.maxBytes;
    if (needToReclaim <= 0) return { totalBytes, candidateBytes: 0, checkpointIds: [] };
    candidates.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    const checkpointIds: string[] = [];
    let candidateBytes = 0;
    for (const candidate of candidates) {
      if (candidateBytes >= needToReclaim) break;
      checkpointIds.push(candidate.id);
      candidateBytes += candidate.bytes;
    }
    return { totalBytes, candidateBytes, checkpointIds };
  }

  /** No silent cleanup: require an actual verified backup and a reference fence. */
  public async applyStorageBudget(options: {
    readonly maxBytes: number;
    readonly deleteBefore: string;
    readonly protectedIds: ReadonlySet<string>;
    readonly userConfirmed: boolean;
    readonly createVerifiedBackup: () => Promise<{ readonly verified: true; readonly id: string }>;
  }): Promise<{ readonly deleted: number; readonly plannedBytes: number }> {
    if (!options.userConfirmed) throw new Error('Checkpoint storage cleanup requires explicit confirmation');
    if (options.protectedIds === undefined || typeof options.protectedIds.has !== 'function') {
      throw new Error('Checkpoint storage cleanup requires an explicit protected-ID reference fence');
    }
    const preview = this.planStorageBudget(options);
    if (preview.checkpointIds.length === 0) return { deleted: 0, plannedBytes: 0 };
    const backup = await options.createVerifiedBackup();
    if (backup?.verified !== true || typeof backup.id !== 'string' || backup.id.length === 0) {
      throw new Error('Checkpoint storage cleanup requires a verified backup');
    }
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE;');
    try {
      const plan = this.planStorageBudget(options);
      const remove = connection.prepare('DELETE FROM checkpoints WHERE id = ? AND created_at < ?');
      let deleted = 0;
      for (const id of plan.checkpointIds) {
        deleted += Number(remove.run(id, options.deleteBefore).changes);
      }
      connection.exec('COMMIT;');
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
      }
    } catch {
      return null;
    }
    if (!Array.isArray(files) || !files.every(isCheckpointFile)) return null;
    return { id: value.id, workspaceId: value.workspace_id, createdAt: value.created_at, files };
  }

  private encryptLegacyRowsAtRest(): void {
    if (this.cipher === undefined) return;
    // Historic code loaded all encrypted checkpoint payloads on every launch.
    // Mark the completion of the one-time plaintext migration transaction.
    const marker = 'checkpoint_cipher_legacy_encryption_v1';
    const connection = this.database.connection;
    if (connection.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(marker)) return;
    connection.exec('BEGIN IMMEDIATE;');
    try {
      const selectLegacy = connection.prepare(`
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
        // Bounded migration batches prevent hundreds of MiB being loaded into
        // JS when upgrading an older installation with plaintext checkpoints.
        const rows = selectLegacy.all(afterId);
        if (rows.length === 0) break;
        for (const row of rows) {
          if (!isLegacyPayloadRow(row)) continue;
          afterId = row.id;
          if (!this.cipher.isEncrypted(row.files_json)) {
            update.run(this.cipher.encrypt(row.files_json), row.id, row.files_json);
          }
        }
        if (rows.length < 8) break;
      }
      connection.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(marker);
      connection.exec('COMMIT;');
    } catch (error) {
      connection.exec('ROLLBACK;');
      throw error;
    }
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
