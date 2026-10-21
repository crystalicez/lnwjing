import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type AutomationPlan, type Result } from '@lnwjing/domain';
import { SqliteAutomationRepository } from '../../storage/src/automation-repository.js';
import { SqliteDatabase } from '../../storage/src/database.js';
import { SqliteGoalRepository } from '../../storage/src/goal-repository.js';
import { SqliteWorkspaceRepository } from '../../storage/src/workspace-repository.js';
import {
  AutomationService,
  type AutomationDispatchObservation,
  type AutomationDispatchPort,
  type AutomationDispatchRequest,
  type MutateAutomationRunRequest,
} from './automation-service.js';
import type { AutomationVerificationPort } from './automation-verifier.js';
import type { FileActor } from './file-service.js';
import { GoalContinuationService, type RunGoalResult } from './goal-continuation-service.js';

const roots: string[] = [];
const now = new Date('2026-09-20T10:00:00.000Z');
const actor: FileActor = { clientId: 'fault-owner', clientName: 'Fault owner', sessionId: 'fault-session' };
const foreignActor: FileActor = { clientId: 'foreign-owner', clientName: 'Foreign owner', sessionId: 'foreign-session' };
const rawOutputMarker = 'raw-output-must-remain-in-task-storage';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

type CrashBoundary = 'none' | 'before_payload_launch' | 'after_payload_start_before_receipt';

interface DurableTaskFile {
  readonly requestDigest: string;
  readonly state: 'running' | 'completed';
  readonly terminalState?: string;
  readonly rawOutput: string;
}

class FaultBoundaryDispatch implements AutomationDispatchPort {
  public payloadLaunchCount = 0;
  public crashBoundary: CrashBoundary = 'none';
  public unknownProbeCount = 0;

  public constructor(private readonly taskDirectory: string) {}

  public async launch(_actor: FileActor, request: AutomationDispatchRequest): Promise<Result<AutomationDispatchObservation>> {
    const existing = await this.readTask(request);
    if (!existing.ok) return existing;
    if (existing.value !== undefined) return ok(observation(existing.value));
    if (this.crashBoundary === 'before_payload_launch') {
      this.crashBoundary = 'none';
      throw new Error('fault: crashed before payload launch');
    }

    this.payloadLaunchCount += 1;
    const task: DurableTaskFile = {
      requestDigest: request.context.requestDigest,
      state: 'running',
      rawOutput: rawOutputMarker,
    };
    await writeFile(this.taskPath(request.context.taskId), JSON.stringify(task), 'utf8');
    if (this.crashBoundary === 'after_payload_start_before_receipt') {
      this.crashBoundary = 'none';
      throw new Error('fault: crashed after payload start before receipt');
    }
    return ok(observation(task));
  }

  public async observe(_actor: FileActor, request: AutomationDispatchRequest): Promise<Result<AutomationDispatchObservation>> {
    if (this.unknownProbeCount > 0) {
      this.unknownProbeCount -= 1;
      return ok({ presence: 'unknown', observedAt: now.toISOString(), detail: 'fault: probe unavailable' });
    }
    const task = await this.readTask(request);
    if (!task.ok) return task;
    return task.value === undefined
      ? ok({ presence: 'absent', observedAt: now.toISOString() })
      : ok(observation(task.value));
  }

  public async complete(taskId: string): Promise<void> {
    const filename = this.taskPath(taskId);
    const task = JSON.parse(await readFile(filename, 'utf8')) as DurableTaskFile;
    await writeFile(filename, JSON.stringify({ ...task, state: 'completed', terminalState: 'completed:0' }), 'utf8');
  }

  private async readTask(request: AutomationDispatchRequest): Promise<Result<DurableTaskFile | undefined>> {
    try {
      const task = JSON.parse(await readFile(this.taskPath(request.context.taskId), 'utf8')) as DurableTaskFile;
      if (task.requestDigest !== request.context.requestDigest) {
        return err(appError('CONFLICT', 'Durable task request digest changed'));
      }
      return ok(task);
    } catch (error) {
      return isMissingFile(error) ? ok(undefined) : err(appError('INTERNAL_ERROR', 'Durable task fixture is corrupt', true));
    }
  }

