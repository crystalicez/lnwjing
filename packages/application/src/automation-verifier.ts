import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  appError,
  automationShellRequestDigest,
  err,
  ok,
  type AutomationAttemptRecord,
  type AutomationMilestoneRecord,
  type AutomationVerificationEvidence,
  type AutomationVerificationRequirement,
  type AutomationVerificationStatus,
  type GoalLeaseProof,
  type Result,
  type WorkspaceId,
  type StoredAutomationRun,
} from '@lnwjing/domain';
import { WorkspacePathGuard, type Workspace } from '@lnwjing/workspace';
import type { AutomationDispatchRequest } from './automation-service.js';
import type { FileActor } from './file-service.js';

export type AutomationTaskEvidenceState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'termination_unverified'
  | 'unknown';

export interface AutomationTaskEvidenceSnapshot {
  readonly taskId: string;
  readonly ownerClientId: string;
  readonly workspaceId: string;
  readonly requestDigest: string;
  readonly state: AutomationTaskEvidenceState;
  readonly observedAt: string;
  readonly exitCode?: number;
}

export interface AutomationVerificationRuntimePort {
  readTask(actor: FileActor, request: AutomationDispatchRequest): Promise<Result<AutomationTaskEvidenceSnapshot>>;
  ensureTask(actor: FileActor, request: AutomationDispatchRequest): Promise<Result<AutomationTaskEvidenceSnapshot>>;
}

export interface VerifyAutomationMilestoneRequest {
  readonly stored: StoredAutomationRun;
  readonly milestone: AutomationMilestoneRecord;
  readonly attempt: AutomationAttemptRecord;
  readonly goalLease: GoalLeaseProof;
  readonly userConfirmed?: boolean;
}

export interface AutomationVerificationResult {
  readonly status: AutomationVerificationStatus;
  readonly evidence: readonly AutomationVerificationEvidence[];
}

export interface AutomationVerificationPort {
  verify(actor: FileActor, request: VerifyAutomationMilestoneRequest): Promise<Result<AutomationVerificationResult>>;
}

interface AutomationWorkspaceLookup {
  get(id: WorkspaceId): Promise<Workspace | null>;
}

const STATUS_PRIORITY: Readonly<Record<AutomationVerificationStatus, number>> = {
  verified: 0,
  pending: 1,
  unknown: 2,
  failed: 3,
};

