import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_AUTOMATION_ATTEMPTS_PER_MILESTONE,
  appError,
  automationShellRequestDigest,
  err,
  ok,
  readyAutomationMilestones,
  validateAutomationPlan,
  type AutomationAttemptRecord,
  type AutomationEventRecord,
  type AutomationMilestoneRecord,
  type AutomationPlan,
  type AutomationRunStatus,
  type AutomationShellDispatch,
  type GoalEvidence,
  type GoalLeaseProof,
  type GoalStepUpdate,
  type GoalTrackedTask,
  type Result,
  type AutomationEventInput,
  type CreateAutomationRunRequest as RepositoryCreateAutomationRunRequest,
  type ReserveAutomationAttemptRequest,
  type RecordAutomationVerificationRequest,
  type StoredAutomationRun,
  type TransitionAutomationMilestoneRequest,
  type TransitionAutomationRunRequest,
  type UpdateAutomationAttemptRequest,
} from '@lnwjing/domain';
import type { FileActor } from './file-service.js';
import type {
  CancelGoalRequest,
  CancelGoalResult,
  CheckpointGoalRequest,
  FinishGoalRequest,
  FinishGoalResult,
  GoalSnapshot,
  GetGoalRequest,
  ValidateGoalLeaseRequest,
} from './goal-continuation-service.js';
import type { AutomationVerificationPort } from './automation-verifier.js';

const MAX_ID_LENGTH = 128;
const MAX_CANCEL_SUMMARY = 2_048;

export interface AutomationRepositoryPort {
  create(input: RepositoryCreateAutomationRunRequest): Result<StoredAutomationRun>;
  getOwned(runId: string, ownerClientId: string, workspaceId: string): Result<StoredAutomationRun | undefined>;
  findActiveForGoal(goalId: string, ownerClientId: string, workspaceId: string): Result<StoredAutomationRun | undefined>;
  transitionRun(input: TransitionAutomationRunRequest): Result<StoredAutomationRun>;
  transitionMilestone(input: TransitionAutomationMilestoneRequest): Result<StoredAutomationRun>;
  reserveAttempt(input: ReserveAutomationAttemptRequest): Result<StoredAutomationRun>;
  updateAttempt(input: UpdateAutomationAttemptRequest): Result<StoredAutomationRun>;
  recordVerification(input: RecordAutomationVerificationRequest): Result<StoredAutomationRun>;
  listEvents(
    runId: string,
    ownerClientId: string,
    workspaceId: string,
    options: { readonly afterSequence?: number; readonly limit: number },
  ): Result<{ readonly events: readonly AutomationEventRecord[]; readonly nextSequence?: number }>;
}

export interface AutomationGoalPort {
  getGoal(actor: FileActor, request: GetGoalRequest): Promise<Result<GoalSnapshot>>;
  validateGoalLease(actor: FileActor, request: ValidateGoalLeaseRequest): Promise<Result<GoalSnapshot>>;
  checkpointGoal(actor: FileActor, request: CheckpointGoalRequest): Promise<Result<GoalSnapshot>>;
  finishGoal(actor: FileActor, request: FinishGoalRequest): Promise<Result<FinishGoalResult>>;
  cancelGoal(actor: FileActor, request: CancelGoalRequest): Promise<Result<CancelGoalResult>>;
}

export interface AutomationDispatchContext {
  readonly runId: string;
  readonly milestoneId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly requestDigest: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly windowsVerbatimArguments?: boolean;
}

export interface AutomationDispatchRequest {
  readonly context: AutomationDispatchContext;
  readonly dispatch: AutomationShellDispatch;
  readonly role: AutomationMilestoneRecord['role'];
  readonly cancelWithGoal: boolean;
  readonly goalLease: GoalLeaseProof;
  readonly userConfirmed?: boolean;
}

export type AutomationObservedTaskState = 'running' | 'completed' | 'failed' | 'cancelled';

export type AutomationDispatchObservation =
  | {
      readonly presence: 'found';
      readonly state: AutomationObservedTaskState;
      readonly observedAt: string;
      readonly terminalState?: string;
    }
  | {
      readonly presence: 'absent' | 'unknown';
      readonly observedAt: string;
      readonly detail?: string;
    };

export interface AutomationDispatchPort {
  launch(actor: FileActor, request: AutomationDispatchRequest): Promise<Result<AutomationDispatchObservation>>;
  observe(actor: FileActor, request: AutomationDispatchRequest): Promise<Result<AutomationDispatchObservation>>;
}

export interface CreateAutomationRunRequest {
  readonly workspaceId: string;
  readonly goalId: string;
  readonly leaseToken: string;
  readonly plan: unknown;
}

export interface AutomationRunLocator {
  readonly workspaceId: string;
  readonly runId: string;
}

export interface MutateAutomationRunRequest extends AutomationRunLocator {
  /** Public callers bind their proof to the stored root goal; internal callers may omit it for compatibility. */
  readonly goalId?: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly userConfirmed?: boolean;
}

export interface CancelAutomationRunRequest extends MutateAutomationRunRequest {
  readonly summary?: string;
}

export interface AutomationEventsRequest extends AutomationRunLocator {
  readonly afterSequence?: number;
  readonly limit?: number;
}

export type AutomationAdvanceBoundary = 'dispatched' | 'running' | 'verification_pending' | 'verified' | 'failed' | 'blocked' | 'idle';

export interface AutomationAdvanceResult {
  readonly run: StoredAutomationRun;
  readonly boundary: AutomationAdvanceBoundary;
  readonly milestoneId?: string;
  readonly attemptId?: string;
  readonly taskId?: string;
}

export interface AutomationFinalizeResult {
  readonly run: StoredAutomationRun;
  readonly goal: GoalSnapshot;
}

export interface AutomationServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

interface AuthorizedRun {
  readonly run: StoredAutomationRun;
  readonly goal: GoalSnapshot;
}

