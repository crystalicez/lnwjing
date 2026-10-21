import { engineeringGoalMetadata, type EngineeringWorkflowPlan } from '@lnwjing/application';
import { appError, err, mayMarkEngineeringGateNotApplicable, ok, requiresHostObservedEngineeringEvidence, type EngineeringGoalMetadata, type GoalCheckpointResumeContext, type GoalEvidence } from '@lnwjing/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { engineeringGetStatusSchema, engineeringPrepareTaskSchema, engineeringStartTaskSchema } from './schemas.js';

const MAX_ENGINEERING_RESUME_CONTEXT_LENGTH = 64_000;
const ENGINEERING_RESUME_CONTEXT_NORMALIZATION_HEADROOM = 1_024;
const SCOPE_DEPENDENT_ENGINEERING_GATES = new Set([
  'diff', 'coverage', 'focused_validation', 'architecture', 'integration', 'restart_persistence',
  'security_review', 'self_review', 'independent_review', 'docs_impact',
]);

export function engineeringTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'engineering_prepare_task',
      description: 'Read-only Engineering Harness preparation. Assess the registered workspace, applicable project instructions, effective Engineering policy, and policy digest without creating a goal, starting a process, scheduling work, or writing repository files.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: engineeringPrepareTaskSchema,
      handler: async (input) => {
        if (context.services.engineeringPreparation === undefined) return missingService();
        const prepared = await context.services.engineeringPreparation.prepare(input.workspaceId, input.objective, input.scopedPath);
        if (!prepared.ok) return prepared;
        return ok({
          ...prepared.value,
          engineeringTask: {
            objective: prepared.value.objective,
            ...(input.scopedPath === undefined ? {} : { scopedPath: input.scopedPath }),
            policyDigest: prepared.value.policy.policyDigest,
            primaryTaskKind: prepared.value.workflow.primaryTaskKind,
            riskTier: prepared.value.workflow.riskTier,
            deliveryScope: prepared.value.workflow.deliveryScope,
            ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
          },
        });
      },
    }),
    defineTool({
      name: 'engineering_start_task',
      description: 'Start or resume a substantive Engineering Harness task by reusing the existing durable Goal authority. This operation does not create or authorize a scheduled continuation.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: engineeringStartTaskSchema,
      handler: async (input) => {
        const goals = context.services.goals;
        const preparation = context.services.engineeringPreparation;
        if (goals === undefined || preparation === undefined) return missingService();
        const existing = await goals.getGoal(context.actor, { workspaceId: input.workspaceId, goalKey: input.goalKey });
        const persistedEngineering = existing.ok ? existing.value.engineering : undefined;
        if (existing.ok && persistedEngineering === undefined) return err(appError('INVALID_INPUT', 'Existing goal is not an Engineering Harness task'));
        let effectiveScopedPath = existing.ok ? input.scopedPath ?? persistedEngineering?.scopedPath : input.scopedPath;
        let prepared = await preparation.prepare(input.workspaceId, input.objective, effectiveScopedPath);
        if (!prepared.ok) return prepared;
        let continuingThroughProjectOptOut = existing.ok && !prepared.value.policy.enabled && prepared.value.policy.source === 'project';
        if (!prepared.value.policy.enabled && !continuingThroughProjectOptOut) {
          return err(appError('INVALID_INPUT', `Engineering Harness is inactive: ${prepared.value.policy.reasons.join(' ')}`));
        }
        if (continuingThroughProjectOptOut && input.scopedPath !== undefined && input.scopedPath !== persistedEngineering?.scopedPath) {
          return err(appError('INVALID_INPUT', 'Project Engineering Harness is disabled for new scope preparation; resume the active task with its existing scopedPath.'));
        }
        if (existing.ok) {
          if (persistedEngineering === undefined) return err(appError('INVALID_INPUT', 'Existing goal is not an Engineering Harness task'));
          const resumed = await goals.runGoal(context.actor, {
            workspaceId: input.workspaceId,
            goalKey: input.goalKey,
            objective: input.objective,
            ...(input.leaseSeconds === undefined ? {} : { leaseSeconds: input.leaseSeconds }),
          });
          if (!resumed.ok) return resumed;
          const resumedGoal = resumed.value;
          const leaseToken = resumedGoal.leaseToken;
          if (!resumedGoal.acquired || leaseToken === undefined) return ok(resumedGoal);
          let current = resumedGoal;
          const existingEngineering = resumedGoal.engineering;
          const releaseAcquiredLease = (summary: string, failureDetail: string): ReturnType<typeof goals.checkpointGoal> => {
            const previousResumeContext = resumedGoal.lastCheckpoint?.resumeContext ?? {
              changedFiles: [],
              commands: [],
              decisions: [],
              failedAttempts: [],
              pendingValidation: [],
              resumePrerequisites: [],
              stateFacts: [],
              artifacts: [],
            };
            const failureAttempt = failureDetail.slice(0, 1_024);
            let priorFailedAttempts = [...previousResumeContext.failedAttempts.slice(-99)];
            const withFailureAttempt = (detail: string): GoalCheckpointResumeContext => ({
              ...previousResumeContext,
              failedAttempts: [...priorFailedAttempts, detail],
            });
            let resumeContext = withFailureAttempt(failureAttempt);
            const fitsResumeContext = (candidate: GoalCheckpointResumeContext): boolean => JSON.stringify(candidate).length <= MAX_ENGINEERING_RESUME_CONTEXT_LENGTH;
            while (!fitsResumeContext(resumeContext) && priorFailedAttempts.length > 0) {
              priorFailedAttempts = priorFailedAttempts.slice(1);
              resumeContext = withFailureAttempt(failureAttempt);
            }
            let releaseSummary = summary;
            if (!fitsResumeContext(resumeContext)) {
              let low = 1;
              let high = failureAttempt.length;
              let fittingLength = 0;
              while (low <= high) {
                const middle = Math.floor((low + high) / 2);
                const candidate = withFailureAttempt(failureAttempt.slice(0, middle));
                if (fitsResumeContext(candidate)) {
                  fittingLength = middle;
                  low = middle + 1;
                } else {
                  high = middle - 1;
                }
              }
              if (fittingLength > 0) {
                resumeContext = withFailureAttempt(failureAttempt.slice(0, fittingLength));
                releaseSummary = `${summary}; ${failureAttempt}`;
              } else {
                resumeContext = previousResumeContext;
                releaseSummary = `${summary}; ${failureAttempt}`;
              }
            }
            return goals.checkpointGoal(context.actor, {
              goalId: resumedGoal.goalId,
              leaseToken,
              expectedRevision: resumedGoal.revision,
              expectedUserIntentRevision: resumedGoal.userIntentRevision,
              currentPhase: resumedGoal.currentPhase,
              summary: releaseSummary,
              stepUpdates: [],
              nextAction: resumedGoal.nextAction,
              blockers: resumedGoal.blockers,
              evidence: resumedGoal.lastCheckpoint?.evidence ?? [],
              trackedTasks: resumedGoal.trackedTasks,
              resumeContext,
              releaseLease: true,
            });
          };
          if (existingEngineering === undefined) {
            const released = await releaseAcquiredLease(
              'Released Engineering Harness lease because the acquired goal metadata was missing.',
              'The acquired Engineering Harness goal is missing its metadata.',
            );
            return released.ok ? err(appError('INTERNAL_ERROR', 'Acquired Engineering Harness goal is missing its metadata')) : released;
          }
          if (input.scopedPath === undefined && existingEngineering.scopedPath !== effectiveScopedPath) {
            const acquiredScopePrepared = await preparation.prepare(input.workspaceId, input.objective, existingEngineering.scopedPath);
            if (!acquiredScopePrepared.ok) {
              const released = await releaseAcquiredLease(
                'Released Engineering Harness lease after acquired-scope preparation failed.',
                `Acquired-scope Engineering preparation failed (${acquiredScopePrepared.error.code}): ${acquiredScopePrepared.error.message}`,
              );
              return released.ok ? acquiredScopePrepared : released;
            }
            prepared = acquiredScopePrepared;
            effectiveScopedPath = existingEngineering.scopedPath;
            continuingThroughProjectOptOut = !prepared.value.policy.enabled && prepared.value.policy.source === 'project';
            if (!prepared.value.policy.enabled && !continuingThroughProjectOptOut) {
              const inactive = err(appError('INVALID_INPUT', `Engineering Harness is inactive: ${prepared.value.policy.reasons.join(' ')}`));
              const released = await releaseAcquiredLease(
                'Released Engineering Harness lease because the acquired scope is no longer enabled.',
                `Acquired-scope Engineering preparation is disabled: ${prepared.value.policy.reasons.join(' ')}`,
              );
              return released.ok ? inactive : released;
            }
          }
          const nextEngineering = engineeringGoalMetadata(prepared.value.policy.policyDigest, prepared.value.workflow, effectiveScopedPath);
          if (!continuingThroughProjectOptOut && (existingEngineering.policyDigest !== nextEngineering.policyDigest || !sameEngineeringMetadataContract(existingEngineering, nextEngineering))) {
            const reconciled = reconcileEngineeringMetadata(existingEngineering, prepared.value.policy.policyDigest, prepared.value.workflow, resumedGoal.userIntentRevision, effectiveScopedPath);
            const checkpointDetails = engineeringMetadataCheckpointDetails(existingEngineering, reconciled, resumedGoal.lastCheckpoint?.resumeContext ?? undefined);
            const checkpointed = await goals.checkpointGoal(context.actor, {
              goalId: resumedGoal.goalId,
              leaseToken,
              expectedRevision: resumedGoal.revision,
              expectedUserIntentRevision: resumedGoal.userIntentRevision,
              currentPhase: resumedGoal.currentPhase,
              summary: 'Reconciled changed Engineering Harness workflow metadata before resume.',
              stepUpdates: [],
              nextAction: resumedGoal.nextAction,
              blockers: resumedGoal.blockers,
              evidence: checkpointDetails.evidence,
              resumeContext: checkpointDetails.resumeContext,
              trackedTasks: resumedGoal.trackedTasks,
              engineering: reconciled,
            });
            if (!checkpointed.ok) {
              const released = await releaseAcquiredLease(
                'Released Engineering Harness lease after metadata reconciliation failed.',
                `Engineering metadata reconciliation failed (${checkpointed.error.code}): ${checkpointed.error.message}`,
              );
              return released.ok ? checkpointed : released;
            }
            current = { ...resumed.value, ...checkpointed.value };
          }
          return ok({
            ...current,
            acquired: true,
            leaseToken,
            engineeringTask: {
              goalId: current.goalId,
              policyDigest: current.engineering?.policyDigest ?? prepared.value.policy.policyDigest,
              goalRevision: current.revision,
              userIntentRevision: current.userIntentRevision,
              ...(effectiveScopedPath === undefined ? {} : { scopedPath: effectiveScopedPath }),
              ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
            },
          });
        }
        if (existing.error.code !== 'INVALID_INPUT') return existing;
        const started = await goals.runGoal(context.actor, {
          workspaceId: input.workspaceId,
          goalKey: input.goalKey,
          objective: input.objective,
          plan: { steps: prepared.value.workflow.workflow.map((step) => ({ id: step.id, title: step.title })) },
          engineering: engineeringGoalMetadata(prepared.value.policy.policyDigest, prepared.value.workflow, effectiveScopedPath),
          ...(input.leaseSeconds === undefined ? {} : { leaseSeconds: input.leaseSeconds }),
        });
        if (!started.ok) return started;
        if (!started.value.acquired || started.value.leaseToken === undefined) return ok(started.value);
        return ok({
          ...started.value,
          engineeringTask: {
            goalId: started.value.goalId,
            policyDigest: prepared.value.policy.policyDigest,
            goalRevision: started.value.revision,
            userIntentRevision: started.value.userIntentRevision,
            ...(effectiveScopedPath === undefined ? {} : { scopedPath: effectiveScopedPath }),
            ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
          },
        });
      },
    }),
    defineTool({
      name: 'engineering_get_status',
      description: 'Read the current Engineering Harness task projection, effective policy, required gates, blockers, and truthful delivery boundary without changing goal state.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: engineeringGetStatusSchema,
      handler: async (input) => {
        if (context.services.goals === undefined || context.services.engineeringPreparation === undefined) return missingService();
        const goal = await context.services.goals.getGoal(context.actor, { goalId: input.goalId });
        if (!goal.ok) return goal;
        if (goal.value.engineering === undefined) return err(appError('INVALID_INPUT', 'Goal is not an Engineering Harness task'));
        const prepared = await context.services.engineeringPreparation.prepare(goal.value.workspaceId, goal.value.objective, goal.value.engineering.scopedPath);
        if (!prepared.ok) return prepared;
        const unresolvedGateIds = goal.value.engineering.gates
          .filter((gate) => gate.status === 'passed'
            ? gate.evidence === undefined || (requiresHostObservedEngineeringEvidence(gate.id) && gate.evidence.source !== 'host_observed')
            : gate.status === 'not_applicable'
              ? gate.reason.trim().length === 0 || !mayMarkEngineeringGateNotApplicable(gate)
              : gate.applicability === 'required')
          .map((gate) => gate.id);
        const policyChanged = prepared.value.policy.policyDigest !== goal.value.engineering.policyDigest;
        const incompleteAcceptanceIds = goal.value.acceptanceCriteria
          .filter((criterion) => criterion.status !== 'completed').map((criterion) => criterion.id);
        const incompleteStepIds = goal.value.plan.steps
          .filter((step) => step.status !== 'completed').map((step) => step.id);
        const blockingTasks = goal.value.trackedTasks.filter((task) => task.role === 'blocking_job');
        const deliveryBoundary = goal.value.status !== 'active'
          ? goal.value.status
          : goal.value.blockers.length > 0
            ? 'blocked'
            : policyChanged || unresolvedGateIds.length > 0 || incompleteAcceptanceIds.length > 0 || incompleteStepIds.length > 0 || blockingTasks.length > 0
              ? 'checks_pending'
              : goal.value.engineering.deliveryScope === 'local'
                ? 'ready_locally'
                : `${goal.value.engineering.deliveryScope}_ready`;
        return ok({
          goalId: goal.value.goalId,
          workspaceId: goal.value.workspaceId,
          status: goal.value.status,
          currentPhase: goal.value.currentPhase,
          nextAction: goal.value.nextAction,
          blockers: goal.value.blockers,
          acceptanceCriteria: goal.value.acceptanceCriteria,
          incompleteAcceptanceIds,
          incompleteStepIds,
          primaryTaskKind: goal.value.engineering.primaryTaskKind,
          riskTier: goal.value.engineering.riskTier,
          deliveryScope: goal.value.engineering.deliveryScope,
          gates: goal.value.engineering.gates,
          unresolvedGateIds,
          deliveryBoundary,
          effectivePolicy: prepared.value.policy,
          policyChanged,
          engineeringTask: {
            goalId: goal.value.goalId,
            policyDigest: goal.value.engineering.policyDigest,
            goalRevision: goal.value.revision,
            userIntentRevision: goal.value.userIntentRevision,
            ...(goal.value.engineering.scopedPath === undefined ? {} : { scopedPath: goal.value.engineering.scopedPath }),
            ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
          },
        });
      },
    }),
  ];
}

