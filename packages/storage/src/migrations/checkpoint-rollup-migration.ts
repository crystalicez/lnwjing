/**
 * Add a constant-cost checkpoint size / format rollup without touching
 * checkpoint payload BLOBs. Upgrading v026 reads metadata once (not files_json).
 * Every future metadata write updates the one-row aggregate transactionally.
 */
export const CHECKPOINT_ROLLUP_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS checkpoint_storage_totals (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  indexed_count INTEGER NOT NULL CHECK (indexed_count >= 0),
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  compressed_v2_count INTEGER NOT NULL CHECK (compressed_v2_count >= 0)
);
INSERT OR IGNORE INTO checkpoint_storage_totals (id, indexed_count, total_count, payload_bytes, compressed_v2_count)
  SELECT 1, COUNT(*), (SELECT COUNT(*) FROM checkpoints),
    COALESCE(SUM(payload_bytes), 0), COALESCE(SUM(compressed_v2), 0)
  FROM checkpoint_storage_meta;

CREATE TRIGGER IF NOT EXISTS checkpoint_meta_rollup_insert AFTER INSERT ON checkpoint_storage_meta
BEGIN
  UPDATE checkpoint_storage_totals
     SET indexed_count = indexed_count + 1,
         payload_bytes = payload_bytes + NEW.payload_bytes,
         compressed_v2_count = compressed_v2_count + NEW.compressed_v2
   WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS checkpoint_meta_rollup_update AFTER UPDATE ON checkpoint_storage_meta
BEGIN
  UPDATE checkpoint_storage_totals
     SET payload_bytes = payload_bytes + NEW.payload_bytes - OLD.payload_bytes,
         compressed_v2_count = compressed_v2_count + NEW.compressed_v2 - OLD.compressed_v2
   WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS checkpoint_meta_rollup_delete AFTER DELETE ON checkpoint_storage_meta
BEGIN
  UPDATE checkpoint_storage_totals
     SET indexed_count = indexed_count - 1,
         payload_bytes = payload_bytes - OLD.payload_bytes,
         compressed_v2_count = compressed_v2_count - OLD.compressed_v2
   WHERE id = 1;
END;

-- Keep the total checkpoint count without repeatedly scanning its B-tree.
-- On an upgrade only, the initial total is counted once in the seed above.
CREATE TRIGGER IF NOT EXISTS checkpoint_total_rollup_insert AFTER INSERT ON checkpoints
BEGIN
  UPDATE checkpoint_storage_totals SET total_count = total_count + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS checkpoint_total_rollup_delete AFTER DELETE ON checkpoints
BEGIN
  UPDATE checkpoint_storage_totals SET total_count = total_count - 1 WHERE id = 1;
END;

-- A v026 INSERT OR REPLACE could miss an implicit delete trigger for an orphan
-- metadata row. Use a true UPSERT so the rollup UPDATE trigger always sees the
-- old values, regardless of SQLite recursive_triggers settings.
DROP TRIGGER IF EXISTS checkpoint_meta_insert;
CREATE TRIGGER checkpoint_meta_insert AFTER INSERT ON checkpoints
BEGIN
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
`;
