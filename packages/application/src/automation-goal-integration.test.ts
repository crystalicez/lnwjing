import { describe, expect, it, vi } from 'vitest';
import { ok, type AutomationMilestoneDefinition } from '@lnwjing/domain';
import { SqliteAutomationRepository } from '../../storage/src/automation-repository.js';
import { SqliteDatabase } from '../../storage/src/database.js';
import { SqliteGoalRepository } from '../../storage/src/goal-repository.js';
import { SqliteWorkspaceRepository } from '../../storage/src/workspace-repository.js';
import { AutomationService, type AutomationDispatchPort, type MutateAutomationRunRequest } from './automation-service.js';
import type { AutomationVerificationPort } from './automation-verifier.js';
import type { FileActor } from './file-service.js';
import { GoalContinuationService } from './goal-continuation-service.js';

const actor: FileActor = { clientId: 'client-a', clientName: 'Client A', sessionId: 'session-a' };
const now = '2026-09-20T10:00:00.000Z';

interface IntegrationFixture {
  readonly database: SqliteDatabase;
  readonly goals: GoalContinuationService;
  readonly service: AutomationService;
  readonly goalId: string;
  readonly leaseToken: string;
  readonly runId: string;
}

describe('AutomationService durable goal integration', () => {
  it('checkpoints the exact task binding before return, removes it after terminal evidence and completes the mapped step', async () => {
    const f = await fixture({ milestones: [milestone('build', 'goal-build', 'supporting_service', false)] });
    try {
      const launched = await f.service.advance(actor, mutation(f, 0));
      expect(launched).toMatchObject({ ok: true, value: { boundary: 'dispatched', run: { run: { revision: 3 } } } });
      if (!launched.ok) throw new Error(launched.error.message);
      const taskId = launched.value.taskId!;
      expect(await f.goals.getGoal(actor, { goalId: f.goalId })).toMatchObject({
        ok: true,
        value: {
          activeTaskIds: [],
          trackedTasks: [{ taskId, provider: 'shell', role: 'supporting_service', cancelWithGoal: false }],
          plan: { steps: [{ id: 'goal-build', status: 'in_progress' }] },
        },
      });

      const terminal = await f.service.advance(actor, mutation(f, 3));
      expect(terminal).toMatchObject({ ok: true, value: { boundary: 'verification_pending', run: { run: { revision: 4 } } } });
      expect(await f.goals.getGoal(actor, { goalId: f.goalId })).toMatchObject({
        ok: true,
        value: { trackedTasks: [], plan: { steps: [{ id: 'goal-build', status: 'in_progress' }] } },
      });

      const verified = await f.service.advance(actor, mutation(f, 4));
      expect(verified).toMatchObject({ ok: true, value: { boundary: 'verified', run: { run: { revision: 5 } } } });
      expect(await f.goals.getGoal(actor, { goalId: f.goalId })).toMatchObject({
        ok: true,
        value: { trackedTasks: [], plan: { steps: [{ id: 'goal-build', status: 'completed' }] } },
      });
    } finally {
      f.database.close();
    }
  });

  it('does not complete a shared root step until every linked milestone verifies', async () => {
    const f = await fixture({
      milestones: [
        milestone('compile', 'goal-build', 'blocking_job', true),
        milestone('package', 'goal-build', 'blocking_job', true),
      ],
    });
    try {
      await f.service.advance(actor, mutation(f, 0));
      await f.service.advance(actor, mutation(f, 3));
      await f.service.advance(actor, mutation(f, 4));
      expect(await f.goals.getGoal(actor, { goalId: f.goalId })).toMatchObject({
        ok: true,
        value: { plan: { steps: [{ id: 'goal-build', status: 'in_progress' }] } },
      });

      await f.service.advance(actor, mutation(f, 5));
      await f.service.advance(actor, mutation(f, 8));
      await f.service.advance(actor, mutation(f, 9));
      expect(await f.goals.getGoal(actor, { goalId: f.goalId })).toMatchObject({
        ok: true,
        value: { plan: { steps: [{ id: 'goal-build', status: 'completed' }] } },
      });
    } finally {
      f.database.close();
    }
  });

  it('finalizes only after re-reading verified evidence and confirms the root goal is terminal', async () => {
    const f = await fixture({ milestones: [milestone('build', 'goal-build', 'blocking_job', true)] });
    try {
      await f.service.advance(actor, mutation(f, 0));
      await f.service.advance(actor, mutation(f, 3));

      const tooEarly = await f.service.finalize(actor, mutation(f, 4));
      expect(tooEarly).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      await f.service.advance(actor, mutation(f, 4));
      const finalized = await f.service.finalize(actor, mutation(f, 5));
      expect(finalized).toMatchObject({
        ok: true,
        value: {
          run: { run: { status: 'completed', revision: 7 } },
          goal: { goalId: f.goalId, status: 'completed' },
        },
      });
      expect(await f.goals.getGoal(actor, { goalId: f.goalId })).toMatchObject({
        ok: true,
        value: { status: 'completed', trackedTasks: [] },
      });
    } finally {
      f.database.close();
    }
  });

  it('preserves supporting-service cancellation policy when the root goal is cancelled', async () => {
    const cancelForGoal = vi.fn(async () => []);
    const f = await fixture({
      milestones: [milestone('watch', 'goal-build', 'supporting_service', false)],
      taskCancellation: { cancelForGoal },
    });
    try {
      await f.service.advance(actor, mutation(f, 0));
      const cancelled = await f.service.cancel(actor, { ...mutation(f, 3), summary: 'Stop automation.' });
      expect(cancelled).toMatchObject({ ok: true, value: { run: { status: 'cancelled' } } });
      expect(cancelForGoal).not.toHaveBeenCalled();
      expect(await f.goals.getGoal(actor, { goalId: f.goalId })).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    } finally {
      f.database.close();
    }
  });
});

