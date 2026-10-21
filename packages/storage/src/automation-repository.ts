import { createHash } from 'node:crypto';
import {
  MAX_AUTOMATION_EVENTS_PER_RUN,
  appError,
  automationAttemptIdentityEquals,
  err,
  ok,
  transitionAutomationMilestone,
  transitionAutomationRun,
  validAutomationAttemptOrdinal,
  validateAutomationPlan,
  type AutomationAttemptRecord,
  type AutomationDispatchStatus,
  type AutomationEventRecord,
  type AutomationMilestoneRecord,
  type AutomationMilestoneStatus,
  type AutomationRunStatus,
  type AutomationVerificationEvidence,
  type AutomationEventInput,
  type CreateAutomationRunRequest,
  type ReserveAutomationAttemptRequest,
  type RecordAutomationVerificationRequest,
  type StoredAutomationRun,
  type TransitionAutomationMilestoneRequest,
  type TransitionAutomationRunRequest,
  type UpdateAutomationAttemptRequest,
  type Result,
} from '@lnwjing/domain';
import type { SqliteDatabase } from './database.js';

type MutationScope =
  | TransitionAutomationRunRequest
  | TransitionAutomationMilestoneRequest
  | ReserveAutomationAttemptRequest
  | UpdateAutomationAttemptRequest
  | RecordAutomationVerificationRequest;

export type {
  AutomationEventInput,
  CreateAutomationRunRequest,
  ReserveAutomationAttemptRequest,
  RecordAutomationVerificationRequest,
  StoredAutomationRun,
  TransitionAutomationMilestoneRequest,
  TransitionAutomationRunRequest,
  UpdateAutomationAttemptRequest,
} from '@lnwjing/domain';

interface RunRow {
  readonly id: string;
  readonly goal_id: string;
  readonly workspace_id: string;
  readonly owner_client_id: string;
  readonly status: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly terminal_at: string | null;
}

