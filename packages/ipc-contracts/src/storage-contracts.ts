/** Storage maintenance is explicit-only. All sizes are SQLite byte counts. */
export interface StoragePolicy {
  readonly compressionEnabledOnNextStart: boolean;
  readonly automaticCheckpointRetention: boolean;
  readonly auditPruneWithoutBackup: boolean;
  readonly routineAuditRetentionDays: number;
}
export interface StorageOverview {
  readonly policy: StoragePolicy;
  readonly sqliteAllocatedBytes: number;
  readonly sqliteFreeBytes: number;
  readonly compactRecommended: boolean;
  readonly compactionRequiresOffline: true;
}
export interface SetStoragePolicyRequest {
  readonly userConfirmed: true;
  readonly compressionEnabledOnNextStart?: boolean;
  readonly automaticCheckpointRetention?: boolean;
  readonly auditPruneWithoutBackup?: boolean;
  readonly routineAuditRetentionDays?: number;
}
export interface SetStoragePolicyResult {
  readonly restartRequired: boolean;
  readonly overview: StorageOverview;
}
export interface CheckpointCleanupPreviewRequest {
  readonly maxBytes: number;
  readonly deleteBefore: string;
}
export interface CheckpointCleanupPreview {
  readonly totalBytes: number;
  readonly candidateBytes: number;
  readonly checkpointIds: readonly string[];
}
export interface ApplyCheckpointCleanupRequest extends CheckpointCleanupPreviewRequest {
  readonly userConfirmed: true;
}
export interface ApplyCheckpointCleanupResult {
  readonly deleted: number;
  readonly plannedBytes: number;
  readonly backupId: string | null;
}
export interface NativeStorageCleanupRequest {
  readonly category: 'tasks' | 'git' | 'processes';
  readonly userConfirmed: true;
  readonly maxDirectories?: number;
  readonly afterName?: string;
}
export interface NativeStorageCleanupResult {
  readonly inspected: number;
  readonly removedFiles: number;
  readonly nextCursor: string | null;
}