function reconcileEngineeringMetadata(
  current: EngineeringGoalMetadata,
  policyDigest: string,
  workflow: EngineeringWorkflowPlan,
  userIntentRevision: number,
  scopedPath?: string,
): EngineeringGoalMetadata {
  const next = engineeringGoalMetadata(policyDigest, workflow, scopedPath);
  const previousGates = new Map(current.gates.map((gate) => [gate.id, gate] as const));
  return {
    ...next,
    gates: next.gates.map((gate) => {
      if (gate.applicability === 'not_applicable') return { ...gate, basedOnUserIntentRevision: userIntentRevision };
      const previous = previousGates.get(gate.id);
      if (previous === undefined) return { ...gate, status: 'pending', basedOnUserIntentRevision: userIntentRevision };
      if (current.scopedPath !== scopedPath && SCOPE_DEPENDENT_ENGINEERING_GATES.has(gate.id)) {
        return {
          ...gate,
          status: 'stale',
          reason: `Engineering task scope changed; revalidate. ${gate.reason}`,
          basedOnUserIntentRevision: userIntentRevision,
        };
      }
      if (sameEngineeringGateContract(previous, gate)) return { ...previous, basedOnUserIntentRevision: userIntentRevision };
      return {
        ...gate,
        status: 'stale',
        reason: `Engineering gate contract changed; revalidate. ${gate.reason}`,
        basedOnUserIntentRevision: userIntentRevision,
      };
    }),
    ...(current.reviewFindings === undefined ? {} : { reviewFindings: current.reviewFindings }),
  };
}

