/**
 * Fix the v027 checkpoint row counter for SQLite INSERT OR REPLACE.
 * By default, SQLite does not fire DELETE triggers for implicit REPLACE
 * deletions unless recursive_triggers is enabled. Keep the count in the same
 * checkpoint metadata trigger that can distinguish a new ID from a replacement.
 *
 * Repair existing v027 drift via one metadata-only B-tree COUNT at migration
 * time. Checkpoint payloads are never selected or rewritten.
 */
export const CHECKPOINT_ROLLUP_REPLACE_MIGRATION_SQL = `
UPDATE checkpoint_storage_totals
SET total_count = (SELECT COUNT(*) FROM checkpoints)
WHERE id = 1;

DROP TRIGGER IF EXISTS checkpoint_total_rollup_insert;
DROP TRIGGER IF EXISTS checkpoint_total_rollup_delete;
DROP TRIGGER IF EXISTS checkpoint_meta_insert;
DROP TRIGGER IF EXISTS checkpoint_meta_delete;

CREATE TRIGGER checkpoint_meta_insert AFTER INSERT ON checkpoints
BEGIN
  UPDATE checkpoint_storage_totals
  SET total_count = total_count +
    CASE WHEN EXISTS (
      SELECT 1 FROM checkpoint_storage_meta WHERE checkpoint_id = NEW.id
    ) THEN 0 ELSE 1 END
  WHERE id = 1;
  INSERT INTO checkpoint_storage_meta
    (checkpoint_id,workspace_id,created_at,payload_bytes,compressed_v2)
  VALUES (NEW.id,NEW.workspace_id,NEW.created_at,length(CAST(NEW.files_json AS BLOB)),
    CASE WHEN substr(NEW.files_json,1,25) = 'lnwjing:checkpoint:v2:br:' THEN 1 ELSE 0 END)
  ON CONFLICT(checkpoint_id) DO UPDATE SET
    workspace_id = excluded.workspace_id,
    created_at = excluded.created_at,
    payload_bytes = excluded.payload_bytes,
    compressed_v2 = excluded.compressed_v2;
END;

CREATE TRIGGER checkpoint_meta_delete AFTER DELETE ON checkpoints
BEGIN
  DELETE FROM checkpoint_storage_meta WHERE checkpoint_id = OLD.id;
  UPDATE checkpoint_storage_totals SET total_count = total_count - 1 WHERE id = 1;
END;
`;
