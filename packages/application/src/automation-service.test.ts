import { describe, expect, it, vi } from 'vitest';
import { ok, type AutomationPlan, type StoredAutomationRun } from '@lnwjing/domain';
import { SqliteAutomationRepository } from '../../storage/src/automation-repository.js';
import { SqliteDatabase } from '../../storage/src/database.js';
import { SqliteGoalRepository } from '../../storage/src/goal-repository.js';
import { SqliteWorkspaceRepository } from '../../storage/src/workspace-repository.js';
import {
  AutomationService,
  createAutomationDispatchReservation,
  type AutomationDispatchPort,
} from './automation-service.js';
import type { FileActor } from './file-service.js';
import { GoalContinuationService, type RunGoalResult } from './goal-continuation-service.js';
import type { AutomationVerificationPort } from './automation-verifier.js';

const actor: FileActor = { clientId: 'client-a', clientName: 'Client A', sessionId: 'session-a' };
const otherClient: FileActor = { clientId: 'client-b', clientName: 'Client B', sessionId: 'session-b' };
const otherSession: FileActor = { clientId: 'client-a', clientName: 'Client A', sessionId: 'session-b' };

interface Fixture {
  readonly database: SqliteDatabase;
  readonly goals: GoalContinuationService;
  readonly repository: SqliteAutomationRepository;
  readonly service: AutomationService;
  readonly started: RunGoalResult;
  readonly dispatch: AutomationDispatchPort;
  readonly verifier: AutomationVerificationPort;
  readonly setNow: (value: string) => void;
}

async function fixture(
  overrides: Partial<AutomationDispatchPort> = {},
  verification?: AutomationVerificationPort['verify'],
): Promise<Fixture> {
  const database = new SqliteDatabase(':memory:');
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: 'workspace-a',
    displayName: 'Workspace A',
    rootPath: 'C:\\workspace-a',
    realRootPath: 'C:\\workspace-a',
    createdAt: '2026-09-20T10:00:00.000Z',
  });
  await workspaces.insert({
    id: 'workspace-b',
    displayName: 'Workspace B',
    rootPath: 'C:\\workspace-b',
    realRootPath: 'C:\\workspace-b',
    createdAt: '2026-09-20T10:00:00.000Z',
  });
  let now = new Date('2026-09-20T10:00:00.000Z');
  const nowProvider = (): Date => now;
  const goals = new GoalContinuationService(workspaces, new SqliteGoalRepository(database), { now: nowProvider });
  const startedResult = await goals.runGoal(actor, {
    workspaceId: 'workspace-a',
    goalKey: 'automation-service-test',
    objective: 'Exercise durable automation safely.',
    plan: {
      steps: [
        { id: 'goal-first', title: 'Run the first milestone' },
        { id: 'goal-second', title: 'Run the second milestone' },
      ],
    },
    leaseSeconds: 600,
  });
  if (!startedResult.ok || startedResult.value.leaseToken === undefined) throw new Error('failed to start fixture goal');
  const launch = vi.fn<AutomationDispatchPort['launch']>(async () => ok({
    presence: 'found',
    state: 'running',
    observedAt: nowProvider().toISOString(),
  }));
  const observe = vi.fn<AutomationDispatchPort['observe']>(async () => ok({
    presence: 'unknown',
    observedAt: nowProvider().toISOString(),
    detail: 'fixture has no observation',
  }));
  const dispatch: AutomationDispatchPort = {
    launch,
    observe,
    ...overrides,
  };
  const repository = new SqliteAutomationRepository(database);
  const verifier: AutomationVerificationPort = {
    verify: vi.fn<AutomationVerificationPort['verify']>(verification ?? (async (_actor, request): ReturnType<AutomationVerificationPort['verify']> => ok({
      status: 'pending',
      evidence: request.milestone.verification.map((requirement) => ({
        requirementId: requirement.id,
        kind: requirement.kind,
        status: 'pending',
        observedAt: nowProvider().toISOString(),
        detail: 'running',
      })),
    }))),
  };
  const service = new AutomationService(repository, goals, dispatch, verifier, {
    now: nowProvider,
    idFactory: (): string => 'run-a',
  });
  return {
    database,
    goals,
    repository,
    service,
    started: startedResult.value,
    dispatch,
    verifier,
    setNow: (value: string): void => { now = new Date(value); },
  };
}