function sameEngineeringGateContract(current: EngineeringGoalMetadata['gates'][number], next: EngineeringGoalMetadata['gates'][number]): boolean {
  const currentPlatforms = [...new Set(current.requiredPlatforms ?? [])].sort();
  const nextPlatforms = [...new Set(next.requiredPlatforms ?? [])].sort();
  return current.title === next.title
    && current.applicability === next.applicability
    && current.reason === next.reason
    && current.checkCommand === next.checkCommand
    && currentPlatforms.length === nextPlatforms.length
    && currentPlatforms.every((platform, index) => platform === nextPlatforms[index]);
}

function engineeringMetadataCheckpointDetails(
  previous: EngineeringGoalMetadata,
  next: EngineeringGoalMetadata,
  previousContext: GoalCheckpointResumeContext | undefined,
): { readonly evidence: readonly GoalEvidence[]; readonly resumeContext: GoalCheckpointResumeContext } {
  const previousGates = new Map(previous.gates.map((gate) => [gate.id, gate] as const));
  const nextGates = new Map(next.gates.map((gate) => [gate.id, gate] as const));
  const addedGateIds = next.gates.filter((gate) => !previousGates.has(gate.id)).map((gate) => gate.id);
  const removedGateIds = previous.gates.filter((gate) => !nextGates.has(gate.id)).map((gate) => gate.id);
  const changedGateIds = next.gates.filter((gate) => {
    const oldGate = previousGates.get(gate.id);
    return oldGate !== undefined && !sameEngineeringGateContract(oldGate, gate);
  }).map((gate) => gate.id);
  const staleGateIds = next.gates.filter((gate) => gate.status === 'stale').map((gate) => gate.id);
  const pendingGateIds = next.gates.filter((gate) => gate.applicability === 'required' && gate.status !== 'passed').map((gate) => gate.id);
  const previousClassification = engineeringClassification(previous);
  const nextClassification = engineeringClassification(next);
  const classificationDecision = previousClassification === nextClassification
    ? `Engineering classification remains ${previousClassification}.`
    : `Engineering classification changed from ${previousClassification} to ${nextClassification}.`;
  const gateDiff = `Gate contract diff: added [${formatGateIds(addedGateIds)}], changed [${formatGateIds(changedGateIds)}], removed [${formatGateIds(removedGateIds)}], stale [${formatGateIds(staleGateIds)}].`;
  const scopeFact = previous.scopedPath === next.scopedPath
    ? undefined
    : `Scoped path changed from ${previous.scopedPath?.slice(0, 256) ?? '(none)'} to ${next.scopedPath?.slice(0, 256) ?? '(none)'}.`;
  const stateFactAdditions: readonly GoalEvidence[] = [
    { kind: 'note', value: `Previous Engineering classification: ${previousClassification}.` },
    { kind: 'note', value: `Reconciled Engineering classification: ${nextClassification}.` },
    { kind: 'note', value: gateDiff },
    ...(scopeFact === undefined ? [] : [{ kind: 'note' as const, value: scopeFact }]),
  ];
  const evidenceValue = [classificationDecision, gateDiff, ...(scopeFact === undefined ? [] : [scopeFact])].join(' ');
  const previousEngineeringGateIds = new Set(previous.gates.map((gate) => gate.id));
  const preservedPendingValidation = (previousContext?.pendingValidation ?? []).filter((validation) => {
    const match = /^Engineering gate ([^ ]+) remains .+ and must be verified before completion\.$/.exec(validation);
    return match === null || !previousEngineeringGateIds.has(match[1]!);
  });
  const pendingValidation = pendingGateIds.map((gateId) => `Engineering gate ${gateId} remains ${nextGates.get(gateId)?.status ?? 'pending'} and must be verified before completion.`);

  const previousResumeContext: GoalCheckpointResumeContext = {
    changedFiles: previousContext?.changedFiles ?? [],
    commands: previousContext?.commands ?? [],
    decisions: previousContext?.decisions ?? [],
    failedAttempts: previousContext?.failedAttempts ?? [],
    pendingValidation: preservedPendingValidation,
    resumePrerequisites: previousContext?.resumePrerequisites ?? [],
    stateFacts: previousContext?.stateFacts ?? [],
    artifacts: previousContext?.artifacts ?? [],
  };
  let resumeContext = appendCheckpointStringsWithinLimit(previousResumeContext, 'decisions', [classificationDecision, gateDiff]);
  resumeContext = appendCheckpointStringsWithinLimit(resumeContext, 'pendingValidation', pendingValidation);
  resumeContext = appendCheckpointEvidenceWithinLimit(resumeContext, stateFactAdditions);

  return {
    evidence: [{ kind: 'note', value: evidenceValue }],
    resumeContext,
  };
}