  private taskPath(taskId: string): string {
    return path.join(this.taskDirectory, `${taskId}.json`);
  }
}

interface Harness {
  readonly root: string;
  readonly databaseFilename: string;
  readonly taskDirectory: string;
  readonly dispatch: FaultBoundaryDispatch;
  readonly started: RunGoalResult;
  readonly runId: string;
  reopen(): OpenHarness;
}

interface OpenHarness {
  readonly database: SqliteDatabase;
  readonly repository: SqliteAutomationRepository;
  readonly goals: GoalContinuationService;
  readonly service: AutomationService;
  close(): void;
}

describe('AutomationService fault injection', () => {
  it('recovers a worker started before its receipt, blocks on an unknown probe, and never launches the payload twice', async () => {
    const harness = await createHarness('after-receipt');
    harness.dispatch.crashBoundary = 'after_payload_start_before_receipt';
    let opened = harness.reopen();
    try {
      const first = await advanceCurrent(opened.service, harness);
      expect(first).toMatchObject({ ok: true, value: { boundary: 'blocked', run: { run: { status: 'blocked' } } } });
      expect(harness.dispatch.payloadLaunchCount).toBe(1);
    } finally {
      opened.close();
    }

    harness.dispatch.unknownProbeCount = 1;
    opened = harness.reopen();
    try {
      const unknown = await advanceCurrent(opened.service, harness);
      expect(unknown).toMatchObject({ ok: true, value: { boundary: 'blocked' } });
      expect(harness.dispatch.payloadLaunchCount).toBe(1);

      const recovered = await advanceCurrent(opened.service, harness);
      expect(recovered).toMatchObject({ ok: true, value: { boundary: 'running' } });
      expect(harness.dispatch.payloadLaunchCount).toBe(1);
      if (!recovered.ok || recovered.value.taskId === undefined) throw new Error('missing recovered task');
      await harness.dispatch.complete(recovered.value.taskId);
    } finally {
      opened.close();
    }

    opened = harness.reopen();
    try {
      const terminal = await advanceCurrent(opened.service, harness);
      expect(terminal).toMatchObject({ ok: true, value: { boundary: 'verification_pending' } });
    } finally {
      opened.close();
    }

    opened = harness.reopen();
    try {
      const verified = await advanceCurrent(opened.service, harness);
      expect(verified).toMatchObject({
        ok: true,
        value: { boundary: 'verified', run: { milestones: [{ status: 'completed' }] } },
      });
      expect(harness.dispatch.payloadLaunchCount).toBe(1);

      const taskFiles = await readdir(harness.taskDirectory);
      expect(taskFiles).toHaveLength(1);
      expect(await readFile(path.join(harness.taskDirectory, taskFiles[0]!), 'utf8')).toContain(rawOutputMarker);
      const automationRows = JSON.stringify({
        runs: opened.database.connection.prepare('SELECT * FROM automation_runs').all(),
        milestones: opened.database.connection.prepare('SELECT * FROM automation_milestones').all(),
        attempts: opened.database.connection.prepare('SELECT * FROM automation_attempts').all(),
        events: opened.database.connection.prepare('SELECT * FROM automation_events').all(),
      });
      expect(automationRows).not.toContain(harness.started.leaseToken);
      expect(automationRows).not.toContain(rawOutputMarker);
      expect(automationRows).not.toMatch(/authorization|super-secret/i);
    } finally {
      opened.close();
    }
  });

  it('retries only after a pre-launch crash is proven absent and launches the replacement payload exactly once', async () => {
    const harness = await createHarness('before-launch');
    harness.dispatch.crashBoundary = 'before_payload_launch';
    let opened = harness.reopen();
    try {
      const crashed = await advanceCurrent(opened.service, harness);
      expect(crashed).toMatchObject({ ok: true, value: { boundary: 'blocked' } });
      expect(harness.dispatch.payloadLaunchCount).toBe(0);
    } finally {
      opened.close();
    }

    opened = harness.reopen();
    try {
      const relaunched = await advanceCurrent(opened.service, harness);
      expect(relaunched).toMatchObject({
        ok: true,
        value: {
          boundary: 'dispatched',
          run: { attempts: [
            { ordinal: 1, dispatchStatus: 'terminal', terminalState: 'absent' },
            { ordinal: 2, dispatchStatus: 'launched' },
          ] },
        },
      });
      if (!relaunched.ok) throw new Error(relaunched.error.message);
      expect(relaunched.value.run.attempts[0]?.taskId).not.toBe(relaunched.value.run.attempts[1]?.taskId);
      expect(harness.dispatch.payloadLaunchCount).toBe(1);
    } finally {
      opened.close();
    }
  });

  it('serializes duplicate wakes and rejects stale revisions, stale leases, foreign actors, and foreign workspaces', async () => {
    const harness = await createHarness('duplicate-wake');
    const first = harness.reopen();
    const second = harness.reopen();
    let releaseLaunch!: () => void;
    let enteredLaunch!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const entered = new Promise<void>((resolve) => { enteredLaunch = resolve; });
    const originalLaunch = harness.dispatch.launch.bind(harness.dispatch);
    harness.dispatch.launch = async (requestActor, request): ReturnType<AutomationDispatchPort['launch']> => {
      enteredLaunch();
      await gate;
      return originalLaunch(requestActor, request);
    };
    try {
      const request = mutation(harness, 0);
      const active = first.service.advance(actor, request);
      await entered;
      const duplicate = await second.service.advance(actor, request);
      expect(duplicate).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      releaseLaunch();
      const launched = await active;
      expect(launched).toMatchObject({ ok: true, value: { boundary: 'dispatched' } });
      expect(harness.dispatch.payloadLaunchCount).toBe(1);

      expect(await second.service.advance(actor, request)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      const current = await first.service.status(actor, { workspaceId: 'workspace-a', runId: harness.runId });
      if (!current.ok) throw new Error(current.error.message);
      expect(await second.service.advance(actor, { ...mutation(harness, current.value.run.revision), leaseToken: 'stale-lease' }))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(await first.service.status(foreignActor, { workspaceId: 'workspace-a', runId: harness.runId }))
        .toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
      expect(await first.service.status(actor, { workspaceId: 'workspace-b', runId: harness.runId }))
        .toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
    } finally {
      releaseLaunch?.();
      first.close();
      second.close();
    }
  });

  it('reconciles a completing automation after the root goal committed but the local completion event failed', async () => {
    const harness = await createHarness('finalize-reconcile');
    const opened = harness.reopen();
    try {
      const launched = await advanceCurrent(opened.service, harness);
      if (!launched.ok || launched.value.taskId === undefined) throw new Error('missing launched task');
      await harness.dispatch.complete(launched.value.taskId);
      expect(await advanceCurrent(opened.service, harness)).toMatchObject({
        ok: true, value: { boundary: 'verification_pending' },
      });
      const verified = await advanceCurrent(opened.service, harness);
      expect(verified).toMatchObject({ ok: true, value: { boundary: 'verified' } });
      if (!verified.ok) throw new Error(verified.error.message);

      opened.database.connection.exec(`CREATE TRIGGER fail_automation_complete_event
        BEFORE INSERT ON automation_events WHEN NEW.kind = 'run_completed'
        BEGIN SELECT RAISE(ABORT, 'injected completion event failure'); END;`);
      const failed = await opened.service.finalize(actor, mutation(harness, verified.value.run.run.revision));
      expect(failed).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      expect(await opened.goals.getGoal(actor, { goalId: harness.started.goalId })).toMatchObject({
        ok: true, value: { status: 'completed' },
      });
      const partial = await opened.service.status(actor, { workspaceId: 'workspace-a', runId: harness.runId });
      expect(partial).toMatchObject({ ok: true, value: { run: { status: 'completing' } } });
      if (!partial.ok) throw new Error(partial.error.message);

      opened.database.connection.exec('DROP TRIGGER fail_automation_complete_event;');
      const recovered = await opened.service.finalize(actor, mutation(harness, partial.value.run.revision));
      expect(recovered).toMatchObject({
        ok: true,
        value: { run: { run: { status: 'completed' } }, goal: { status: 'completed' } },
      });
    } finally {
      opened.close();
    }
  });

  it('reconciles local cancellation after the root goal cancelled but the automation event write failed', async () => {
    const harness = await createHarness('cancel-reconcile');
    const opened = harness.reopen();
    try {
      opened.database.connection.exec(`CREATE TRIGGER fail_automation_cancel_event
        BEFORE INSERT ON automation_events WHEN NEW.kind = 'run_cancelled'
        BEGIN SELECT RAISE(ABORT, 'injected cancellation event failure'); END;`);
      const failed = await opened.service.cancel(actor, {
        ...mutation(harness, 0),
        summary: 'Cancel with an injected local persistence failure.',
      });
      expect(failed).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      expect(await opened.goals.getGoal(actor, { goalId: harness.started.goalId })).toMatchObject({
        ok: true, value: { status: 'cancelled' },
      });
      expect(await opened.service.status(actor, { workspaceId: 'workspace-a', runId: harness.runId })).toMatchObject({
        ok: true, value: { run: { status: 'active', revision: 0 } },
      });

      opened.database.connection.exec('DROP TRIGGER fail_automation_cancel_event;');
      const recovered = await opened.service.cancel(actor, {
        ...mutation(harness, 0),
        summary: 'Reconcile cancelled root goal.',
      });
      expect(recovered).toMatchObject({ ok: true, value: { run: { status: 'cancelled', revision: 1 } } });
    } finally {
      opened.close();
    }
  });

  it('rolls back run state and event sequence when an injected SQLite event write fails', async () => {
    const harness = await createHarness('transaction-rollback');
    const opened = harness.reopen();
    try {
      opened.database.connection.exec(`CREATE TRIGGER fail_automation_pause_event
        BEFORE INSERT ON automation_events WHEN NEW.kind = 'run_paused'
        BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;`);
      const paused = await opened.service.pause(actor, mutation(harness, 0));
      expect(paused).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      expect(await opened.service.status(actor, { workspaceId: 'workspace-a', runId: harness.runId })).toMatchObject({
        ok: true,
        value: { run: { status: 'active', revision: 0 } },
      });
      expect(opened.database.connection.prepare('SELECT sequence, kind FROM automation_events WHERE run_id = ? ORDER BY sequence').all(harness.runId))
        .toEqual([{ sequence: 0, kind: 'run_created' }]);
    } finally {
      opened.close();
    }
  });
});

async function createHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), `lnwjing-automation-fault-${label}-`));
  roots.push(root);
  const databaseFilename = path.join(root, 'lnwjing.sqlite');
  const taskDirectory = path.join(root, 'tasks');
  const workspaceARoot = path.join(root, 'workspace-a');
  const workspaceBRoot = path.join(root, 'workspace-b');
  await Promise.all([
    mkdir(taskDirectory, { recursive: true }),
    mkdir(workspaceARoot, { recursive: true }),
    mkdir(workspaceBRoot, { recursive: true }),
  ]);
  const dispatch = new FaultBoundaryDispatch(taskDirectory);
  const initial = openHarness(databaseFilename, dispatch, `run-${label}`);
  let started: Awaited<ReturnType<GoalContinuationService['runGoal']>>;
  let created: Awaited<ReturnType<AutomationService['createRun']>>;
  try {
    await new SqliteWorkspaceRepository(initial.database).insert({
      id: 'workspace-a', displayName: 'Workspace A', rootPath: workspaceARoot, realRootPath: workspaceARoot, createdAt: now.toISOString(),
    });
    await new SqliteWorkspaceRepository(initial.database).insert({
      id: 'workspace-b', displayName: 'Workspace B', rootPath: workspaceBRoot, realRootPath: workspaceBRoot, createdAt: now.toISOString(),
    });
    started = await initial.goals.runGoal(actor, {
      workspaceId: 'workspace-a', goalKey: `fault-${label}`, objective: 'Exercise crash-safe native automation.',
      plan: { steps: [{ id: 'build', title: 'Build' }] }, leaseSeconds: 600,
    });
    if (!started.ok || started.value.leaseToken === undefined) throw new Error('failed to acquire test goal');
    created = await initial.service.createRun(actor, {
      workspaceId: 'workspace-a', goalId: started.value.goalId, leaseToken: started.value.leaseToken,
      plan: automationPlan(workspaceARoot),
    });
    if (!created.ok) throw new Error(created.error.message);
  } finally {
    initial.close();
  }
  if (!started.ok || started.value.leaseToken === undefined || !created.ok) throw new Error('failed to create fault harness');
  return {
    root,
    databaseFilename,
    taskDirectory,
    dispatch,
    started: started.value,
    runId: created.value.run.id,
    reopen(): OpenHarness { return openHarness(databaseFilename, dispatch, `run-${label}`); },
  };
}