export class AutomationVerifier implements AutomationVerificationPort {
  public constructor(
    private readonly workspaces: AutomationWorkspaceLookup,
    private readonly runtime: AutomationVerificationRuntimePort,
    private readonly pathGuard: WorkspacePathGuard = new WorkspacePathGuard(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async verify(
    actor: FileActor,
    request: VerifyAutomationMilestoneRequest,
  ): Promise<Result<AutomationVerificationResult>> {
    const binding = this.validateBinding(actor, request);
    if (!binding.ok) return binding;
    if (request.milestone.verification.length < 1 || request.milestone.verification.length > 16) {
      return err(appError('INVALID_INPUT', 'Automation verification requirements are invalid'));
    }

    const evidence: AutomationVerificationEvidence[] = [];
    for (const requirement of request.milestone.verification) {
      if (requirement.kind === 'command_exit') {
        evidence.push(await this.verifyCommandExit(actor, request, requirement));
      } else if (requirement.kind === 'file_sha256') {
        evidence.push(await this.verifyFile(request, requirement));
      } else {
        evidence.push(await this.verifyGitDiff(actor, request, requirement));
      }
    }
    return ok({ status: aggregateStatus(evidence), evidence });
  }

  private validateBinding(actor: FileActor, request: VerifyAutomationMilestoneRequest): Result<void> {
    const { run } = request.stored;
    if (actor.clientId.trim() !== run.ownerClientId) {
      return err(appError('PERMISSION_DENIED', 'Automation verifier actor does not own the run'));
    }
    if (request.goalLease.goalId !== run.goalId) {
      return err(appError('CONFLICT', 'Automation verifier goal lease does not match the run', true));
    }
    if (request.milestone.runId !== run.id
      || request.attempt.runId !== run.id
      || request.attempt.milestoneId !== request.milestone.id) {
      return err(appError('CONFLICT', 'Automation verification binding is inconsistent', true));
    }
    if (request.milestone.status !== 'verifying' || request.attempt.dispatchStatus !== 'terminal') {
      return err(appError('CONFLICT', 'Automation verification requires a terminal attempt in a verifying milestone', true));
    }
    return ok(undefined);
  }

  private async verifyCommandExit(
    actor: FileActor,
    request: VerifyAutomationMilestoneRequest,
    requirement: Extract<AutomationVerificationRequirement, { readonly kind: 'command_exit' }>,
  ): Promise<AutomationVerificationEvidence> {
    const dispatchRequest = originalDispatchRequest(request);
    const snapshot = await safelyReadTask(() => this.runtime.readTask(actor, dispatchRequest));
    return evidenceFromTask(
      requirement,
      snapshot,
      dispatchRequest,
      request.stored.run.ownerClientId,
      requirement.expectedExitCode,
      this.now,
    );
  }

  private async verifyFile(
    request: VerifyAutomationMilestoneRequest,
    requirement: Extract<AutomationVerificationRequirement, { readonly kind: 'file_sha256' }>,
  ): Promise<AutomationVerificationEvidence> {
    const observedAt = this.now().toISOString();
    const workspace = await this.workspaces.get(request.stored.run.workspaceId);
    if (workspace === null) return fileEvidence(requirement, 'unknown', observedAt, undefined, 'WORKSPACE_NOT_FOUND');
    const resolved = await this.pathGuard.resolveForRead(workspace, requirement.path);
    if (!resolved.ok) return fileEvidence(requirement, 'failed', observedAt, undefined, resolved.error.code);
    try {
      const target = resolved.value.realPath ?? resolved.value.absolutePath;
      const metadata = await stat(target);
      if (!metadata.isFile()) return fileEvidence(requirement, 'failed', observedAt, undefined, 'NOT_A_REGULAR_FILE');
      const digest = await sha256File(target);
      return fileEvidence(
        requirement,
        digest === requirement.expectedSha256 ? 'verified' : 'failed',
        observedAt,
        digest,
        digest === requirement.expectedSha256 ? 'digest_match' : 'digest_mismatch',
      );
    } catch {
      return fileEvidence(requirement, 'failed', observedAt, undefined, 'FILE_UNREADABLE');
    }
  }

  private async verifyGitDiff(
    actor: FileActor,
    request: VerifyAutomationMilestoneRequest,
    requirement: Extract<AutomationVerificationRequirement, { readonly kind: 'git_diff_check' }>,
  ): Promise<AutomationVerificationEvidence> {
    const workspace = await this.workspaces.get(request.stored.run.workspaceId);
    if (workspace === null) return genericEvidence(requirement, 'unknown', this.now().toISOString(), 'WORKSPACE_NOT_FOUND');
    const root = await this.pathGuard.resolveForRead(workspace, '.');
    if (!root.ok) return genericEvidence(requirement, 'failed', this.now().toISOString(), root.error.code);
    try {
      const metadata = await stat(root.value.realPath ?? root.value.absolutePath);
      if (!metadata.isDirectory()) return genericEvidence(requirement, 'failed', this.now().toISOString(), 'WORKSPACE_NOT_DIRECTORY');
    } catch {
      return genericEvidence(requirement, 'failed', this.now().toISOString(), 'WORKSPACE_UNREADABLE');
    }

    const taskId = verificationTaskId(request, requirement.id);
    const dispatch = {
      executable: 'git',
      arguments: ['diff', '--check'],
      cwd: root.value.realPath ?? root.value.absolutePath,
      timeoutSeconds: 60,
      maxOutputBytes: 4_096,
      includeStdout: false,
      includeStderr: false,
    } as const;
    const requestDigest = automationShellRequestDigest({
      taskId,
      ownerClientId: request.stored.run.ownerClientId,
      workspaceId: request.stored.run.workspaceId,
      dispatch,
    });
    const dispatchRequest: AutomationDispatchRequest = {
      context: {
        runId: request.stored.run.id,
        milestoneId: request.milestone.id,
        attemptId: `verification-${sha256(`${request.attempt.id}:${requirement.id}`).slice(0, 48)}`,
        taskId,
        requestDigest,
        goalId: request.stored.run.goalId,
        workspaceId: request.stored.run.workspaceId,
      },
      dispatch,
      role: request.milestone.role,
      cancelWithGoal: request.milestone.cancelWithGoal,
      goalLease: request.goalLease,
      ...(request.userConfirmed === undefined ? {} : { userConfirmed: request.userConfirmed }),
    };
    const snapshot = await safelyReadTask(() => this.runtime.ensureTask(actor, dispatchRequest));
    return evidenceFromTask(requirement, snapshot, dispatchRequest, request.stored.run.ownerClientId, 0, this.now);
  }
}

function originalDispatchRequest(request: VerifyAutomationMilestoneRequest): AutomationDispatchRequest {
  return {
    context: {
      runId: request.stored.run.id,
      milestoneId: request.milestone.id,
      attemptId: request.attempt.id,
      taskId: request.attempt.taskId,
      requestDigest: request.attempt.requestDigest,
      goalId: request.stored.run.goalId,
      workspaceId: request.stored.run.workspaceId,
    },
    dispatch: request.milestone.dispatch,
    role: request.milestone.role,
    cancelWithGoal: request.milestone.cancelWithGoal,
    goalLease: request.goalLease,
    ...(request.userConfirmed === undefined ? {} : { userConfirmed: request.userConfirmed }),
  };
}

type SafeTaskRead =
  | { readonly kind: 'snapshot'; readonly value: AutomationTaskEvidenceSnapshot }
  | { readonly kind: 'error'; readonly detail: string };

async function safelyReadTask(read: () => Promise<Result<AutomationTaskEvidenceSnapshot>>): Promise<SafeTaskRead> {
  try {
    const result = await read();
    if (!result.ok) return { kind: 'error', detail: result.error.code };
    return isTaskEvidenceSnapshot(result.value)
      ? { kind: 'snapshot', value: result.value }
      : { kind: 'error', detail: 'INVALID_TASK_SNAPSHOT' };
  } catch {
    return { kind: 'error', detail: 'TASK_OBSERVATION_FAILED' };
  }
}

function evidenceFromTask(
  requirement: Extract<AutomationVerificationRequirement, { readonly kind: 'command_exit' | 'git_diff_check' }>,
  read: SafeTaskRead,
  request: AutomationDispatchRequest,
  expectedOwnerClientId: string,
  expectedExitCode: number,
  now: () => Date,
): AutomationVerificationEvidence {
  if (read.kind === 'error') {
    return genericEvidence(requirement, 'unknown', now().toISOString(), read.detail);
  }
  const snapshot = read.value;
  const base = {
    requirementId: requirement.id,
    kind: requirement.kind,
    observedAt: snapshot.observedAt,
    observedDigest: snapshot.requestDigest,
    observedTaskId: snapshot.taskId,
    ...(snapshot.exitCode === undefined ? {} : { observedExitCode: snapshot.exitCode }),
  } as const;
  if (snapshot.taskId !== request.context.taskId
    || snapshot.ownerClientId !== expectedOwnerClientId
    || snapshot.workspaceId !== request.context.workspaceId
    || snapshot.requestDigest !== request.context.requestDigest) {
    return { ...base, status: 'unknown', detail: 'identity_mismatch' };
  }
  if (snapshot.state === 'running') return { ...base, status: 'pending', detail: 'running' };
  if (snapshot.state === 'unknown' || snapshot.state === 'termination_unverified') {
    return { ...base, status: 'unknown', detail: snapshot.state };
  }
  if (snapshot.state !== 'completed') return { ...base, status: 'failed', detail: snapshot.state };
  if (snapshot.exitCode === undefined) return { ...base, status: 'unknown', detail: 'exit_code_missing' };
  return snapshot.exitCode === expectedExitCode
    ? { ...base, status: 'verified', detail: 'completed' }
    : { ...base, status: 'failed', detail: 'unexpected_exit_code' };
}

function genericEvidence(
  requirement: AutomationVerificationRequirement,
  status: AutomationVerificationStatus,
  observedAt: string,
  detail: string,
): AutomationVerificationEvidence {
  return { requirementId: requirement.id, kind: requirement.kind, status, observedAt, detail };
}

function fileEvidence(
  requirement: Extract<AutomationVerificationRequirement, { readonly kind: 'file_sha256' }>,
  status: AutomationVerificationStatus,
  observedAt: string,
  observedDigest: string | undefined,
  detail: string,
): AutomationVerificationEvidence {
  return {
    requirementId: requirement.id,
    kind: requirement.kind,
    status,
    observedAt,
    ...(observedDigest === undefined ? {} : { observedDigest }),
    detail,
  };
}

function aggregateStatus(evidence: readonly AutomationVerificationEvidence[]): AutomationVerificationStatus {
  return evidence.reduce<AutomationVerificationStatus>(
    (current, entry) => STATUS_PRIORITY[entry.status] > STATUS_PRIORITY[current] ? entry.status : current,
    'verified',
  );
}

function isTaskEvidenceSnapshot(value: unknown): value is AutomationTaskEvidenceSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.taskId === 'string'
    && typeof value.ownerClientId === 'string'
    && typeof value.workspaceId === 'string'
    && typeof value.requestDigest === 'string'
    && /^[a-f0-9]{64}$/i.test(value.requestDigest)
    && (value.state === 'running'
      || value.state === 'completed'
      || value.state === 'failed'
      || value.state === 'cancelled'
      || value.state === 'timed_out'
      || value.state === 'termination_unverified'
      || value.state === 'unknown')
    && typeof value.observedAt === 'string'
    && Number.isFinite(Date.parse(value.observedAt))
    && (value.exitCode === undefined || Number.isInteger(value.exitCode));
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function verificationTaskId(request: VerifyAutomationMilestoneRequest, requirementId: string): string {
  return `automation-verify-${sha256(canonicalJson({
    version: 1,
    runId: request.stored.run.id,
    milestoneId: request.milestone.id,
    attemptId: request.attempt.id,
    requirementId,
  })).slice(0, 48)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