interface MilestoneRow {
  readonly run_id: string;
  readonly milestone_id: string;
  readonly position: number;
  readonly title: string;
  readonly goal_step_id: string;
  readonly depends_on_json: string;
  readonly provider: string;
  readonly role: string;
  readonly cancel_with_goal: number;
  readonly dispatch_json: string;
  readonly dispatch_digest: string;
  readonly verification_json: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AttemptRow {
  readonly id: string;
  readonly run_id: string;
  readonly milestone_id: string;
  readonly ordinal: number;
  readonly provider: string;
  readonly dispatch_status: string;
  readonly durable_task_id: string;
  readonly request_digest: string;
  readonly evidence_json: string;
  readonly terminal_state: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface EventRow {
  readonly run_id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly milestone_id: string | null;
  readonly attempt_id: string | null;
  readonly payload_json: string;
  readonly created_at: string;
}

const RUN_STATUSES: ReadonlySet<string> = new Set(['active', 'paused', 'blocked', 'completing', 'completed', 'failed', 'cancelled']);
const MILESTONE_STATUSES: ReadonlySet<string> = new Set(['pending', 'ready', 'dispatching', 'running', 'verifying', 'completed', 'blocked', 'failed', 'cancelled']);
const DISPATCH_STATUSES: ReadonlySet<string> = new Set(['reserved', 'launched', 'dispatched_unresolved', 'terminal']);
const DISPATCH_TRANSITIONS: Readonly<Record<AutomationDispatchStatus, readonly AutomationDispatchStatus[]>> = {
  reserved: ['launched', 'dispatched_unresolved', 'terminal'],
  launched: ['dispatched_unresolved', 'terminal'],
  dispatched_unresolved: ['launched', 'terminal'],
  terminal: [],
};

export class SqliteAutomationRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public create(input: CreateAutomationRunRequest): Result<StoredAutomationRun> {
    const plan = validateAutomationPlan(input.plan);
    if (!plan.ok) return plan;
    for (const milestone of plan.value.milestones) {
      if (commandMayContainSecret(milestone.dispatch.arguments)) {
        return err(appError('INVALID_INPUT', `Automation milestone ${milestone.id} command may contain a secret`));
      }
    }
    const db = this.database.connection;
    db.exec('BEGIN IMMEDIATE;');
    try {
      const goal = db.prepare('SELECT id FROM goals WHERE id = ? AND workspace_id = ? AND owner_client_id = ?')
        .get(input.goalId, input.workspaceId, input.ownerClientId);
      if (goal === undefined) throw new RepositoryNotFoundError('Root goal was not found for this owner and workspace');
      db.prepare(`INSERT INTO automation_runs
        (id, goal_id, workspace_id, owner_client_id, status, revision, created_at, updated_at, terminal_at)
        VALUES (?, ?, ?, ?, 'active', 0, ?, ?, NULL)`)
        .run(input.id, input.goalId, input.workspaceId, input.ownerClientId, input.createdAt, input.createdAt);
      const insertMilestone = db.prepare(`INSERT INTO automation_milestones
        (run_id, milestone_id, position, title, goal_step_id, depends_on_json, provider, role, cancel_with_goal,
         dispatch_json, dispatch_digest, verification_json, status, attempt_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'shell', ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`);
      plan.value.milestones.forEach((milestone, position) => {
        const dispatchJson = canonicalJson(milestone.dispatch);
        insertMilestone.run(
          input.id,
          milestone.id,
          position,
          milestone.title,
          milestone.goalStepId,
          JSON.stringify(milestone.dependsOn),
          milestone.role,
          milestone.cancelWithGoal ? 1 : 0,
          dispatchJson,
          sha256(dispatchJson),
          JSON.stringify(milestone.verification),
          input.createdAt,
          input.createdAt,
        );
      });
      this.insertEvent(input.id, 0, input.createdAt, {
        kind: 'run_created',
        payload: { milestoneCount: plan.value.milestones.length },
      });
      db.exec('COMMIT;');
      return this.requireStored(input.id, input.ownerClientId, input.workspaceId);
    } catch (error: unknown) {
      safeRollback(db);
      return repositoryError(error, 'Automation run could not be created');
    }
  }

  public getOwned(runId: string, ownerClientId: string, workspaceId: string): Result<StoredAutomationRun | undefined> {
    const row = this.selectOwnedRun(runId, ownerClientId, workspaceId);
    if (row === undefined) return ok(undefined);
    try {
      return ok(this.fromRow(row));
    } catch (error: unknown) {
      return err(appError('INTERNAL_ERROR', error instanceof Error ? error.message : 'Stored automation run is corrupt', true));
    }
  }

  public findActiveForGoal(goalId: string, ownerClientId: string, workspaceId: string): Result<StoredAutomationRun | undefined> {
    const row = this.database.connection.prepare(`SELECT * FROM automation_runs
      WHERE goal_id = ? AND owner_client_id = ? AND workspace_id = ?
        AND status IN ('active','paused','blocked','completing')`)
      .get(goalId, ownerClientId, workspaceId) as RunRow | undefined;
    if (row === undefined) return ok(undefined);
    try {
      return ok(this.fromRow(row));
    } catch (error: unknown) {
      return err(appError('INTERNAL_ERROR', error instanceof Error ? error.message : 'Stored automation run is corrupt', true));
    }
  }

  public transitionRun(input: TransitionAutomationRunRequest): Result<StoredAutomationRun> {
    return this.mutate(input, (run) => {
      const transition = transitionAutomationRun(asRunStatus(run.status), input.status);
      if (!transition.ok) throw new RepositoryConflictError(transition.error.message);
      return input.status;
    });
  }

  public transitionMilestone(input: TransitionAutomationMilestoneRequest): Result<StoredAutomationRun> {
    return this.mutate(input, (run) => {
      const milestone = this.requireMilestone(input.runId, input.milestoneId);
      const transition = transitionAutomationMilestone(asMilestoneStatus(milestone.status), input.status);
      if (!transition.ok) throw new RepositoryConflictError(transition.error.message);
      this.database.connection.prepare(`UPDATE automation_milestones SET status = ?, updated_at = ?
        WHERE run_id = ? AND milestone_id = ?`)
        .run(input.status, input.updatedAt, input.runId, input.milestoneId);
      return asRunStatus(run.status);
    });
  }

  public reserveAttempt(input: ReserveAutomationAttemptRequest): Result<StoredAutomationRun> {
    if (!validAutomationAttemptOrdinal(input.ordinal)
      || !isBoundedId(input.attemptId)
      || !isBoundedId(input.taskId)
      || !/^[a-f0-9]{64}$/i.test(input.requestDigest)) {
      return err(appError('INVALID_INPUT', 'Automation attempt reservation is invalid'));
    }
    return this.mutate(input, (run) => {
      const milestone = this.requireMilestone(input.runId, input.milestoneId);
      const transition = transitionAutomationMilestone(asMilestoneStatus(milestone.status), 'dispatching');
      if (!transition.ok) throw new RepositoryConflictError(transition.error.message);
      if (input.ordinal !== milestone.attempt_count + 1) throw new RepositoryConflictError('Automation attempt ordinal is not the next immutable ordinal');
      const existing = this.database.connection.prepare('SELECT * FROM automation_attempts WHERE id = ?').get(input.attemptId) as AttemptRow | undefined;
      if (existing !== undefined) {
        const same = automationAttemptIdentityEquals(
          { id: existing.id, milestoneId: existing.milestone_id, ordinal: existing.ordinal },
          { id: input.attemptId, milestoneId: input.milestoneId, ordinal: input.ordinal },
        );
        throw new RepositoryConflictError(same ? 'Automation attempt is already reserved' : 'Automation attempt identity is immutable');
      }
      this.database.connection.prepare(`INSERT INTO automation_attempts
        (id, run_id, milestone_id, ordinal, provider, dispatch_status, durable_task_id, request_digest, evidence_json, terminal_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'shell', 'reserved', ?, ?, '[]', NULL, ?, ?)`)
        .run(input.attemptId, input.runId, input.milestoneId, input.ordinal, input.taskId, input.requestDigest.toLowerCase(), input.updatedAt, input.updatedAt);
      this.database.connection.prepare(`UPDATE automation_milestones SET status = 'dispatching', attempt_count = ?, updated_at = ?
        WHERE run_id = ? AND milestone_id = ?`)
        .run(input.ordinal, input.updatedAt, input.runId, input.milestoneId);
      return asRunStatus(run.status);
    });
  }

  public updateAttempt(input: UpdateAutomationAttemptRequest): Result<StoredAutomationRun> {
    return this.mutate(input, (run) => {
      const attempt = this.database.connection.prepare('SELECT * FROM automation_attempts WHERE id = ? AND run_id = ?')
        .get(input.attemptId, input.runId) as AttemptRow | undefined;
      if (attempt === undefined) throw new RepositoryNotFoundError('Automation attempt was not found');
      const currentStatus = asDispatchStatus(attempt.dispatch_status);
      if (!DISPATCH_TRANSITIONS[currentStatus].includes(input.dispatchStatus)) {
        throw new RepositoryConflictError(`Automation dispatch cannot transition from ${currentStatus} to ${input.dispatchStatus}`);
      }
      if (input.milestoneStatus !== undefined) {
        const milestone = this.requireMilestone(input.runId, attempt.milestone_id);
        const transition = transitionAutomationMilestone(asMilestoneStatus(milestone.status), input.milestoneStatus);
        if (!transition.ok) throw new RepositoryConflictError(transition.error.message);
        this.database.connection.prepare(`UPDATE automation_milestones SET status = ?, updated_at = ?
          WHERE run_id = ? AND milestone_id = ?`)
          .run(input.milestoneStatus, input.updatedAt, input.runId, attempt.milestone_id);
      }
      const evidenceJson = input.evidence === undefined ? attempt.evidence_json : JSON.stringify(input.evidence.map(sanitizeEvidence));
      this.database.connection.prepare(`UPDATE automation_attempts
        SET dispatch_status = ?, evidence_json = ?, terminal_state = ?, updated_at = ? WHERE id = ? AND run_id = ?`)
        .run(
          input.dispatchStatus,
          evidenceJson,
          input.terminalState === undefined ? attempt.terminal_state : input.terminalState,
          input.updatedAt,
          input.attemptId,
          input.runId,
        );
      return asRunStatus(run.status);
    });
  }

  public recordVerification(input: RecordAutomationVerificationRequest): Result<StoredAutomationRun> {
    if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 16) {
      return err(appError('INVALID_INPUT', 'Automation verification evidence is invalid'));
    }
    return this.mutate(input, (run) => {
      const attempt = this.database.connection.prepare('SELECT * FROM automation_attempts WHERE id = ? AND run_id = ?')
        .get(input.attemptId, input.runId) as AttemptRow | undefined;
      if (attempt === undefined) throw new RepositoryNotFoundError('Automation attempt was not found');
      if (asDispatchStatus(attempt.dispatch_status) !== 'terminal') {
        throw new RepositoryConflictError('Automation verification requires a terminal dispatch');
      }
      if (input.milestoneStatus !== undefined) {
        const milestone = this.requireMilestone(input.runId, attempt.milestone_id);
        const transition = transitionAutomationMilestone(asMilestoneStatus(milestone.status), input.milestoneStatus);
        if (!transition.ok) throw new RepositoryConflictError(transition.error.message);
        this.database.connection.prepare(`UPDATE automation_milestones SET status = ?, updated_at = ?
          WHERE run_id = ? AND milestone_id = ?`)
          .run(input.milestoneStatus, input.updatedAt, input.runId, attempt.milestone_id);
      } else {
        const milestone = this.requireMilestone(input.runId, attempt.milestone_id);
        if (asMilestoneStatus(milestone.status) !== 'verifying') {
          throw new RepositoryConflictError('Pending automation evidence requires a verifying milestone');
        }
      }
      this.database.connection.prepare(`UPDATE automation_attempts SET evidence_json = ?, updated_at = ?
        WHERE id = ? AND run_id = ?`)
        .run(JSON.stringify(input.evidence.map(sanitizeEvidence)), input.updatedAt, input.attemptId, input.runId);
      return asRunStatus(run.status);
    });
  }