function plan(): AutomationPlan {
  return {
    milestones: [
      {
        id: 'first',
        title: 'First',
        goalStepId: 'goal-first',
        dependsOn: [],
        provider: 'shell',
        role: 'supporting_service',
        cancelWithGoal: false,
        dispatch: {
          executable: 'node',
          arguments: ['--version'],
          cwd: 'C:\\workspace-a',
          timeoutSeconds: 60,
          maxOutputBytes: 1024,
          includeStdout: true,
          includeStderr: true,
        },
        verification: [{ id: 'first-exit', kind: 'command_exit', expectedExitCode: 0 }],
      },
      {
        id: 'second',
        title: 'Second',
        goalStepId: 'goal-second',
        dependsOn: [],
        provider: 'shell',
        role: 'blocking_job',
        cancelWithGoal: true,
        dispatch: {
          executable: 'node',
          arguments: ['--help'],
          cwd: 'C:\\workspace-a',
          timeoutSeconds: 60,
          maxOutputBytes: 1024,
          includeStdout: true,
          includeStderr: true,
        },
        verification: [{ id: 'second-exit', kind: 'command_exit', expectedExitCode: 0 }],
      },
    ],
  } as const;
}

async function createRun(f: Fixture): Promise<StoredAutomationRun> {
  const created = await f.service.createRun(actor, {
    workspaceId: 'workspace-a',
    goalId: f.started.goalId,
    leaseToken: f.started.leaseToken!,
    plan: plan(),
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe('AutomationService', () => {
  it('binds a validated DAG to an existing active goal without creating a goal or schedule', async () => {
    const f = await fixture();
    try {
      const beforeGoals = f.database.connection.prepare('SELECT COUNT(*) AS count FROM goals').get();
      const created = await createRun(f);

      expect(created).toMatchObject({
        run: { id: 'run-a', goalId: f.started.goalId, workspaceId: 'workspace-a', ownerClientId: 'client-a', revision: 0 },
        milestones: [
          { id: 'first', role: 'supporting_service', cancelWithGoal: false, status: 'pending' },
          { id: 'second', role: 'blocking_job', cancelWithGoal: true, status: 'pending' },
        ],
      });
      expect(f.database.connection.prepare('SELECT COUNT(*) AS count FROM goals').get()).toEqual(beforeGoals);
      expect(f.database.connection.prepare('SELECT COUNT(*) AS count FROM goal_scheduled_continuations').get()).toEqual({ count: 0 });

      const missingStep = await f.service.createRun(actor, {
        workspaceId: 'workspace-a',
        goalId: f.started.goalId,
        leaseToken: f.started.leaseToken!,
        plan: {
          milestones: [{ ...plan().milestones[0], goalStepId: 'missing-goal-step' }],
        },
      });
      expect(missingStep).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      f.database.close();
    }
  });

  it('hides runs across clients/workspaces and requires the current session-bound lease for every mutation', async () => {
    const f = await fixture();
    try {
      const created = await createRun(f);
      expect(await f.service.status(otherClient, { workspaceId: 'workspace-a', runId: created.run.id }))
        .toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
      expect(await f.service.status(actor, { workspaceId: 'workspace-b', runId: created.run.id }))
        .toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });

      const wrongSession = await f.service.advance(otherSession, {
        workspaceId: 'workspace-a',
        runId: created.run.id,
        expectedRevision: created.run.revision,
        leaseToken: f.started.leaseToken!,
      });
      expect(wrongSession).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      const bypassWithoutLease = await f.service.advance(actor, {
        workspaceId: 'workspace-a',
        runId: created.run.id,
        expectedRevision: created.run.revision,
        leaseToken: '',
        authorization: { mode: 'full', bypassApplicationAuthorization: true },
      } as never);
      expect(bypassWithoutLease).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      f.setNow('2026-09-20T10:11:00.000Z');
      const expired = await f.service.pause(actor, {
        workspaceId: 'workspace-a',
        runId: created.run.id,
        expectedRevision: created.run.revision,
        leaseToken: f.started.leaseToken!,
      });
      expect(expired).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      f.database.close();
    }
  });

  it('selects the first ready milestone deterministically and only one concurrent advance reserves or launches it', async () => {
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const launch = vi.fn<AutomationDispatchPort['launch']>(async (): ReturnType<AutomationDispatchPort['launch']> => {
      await launchGate;
      return ok({ presence: 'found' as const, state: 'running' as const, observedAt: '2026-09-20T10:00:01.000Z' });
    });
    const f = await fixture({ launch });
    try {
      const created = await createRun(f);
      const request = {
        workspaceId: 'workspace-a',
        runId: created.run.id,
        expectedRevision: created.run.revision,
        leaseToken: f.started.leaseToken!,
      };
      const first = f.service.advance(actor, request);
      const concurrent = await f.service.advance(actor, request);
      expect(concurrent).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      releaseLaunch();
      const advanced = await first;

      expect(advanced).toMatchObject({
        ok: true,
        value: {
          boundary: 'dispatched',
          milestoneId: 'first',
          run: {
            run: { revision: 3 },
            milestones: [
              { id: 'first', status: 'running', role: 'supporting_service', cancelWithGoal: false, attemptCount: 1 },
              { id: 'second', status: 'pending' },
            ],
            attempts: [{ milestoneId: 'first', ordinal: 1, dispatchStatus: 'launched' }],
          },
        },
      });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0]?.[1]).toMatchObject({
        context: {
          runId: 'run-a',
          milestoneId: 'first',
          goalId: f.started.goalId,
          workspaceId: 'workspace-a',
        },
        role: 'supporting_service',
        cancelWithGoal: false,
      });
    } finally {
      releaseLaunch?.();
      f.database.close();
    }
  });

  it('records an unknown launch as blocked and never silently dispatches it again', async () => {
    const launch = vi.fn<AutomationDispatchPort['launch']>(async () => ok({
      presence: 'unknown',
      observedAt: '2026-09-20T10:00:01.000Z',
      detail: 'worker receipt timed out',
    }));
    const observe = vi.fn<AutomationDispatchPort['observe']>(async () => ok({
      presence: 'unknown',
      observedAt: '2026-09-20T10:00:02.000Z',
      detail: 'lookup unavailable',
    }));
    const f = await fixture({ launch, observe });
    try {
      const created = await createRun(f);
      const first = await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 0, leaseToken: f.started.leaseToken!,
      });
      expect(first).toMatchObject({
        ok: true,
        value: {
          boundary: 'blocked',
          run: {
            run: { status: 'blocked', revision: 4 },
            attempts: [{ dispatchStatus: 'dispatched_unresolved' }],
          },
        },
      });
      if (!first.ok) throw new Error(first.error.message);
      expect(first.value.run.milestones[0]).toMatchObject({ id: 'first', status: 'blocked' });

      const second = await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 4, leaseToken: f.started.leaseToken!,
      });
      expect(second).toMatchObject({ ok: true, value: { boundary: 'blocked' } });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(observe).toHaveBeenCalledTimes(1);
    } finally {
      f.database.close();
    }
  });

  it('relaunches only after exact recovery lookup proves the unresolved task absent', async () => {
    const launch = vi.fn<AutomationDispatchPort['launch']>()
      .mockResolvedValueOnce(ok({
        presence: 'unknown', observedAt: '2026-09-20T10:00:01.000Z', detail: 'receipt lost',
      }))
      .mockResolvedValueOnce(ok({
        presence: 'found', state: 'running', observedAt: '2026-09-20T10:00:03.000Z',
      }));
    const observe = vi.fn<AutomationDispatchPort['observe']>(async () => ok({
      presence: 'absent', observedAt: '2026-09-20T10:00:02.000Z',
    }));
    const f = await fixture({ launch, observe });
    try {
      const created = await createRun(f);
      const unresolved = await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 0, leaseToken: f.started.leaseToken!,
      });
      expect(unresolved).toMatchObject({ ok: true, value: { boundary: 'blocked', run: { run: { revision: 4 } } } });

      const recovered = await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 4, leaseToken: f.started.leaseToken!,
      });
      expect(recovered).toMatchObject({
        ok: true,
        value: {
          boundary: 'dispatched',
          run: {
            run: { status: 'active', revision: 9 },
            attempts: [
              { ordinal: 1, dispatchStatus: 'terminal', terminalState: 'absent' },
              { ordinal: 2, dispatchStatus: 'launched' },
            ],
          },
        },
      });
      expect(observe).toHaveBeenCalledTimes(1);
      expect(launch).toHaveBeenCalledTimes(2);
      expect(launch.mock.calls[0]?.[1].context.taskId).not.toBe(launch.mock.calls[1]?.[1].context.taskId);
    } finally {
      f.database.close();
    }
  });

  it('recovers a crash after reservation but before spawn by exact-looking up the same deterministic task ID', async () => {
    const launch = vi.fn<AutomationDispatchPort['launch']>(async () => ok({
      presence: 'found', state: 'running', observedAt: '2026-09-20T10:00:03.000Z',
    }));
    const observe = vi.fn<AutomationDispatchPort['observe']>(async () => ok({
      presence: 'absent', observedAt: '2026-09-20T10:00:02.000Z',
    }));
    const f = await fixture({ launch, observe });
    try {
      const created = await createRun(f);
      const ready = f.repository.transitionMilestone({
        runId: created.run.id, ownerClientId: actor.clientId, workspaceId: 'workspace-a', expectedRevision: 0,
        milestoneId: 'first', status: 'ready', updatedAt: '2026-09-20T10:00:01.000Z',
        event: { kind: 'fixture_ready', milestoneId: 'first', payload: {} },
      });
      if (!ready.ok) throw new Error(ready.error.message);
      const identity = createAutomationDispatchReservation(ready.value, ready.value.milestones[0]!, 1);
      const reserved = f.repository.reserveAttempt({
        runId: created.run.id, ownerClientId: actor.clientId, workspaceId: 'workspace-a', expectedRevision: 1,
        milestoneId: 'first', attemptId: identity.attemptId, ordinal: 1, taskId: identity.taskId,
        requestDigest: identity.requestDigest, updatedAt: '2026-09-20T10:00:01.500Z',
        event: { kind: 'fixture_reserved_before_crash', milestoneId: 'first', attemptId: identity.attemptId, payload: {} },
      });
      if (!reserved.ok) throw new Error(reserved.error.message);

      const recovered = await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 2, leaseToken: f.started.leaseToken!,
      });
      expect(recovered).toMatchObject({
        ok: true,
        value: {
          boundary: 'dispatched',
          run: { run: { revision: 3 }, attempts: [{ id: identity.attemptId, taskId: identity.taskId, dispatchStatus: 'launched' }] },
        },
      });
      expect(observe).toHaveBeenCalledTimes(1);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0]?.[1].context).toMatchObject({ taskId: identity.taskId, requestDigest: identity.requestDigest });
    } finally {
      f.database.close();
    }
  });

  it('observes a launched task without relaunching and advances a terminal task to verification', async () => {
    const observe = vi.fn<AutomationDispatchPort['observe']>(async () => ok({
      presence: 'found',
      state: 'completed',
      terminalState: 'completed:0',
      observedAt: '2026-09-20T10:00:02.000Z',
    }));
    const f = await fixture({ observe });
    try {
      const created = await createRun(f);
      const launched = await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 0, leaseToken: f.started.leaseToken!,
      });
      expect(launched).toMatchObject({ ok: true, value: { boundary: 'dispatched', run: { run: { revision: 3 } } } });

      const terminal = await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 3, leaseToken: f.started.leaseToken!,
      });
      expect(terminal).toMatchObject({
        ok: true,
        value: {
          boundary: 'verification_pending',
          run: {
            run: { revision: 4 },
            attempts: [{ dispatchStatus: 'terminal', terminalState: 'completed:0' }],
          },
        },
      });
      if (!terminal.ok) throw new Error(terminal.error.message);
      expect(terminal.value.run.milestones[0]).toMatchObject({ id: 'first', status: 'verifying' });
      expect(f.dispatch.launch).toHaveBeenCalledTimes(1);
      expect(observe).toHaveBeenCalledTimes(1);
    } finally {
      f.database.close();
    }
  });

  it('persists verifier-produced evidence and completes the milestone atomically', async () => {
    const observe = vi.fn<AutomationDispatchPort['observe']>(async () => ok({
      presence: 'found', state: 'completed', terminalState: 'completed:0', observedAt: '2026-09-20T10:00:02.000Z',
    }));
    const verify = vi.fn<AutomationVerificationPort['verify']>(async (_actor, request) => ok({
      status: 'verified',
      evidence: [{
        requirementId: 'first-exit', kind: 'command_exit', status: 'verified',
        observedAt: '2026-09-20T10:00:03.000Z', observedDigest: request.attempt.requestDigest,
        observedTaskId: request.attempt.taskId, observedExitCode: 0, detail: 'completed',
      }],
    }));
    const f = await fixture({ observe }, verify);
    try {
      const created = await createRun(f);
      const launched = await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 0, leaseToken: f.started.leaseToken!,
      });
      expect(launched).toMatchObject({ ok: true, value: { boundary: 'dispatched', run: { run: { revision: 3 } } } });

      const terminal = await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 3, leaseToken: f.started.leaseToken!,
      });
      expect(terminal).toMatchObject({ ok: true, value: { boundary: 'verification_pending', run: { run: { revision: 4 } } } });

      const verified = await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 4, leaseToken: f.started.leaseToken!,
      });
      expect(verified).toMatchObject({
        ok: true,
        value: {
          boundary: 'verified',
          run: {
            run: { status: 'active', revision: 5 },
            attempts: [{ evidence: [{ requirementId: 'first-exit', status: 'verified' }] }],
          },
        },
      });
      if (!verified.ok) throw new Error(verified.error.message);
      expect(verified.value.run.milestones.find((milestone) => milestone.id === 'first'))
        .toMatchObject({ status: 'completed' });
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify.mock.calls[0]?.[1]).toMatchObject({
        stored: { run: { id: 'run-a', ownerClientId: actor.clientId } },
        milestone: { id: 'first', status: 'verifying' },
        attempt: { dispatchStatus: 'terminal' },
        goalLease: { goalId: f.started.goalId, leaseGeneration: 1 },
      });
      expect(f.repository.listEvents('run-a', actor.clientId, 'workspace-a', { limit: 10 })).toMatchObject({
        ok: true,
        value: { events: [{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }, { sequence: 3 }, { sequence: 4 }, { sequence: 5, kind: 'verification_recorded' }] },
      });
    } finally {
      f.database.close();
    }
  });

  it('stores unknown evidence without completing or dispatching another milestone', async () => {
    const observe = vi.fn<AutomationDispatchPort['observe']>(async () => ok({
      presence: 'found', state: 'completed', terminalState: 'completed:0', observedAt: '2026-09-20T10:00:02.000Z',
    }));
    const verify = vi.fn<AutomationVerificationPort['verify']>(async (_actor, request) => ok({
      status: 'unknown',
      evidence: [{
        requirementId: 'first-exit', kind: 'command_exit', status: 'unknown',
        observedAt: '2026-09-20T10:00:03.000Z', observedDigest: request.attempt.requestDigest,
        observedTaskId: request.attempt.taskId, detail: 'termination_unverified',
      }],
    }));
    const f = await fixture({ observe }, verify);
    try {
      const created = await createRun(f);
      await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 0, leaseToken: f.started.leaseToken!,
      });
      await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 3, leaseToken: f.started.leaseToken!,
      });
      const blocked = await f.service.advance(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 4, leaseToken: f.started.leaseToken!,
      });
      expect(blocked).toMatchObject({
        ok: true,
        value: {
          boundary: 'blocked',
          run: {
            run: { status: 'blocked', revision: 6 },
            attempts: [{ evidence: [{ status: 'unknown' }] }],
          },
        },
      });
      if (!blocked.ok) throw new Error(blocked.error.message);
      expect(blocked.value.run.milestones.find((milestone) => milestone.id === 'first'))
        .toMatchObject({ status: 'verifying' });
    } finally {
      f.database.close();
    }
  });

  it('applies pause, resume and cancel through CAS and propagates cancellation to the root goal', async () => {
    const f = await fixture();
    try {
      const created = await createRun(f);
      const paused = await f.service.pause(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 0, leaseToken: f.started.leaseToken!,
      });
      expect(paused).toMatchObject({ ok: true, value: { run: { status: 'paused', revision: 1 } } });

      const staleResume = await f.service.resume(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 0, leaseToken: f.started.leaseToken!,
      });
      expect(staleResume).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      const resumed = await f.service.resume(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 1, leaseToken: f.started.leaseToken!,
      });
      expect(resumed).toMatchObject({ ok: true, value: { run: { status: 'active', revision: 2 } } });

      const cancelled = await f.service.cancel(actor, {
        workspaceId: 'workspace-a', runId: created.run.id, expectedRevision: 2, leaseToken: f.started.leaseToken!,
        summary: 'Operator cancelled automation.',
      });
      expect(cancelled).toMatchObject({ ok: true, value: { run: { status: 'cancelled', revision: 3 } } });
      expect(await f.goals.getGoal(actor, { goalId: f.started.goalId })).toMatchObject({
        ok: true,
        value: { status: 'cancelled' },
      });
    } finally {
      f.database.close();
    }
  });
});