function openHarness(databaseFilename: string, dispatch: FaultBoundaryDispatch, runId: string): OpenHarness {
  const database = new SqliteDatabase(databaseFilename);
  const workspaces = new SqliteWorkspaceRepository(database);
  const goals = new GoalContinuationService(workspaces, new SqliteGoalRepository(database), { now: (): Date => now });
  const repository = new SqliteAutomationRepository(database);
  const verifier: AutomationVerificationPort = {
    async verify(_actor, request) {
      return ok({
        status: 'verified',
        evidence: request.milestone.verification.map((requirement) => ({
          requirementId: requirement.id,
          kind: requirement.kind,
          status: 'verified' as const,
          observedAt: now.toISOString(),
          observedDigest: request.attempt.requestDigest,
          observedTaskId: request.attempt.taskId,
          observedExitCode: 0,
          detail: 'exact terminal task fixture',
        })),
      });
    },
  };
  return {
    database,
    repository,
    goals,
    service: new AutomationService(repository, goals, dispatch, verifier, { now: () => now, idFactory: () => runId }),
    close(): void { database.close(); },
  };
}

function automationPlan(root: string): AutomationPlan {
  return {
    milestones: [{
      id: 'build', title: 'Build', goalStepId: 'build', dependsOn: [], provider: 'shell', role: 'blocking_job', cancelWithGoal: true,
      dispatch: {
        executable: process.execPath,
        arguments: ['--version'],
        cwd: root,
        timeoutSeconds: 60,
        maxOutputBytes: 1024,
        includeStdout: false,
        includeStderr: true,
      },
      verification: [{ id: 'exit', kind: 'command_exit', expectedExitCode: 0 }],
    }],
  } as const;
}

function mutation(harness: Pick<Harness, 'started' | 'runId'>, expectedRevision: number): MutateAutomationRunRequest {
  return {
    workspaceId: 'workspace-a',
    goalId: harness.started.goalId,
    runId: harness.runId,
    leaseToken: harness.started.leaseToken!,
    expectedRevision,
    userConfirmed: true,
  };
}

async function advanceCurrent(service: AutomationService, harness: Pick<Harness, 'started' | 'runId'>): ReturnType<AutomationService['advance']> {
  const current = await service.status(actor, { workspaceId: 'workspace-a', runId: harness.runId });
  if (!current.ok) throw new Error(current.error.message);
  return service.advance(actor, mutation(harness, current.value.run.revision));
}

function observation(task: DurableTaskFile): AutomationDispatchObservation {
  return task.state === 'running'
    ? { presence: 'found', state: 'running', observedAt: now.toISOString() }
    : { presence: 'found', state: 'completed', terminalState: task.terminalState ?? 'completed:0', observedAt: now.toISOString() };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