export class AutomationService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  public constructor(
    private readonly repository: AutomationRepositoryPort,
    private readonly goals: AutomationGoalPort,
    private readonly dispatch: AutomationDispatchPort,
    private readonly verifier: AutomationVerificationPort,
    options: AutomationServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public async createRun(actor: FileActor, request: CreateAutomationRunRequest): Promise<Result<StoredAutomationRun>> {
    const workspaceId = boundedId(request.workspaceId, 'workspaceId');
    if (!workspaceId.ok) return workspaceId;
    const goalId = boundedId(request.goalId, 'goalId');
    if (!goalId.ok) return goalId;
    const plan = validateAutomationPlan(request.plan);
    if (!plan.ok) return plan;
    const goal = await this.goals.validateGoalLease(actor, { goalId: goalId.value, leaseToken: request.leaseToken });
    if (!goal.ok) return goal;
    if (goal.value.workspaceId !== workspaceId.value) {
      return err(appError('PERMISSION_DENIED', 'Goal does not belong to the requested workspace'));
    }
    const goalStepIds = new Set(goal.value.plan.steps.map((step) => step.id));
    const missing = plan.value.milestones.find((milestone) => !goalStepIds.has(milestone.goalStepId));
    if (missing !== undefined) {
      return err(appError('INVALID_INPUT', `Automation milestone ${missing.id} maps to an unknown goal step`));
    }
    const active = this.repository.findActiveForGoal(goalId.value, actor.clientId, workspaceId.value);
    if (!active.ok) return active;
    if (active.value !== undefined) return err(appError('CONFLICT', 'The goal already has a non-terminal automation run', true));
    return this.repository.create({
      id: boundedGeneratedId(this.idFactory()),
      goalId: goalId.value,
      workspaceId: workspaceId.value,
      ownerClientId: actorClientId(actor),
      plan: plan.value,
      createdAt: this.now().toISOString(),
    });
  }

  public async status(actor: FileActor, request: AutomationRunLocator): Promise<Result<StoredAutomationRun>> {
    const authorized = await this.loadAuthorizedRun(actor, request);
    return authorized.ok ? ok(authorized.value.run) : authorized;
  }

  public async events(
    actor: FileActor,
    request: AutomationEventsRequest,
  ): Promise<Result<{ readonly events: readonly AutomationEventRecord[]; readonly nextSequence?: number }>> {
    const authorized = await this.loadAuthorizedRun(actor, request);
    if (!authorized.ok) return authorized;
    return this.repository.listEvents(
      authorized.value.run.run.id,
      actorClientId(actor),
      authorized.value.run.run.workspaceId,
      {
        ...(request.afterSequence === undefined ? {} : { afterSequence: request.afterSequence }),
        limit: request.limit ?? 100,
      },
    );
  }

  public async pause(actor: FileActor, request: MutateAutomationRunRequest): Promise<Result<StoredAutomationRun>> {
    const authorized = await this.loadAuthorizedRun(actor, request, true);
    if (!authorized.ok) return authorized;
    if (authorized.value.run.run.status !== 'active') {
      return err(appError('CONFLICT', 'Only an active automation run can be paused', true));
    }
    const paused = this.transitionRun(actor, authorized.value.run, request.expectedRevision, 'paused', 'run_paused');
    if (!paused.ok) return paused;
    const checkpoint = await this.syncGoalState(actor, authorized.value.goal, paused.value, request.leaseToken, 'control:pause');
    return checkpoint.ok ? paused : err(checkpoint.error);
  }

  public async resume(actor: FileActor, request: MutateAutomationRunRequest): Promise<Result<StoredAutomationRun>> {
    const authorized = await this.loadAuthorizedRun(actor, request, true);
    if (!authorized.ok) return authorized;
    if (authorized.value.run.run.status !== 'paused' && authorized.value.run.run.status !== 'blocked') {
      return err(appError('CONFLICT', 'Only a paused or blocked automation run can be resumed', true));
    }
    const resumed = this.transitionRun(actor, authorized.value.run, request.expectedRevision, 'active', 'run_resumed');
    if (!resumed.ok) return resumed;
    const checkpoint = await this.syncGoalState(actor, authorized.value.goal, resumed.value, request.leaseToken, 'control:resume');
    return checkpoint.ok ? resumed : err(checkpoint.error);
  }

  public async cancel(actor: FileActor, request: CancelAutomationRunRequest): Promise<Result<StoredAutomationRun>> {
    const loaded = await this.loadAuthorizedRun(actor, request, false);
    if (!loaded.ok) return loaded;
    const requestValidation = this.validateMutationRequest(loaded.value.run, request);
    if (!requestValidation.ok) return requestValidation;
    const summary = boundedSummary(request.summary ?? 'Automation run cancelled by its owner.');
    if (!summary.ok) return summary;

    if (loaded.value.goal.status === 'cancelled') {
      if (loaded.value.run.run.status === 'cancelled') return ok(loaded.value.run);
      if (isTerminalRun(loaded.value.run.run.status)) {
        return err(appError('CONFLICT', 'Automation run terminal state does not match the cancelled root goal', true));
      }
      return this.transitionRun(actor, loaded.value.run, request.expectedRevision, 'cancelled', 'run_cancelled_reconciled');
    }
    if (loaded.value.goal.status !== 'active') {
      return err(appError('CONFLICT', 'Root goal is already terminal', true));
    }

    const goal = await this.validateMutationGoal(actor, loaded.value.run, request);
    if (!goal.ok) return goal;
    const rootCancellation = await this.goals.cancelGoal(actor, {
      goalId: goal.value.goalId,
      expectedRevision: goal.value.revision,
      summary: summary.value,
      evidence: [{ kind: 'task', value: `automation:${loaded.value.run.run.id}` }],
    });
    if (!rootCancellation.ok) return rootCancellation;
    return this.transitionRun(actor, loaded.value.run, request.expectedRevision, 'cancelled', 'run_cancelled');
  }

  public async finalize(actor: FileActor, request: MutateAutomationRunRequest): Promise<Result<AutomationFinalizeResult>> {
    const loaded = await this.loadAuthorizedRun(actor, request, false);
    if (!loaded.ok) return loaded;
    const requestValidation = this.validateMutationRequest(loaded.value.run, request);
    if (!requestValidation.ok) return requestValidation;
    let stored = loaded.value.run;

    if (loaded.value.goal.status === 'completed') {
      if (stored.run.status === 'completed') return ok({ run: stored, goal: loaded.value.goal });
      if (stored.run.status !== 'completing') {
        return err(appError('CONFLICT', 'Automation run state does not match the completed root goal', true));
      }
      const reconciled = this.transitionRun(actor, stored, request.expectedRevision, 'completed', 'run_completed_reconciled');
      return reconciled.ok ? ok({ run: reconciled.value, goal: loaded.value.goal }) : reconciled;
    }
    if (loaded.value.goal.status !== 'active') {
      return err(appError('CONFLICT', 'Root goal is already terminal', true));
    }

    const goal = await this.validateMutationGoal(actor, stored, request);
    if (!goal.ok) return goal;
    if (stored.run.status !== 'active' && stored.run.status !== 'completing') {
      return err(appError('CONFLICT', 'Automation run is not ready to finalize', true));
    }
    const incomplete = stored.milestones.find((milestone) => milestone.status !== 'completed');
    if (incomplete !== undefined) {
      return err(appError('CONFLICT', `Automation milestone ${incomplete.id} is not verified`, true));
    }
    const unresolved = stored.attempts.find((attempt) => attempt.dispatchStatus !== 'terminal');
    if (unresolved !== undefined) {
      return err(appError('CONFLICT', `Automation attempt ${unresolved.id} is not terminal`, true));
    }
    const missingEvidence = stored.milestones.find((milestone) => {
      const attempt = latestAttempt(stored, milestone.id);
      if (attempt === undefined) return true;
      const verifiedIds = new Set(attempt.evidence
        .filter((entry) => entry.status === 'verified')
        .map((entry) => `${entry.kind}\0${entry.requirementId}`));
      return milestone.verification.some((requirement) => !verifiedIds.has(`${requirement.kind}\0${requirement.id}`));
    });
    if (missingEvidence !== undefined) {
      return err(appError('CONFLICT', `Automation milestone ${missingEvidence.id} has incomplete verification evidence`, true));
    }

    if (stored.run.status === 'active') {
      const completing = this.transitionRun(actor, stored, stored.run.revision, 'completing', 'run_completing');
      if (!completing.ok) return completing;
      stored = completing.value;
    }
    const checkpoint = await this.syncGoalState(
      actor,
      goal.value,
      stored,
      request.leaseToken,
      'finalize',
      true,
    );
    if (!checkpoint.ok) return checkpoint;
    const terminalEvidence = automationGoalEvidence(stored);
    const finished = await this.goals.finishGoal(actor, {
      goalId: stored.run.goalId,
      leaseToken: request.leaseToken,
      expectedRevision: checkpoint.value.revision,
      status: 'completed',
      summary: `Automation run ${stored.run.id} completed with verified evidence.`,
      evidence: terminalEvidence,
    });
    if (!finished.ok) return finished;
    if (finished.value.completionState !== 'completed') {
      return err(appError('CONFLICT', 'Root goal completion is waiting for native scheduled-task cleanup', true));
    }
    const goalReadback = await this.goals.getGoal(actor, { goalId: stored.run.goalId });
    if (!goalReadback.ok) return goalReadback;
    if (goalReadback.value.status !== 'completed') {
      return err(appError('CONFLICT', 'Root goal terminal completion was not confirmed', true));
    }
    const completed = this.transitionRun(actor, stored, stored.run.revision, 'completed', 'run_completed');
    if (!completed.ok) return completed;
    return ok({ run: completed.value, goal: goalReadback.value });
  }

  public async advance(actor: FileActor, request: MutateAutomationRunRequest): Promise<Result<AutomationAdvanceResult>> {
    const authorized = await this.loadAuthorizedRun(actor, request, true);
    if (!authorized.ok) return authorized;
    let stored = authorized.value.run;
    if (stored.run.status === 'paused') return err(appError('CONFLICT', 'Paused automation cannot advance', true));
    if (isTerminalRun(stored.run.status) || stored.run.status === 'completing') {
      return err(appError('CONFLICT', 'Automation run cannot advance from its current state', true));
    }

    const goalLease: GoalLeaseProof = {
      goalId: authorized.value.goal.goalId,
      leaseToken: request.leaseToken,
      leaseGeneration: authorized.value.goal.leaseGeneration,
    };
    let goal = authorized.value.goal;
    if (requiresPreflightGoalSync(stored)) {
      const synchronized = await this.syncGoalState(actor, goal, stored, request.leaseToken, 'recovery:preflight');
      if (!synchronized.ok) return synchronized;
      goal = synchronized.value;
    }
    const unresolved = stored.attempts.find((attempt) => attempt.dispatchStatus === 'dispatched_unresolved');
    if (unresolved !== undefined) {
      return this.withGoalCheckpoint(
        actor,
        goal,
        request.leaseToken,
        this.observeUnresolved(actor, stored, unresolved, goalLease, request.userConfirmed),
      );
    }

    const inFlight = stored.milestones.find((milestone) => milestone.status === 'dispatching' || milestone.status === 'running');
    if (inFlight !== undefined) {
      return this.withGoalCheckpoint(
        actor,
        goal,
        request.leaseToken,
        this.observeInFlight(actor, stored, inFlight, goalLease, request.userConfirmed),
      );
    }
    const verifying = stored.milestones.find((milestone) => milestone.status === 'verifying');
    if (verifying !== undefined) {
      const attempt = latestAttempt(stored, verifying.id);
      if (attempt === undefined) return err(appError('INTERNAL_ERROR', 'Verifying automation milestone has no attempt', true));
      return this.withGoalCheckpoint(
        actor,
        goal,
        request.leaseToken,
        this.verifyMilestone(actor, stored, verifying, attempt, goalLease, request.userConfirmed),
      );
    }

    const statusByMilestone = Object.fromEntries(stored.milestones.map((milestone) => [milestone.id, milestone.status]));
    const plan: AutomationPlan = { milestones: stored.milestones };
    const next = readyAutomationMilestones(plan, statusByMilestone)[0];
    if (next === undefined) {
      return this.withGoalCheckpoint(
        actor,
        goal,
        request.leaseToken,
        ok({ run: stored, boundary: 'idle' }),
      );
    }
    const ready = this.repository.transitionMilestone(this.mutationScope(actor, stored, stored.run.revision, {
      kind: 'milestone_ready',
      milestoneId: next.id,
      payload: { dependencyCount: next.dependsOn.length },
    }, {
      milestoneId: next.id,
      status: 'ready',
    }));
    if (!ready.ok) return ready;
    stored = ready.value;

    const milestone = requireMilestone(stored, next.id);
    const ordinal = milestone.attemptCount + 1;
    if (ordinal > MAX_AUTOMATION_ATTEMPTS_PER_MILESTONE) {
      return err(appError('CONFLICT', `Automation milestone ${milestone.id} exhausted its attempt limit`));
    }
    const identity = createAutomationDispatchReservation(stored, milestone, ordinal);
    const reserved = this.repository.reserveAttempt(this.mutationScope(actor, stored, stored.run.revision, {
      kind: 'attempt_reserved',
      milestoneId: milestone.id,
      attemptId: identity.attemptId,
      payload: { ordinal, taskId: identity.taskId },
    }, {
      milestoneId: milestone.id,
      attemptId: identity.attemptId,
      ordinal,
      taskId: identity.taskId,
      requestDigest: identity.requestDigest,
    }));
    if (!reserved.ok) return reserved;
    stored = reserved.value;
    const attempt = requireAttempt(stored, identity.attemptId);
    const dispatchRequest = toDispatchRequest(stored, milestone, attempt, goalLease, request.userConfirmed);
    let observation: Result<AutomationDispatchObservation>;
    try {
      observation = await this.dispatch.launch(actor, dispatchRequest);
    } catch {
      observation = err(appError('INTERNAL_ERROR', 'Automation dispatch outcome is unknown', true));
    }
    return this.withGoalCheckpoint(
      actor,
      goal,
      request.leaseToken,
      this.persistDispatchObservation(actor, stored, milestone, attempt, observation, 'launch'),
    );
  }

  private async withGoalCheckpoint(
    actor: FileActor,
    goal: GoalSnapshot,
    leaseToken: string,
    result: Result<AutomationAdvanceResult> | Promise<Result<AutomationAdvanceResult>>,
  ): Promise<Result<AutomationAdvanceResult>> {
    const advanced = await result;
    if (!advanced.ok) return advanced;
    const checkpoint = await this.syncGoalState(
      actor,
      goal,
      advanced.value.run,
      leaseToken,
      `advance:${advanced.value.boundary}`,
    );
    return checkpoint.ok ? advanced : err(checkpoint.error);
  }

  private async syncGoalState(
    actor: FileActor,
    goal: GoalSnapshot,
    stored: StoredAutomationRun,
    leaseToken: string,
    reason: string,
    force = false,
  ): Promise<Result<GoalSnapshot>> {
    const trackedTasks = automationGoalTrackedTasks(goal, stored);
    const stepUpdates = automationGoalStepUpdates(goal, stored);
    const blockerPrefix = `[automation:${stored.run.id}]`;
    const blockers = goal.blockers.filter((entry) => !entry.startsWith(blockerPrefix));
    if (stored.run.status === 'blocked' || stored.run.status === 'failed' || stored.run.status === 'paused') {
      blockers.push(`${blockerPrefix} ${stored.run.status === 'paused' ? 'paused' : 'requires operator attention'}`);
    }
    const currentPhase = `automation:${stored.run.id}:${stored.run.status}`;
    const nextAction = automationGoalNextAction(stored);
    const changed = force
      || goal.currentPhase !== currentPhase
      || goal.nextAction !== nextAction
      || !sameTrackedTasks(goal.trackedTasks, trackedTasks)
      || !sameStrings(goal.blockers, blockers)
      || stepUpdates.some((update) => {
        const current = goal.plan.steps.find((step) => step.id === update.stepId);
        return current?.status !== update.status || current.summary !== update.summary;
      });
    if (!changed) return ok(goal);
    return this.goals.checkpointGoal(actor, {
      goalId: stored.run.goalId,
      leaseToken,
      expectedRevision: goal.revision,
      currentPhase,
      summary: `Automation run ${stored.run.id} checkpointed (${reason}).`,
      stepUpdates,
      nextAction,
      blockers,
      evidence: automationGoalEvidence(stored),
      trackedTasks,
      releaseLease: false,
    });
  }

  private async loadAuthorizedRun(
    actor: FileActor,
    request: AutomationRunLocator | MutateAutomationRunRequest,
    mutation = false,
  ): Promise<Result<AuthorizedRun>> {
    const runId = boundedId(request.runId, 'runId');
    if (!runId.ok) return runId;
    const workspaceId = boundedId(request.workspaceId, 'workspaceId');
    if (!workspaceId.ok) return workspaceId;
    const stored = this.repository.getOwned(runId.value, actorClientId(actor), workspaceId.value);
    if (!stored.ok) return stored;
    if (stored.value === undefined) return err(appError('PROCESS_NOT_FOUND', 'Automation run was not found'));
    const goal = mutation
      ? await this.validateMutationGoal(actor, stored.value, request as MutateAutomationRunRequest)
      : await this.goals.getGoal(actor, { goalId: stored.value.run.goalId });
    if (!goal.ok) return goal;
    if (goal.value.goalId !== stored.value.run.goalId
      || goal.value.workspaceId !== stored.value.run.workspaceId
      || goal.value.workspaceId !== workspaceId.value) {
      return err(appError('PERMISSION_DENIED', 'Automation run and root goal scope do not match'));
    }
    return ok({ run: stored.value, goal: goal.value });
  }

  private validateMutationRequest(stored: StoredAutomationRun, request: MutateAutomationRunRequest): Result<void> {
    if (request.goalId !== undefined && request.goalId !== stored.run.goalId) {
      return err(appError('CONFLICT', 'Automation run does not belong to the supplied goal', true));
    }
    if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
      return err(appError('INVALID_INPUT', 'expectedRevision is invalid'));
    }
    if (stored.run.revision !== request.expectedRevision) {
      return err(appError('CONFLICT', 'Automation run revision changed', true));
    }
    return ok(undefined);
  }

  private async validateMutationGoal(
    actor: FileActor,
    stored: StoredAutomationRun,
    request: MutateAutomationRunRequest,
  ): Promise<Result<GoalSnapshot>> {
    const requestValidation = this.validateMutationRequest(stored, request);
    if (!requestValidation.ok) return requestValidation;
    if (typeof request.leaseToken !== 'string' || request.leaseToken.trim().length === 0) {
      return err(appError('CONFLICT', 'A current goal lease is required', true));
    }
    return this.goals.validateGoalLease(actor, { goalId: stored.run.goalId, leaseToken: request.leaseToken });
  }

  private transitionRun(
    actor: FileActor,
    stored: StoredAutomationRun,
    expectedRevision: number,
    status: AutomationRunStatus,
    kind: string,
  ): Result<StoredAutomationRun> {
    return this.repository.transitionRun(this.mutationScope(actor, stored, expectedRevision, {
      kind,
      payload: { status },
    }, { status }));
  }

  private async observeInFlight(
    actor: FileActor,
    stored: StoredAutomationRun,
    milestone: AutomationMilestoneRecord,
    goalLease: GoalLeaseProof,
    userConfirmed?: boolean,
  ): Promise<Result<AutomationAdvanceResult>> {
    const attempt = latestAttempt(stored, milestone.id);
    if (attempt === undefined) return err(appError('INTERNAL_ERROR', 'In-flight automation milestone has no reserved attempt', true));
    const request = toDispatchRequest(stored, milestone, attempt, goalLease, userConfirmed);
    let observation: Result<AutomationDispatchObservation>;
    try {
      observation = await this.dispatch.observe(actor, request);
    } catch {
      observation = err(appError('INTERNAL_ERROR', 'Automation observation outcome is unknown', true));
    }
    if (milestone.status === 'dispatching' && attempt.dispatchStatus === 'reserved' && observation.ok && observation.value.presence === 'absent') {
      try {
        const launched = await this.dispatch.launch(actor, request);
        return this.persistDispatchObservation(actor, stored, milestone, attempt, launched, 'recovery_launch');
      } catch {
        return this.persistDispatchObservation(
          actor,
          stored,
          milestone,
          attempt,
          err(appError('INTERNAL_ERROR', 'Automation recovery dispatch outcome is unknown', true)),
          'recovery_launch',
        );
      }
    }
    if (milestone.status === 'running' && attempt.dispatchStatus === 'launched'
      && observation.ok && observation.value.presence === 'found') {
      if (observation.value.state === 'running') {
        return ok({
          run: stored,
          boundary: 'running',
          milestoneId: milestone.id,
          attemptId: attempt.id,
          taskId: attempt.taskId,
        });
      }
      const terminal = this.repository.updateAttempt(this.mutationScope(actor, stored, stored.run.revision, {
        kind: 'dispatch_terminal',
        milestoneId: milestone.id,
        attemptId: attempt.id,
        payload: { state: observation.value.state, taskId: attempt.taskId },
      }, {
        attemptId: attempt.id,
        dispatchStatus: 'terminal',
        milestoneStatus: 'verifying',
        terminalState: observation.value.terminalState ?? observation.value.state,
      }));
      if (!terminal.ok) return terminal;
      return ok({
        run: terminal.value,
        boundary: 'verification_pending',
        milestoneId: milestone.id,
        attemptId: attempt.id,
        taskId: attempt.taskId,
      });
    }
    return this.persistDispatchObservation(actor, stored, milestone, attempt, observation, 'observe');
  }

  private async verifyMilestone(
    actor: FileActor,
    stored: StoredAutomationRun,
    milestone: AutomationMilestoneRecord,
    attempt: AutomationAttemptRecord,
    goalLease: GoalLeaseProof,
    userConfirmed?: boolean,
  ): Promise<Result<AutomationAdvanceResult>> {
    let verified: Awaited<ReturnType<AutomationVerificationPort['verify']>>;
    try {
      verified = await this.verifier.verify(actor, {
        stored,
        milestone,
        attempt,
        goalLease,
        ...(userConfirmed === undefined ? {} : { userConfirmed }),
      });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Automation verification failed unexpectedly', true));
    }
    if (!verified.ok) return verified;
    const milestoneStatus = verified.value.status === 'verified'
      ? 'completed' as const
      : verified.value.status === 'failed'
        ? 'failed' as const
        : undefined;
    const recorded = this.repository.recordVerification(this.mutationScope(actor, stored, stored.run.revision, {
      kind: 'verification_recorded',
      milestoneId: milestone.id,
      attemptId: attempt.id,
      payload: { status: verified.value.status, evidenceCount: verified.value.evidence.length, taskId: attempt.taskId },
    }, {
      attemptId: attempt.id,
      evidence: verified.value.evidence,
      ...(milestoneStatus === undefined ? {} : { milestoneStatus }),
    }));
    if (!recorded.ok) return recorded;
    if (verified.value.status === 'verified') {
      return ok({
        run: recorded.value,
        boundary: 'verified',
        milestoneId: milestone.id,
        attemptId: attempt.id,
        taskId: attempt.taskId,
      });
    }
    if (verified.value.status === 'pending') {
      return ok({
        run: recorded.value,
        boundary: 'verification_pending',
        milestoneId: milestone.id,
        attemptId: attempt.id,
        taskId: attempt.taskId,
      });
    }
    const runStatus = verified.value.status === 'failed' ? 'failed' : 'blocked';
    const transitioned = recorded.value.run.status === runStatus
      ? ok(recorded.value)
      : this.transitionRun(
          actor,
          recorded.value,
          recorded.value.run.revision,
          runStatus,
          verified.value.status === 'failed' ? 'run_verification_failed' : 'run_verification_unknown',
        );
    if (!transitioned.ok) return transitioned;
    return ok({
      run: transitioned.value,
      boundary: verified.value.status === 'failed' ? 'failed' : 'blocked',
      milestoneId: milestone.id,
      attemptId: attempt.id,
      taskId: attempt.taskId,
    });
  }

  private async observeUnresolved(
    actor: FileActor,
    stored: StoredAutomationRun,
    attempt: AutomationAttemptRecord,
    goalLease: GoalLeaseProof,
    userConfirmed?: boolean,
  ): Promise<Result<AutomationAdvanceResult>> {
    const milestone = requireMilestone(stored, attempt.milestoneId);
    let observation: Result<AutomationDispatchObservation>;
    try {
      observation = await this.dispatch.observe(actor, toDispatchRequest(stored, milestone, attempt, goalLease, userConfirmed));
    } catch {
      observation = err(appError('INTERNAL_ERROR', 'Automation observation outcome is unknown', true));
    }
    if (!observation.ok || observation.value.presence === 'unknown') {
      return ok({ run: stored, boundary: 'blocked', milestoneId: milestone.id, attemptId: attempt.id, taskId: attempt.taskId });
    }
    if (observation.value.presence === 'found') {
      const active = stored.run.status === 'blocked'
        ? this.transitionRun(actor, stored, stored.run.revision, 'active', 'run_recovered')
        : ok(stored);
      if (!active.ok) return active;
      const ready = this.repository.transitionMilestone(this.mutationScope(actor, active.value, active.value.run.revision, {
        kind: 'milestone_recovery_ready', milestoneId: milestone.id, attemptId: attempt.id, payload: { taskId: attempt.taskId },
      }, { milestoneId: milestone.id, status: 'ready' }));
      if (!ready.ok) return ready;
      const dispatching = this.repository.transitionMilestone(this.mutationScope(actor, ready.value, ready.value.run.revision, {
        kind: 'milestone_recovery_dispatching', milestoneId: milestone.id, attemptId: attempt.id, payload: { taskId: attempt.taskId },
      }, { milestoneId: milestone.id, status: 'dispatching' }));
      if (!dispatching.ok) return dispatching;
      return this.persistDispatchObservation(actor, dispatching.value, milestone, attempt, observation, 'recovery_observe');
    }

    const closed = this.repository.updateAttempt(this.mutationScope(actor, stored, stored.run.revision, {
      kind: 'dispatch_absence_proven', milestoneId: milestone.id, attemptId: attempt.id, payload: { taskId: attempt.taskId },
    }, {
      attemptId: attempt.id,
      dispatchStatus: 'terminal',
      milestoneStatus: 'failed',
      terminalState: 'absent',
    }));
    if (!closed.ok) return closed;
    if (attempt.ordinal >= MAX_AUTOMATION_ATTEMPTS_PER_MILESTONE) {
      const failed = this.transitionRun(actor, closed.value, closed.value.run.revision, 'failed', 'run_attempts_exhausted');
      if (!failed.ok) return failed;
      return ok({ run: failed.value, boundary: 'blocked', milestoneId: milestone.id, attemptId: attempt.id, taskId: attempt.taskId });
    }
    const active = closed.value.run.status === 'blocked'
      ? this.transitionRun(actor, closed.value, closed.value.run.revision, 'active', 'run_recovered')
      : ok(closed.value);
    if (!active.ok) return active;
    const ready = this.repository.transitionMilestone(this.mutationScope(actor, active.value, active.value.run.revision, {
      kind: 'milestone_retry_ready', milestoneId: milestone.id, attemptId: attempt.id, payload: { priorOrdinal: attempt.ordinal },
    }, { milestoneId: milestone.id, status: 'ready' }));
    if (!ready.ok) return ready;
    const refreshedMilestone = requireMilestone(ready.value, milestone.id);
    const ordinal = attempt.ordinal + 1;
    const identity = createAutomationDispatchReservation(ready.value, refreshedMilestone, ordinal);
    const reserved = this.repository.reserveAttempt(this.mutationScope(actor, ready.value, ready.value.run.revision, {
      kind: 'attempt_reserved_after_absence', milestoneId: milestone.id, attemptId: identity.attemptId,
      payload: { ordinal, taskId: identity.taskId },
    }, {
      milestoneId: milestone.id,
      attemptId: identity.attemptId,
      ordinal,
      taskId: identity.taskId,
      requestDigest: identity.requestDigest,
    }));
    if (!reserved.ok) return reserved;
    const nextAttempt = requireAttempt(reserved.value, identity.attemptId);
    let relaunched: Result<AutomationDispatchObservation>;
    try {
      relaunched = await this.dispatch.launch(
        actor,
        toDispatchRequest(reserved.value, refreshedMilestone, nextAttempt, goalLease, userConfirmed),
      );
    } catch {
      relaunched = err(appError('INTERNAL_ERROR', 'Automation recovery dispatch outcome is unknown', true));
    }
    return this.persistDispatchObservation(actor, reserved.value, refreshedMilestone, nextAttempt, relaunched, 'recovery_launch');
  }

  private persistDispatchObservation(
    actor: FileActor,
    stored: StoredAutomationRun,
    milestone: AutomationMilestoneRecord,
    attempt: AutomationAttemptRecord,
    observation: Result<AutomationDispatchObservation>,
    source: string,
  ): Result<AutomationAdvanceResult> {
    const observed = observation.ok ? observation.value : undefined;
    if (observed === undefined || observed.presence !== 'found') {
      const unresolved = this.repository.updateAttempt(this.mutationScope(actor, stored, stored.run.revision, {
        kind: 'dispatch_unresolved',
        milestoneId: milestone.id,
        attemptId: attempt.id,
        payload: { source, taskId: attempt.taskId },
      }, {
        attemptId: attempt.id,
        dispatchStatus: 'dispatched_unresolved',
        milestoneStatus: 'blocked',
        terminalState: null,
      }));
      if (!unresolved.ok) return unresolved;
      const blocked = unresolved.value.run.status === 'blocked'
        ? unresolved
        : this.transitionRun(actor, unresolved.value, unresolved.value.run.revision, 'blocked', 'run_blocked');
      if (!blocked.ok) return blocked;
      return ok({
        run: blocked.value,
        boundary: 'blocked',
        milestoneId: milestone.id,
        attemptId: attempt.id,
        taskId: attempt.taskId,
      });
    }

    const launched = this.repository.updateAttempt(this.mutationScope(actor, stored, stored.run.revision, {
      kind: 'dispatch_observed',
      milestoneId: milestone.id,
      attemptId: attempt.id,
      payload: { source, state: observed.state, taskId: attempt.taskId },
    }, {
      attemptId: attempt.id,
      dispatchStatus: 'launched',
      milestoneStatus: 'running',
    }));
    if (!launched.ok) return launched;
    if (observed.state === 'running') {
      return ok({
        run: launched.value,
        boundary: source === 'launch' || source === 'recovery_launch' ? 'dispatched' : 'running',
        milestoneId: milestone.id,
        attemptId: attempt.id,
        taskId: attempt.taskId,
      });
    }
    const terminal = this.repository.updateAttempt(this.mutationScope(actor, launched.value, launched.value.run.revision, {
      kind: 'dispatch_terminal',
      milestoneId: milestone.id,
      attemptId: attempt.id,
      payload: { state: observed.state, taskId: attempt.taskId },
    }, {
      attemptId: attempt.id,
      dispatchStatus: 'terminal',
      milestoneStatus: 'verifying',
      terminalState: observed.terminalState ?? observed.state,
    }));
    if (!terminal.ok) return terminal;
    return ok({
      run: terminal.value,
      boundary: 'verification_pending',
      milestoneId: milestone.id,
      attemptId: attempt.id,
      taskId: attempt.taskId,
    });
  }

  private mutationScope<T extends object>(
    actor: FileActor,
    stored: StoredAutomationRun,
    expectedRevision: number,
    event: AutomationEventInput,
    extra: T,
  ): T & {
    readonly runId: string;
    readonly ownerClientId: string;
    readonly workspaceId: string;
    readonly expectedRevision: number;
    readonly updatedAt: string;
    readonly event: AutomationEventInput;
  } {
    return {
      ...extra,
      runId: stored.run.id,
      ownerClientId: actorClientId(actor),
      workspaceId: stored.run.workspaceId,
      expectedRevision,
      updatedAt: this.now().toISOString(),
      event,
    };
  }
}

