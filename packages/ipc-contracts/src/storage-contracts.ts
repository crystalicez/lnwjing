/** Storage maintenance and recovery policies for the current profile. */
export interface StoragePolicy {
  readonly checkpointCreationMode: 'always' | 'git-aware';
  /** Maximum allocated main-database size, excluding WAL and backups. */
  readonly sqliteHardLimitMiB: number;
  readonly compressionEnabledOnNextStart: boolean;
  readonly automaticCheckpointRetention: boolean;
  readonly auditPruneWithoutBackup: boolean;
  /** Permit emergency expiration of eligible routine reads and old file Undo. */
  readonly automaticHardLimitRecovery: boolean;
  readonly routineAuditRetentionDays: number;
}
/** Read-only, on-demand logical-file inventory of the owned AppData profile.
 * This is NOT a hard disk quota; outside-profile paths and racing writers are
 * not included, and reclaimability still requires a policy/eligibility check. */
export interface ProfileStorageInventory {
  readonly scope: 'profile';
  readonly scannedAt: string;
  readonly logicalBytes: number;
  readonly allocatedBytes: number | null;
  readonly files: number;
  readonly directories: number;
  readonly visitedEntries: number;
  readonly skippedLinks: number;
  readonly unreadableEntries: number;
  readonly incomplete: boolean;
  readonly reason: 'complete' | 'entry-limit' | 'time-limit' | 'unreadable' | 'links-or-mounts';
  readonly categories: readonly {
    readonly id: string;
    readonly retention: 'protected' | 'managed' | 'rebuildable' | 'unknown';
    readonly logicalBytes: number;
    readonly files: number;
    readonly directories: number;
  }[];
  readonly potentiallyReclaimableLogicalBytes: number;
  readonly rebuildableLogicalBytes: number;
}
export interface StorageOverview {
  readonly policy: StoragePolicy;
  readonly sqliteAllocatedBytes: number;
  readonly sqliteFreeBytes: number;
  /** Actual WAL file bytes; outside main DB max_page_count. */
  readonly sqliteWalBytes: number;
  readonly sqliteEffectiveHardLimitBytes: number;
  readonly sqliteOverBudget: boolean;
  readonly sqlitePressureHigh: boolean;
  readonly hardLimitRecovery?: {
    readonly state: 'idle' | 'running' | 'reclaimed' | 'waiting' | 'blocked' | 'failed';
    readonly lastRunAt?: string;
    readonly deletedRoutineReads: number;
    /** Expired file checkpoints; the original one-click Undo is no longer available. */
    readonly deletedCheckpoints?: number;
    /** Reusable SQLite space; not physical disk bytes returned. */
    readonly reclaimedBytes: number;
  };
  /** Bounded automatic daily backup budget; manual recovery snapshots are explicit. */
  readonly automaticBackupBudget?: {
    readonly budgetBytes: number;
    readonly usedBytes: number;
    readonly projectedNextBytes: number;
    readonly blocked: boolean;
  };
  readonly automaticBackupBudgetUnknown?: boolean;
  /** Opt-in, profile-only app-managed reservation coverage. NOT an OS hard cap. */
  readonly globalQuota?: {
    readonly limitBytes: number;
    readonly criticalReserveBytes: number;
    readonly reservedBytes: number;
    readonly activeReservations: number;
    /** OS free bytes of the entire underlying volume, not lnwjing-only usage. */
    readonly volumeFreeBytes: number;
    /** Free bytes after in-flight cooperative reservations and the critical safety buffer. */
    readonly volumeUnreservedBytes: number;
    readonly enforcement: 'partial';
  };
  readonly compactRecommended: boolean;
  readonly hasCompressedV2?: boolean;
  readonly checkpointMetadataIncomplete?: boolean;
  /** Bounded metadata only: legacy checkpoints may be partially indexed. */
  readonly checkpointStorage?: {
    readonly indexed: number;
    readonly total: number;
    /** Sum of indexed checkpoint payloads, only authoritative when complete. */
    readonly payloadBytes?: number;
  };
  readonly compactionRequiresOffline: true;
  readonly usageCategories?: readonly { readonly category: string; readonly bytes: number; readonly inspectedEntries: number; readonly truncated: boolean }[];
}
export interface SetStoragePolicyRequest {
  readonly userConfirmed: true;
  readonly checkpointCreationMode?: 'always' | 'git-aware';
  readonly sqliteHardLimitMiB?: number;
  /** Zero disables the opt-in profile quota; nonzero values are MiB. */
  readonly globalQuotaMiB?: number;
  readonly compressionEnabledOnNextStart?: boolean;
  readonly automaticCheckpointRetention?: boolean;
  readonly auditPruneWithoutBackup?: boolean;
  readonly automaticHardLimitRecovery?: boolean;
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
  readonly previewToken: string;
}
export interface ApplyCheckpointCleanupRequest extends CheckpointCleanupPreviewRequest {
  readonly userConfirmed: true;
  readonly expectedPreviewToken: string;
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
