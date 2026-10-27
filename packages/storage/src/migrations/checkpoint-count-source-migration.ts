/**
 * Repair legacy rollup drift without touching checkpoint payloads. The
 * repository reads its authoritative checkpoint count from the primary-key
 * index, because INSERT OR REPLACE can bypass implicit DELETE triggers.
 *
 * Retain the historical total_count column and triggers for compatibility
 * with older executables while current readers ignore that unsafe counter.
 */
export const CHECKPOINT_COUNT_SOURCE_MIGRATION_SQL = `
UPDATE checkpoint_storage_totals
SET total_count = (SELECT COUNT(*) FROM checkpoints)
WHERE id = 1;
`;