  public listEvents(
    runId: string,
    ownerClientId: string,
    workspaceId: string,
    options: { readonly afterSequence?: number; readonly limit: number },
  ): Result<{ readonly events: readonly AutomationEventRecord[]; readonly nextSequence?: number }> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200
      || (options.afterSequence !== undefined && (!Number.isInteger(options.afterSequence) || options.afterSequence < 0))) {
      return err(appError('INVALID_INPUT', 'Automation event page is invalid'));
    }
    if (this.selectOwnedRun(runId, ownerClientId, workspaceId) === undefined) return ok({ events: [] });
    try {
      const afterSequence = options.afterSequence ?? -1;
      const rows = this.database.connection.prepare(`SELECT * FROM automation_events
        WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`)
        .all(runId, afterSequence, options.limit + 1) as unknown as EventRow[];
      const hasMore = rows.length > options.limit;
      const pageRows = rows.slice(0, options.limit);
      const events = pageRows.map((row) => decodeEvent(row));
      const last = events.at(-1);
      return ok({ events, ...(hasMore && last !== undefined ? { nextSequence: last.sequence } : {}) });
    } catch (error: unknown) {
      return err(appError('INTERNAL_ERROR', error instanceof Error ? error.message : 'Stored automation events are corrupt', true));
    }
  }

  private mutate(
    input: MutationScope,
    apply: (run: RunRow) => AutomationRunStatus,
  ): Result<StoredAutomationRun> {
    const event = sanitizeEvent(input.event);
    if (!event.ok) return event;
    const db = this.database.connection;
    db.exec('BEGIN IMMEDIATE;');
    try {
      const run = this.selectOwnedRun(input.runId, input.ownerClientId, input.workspaceId);
      if (run === undefined) throw new RepositoryNotFoundError('Automation run was not found');
      if (run.revision !== input.expectedRevision) throw new RepositoryConflictError('Automation run revision changed');
      if (input.expectedRevision + 1 >= MAX_AUTOMATION_EVENTS_PER_RUN) throw new RepositoryConflictError('Automation event limit reached');
      const nextStatus = apply(run);
      const nextRevision = input.expectedRevision + 1;
      const terminalAt = isTerminalRunStatus(nextStatus) ? input.updatedAt : null;
      const changed = db.prepare(`UPDATE automation_runs SET status = ?, revision = ?, updated_at = ?, terminal_at = ?
        WHERE id = ? AND owner_client_id = ? AND workspace_id = ? AND revision = ?`)
        .run(nextStatus, nextRevision, input.updatedAt, terminalAt, input.runId, input.ownerClientId, input.workspaceId, input.expectedRevision);
      if (Number(changed.changes) !== 1) throw new RepositoryConflictError('Automation run revision changed');
      this.insertEvent(input.runId, nextRevision, input.updatedAt, event.value);
      db.exec('COMMIT;');
      return this.requireStored(input.runId, input.ownerClientId, input.workspaceId);
    } catch (error: unknown) {
      safeRollback(db);
      return repositoryError(error, 'Automation mutation failed');
    }
  }

  private insertEvent(runId: string, sequence: number, createdAt: string, event: AutomationEventInput): void {
    const sanitized = sanitizeEvent(event);
    if (!sanitized.ok) throw new RepositoryCorruptError(sanitized.error.message);
    const payloadJson = JSON.stringify(sanitized.value.payload);
    this.database.connection.prepare(`INSERT INTO automation_events
      (run_id, sequence, kind, milestone_id, attempt_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        runId,
        sequence,
        sanitized.value.kind,
        sanitized.value.milestoneId ?? null,
        sanitized.value.attemptId ?? null,
        payloadJson,
        createdAt,
      );
  }

  private selectOwnedRun(runId: string, ownerClientId: string, workspaceId: string): RunRow | undefined {
    return this.database.connection.prepare(`SELECT * FROM automation_runs
      WHERE id = ? AND owner_client_id = ? AND workspace_id = ?`)
      .get(runId, ownerClientId, workspaceId) as RunRow | undefined;
  }

  private requireMilestone(runId: string, milestoneId: string): MilestoneRow {
    const row = this.database.connection.prepare(`SELECT * FROM automation_milestones
      WHERE run_id = ? AND milestone_id = ?`).get(runId, milestoneId) as MilestoneRow | undefined;
    if (row === undefined) throw new RepositoryNotFoundError('Automation milestone was not found');
    return row;
  }

  private requireStored(runId: string, ownerClientId: string, workspaceId: string): Result<StoredAutomationRun> {
    const stored = this.getOwned(runId, ownerClientId, workspaceId);
    if (!stored.ok) return stored;
    return stored.value === undefined
      ? err(appError('INTERNAL_ERROR', 'Automation run disappeared after mutation', true))
      : ok(stored.value);
  }

  private fromRow(row: RunRow): StoredAutomationRun {
    const status = asRunStatus(row.status);
    if (!Number.isInteger(row.revision) || row.revision < 0) throw new RepositoryCorruptError('Stored automation revision is invalid');
    const milestoneRows = this.database.connection.prepare('SELECT * FROM automation_milestones WHERE run_id = ? ORDER BY position, milestone_id')
      .all(row.id) as unknown as MilestoneRow[];
    const rawMilestones = milestoneRows.map((milestone) => ({
      id: milestone.milestone_id,
      title: milestone.title,
      goalStepId: milestone.goal_step_id,
      dependsOn: parseJson(milestone.depends_on_json),
      provider: milestone.provider,
      role: milestone.role,
      cancelWithGoal: milestone.cancel_with_goal === 1,
      dispatch: parseJson(milestone.dispatch_json),
      verification: parseJson(milestone.verification_json),
    }));
    const plan = validateAutomationPlan({ milestones: rawMilestones });
    if (!plan.ok) throw new RepositoryCorruptError(`Stored automation plan is corrupt: ${plan.error.message}`);
    const definitions = new Map(plan.value.milestones.map((milestone) => [milestone.id, milestone]));
    const milestones = milestoneRows.map((milestone): AutomationMilestoneRecord => {
      const definition = definitions.get(milestone.milestone_id);
      if (definition === undefined || sha256(canonicalJson(definition.dispatch)) !== milestone.dispatch_digest) {
        throw new RepositoryCorruptError('Stored automation dispatch digest does not match');
      }
      return {
        ...definition,
        runId: row.id,
        position: milestone.position,
        status: asMilestoneStatus(milestone.status),
        attemptCount: milestone.attempt_count,
        createdAt: milestone.created_at,
        updatedAt: milestone.updated_at,
      };
    });
    const attemptRows = this.database.connection.prepare('SELECT * FROM automation_attempts WHERE run_id = ? ORDER BY milestone_id, ordinal')
      .all(row.id) as unknown as AttemptRow[];
    const attempts = attemptRows.map((attempt): AutomationAttemptRecord => {
      if (!validAutomationAttemptOrdinal(attempt.ordinal)
        || !/^[a-f0-9]{64}$/i.test(attempt.request_digest)
        || attempt.provider !== 'shell') throw new RepositoryCorruptError('Stored automation attempt is corrupt');
      const evidence = parseEvidenceArray(attempt.evidence_json);
      return {
        id: attempt.id,
        runId: attempt.run_id,
        milestoneId: attempt.milestone_id,
        ordinal: attempt.ordinal,
        provider: 'shell',
        dispatchStatus: asDispatchStatus(attempt.dispatch_status),
        taskId: attempt.durable_task_id,
        requestDigest: attempt.request_digest,
        evidence,
        ...(attempt.terminal_state === null ? {} : { terminalState: attempt.terminal_state }),
        createdAt: attempt.created_at,
        updatedAt: attempt.updated_at,
      };
    });
    return {
      run: {
        id: row.id,
        goalId: row.goal_id,
        workspaceId: row.workspace_id,
        ownerClientId: row.owner_client_id,
        status,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      milestones,
      attempts,
    };
  }
}

function sanitizeEvent(event: AutomationEventInput): Result<AutomationEventInput> {
  if (!isBoundedId(event.kind) || (event.milestoneId !== undefined && !isBoundedId(event.milestoneId))
    || (event.attemptId !== undefined && !isBoundedId(event.attemptId))) {
    return err(appError('INVALID_INPUT', 'Automation event identity is invalid'));
  }
  const payload = sanitizeValue(event.payload, 0);
  if (!isRecord(payload)) return err(appError('INVALID_INPUT', 'Automation event payload is invalid'));
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 16_384) return err(appError('INVALID_INPUT', 'Automation event payload is too large'));
  return ok({
    kind: event.kind,
    ...(event.milestoneId === undefined ? {} : { milestoneId: event.milestoneId }),
    ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
    payload,
  });
}

function sanitizeValue(value: unknown, depth: number, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value).slice(0, 1_024);
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => sanitizeValue(entry, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 64).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeValue(entryValue, depth + 1, entryKey),
    ]));
  }
  return String(value).slice(0, 1_024);
}

const SENSITIVE_KEY = /(authorization|token|secret|password|api[_-]?key|private[_-]?key|lease|approval|stdout|stderr|raw[_-]?output)/i;

function redactText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
}

function sanitizeEvidence(evidence: AutomationVerificationEvidence): AutomationVerificationEvidence {
  return {
    requirementId: evidence.requirementId,
    kind: evidence.kind,
    status: evidence.status,
    observedAt: evidence.observedAt,
    ...(evidence.observedDigest === undefined ? {} : { observedDigest: evidence.observedDigest }),
    ...(evidence.observedTaskId === undefined ? {} : { observedTaskId: evidence.observedTaskId }),
    ...(evidence.observedExitCode === undefined ? {} : { observedExitCode: evidence.observedExitCode }),
    ...(evidence.detail === undefined ? {} : { detail: redactText(evidence.detail).slice(0, 1_024) }),
  };
}

function parseEvidenceArray(value: string): readonly AutomationVerificationEvidence[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) throw new RepositoryCorruptError('Stored automation evidence is corrupt');
  return parsed.map((entry): AutomationVerificationEvidence => {
    if (!isRecord(entry)
      || !isBoundedId(entry.requirementId)
      || (entry.kind !== 'command_exit' && entry.kind !== 'file_sha256' && entry.kind !== 'git_diff_check')
      || (entry.status !== 'pending' && entry.status !== 'verified' && entry.status !== 'failed' && entry.status !== 'unknown')
      || typeof entry.observedAt !== 'string'
      || !Number.isFinite(Date.parse(entry.observedAt))) {
      throw new RepositoryCorruptError('Stored automation evidence is corrupt');
    }
    return {
      requirementId: entry.requirementId,
      kind: entry.kind,
      status: entry.status,
      observedAt: entry.observedAt,
      ...(typeof entry.observedDigest === 'string' ? { observedDigest: entry.observedDigest } : {}),
      ...(typeof entry.observedTaskId === 'string' ? { observedTaskId: entry.observedTaskId } : {}),
      ...(typeof entry.observedExitCode === 'number' ? { observedExitCode: entry.observedExitCode } : {}),
      ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {}),
    };
  });
}

function decodeEvent(row: EventRow): AutomationEventRecord {
  const payload = parseJson(row.payload_json);
  if (!isRecord(payload)) throw new RepositoryCorruptError('Stored automation event payload is corrupt');
  return {
    sequence: row.sequence,
    runId: row.run_id,
    kind: row.kind,
    ...(row.milestone_id === null ? {} : { milestoneId: row.milestone_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    payload,
    createdAt: row.created_at,
  };
}

function commandMayContainSecret(arguments_: readonly string[]): boolean {
  return arguments_.some((argument) => (
    /(?:^|[-_/])(authorization|bearer|token|secret|password|api[_-]?key|private[_-]?key|lease[_-]?token|approval)(?:$|\s*[:=])/i.test(argument)
    || /(authorization|bearer|token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]/i.test(argument)
  ));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new RepositoryCorruptError('Stored automation JSON is corrupt');
  }
}

function asRunStatus(value: string): AutomationRunStatus {
  if (!RUN_STATUSES.has(value)) throw new RepositoryCorruptError('Stored automation run status is corrupt');
  return value as AutomationRunStatus;
}

function asMilestoneStatus(value: string): AutomationMilestoneStatus {
  if (!MILESTONE_STATUSES.has(value)) throw new RepositoryCorruptError('Stored automation milestone status is corrupt');
  return value as AutomationMilestoneStatus;
}

function asDispatchStatus(value: string): AutomationDispatchStatus {
  if (!DISPATCH_STATUSES.has(value)) throw new RepositoryCorruptError('Stored automation dispatch status is corrupt');
  return value as AutomationDispatchStatus;
}

function isTerminalRunStatus(value: AutomationRunStatus): boolean {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeRollback(database: { exec(sql: string): void }): void {
  try { database.exec('ROLLBACK;'); } catch { /* transaction already closed */ }
}

function repositoryError(error: unknown, fallback: string): Result<never> {
  if (error instanceof RepositoryNotFoundError) return err(appError('PROCESS_NOT_FOUND', error.message));
  if (error instanceof RepositoryConflictError || isSqliteConstraint(error)) {
    return err(appError('CONFLICT', error instanceof Error ? error.message : fallback, true));
  }
  return err(appError('INTERNAL_ERROR', error instanceof Error ? error.message : fallback, true));
}

function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error && /(UNIQUE|CHECK|FOREIGN KEY) constraint failed/i.test(error.message);
}

class RepositoryNotFoundError extends Error {}
class RepositoryConflictError extends Error {}
class RepositoryCorruptError extends Error {}
