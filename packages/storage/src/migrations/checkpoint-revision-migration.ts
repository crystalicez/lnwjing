/**
 * Constant-cost version stamp for every checkpoint-table write, including
 * raw SQL on this or another SQLite connection. Unrelated audit/goal/settings
 * writes do not invalidate a previously approved cleanup preview.
 */
export const CHECKPOINT_REVISION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS checkpoint_storage_revision (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO checkpoint_storage_revision (id, revision) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS checkpoint_revision_insert
AFTER INSERT ON checkpoints
BEGIN
  UPDATE checkpoint_storage_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS checkpoint_revision_update
AFTER UPDATE ON checkpoints
BEGIN
  UPDATE checkpoint_storage_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS checkpoint_revision_delete
AFTER DELETE ON checkpoints
BEGIN
  UPDATE checkpoint_storage_revision SET revision = revision + 1 WHERE id = 1;
END;
`;
