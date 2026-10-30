import type {
  ApplyCheckpointCleanupRequest,
  CheckpointCleanupPreviewRequest,
  NativeStorageCleanupRequest,
  SetStoragePolicyRequest,
} from '@lnwjing/ipc-contracts';

type Input = Record<string, unknown>;
const MAX_BUDGET_BYTES = 1024 ** 4;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown, allowed: readonly string[]): Input {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid storage request');
  const raw = value as Input;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error('Unknown storage request field');
  return raw;
}

export function parseSetStoragePolicyRequest(payload: unknown): SetStoragePolicyRequest {
  const fields = ['userConfirmed', 'compressionEnabledOnNextStart', 'automaticCheckpointRetention', 'auditPruneWithoutBackup', 'routineAuditRetentionDays', 'checkpointCreationMode', 'sqliteHardLimitMiB'];
  const input = record(payload, fields);
  if (input.userConfirmed !== true) throw new Error('Storage policy change requires confirmation');
  for (const name of fields.slice(1, 4)) {
    if (input[name] !== undefined && typeof input[name] !== 'boolean') throw new Error('Invalid storage policy flag');
  }
  if (input.checkpointCreationMode !== undefined && input.checkpointCreationMode !== 'always' && input.checkpointCreationMode !== 'git-aware') {
    throw new Error('Invalid checkpoint creation mode');
  }
  if (input.sqliteHardLimitMiB !== undefined && (!Number.isSafeInteger(input.sqliteHardLimitMiB)
    || (input.sqliteHardLimitMiB as number) < 512 || (input.sqliteHardLimitMiB as number) > 16384)) {
    throw new Error('Invalid SQLite hard limit');
  }
  const days = input.routineAuditRetentionDays;
  if (days !== undefined && (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > 3650)) {
    throw new Error('Invalid routine audit retention');
  }
  return {
    userConfirmed: true,
    ...(input.checkpointCreationMode === undefined ? {} : { checkpointCreationMode: input.checkpointCreationMode as 'always' | 'git-aware' }),
    ...(input.sqliteHardLimitMiB === undefined ? {} : { sqliteHardLimitMiB: input.sqliteHardLimitMiB as number }),
    ...(input.compressionEnabledOnNextStart === undefined ? {} : { compressionEnabledOnNextStart: input.compressionEnabledOnNextStart as boolean }),
    ...(input.automaticCheckpointRetention === undefined ? {} : { automaticCheckpointRetention: input.automaticCheckpointRetention as boolean }),
    ...(input.auditPruneWithoutBackup === undefined ? {} : { auditPruneWithoutBackup: input.auditPruneWithoutBackup as boolean }),
    ...(days === undefined ? {} : { routineAuditRetentionDays: days as number }),
  };
}

export function parseCheckpointCleanupPreview(payload: unknown): CheckpointCleanupPreviewRequest {
  const input = record(payload, ['maxBytes', 'deleteBefore']);
  if (!Number.isSafeInteger(input.maxBytes) || (input.maxBytes as number) < 0 || (input.maxBytes as number) > MAX_BUDGET_BYTES) {
    throw new Error('Invalid checkpoint storage budget');
  }
  const date = input.deleteBefore;
  if (typeof date !== 'string' || !ISO_UTC.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) {
    throw new Error('Invalid checkpoint retention date');
  }
  return { maxBytes: input.maxBytes as number, deleteBefore: date };
}

export function parseApplyCheckpointCleanup(payload: unknown): ApplyCheckpointCleanupRequest {
  const input = record(payload, ['maxBytes', 'deleteBefore', 'userConfirmed', 'expectedPreviewToken']);
  if (input.userConfirmed !== true) throw new Error('Checkpoint cleanup requires confirmation');
  if (typeof input.expectedPreviewToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedPreviewToken)) throw new Error('Checkpoint cleanup requires valid preview');
  return { ...parseCheckpointCleanupPreview({ maxBytes: input.maxBytes, deleteBefore: input.deleteBefore }), userConfirmed: true, expectedPreviewToken: input.expectedPreviewToken };
}

export function parseNativeStorageCleanup(payload: unknown): NativeStorageCleanupRequest {
  const input = record(payload, ['category', 'userConfirmed', 'maxDirectories', 'afterName']);
  if (input.userConfirmed !== true) throw new Error('Native cleanup requires confirmation');
  if (input.category !== 'tasks' && input.category !== 'git' && input.category !== 'processes') throw new Error('Invalid native cleanup category');
  if (input.maxDirectories !== undefined && (!Number.isSafeInteger(input.maxDirectories) || (input.maxDirectories as number) < 1 || (input.maxDirectories as number) > 128)) {
    throw new Error('Invalid native cleanup batch size');
  }
  if (input.afterName !== undefined && (typeof input.afterName !== 'string' || !UUID.test(input.afterName))) {
    throw new Error('Invalid native cleanup cursor');
  }
  return {
    category: input.category, userConfirmed: true,
    ...(input.maxDirectories === undefined ? {} : { maxDirectories: input.maxDirectories as number }),
    ...(input.afterName === undefined ? {} : { afterName: input.afterName as string }),
  };
}
