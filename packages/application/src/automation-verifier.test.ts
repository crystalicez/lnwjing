import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { ok, type AutomationVerificationRequirement, type StoredAutomationRun } from '@lnwjing/domain';
import type { Workspace } from '@lnwjing/workspace';
import { AutomationVerifier, type AutomationTaskEvidenceSnapshot, type AutomationVerificationRuntimePort } from './automation-verifier.js';
import type { FileActor } from './file-service.js';

const roots: string[] = [];
const actor: FileActor = { clientId: 'client-a', clientName: 'Client A', sessionId: 'session-a' };
const observedAt = '2026-09-20T10:00:02.000Z';

interface VerificationFixture {
  readonly workspace: Workspace;
  readonly stored: StoredAutomationRun;
  readonly milestone: StoredAutomationRun['milestones'][number];
  readonly attempt: StoredAutomationRun['attempts'][number];
  readonly runtime: {
    readonly readTask: MockedFunction<AutomationVerificationRuntimePort['readTask']>;
    readonly ensureTask: MockedFunction<AutomationVerificationRuntimePort['ensureTask']>;
  };
  readonly verifier: AutomationVerifier;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('AutomationVerifier', () => {
  it('accepts only an exact completed task with the expected exit code', async () => {
    const fixture = await createFixture([{ id: 'exit', kind: 'command_exit', expectedExitCode: 0 }]);
    fixture.runtime.readTask.mockResolvedValue(ok(taskSnapshot(fixture, { state: 'completed', exitCode: 0 })));

    await expect(fixture.verifier.verify(actor, verificationRequest(fixture))).resolves.toEqual({
      ok: true,
      value: {
        status: 'verified',
        evidence: [{
          requirementId: 'exit',
          kind: 'command_exit',
          status: 'verified',
          observedAt,
          observedDigest: fixture.attempt.requestDigest,
          observedTaskId: fixture.attempt.taskId,
          observedExitCode: 0,
          detail: 'completed',
        }],
      },
    });
  });

  it('does not accept caller booleans, arbitrary text or a mismatched durable identity', async () => {
    const fixture = await createFixture([{ id: 'exit', kind: 'command_exit', expectedExitCode: 0 }]);
    fixture.runtime.readTask.mockResolvedValueOnce(ok({ pass: true, text: 'looks good' } as never));
    const arbitrary = await fixture.verifier.verify(actor, verificationRequest(fixture));
    expect(arbitrary).toMatchObject({ ok: true, value: { status: 'unknown', evidence: [{ status: 'unknown' }] } });

    fixture.runtime.readTask.mockResolvedValueOnce(ok(taskSnapshot(fixture, { requestDigest: 'f'.repeat(64), state: 'completed', exitCode: 0 })));
    const mismatched = await fixture.verifier.verify(actor, verificationRequest(fixture));
    expect(mismatched).toMatchObject({ ok: true, value: { status: 'unknown', evidence: [{ status: 'unknown' }] } });
  });

  it.each([
    ['running', 'pending'],
    ['unknown', 'unknown'],
    ['termination_unverified', 'unknown'],
    ['timed_out', 'failed'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
  ] as const)('maps durable task state %s to %s without treating timeout as success', async (state, status) => {
    const fixture = await createFixture([{ id: 'exit', kind: 'command_exit', expectedExitCode: 0 }]);
    fixture.runtime.readTask.mockResolvedValue(ok(taskSnapshot(fixture, { state })));

    await expect(fixture.verifier.verify(actor, verificationRequest(fixture)))
      .resolves.toMatchObject({ ok: true, value: { status, evidence: [{ status }] } });
  });

  it('computes a file digest from scoped bytes and rejects a junction or symlink escape', async () => {
    const root = await tempRoot('workspace');
    const outside = await tempRoot('outside');
    const content = Buffer.from('durable evidence\n', 'utf8');
    await writeFile(path.join(root, 'proof.bin'), content);
    await writeFile(path.join(outside, 'proof.bin'), content);
    await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const digest = createHash('sha256').update(content).digest('hex');

    const valid = await createFixture([{ id: 'file', kind: 'file_sha256', path: 'proof.bin', expectedSha256: digest }], root);
    await expect(valid.verifier.verify(actor, verificationRequest(valid)))
      .resolves.toMatchObject({
        ok: true,
        value: { status: 'verified', evidence: [{ status: 'verified', observedDigest: digest }] },
      });

    const escaped = await createFixture([{ id: 'file', kind: 'file_sha256', path: 'escape/proof.bin', expectedSha256: digest }], root);
    await expect(escaped.verifier.verify(actor, verificationRequest(escaped)))
      .resolves.toMatchObject({
        ok: true,
        value: { status: 'failed', evidence: [{ status: 'failed', detail: 'PATH_OUTSIDE_WORKSPACE' }] },
      });
  });

  it('uses a deterministic reserved git diff --check task without capturing command output', async () => {
    const root = await tempRoot('git');
    const canonicalRoot = await realpath(root);
    const fixture = await createFixture([{ id: 'diff', kind: 'git_diff_check' }], root);
    fixture.runtime.ensureTask.mockImplementation(async (_actor, request) => ok({
      taskId: request.context.taskId,
      ownerClientId: actor.clientId,
      workspaceId: request.context.workspaceId,
      requestDigest: request.context.requestDigest,
      state: 'completed',
      exitCode: 0,
      observedAt,
    }));

    const first = await fixture.verifier.verify(actor, verificationRequest(fixture));
    const second = await fixture.verifier.verify(actor, verificationRequest(fixture));
    expect(first).toMatchObject({ ok: true, value: { status: 'verified', evidence: [{ kind: 'git_diff_check', status: 'verified' }] } });
    expect(second).toMatchObject({ ok: true, value: { status: 'verified' } });
    const firstRequest = fixture.runtime.ensureTask.mock.calls[0]?.[1];
    const secondRequest = fixture.runtime.ensureTask.mock.calls[1]?.[1];
    expect(firstRequest?.context).toMatchObject({
      runId: fixture.stored.run.id,
      milestoneId: fixture.milestone.id,
      goalId: fixture.stored.run.goalId,
      workspaceId: fixture.stored.run.workspaceId,
    });
    expect(firstRequest?.dispatch).toEqual({
      executable: 'git',
      arguments: ['diff', '--check'],
      cwd: canonicalRoot,
      timeoutSeconds: 60,
      maxOutputBytes: 4096,
      includeStdout: false,
      includeStderr: false,
    });
    expect(firstRequest?.context.taskId).toBe(secondRequest?.context.taskId);
    expect(firstRequest?.context.requestDigest).toBe(secondRequest?.context.requestDigest);
  });

  it('rejects an empty verification definition even when malformed stored data reaches the verifier', async () => {
    const fixture = await createFixture([]);
    await expect(fixture.verifier.verify(actor, verificationRequest(fixture)))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(fixture.runtime.readTask).not.toHaveBeenCalled();
    expect(fixture.runtime.ensureTask).not.toHaveBeenCalled();
  });
});

async function createFixture(requirements: readonly AutomationVerificationRequirement[], root = 'C:\\workspace-a'): Promise<VerificationFixture> {
  const workspace: Workspace = {
    id: 'workspace-a', displayName: 'Workspace A', rootPath: root, realRootPath: root, createdAt: '2026-09-20T10:00:00.000Z',
  };
  const stored = storedRun(requirements, root);
  const runtime = {
    readTask: vi.fn<AutomationVerificationRuntimePort['readTask']>(),
    ensureTask: vi.fn<AutomationVerificationRuntimePort['ensureTask']>(),
  };
  const workspaces = { get: vi.fn(async (id: string) => id === workspace.id ? workspace : null) };
  return {
    workspace,
    stored,
    milestone: stored.milestones[0]!,
    attempt: stored.attempts[0]!,
    runtime,
    verifier: new AutomationVerifier(workspaces, runtime, undefined, (): Date => new Date(observedAt)),
  };
}

function verificationRequest(fixture: VerificationFixture): Parameters<AutomationVerifier['verify']>[1] {
  return {
    stored: fixture.stored,
    milestone: fixture.milestone,
    attempt: fixture.attempt,
    goalLease: { goalId: fixture.stored.run.goalId, leaseToken: 'lease-a', leaseGeneration: 1 },
    userConfirmed: true,
  } as const;
}

function taskSnapshot(
  fixture: VerificationFixture,
  overrides: Partial<AutomationTaskEvidenceSnapshot> = {},
): AutomationTaskEvidenceSnapshot {
  return {
    taskId: fixture.attempt.taskId,
    ownerClientId: actor.clientId,
    workspaceId: fixture.stored.run.workspaceId,
    requestDigest: fixture.attempt.requestDigest,
    state: 'completed',
    observedAt,
    ...overrides,
  };
}

function storedRun(requirements: readonly AutomationVerificationRequirement[], root: string): StoredAutomationRun {
  return {
    run: {
      id: 'run-a', goalId: 'goal-a', workspaceId: 'workspace-a', ownerClientId: actor.clientId,
      status: 'active', revision: 4, createdAt: '2026-09-20T10:00:00.000Z', updatedAt: observedAt,
    },
    milestones: [{
      runId: 'run-a', id: 'build', title: 'Build', goalStepId: 'goal-build', position: 0, dependsOn: [],
      provider: 'shell', role: 'blocking_job', cancelWithGoal: true,
      dispatch: {
        executable: process.execPath, arguments: ['--version'], cwd: root, timeoutSeconds: 30,
        maxOutputBytes: 1024, includeStdout: true, includeStderr: true,
      },
      verification: requirements, status: 'verifying', attemptCount: 1,
      createdAt: '2026-09-20T10:00:00.000Z', updatedAt: observedAt,
    }],
    attempts: [{
      id: 'attempt-a', runId: 'run-a', milestoneId: 'build', ordinal: 1, provider: 'shell',
      dispatchStatus: 'terminal', taskId: 'automation-task-a', requestDigest: 'a'.repeat(64),
      evidence: [], terminalState: 'completed:0', createdAt: '2026-09-20T10:00:00.000Z', updatedAt: observedAt,
    }],
  };
}

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `lnwjing-automation-verifier-${label}-`));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
