/**
 * Checkpoint payload metadata is maintained on every write, including raw
 * SQL from legacy callers. Existing payloads are deliberately NOT backfilled
 * in this migration: startup must not scan hundreds of MiB of snapshots.
 * The Storage Preview action performs a bounded, cooperative one-time fill.
 */
export const CHECKPOINT_METADATA_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS checkpoint_storage_meta (
  checkpoint_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  compressed_v2 INTEGER NOT NULL CHECK (compressed_v2 IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_meta_created
  ON checkpoint_storage_meta(created_at ASC, checkpoint_id ASC);
CREATE INDEX IF NOT EXISTS idx_checkpoint_meta_compressed
  ON checkpoint_storage_meta(compressed_v2) WHERE compressed_v2 = 1;

CREATE TRIGGER IF NOT EXISTS checkpoint_meta_insert AFTER INSERT ON checkpoints
BEGIN
  INSERT OR REPLACE INTO checkpoint_storage_meta
    (checkpoint_id,workspace_id,created_at,payload_bytes,compressed_v2)
  VALUES (NEW.id,NEW.workspace_id,NEW.created_at,length(CAST(NEW.files_json AS BLOB)),
    CASE WHEN substr(NEW.files_json,1,25) = 'lnwjing:checkpoint:v2:br:' THEN 1 ELSE 0 END);
END;
CREATE TRIGGER IF NOT EXISTS checkpoint_meta_update AFTER UPDATE ON checkpoints
BEGIN
  DELETE FROM checkpoint_storage_meta WHERE checkpoint_id = OLD.id;
  INSERT INTO checkpoint_storage_meta
    (checkpoint_id,workspace_id,created_at,payload_bytes,compressed_v2)
  VALUES (NEW.id,NEW.workspace_id,NEW.created_at,length(CAST(NEW.files_json AS BLOB)),
    CASE WHEN substr(NEW.files_json,1,25) = 'lnwjing:checkpoint:v2:br:' THEN 1 ELSE 0 END);
END;
CREATE TRIGGER IF NOT EXISTS checkpoint_meta_delete AFTER DELETE ON checkpoints
BEGIN
  DELETE FROM checkpoint_storage_meta WHERE checkpoint_id = OLD.id;
END;
`;
