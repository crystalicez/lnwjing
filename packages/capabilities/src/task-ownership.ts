import { appError } from '@lnwjing/domain';

export const CAPABILITY_TASK_OWNER_METADATA_KEY = 'lnwjing.taskOwner.v1';

export const CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY = 'lnwjing.activeWorkspaceRoot.v1';

export interface CapabilityTaskOwner {
  readonly clientId: string;
  readonly sessionId: string;
  readonly workspaceId?: string;
  /** Immutable, server-verified goal binding (never taken from caller metadata). */
  readonly goalId?: string;
  /** SHA-256 of an optional client-held recovery token; never the token itself. */
  readonly recoveryHash?: string;
}

export function readCapabilityTaskOwner(input: unknown): CapabilityTaskOwner {
  if (!isRecord(input)) return legacyCapabilityTaskOwner();
  const metadata = isRecord(input.metadata) ? input.metadata : undefined;
  const value = metadata?.[CAPABILITY_TASK_OWNER_METADATA_KEY];
  if (!isRecord(value)) return legacyCapabilityTaskOwner();
  const clientId = boundedString(value.clientId);
  const sessionId = boundedString(value.sessionId);
  const workspaceId = boundedString(value.workspaceId);
  if (clientId === undefined || sessionId === undefined) return legacyCapabilityTaskOwner();
  const goalId = boundedString(value.goalId);
  const recoveryHash = typeof value.recoveryHash === 'string' && /^[a-f0-9]{64}$/.test(value.recoveryHash) ? value.recoveryHash : undefined;
  return { clientId, sessionId, ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(goalId === undefined ? {} : { goalId }), ...(recoveryHash === undefined ? {} : { recoveryHash }) };
}

export function readCapabilityActiveWorkspaceRoot(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const metadata = isRecord(input.metadata) ? input.metadata : undefined;
  const value = metadata?.[CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY];
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 32_768 ? trimmed : undefined;
}

export function legacyCapabilityTaskOwner(): CapabilityTaskOwner {
  return { clientId: 'legacy', sessionId: 'legacy' };
}

export function capabilityTaskOwnerMatches(stored: CapabilityTaskOwner, requester: CapabilityTaskOwner): boolean {
  if (stored.clientId !== requester.clientId) return false;
  if (requester.workspaceId !== undefined && stored.workspaceId !== requester.workspaceId) return false;
  // An opt-in secret protects even conversations sharing the same stateless
  // endpoint session. Do not turn it into a mere fallback after session match.
  if (stored.recoveryHash !== undefined) {
    return requester.workspaceId !== undefined && stored.workspaceId === requester.workspaceId
      && requester.recoveryHash === stored.recoveryHash;
  }
  if (stored.sessionId === requester.sessionId) return true;
  // Recovery is always explicit and workspace-scoped. A client ID alone is
  // insufficient: several AI conversations may share one transport client.
  if (requester.workspaceId === undefined || stored.workspaceId !== requester.workspaceId) return false;
  return stored.goalId !== undefined && requester.goalId === stored.goalId;
}

/** Only an exact same-client, same-workspace, unbound legacy record is eligible
 * for a one-shot host-approved observation. Never confer ownership. */
export function capabilityLegacyRecoveryMatches(stored: CapabilityTaskOwner, requester: CapabilityTaskOwner): boolean {
  return requester.workspaceId !== undefined && stored.workspaceId === requester.workspaceId
    && stored.clientId === requester.clientId && stored.clientId !== 'legacy'
    && stored.goalId === undefined && stored.recoveryHash === undefined;
}

export function capabilityTaskOwnerDenied(): ReturnType<typeof appError> & { details: { reason: string; recovery: string } } {
  return {
    ...appError('PERMISSION_DENIED', 'Task access requires the original session or a verified recovery proof'),
    details: { reason: 'task_recovery_or_owner_mismatch',
      recovery: 'Use the original goalLease or recovery_token if set at launch. For an unbound legacy task, ask the user before calling shell recover_legacy_result with exact workspaceId and task_id; Desktop approval is required. Do not relaunch an uncertain task.' },
  };
}

/** A trackedTasks entry is not a grant to adopt another goal's bound job. */
export function capabilityTaskGoalMatches(stored: CapabilityTaskOwner, clientId: string, workspaceId: string, goalId?: string): boolean {
  if (stored.clientId !== clientId || stored.workspaceId !== workspaceId) return false;
  if (stored.goalId !== undefined) return stored.goalId === goalId;
  // Preserve existing behavior only for legacy, non-proof-bound jobs.
  return stored.recoveryHash === undefined;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