export function createAutomationDispatchReservation(
  stored: StoredAutomationRun,
  milestone: AutomationMilestoneRecord,
  ordinal: number,
): { readonly attemptId: string; readonly taskId: string; readonly requestDigest: string } {
  const identityDigest = sha256(canonicalJson({
    version: 1,
    runId: stored.run.id,
    milestoneId: milestone.id,
    ordinal,
  }));
  const taskId = `automation-${identityDigest.slice(0, 48)}`;
  const requestDigest = automationShellRequestDigest({
    taskId,
    ownerClientId: stored.run.ownerClientId,
    workspaceId: stored.run.workspaceId,
    dispatch: milestone.dispatch,
  });
  return {
    attemptId: `attempt-${identityDigest.slice(0, 48)}`,
    taskId,
    requestDigest,
  };
}

function toDispatchRequest(
  stored: StoredAutomationRun,
  milestone: AutomationMilestoneRecord,
  attempt: AutomationAttemptRecord,
  goalLease: GoalLeaseProof,
  userConfirmed?: boolean,
): AutomationDispatchRequest {
  return {
    context: {
      runId: stored.run.id,
      milestoneId: milestone.id,
      attemptId: attempt.id,
      taskId: attempt.taskId,
      requestDigest: attempt.requestDigest,
      goalId: stored.run.goalId,
      workspaceId: stored.run.workspaceId,
      ...(milestone.dispatch.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: milestone.dispatch.windowsVerbatimArguments }),
    },
    dispatch: milestone.dispatch,
    role: milestone.role,
    cancelWithGoal: milestone.cancelWithGoal,
    goalLease,
    ...(userConfirmed === undefined ? {} : { userConfirmed }),
  };
}