async function fixture(input: {
  readonly milestones: readonly ReturnType<typeof milestone>[];
  readonly taskCancellation?: { cancelForGoal: (...args: never[]) => Promise<readonly never[]> };
}): Promise<IntegrationFixture> {
  const database = new SqliteDatabase(':memory:');
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: 'workspace-a', displayName: 'Workspace A', rootPath: 'C:\\workspace-a', realRootPath: 'C:\\workspace-a', createdAt: now,
  });
  const goals = new GoalContinuationService(workspaces, new SqliteGoalRepository(database), {
    now: (): Date => new Date(now),
    ...(input.taskCancellation === undefined ? {} : { taskCancellation: input.taskCancellation }),
  });
  const started = await goals.runGoal(actor, {
    workspaceId: 'workspace-a', goalKey: 'automation-goal-integration', objective: 'Run automation safely.',
    plan: { steps: [{ id: 'goal-build', title: 'Build' }] }, leaseSeconds: 600,
  });
  if (!started.ok || started.value.leaseToken === undefined) throw new Error('failed to start goal');
  const dispatch: AutomationDispatchPort = {
    launch: vi.fn(async () => ok({ presence: 'found', state: 'running', observedAt: now })),
    observe: vi.fn(async () => ok({ presence: 'found', state: 'completed', terminalState: 'completed:0', observedAt: now })),
  };
  const verifier: AutomationVerificationPort = {
    verify: vi.fn(async (_actor, request) => ok({
      status: 'verified',
      evidence: request.milestone.verification.map((requirement) => ({
        requirementId: requirement.id,
        kind: requirement.kind,
        status: 'verified' as const,
        observedAt: now,
        observedDigest: request.attempt.requestDigest,
        observedTaskId: request.attempt.taskId,
        observedExitCode: 0,
        detail: 'completed',
      })),
    })),
  };
  const repository = new SqliteAutomationRepository(database);
  const service = new AutomationService(repository, goals, dispatch, verifier, {
    now: (): Date => new Date(now), idFactory: (): string => 'run-a',
  });
  const created = await service.createRun(actor, {
    workspaceId: 'workspace-a', goalId: started.value.goalId, leaseToken: started.value.leaseToken,
    plan: { milestones: input.milestones },
  });
  if (!created.ok) throw new Error(created.error.message);
  return {
    database,
    goals,
    service,
    goalId: started.value.goalId,
    leaseToken: started.value.leaseToken,
    runId: created.value.run.id,
  };
}

function mutation(f: IntegrationFixture, expectedRevision: number): MutateAutomationRunRequest {
  return {
    workspaceId: 'workspace-a', runId: f.runId, leaseToken: f.leaseToken, expectedRevision, userConfirmed: true,
  } as const;
}

function milestone(id: string, goalStepId: string, role: 'blocking_job' | 'supporting_service', cancelWithGoal: boolean): AutomationMilestoneDefinition {
  return {
    id,
    title: id,
    goalStepId,
    dependsOn: [],
    provider: 'shell',
    role,
    cancelWithGoal,
    dispatch: {
      executable: 'node', arguments: ['--version'], cwd: 'C:\\workspace-a', timeoutSeconds: 60,
      maxOutputBytes: 1024, includeStdout: true, includeStderr: true,
    },
    verification: [{ id: `${id}-exit`, kind: 'command_exit', expectedExitCode: 0 }],
  } as const;
}