function engineeringClassification(metadata: EngineeringGoalMetadata): string {
  return `${metadata.primaryTaskKind} / ${metadata.riskTier} / ${metadata.deliveryScope}`;
}

function formatGateIds(ids: readonly string[]): string {
  if (ids.length === 0) return 'none';
  const shown = ids.slice(0, 6).map((id) => id.slice(0, 64));
  return `${shown.join(', ')}${ids.length > shown.length ? `, +${ids.length - shown.length} more` : ''}`;
}

function appendCheckpointStringsWithinLimit(
  resumeContext: GoalCheckpointResumeContext,
  field: 'decisions' | 'pendingValidation',
  additions: readonly string[],
): GoalCheckpointResumeContext {
  let result = resumeContext;
  for (const addition of additions) {
    const existing = result[field];
    if (existing.includes(addition) || existing.length >= 100 || addition.length > 1_024) continue;
    const candidate: GoalCheckpointResumeContext = { ...result, [field]: [...existing, addition] };
    if (JSON.stringify(candidate).length > MAX_ENGINEERING_RESUME_CONTEXT_LENGTH - ENGINEERING_RESUME_CONTEXT_NORMALIZATION_HEADROOM) continue;
    result = candidate;
  }
  return result;
}

function appendCheckpointEvidenceWithinLimit(
  resumeContext: GoalCheckpointResumeContext,
  additions: readonly GoalEvidence[],
): GoalCheckpointResumeContext {
  let result = resumeContext;
  for (const addition of additions) {
    if (result.stateFacts.length >= 100 || addition.value.length > 1_024
      || result.stateFacts.some((entry) => entry.kind === addition.kind && entry.value === addition.value)) continue;
    const candidate: GoalCheckpointResumeContext = { ...result, stateFacts: [...result.stateFacts, addition] };
    if (JSON.stringify(candidate).length > MAX_ENGINEERING_RESUME_CONTEXT_LENGTH - ENGINEERING_RESUME_CONTEXT_NORMALIZATION_HEADROOM) continue;
    result = candidate;
  }
  return result;
}

function sameEngineeringMetadataContract(current: EngineeringGoalMetadata, next: EngineeringGoalMetadata): boolean {
  if (current.primaryTaskKind !== next.primaryTaskKind
    || current.riskTier !== next.riskTier
    || current.deliveryScope !== next.deliveryScope
    || current.scopedPath !== next.scopedPath
    || current.gates.length !== next.gates.length) return false;
  const currentGates = new Map(current.gates.map((gate) => [gate.id, gate] as const));
  return next.gates.every((gate) => {
    const previous = currentGates.get(gate.id);
    return previous !== undefined && sameEngineeringGateContract(previous, gate);
  });
}