function latestAttempt(stored: StoredAutomationRun, milestoneId: string): AutomationAttemptRecord | undefined {
  return stored.attempts
    .filter((attempt) => attempt.milestoneId === milestoneId)
    .sort((left, right) => right.ordinal - left.ordinal)[0];
}

function requireMilestone(stored: StoredAutomationRun, milestoneId: string): AutomationMilestoneRecord {
  const milestone = stored.milestones.find((entry) => entry.id === milestoneId);
  if (milestone === undefined) throw new Error('Stored automation milestone is missing');
  return milestone;
}

function requireAttempt(stored: StoredAutomationRun, attemptId: string): AutomationAttemptRecord {
  const attempt = stored.attempts.find((entry) => entry.id === attemptId);
  if (attempt === undefined) throw new Error('Stored automation attempt is missing');
  return attempt;
}

function isTerminalRun(status: AutomationRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function automationGoalTrackedTasks(goal: GoalSnapshot, stored: StoredAutomationRun): readonly GoalTrackedTask[] {
  const ownedTaskIds = new Set<string>();
  for (const attempt of stored.attempts) {
    ownedTaskIds.add(attempt.taskId);
    for (const evidence of attempt.evidence) {
      if (evidence.observedTaskId !== undefined) ownedTaskIds.add(evidence.observedTaskId);
    }
  }
  const retained = goal.trackedTasks.filter((task) => !ownedTaskIds.has(task.taskId));
  const active = new Map<string, GoalTrackedTask>();
  for (const attempt of stored.attempts) {
    if (attempt.dispatchStatus !== 'launched' && attempt.dispatchStatus !== 'dispatched_unresolved') continue;
    const milestone = stored.milestones.find((entry) => entry.id === attempt.milestoneId);
    if (milestone === undefined) continue;
    active.set(attempt.taskId, {
      taskId: attempt.taskId,
      provider: 'shell',
      role: milestone.role,
      cancelWithGoal: milestone.cancelWithGoal,
    });
  }
  for (const attempt of stored.attempts) {
    const milestone = stored.milestones.find((entry) => entry.id === attempt.milestoneId);
    if (milestone === undefined) continue;
    for (const evidence of attempt.evidence) {
      if (evidence.kind !== 'git_diff_check'
        || evidence.observedTaskId === undefined
        || (evidence.status !== 'pending' && evidence.status !== 'unknown')) continue;
      active.set(evidence.observedTaskId, {
        taskId: evidence.observedTaskId,
        provider: 'shell',
        role: milestone.role,
        cancelWithGoal: milestone.cancelWithGoal,
      });
    }
  }
  return [...retained, ...active.values()];
}

function requiresPreflightGoalSync(stored: StoredAutomationRun): boolean {
  return stored.run.status === 'blocked'
    || stored.run.status === 'paused'
    || stored.milestones.some((milestone) => milestone.status === 'running' || milestone.status === 'verifying')
    || stored.attempts.some((attempt) => attempt.dispatchStatus === 'launched' || attempt.dispatchStatus === 'dispatched_unresolved');
}

function automationGoalStepUpdates(goal: GoalSnapshot, stored: StoredAutomationRun): readonly GoalStepUpdate[] {
  const byStep = new Map<string, AutomationMilestoneRecord[]>();
  for (const milestone of stored.milestones) {
    const entries = byStep.get(milestone.goalStepId) ?? [];
    entries.push(milestone);
    byStep.set(milestone.goalStepId, entries);
  }
  return goal.plan.steps.flatMap((step): GoalStepUpdate[] => {
    const milestones = byStep.get(step.id);
    if (milestones === undefined || milestones.length === 0) return [];
    const status = milestones.every((milestone) => milestone.status === 'completed')
      ? 'completed' as const
      : stored.run.status === 'blocked'
        || stored.run.status === 'failed'
        || milestones.some((milestone) => milestone.status === 'blocked' || milestone.status === 'failed')
        ? 'blocked' as const
        : milestones.every((milestone) => milestone.status === 'pending')
          ? 'pending' as const
          : 'in_progress' as const;
    const summary = `Automation milestones: ${milestones.map((milestone) => `${milestone.id}=${milestone.status}`).join(', ')}`;
    return [{ stepId: step.id, status, summary }];
  });
}

function automationGoalEvidence(stored: StoredAutomationRun): readonly GoalEvidence[] {
  const entries: GoalEvidence[] = [];
  for (const attempt of stored.attempts) {
    entries.push({ kind: 'task', value: attempt.taskId });
    if (attempt.terminalState !== undefined) {
      entries.push({
        kind: 'note',
        value: `automation:${stored.run.id}/${attempt.milestoneId}/${attempt.id}:terminal=${attempt.terminalState}`,
      });
    }
    for (const evidence of attempt.evidence) {
      entries.push({
        kind: evidence.observedDigest === undefined ? 'note' : 'hash',
        value: evidence.observedDigest === undefined
          ? `automation:${stored.run.id}/${attempt.milestoneId}/${evidence.requirementId}:${evidence.status}`
          : evidence.observedDigest,
      });
    }
  }
  return entries.slice(-20);
}

function automationGoalNextAction(stored: StoredAutomationRun): string {
  if (stored.run.status === 'completed') return 'Automation is complete.';
  if (stored.run.status === 'completing') return 'Confirm root goal completion and finalize the automation run.';
  if (stored.run.status === 'blocked' || stored.run.status === 'failed') return 'Inspect automation evidence and resolve the blocker.';
  if (stored.run.status === 'paused') return 'Resume or cancel the paused automation run.';
  if (stored.milestones.every((milestone) => milestone.status === 'completed')) return 'Finalize the verified automation run.';
  return 'Advance the automation run to its next durable boundary.';
}

function sameTrackedTasks(left: readonly GoalTrackedTask[], right: readonly GoalTrackedTask[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && entry.taskId === candidate.taskId
      && entry.provider === candidate.provider
      && entry.role === candidate.role
      && entry.cancelWithGoal === candidate.cancelWithGoal;
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function actorClientId(actor: FileActor): string {
  const value = actor.clientId.trim();
  if (value.length < 1 || value.length > MAX_ID_LENGTH) throw new Error('client identity is invalid');
  return value;
}

function boundedGeneratedId(value: string): string {
  const result = boundedId(value, 'generated automation run ID');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function boundedId(value: string, label: string): Result<string> {
  if (typeof value !== 'string') return err(appError('INVALID_INPUT', `${label} is invalid`));
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= MAX_ID_LENGTH && /^[A-Za-z0-9._:-]+$/.test(normalized)
    ? ok(normalized)
    : err(appError('INVALID_INPUT', `${label} is invalid`));
}

function boundedSummary(value: string): Result<string> {
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= MAX_CANCEL_SUMMARY
    ? ok(normalized)
    : err(appError('INVALID_INPUT', 'Automation cancellation summary is invalid'));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
