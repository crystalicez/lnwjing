import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok, type StoredAutomationRun } from '@lnwjing/domain';
import { SqliteDatabase } from '../../storage/src/database.js';
import { SqliteGoalRepository } from '../../storage/src/goal-repository.js';
import { SqliteWorkspaceRepository } from '../../storage/src/workspace-repository.js';
import type { FileActor } from './file-service.js';
import { GoalContinuationService } from './goal-continuation-service.js';
import {
  ScheduledContinuationService,
  type AutomationResumeLookupPort,
  type PrepareScheduledContinuationRequest,
} from './scheduled-continuation-service.js';

const roots: string[] = [];
const actor: FileActor = { clientId: 'client-a', clientName: 'Client A', sessionId: 'session-a' };

interface ScheduledAutomationFixture {
  readonly database: SqliteDatabase;
  readonly clock: { readonly now: () => Date; readonly set: (value: string) => void };
  readonly goalId: string;
  readonly leaseToken: string;
  readonly goalRevision: number;
  readonly scheduled: ScheduledContinuationService;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('scheduled automation resume hint', () => {
  it('adds one read-only hint only after a recurring wake acquires the goal lease', async () => {
    const findActiveForGoal = vi.fn<AutomationResumeLookupPort['findActiveForGoal']>((goalId) => ok(activeRun(goalId)));
    const f = await fixture(findActiveForGoal);
    try {
      const prepared = await f.scheduled.prepareScheduledContinuation(actor, prepareRequest(f));
      if (!prepared.ok) throw new Error(prepared.error.message);
      const receipt = await f.scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-recurring-automation',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(receipt.ok).toBe(true);
      f.database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-09-20T10:24:00.000Z', f.goalId);
      f.clock.set('2026-09-20T10:25:00.000Z');

      const claimed = await f.scheduled.claimScheduledContinuation({ ...actor, sessionId: 'wake-a' }, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(claimed).toMatchObject({
        ok: true,
        value: {
          outcome: 'recurring_acquired',
          automationResume: { runId: 'run-a', revision: 7, nextAction: 'advance' },
        },
      });
      expect(findActiveForGoal).toHaveBeenCalledWith(f.goalId, actor.clientId, 'workspace-a');
    } finally {
      f.database.close();
    }
  });

  it('does not advertise a paused automation as resumable work on a recurring wake', async () => {
    const findActiveForGoal = vi.fn<AutomationResumeLookupPort['findActiveForGoal']>((goalId) => ok(activeRun(goalId, 'paused')));
    const f = await fixture(findActiveForGoal);
    try {
      const prepared = await f.scheduled.prepareScheduledContinuation(actor, prepareRequest(f));
      if (!prepared.ok) throw new Error(prepared.error.message);
      await f.scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-recurring-paused',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      f.database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-09-20T10:24:00.000Z', f.goalId);
      f.clock.set('2026-09-20T10:25:00.000Z');

      const claimed = await f.scheduled.claimScheduledContinuation({ ...actor, sessionId: 'wake-paused' }, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(claimed).toMatchObject({ ok: true, value: { outcome: 'recurring_acquired' } });
      if (!claimed.ok) throw new Error(claimed.error.message);
      expect('automationResume' in claimed.value).toBe(false);
      expect(findActiveForGoal).toHaveBeenCalledWith(f.goalId, actor.clientId, 'workspace-a');
    } finally {
      f.database.close();
    }
  });

  it('does not read or mutate automation state on a busy/no-op recurring claim', async () => {
    const findActiveForGoal = vi.fn<AutomationResumeLookupPort['findActiveForGoal']>((goalId) => ok(activeRun(goalId)));
    const f = await fixture(findActiveForGoal);
    try {
      const prepared = await f.scheduled.prepareScheduledContinuation(actor, {
        ...prepareRequest(f),
        trackedTasks: [{ taskId: 'live-task', provider: 'shell', role: 'blocking_job', cancelWithGoal: true }],
      });
      if (!prepared.ok) throw new Error(prepared.error.message);
      await f.scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-recurring-busy',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      f.database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-09-20T10:30:00.000Z', f.goalId);
      f.clock.set('2026-09-20T10:25:00.000Z');

      const claimed = await f.scheduled.claimScheduledContinuation({ ...actor, sessionId: 'wake-busy' }, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(claimed).toMatchObject({ ok: true, value: { outcome: 'worker_busy_noop' } });
      if (!claimed.ok) throw new Error(claimed.error.message);
      expect('automationResume' in claimed.value).toBe(false);
      expect(findActiveForGoal).not.toHaveBeenCalled();
    } finally {
      f.database.close();
    }
  });
});

async function fixture(findActiveForGoal: AutomationResumeLookupPort['findActiveForGoal']): Promise<ScheduledAutomationFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-automation-resume-'));
  roots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: 'workspace-a', displayName: 'Workspace A', rootPath: root, realRootPath: root,
    createdAt: '2026-09-20T10:00:00.000Z',
  });
  const repository = new SqliteGoalRepository(database);
  let now = new Date('2026-09-20T10:00:00.000Z');
  const clock = { now: (): Date => now, set: (value: string): void => { now = new Date(value); } };
  const goals = new GoalContinuationService(workspaces, repository, {
    now: clock.now, scheduledContinuations: repository,
  });
  const started = await goals.runGoal(actor, {
    workspaceId: 'workspace-a', goalKey: 'scheduled-automation', objective: 'Resume automation safely.',
    plan: { steps: [{ id: 'build', title: 'Build' }] }, leaseSeconds: 600,
  });
  if (!started.ok || started.value.leaseToken === undefined) throw new Error('failed to start goal');
  return {
    database,
    clock,
    goalId: started.value.goalId,
    leaseToken: started.value.leaseToken,
    goalRevision: started.value.revision,
    scheduled: new ScheduledContinuationService(repository, {
      now: clock.now,
      hostTimeZone: 'Asia/Bangkok',
      automationResumes: { findActiveForGoal },
    }),
  };
}

function prepareRequest(f: ScheduledAutomationFixture): PrepareScheduledContinuationRequest {
  return {
    goalId: f.goalId,
    leaseToken: f.leaseToken,
    expectedRevision: f.goalRevision,
    currentPhase: 'automation',
    summary: 'Automation can continue on the next recurring wake.',
    stepUpdates: [],
    nextAction: 'Advance the automation run.',
    blockers: [],
    evidence: [],
    trackedTasks: [],
    successorDelayMinutes: 25,
    executionPreference: 'cloud',
  };
}

function activeRun(goalId: string, status: StoredAutomationRun['run']['status'] = 'active'): StoredAutomationRun {
  return {
    run: {
      id: 'run-a', goalId, workspaceId: 'workspace-a', ownerClientId: actor.clientId,
      status, revision: 7, createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
    },
    milestones: [{
      runId: 'run-a', id: 'build', title: 'Build', goalStepId: 'build', position: 0, dependsOn: [],
      provider: 'shell', role: 'blocking_job', cancelWithGoal: true,
      dispatch: {
        executable: 'node', arguments: ['--version'], cwd: 'C:\\workspace-a', timeoutSeconds: 60,
        maxOutputBytes: 1024, includeStdout: true, includeStderr: true,
      },
      verification: [{ id: 'exit', kind: 'command_exit', expectedExitCode: 0 }],
      status: 'running', attemptCount: 1, createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
    }],
    attempts: [],
  };
}
