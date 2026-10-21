import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok, type EngineeringGoalMetadata } from '@lnwjing/domain';
import { engineeringTools } from './engineering-tools.js';

const actor = { clientId: 'test-client', clientName: 'Engineering test' };

describe('engineering_prepare_task', () => {
  it('is read-only and delegates only to the preparation service', async () => {
    const prepare = vi.fn(async () => ok({
      objective: 'Fix auth bug',
      assessment: { project: { kind: 'node' } },
      policy: { enabled: true, policyDigest: 'digest' },
      workflow: { primaryTaskKind: 'bugfix', riskTier: 'medium', deliveryScope: 'local' },
    } as never));
    const [tool] = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { engineeringPreparation: { prepare } as never },
    });

    expect(tool).toMatchObject({
      name: 'engineering_prepare_task',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      execution: { taskSupport: 'forbidden' },
    });
    expect(tool.parse({ workspaceId: 'workspace-1', objective: 'Fix auth bug', scopedPath: 'src/auth.ts' })).toMatchObject({ ok: true });
    expect(await tool.execute({ workspaceId: 'workspace-1', objective: 'Fix auth bug', scopedPath: 'src/auth.ts' }, new AbortController().signal)).toMatchObject({
      ok: true,
      value: {
        engineeringTask: {
          objective: 'Fix auth bug',
          policyDigest: 'digest',
          primaryTaskKind: 'bugfix',
          riskTier: 'medium',
          deliveryScope: 'local',
        },
      },
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith('workspace-1', 'Fix auth bug', 'src/auth.ts');
  });

  it('rejects malformed input before the preparation service can run', () => {
    const [tool] = engineeringTools({ actor, contextEconomy: {} as never, services: {} });
    expect(tool.parse({ workspaceId: 'workspace-1', objective: '' })).toMatchObject({ ok: false });
    expect(tool.parse({ workspaceId: 'workspace-1', objective: 'Fix bug', unknown: true })).toMatchObject({ ok: false });
  });
});

describe('engineering_start_task', () => {
  const prepared = (): ReturnType<typeof ok> => ok({
    objective: 'Fix auth bug',
    assessment: { project: { kind: 'node' } },
    policy: { enabled: true, policyDigest: 'digest-1', reasons: ['enabled'] },
    workflow: {
      primaryTaskKind: 'bugfix',
      riskTier: 'high',
      riskReasons: ['auth persistence'],
      workflow: [
        { id: 'reproduce', title: 'Reproduce the failure' },
        { id: 'validate', title: 'Validate the repair' },
      ],
      gates: [{
        id: 'focused_validation',
        title: 'Focused validation',
        applicability: 'required',
        status: 'pending',
        reason: 'Behavior changed',
        basedOnUserIntentRevision: 0,
      }],
      selectedCodeIntelligence: 'lsp_search',
      codeIntelligenceReason: 'Use LSP',
      deliveryScope: 'local',
    },
  } as never);

  it('creates a durable engineering goal with workflow metadata without touching scheduled continuation services', async () => {
    const runGoal = vi.fn(async () => ok({ goalId: 'goal-1', status: 'active', acquired: true }));
    const getGoal = vi.fn(async () => err(appError('INVALID_INPUT', 'Goal was not found')));
    const prepare = vi.fn(async () => prepared());
    const scheduled = { prepareScheduledContinuation: vi.fn() };
    const tools = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: {
        goals: { runGoal, getGoal } as never,
        engineeringPreparation: { prepare } as never,
        scheduledContinuations: scheduled as never,
      },
    });
    const tool = tools.find((entry) => entry.name === 'engineering_start_task');

    expect(tool).toMatchObject({
      name: 'engineering_start_task',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
    });
    const input = { workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' };
    expect(tool?.parse(input)).toMatchObject({ ok: true });
    expect(await tool?.execute(input, new AbortController().signal)).toMatchObject({ ok: true });
    expect(runGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      ...input,
      plan: { steps: [
        { id: 'reproduce', title: 'Reproduce the failure' },
        { id: 'validate', title: 'Validate the repair' },
      ] },
      engineering: expect.objectContaining({ schemaVersion: 1, primaryTaskKind: 'bugfix', riskTier: 'high', policyDigest: 'digest-1' }),
    }));
    expect(scheduled.prepareScheduledContinuation).not.toHaveBeenCalled();
  });

  it('resumes an existing engineering goal without replacing its evolved plan or metadata', async () => {
    const runGoal = vi.fn(async () => ok({ goalId: 'goal-1', status: 'active', acquired: true }));
    const getGoal = vi.fn(async () => ok({
      goalId: 'goal-1',
      engineering: { schemaVersion: 1, policyDigest: 'digest-1', scopedPath: 'src/auth/session.ts' },
      plan: { steps: [{ id: 'reproduce', title: 'Reproduce', status: 'completed' }] },
    } as never));
    const prepare = vi.fn(async () => prepared());
    const tools = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal } as never, engineeringPreparation: { prepare } as never },
    });
    const tool = tools.find((entry) => entry.name === 'engineering_start_task');
    const input = { workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' };

    expect(await tool?.execute(input, new AbortController().signal)).toMatchObject({ ok: true });
    expect(prepare).toHaveBeenCalledWith('workspace-1', 'Fix auth bug', 'src/auth/session.ts');
    expect(runGoal).toHaveBeenCalledWith(actor, input);
  });

  it('keeps an active durable task resumable when the repository later opts new Engineering preparation out', async () => {
    const existingEngineering = { schemaVersion: 1, policyDigest: 'digest-active', scopedPath: 'src/auth/session.ts', gates: [] };
    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: existingEngineering } as never));
    const runGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', revision: 4, userIntentRevision: 1,
      currentPhase: 'validate', nextAction: 'Continue validation', blockers: [], trackedTasks: [], engineering: existingEngineering,
    } as never));
    const checkpointGoal = vi.fn();
    const prepare = vi.fn(async () => ok({
      objective: 'Fix auth bug', assessment: {}, workflow: { primaryTaskKind: 'bugfix', riskTier: 'high', deliveryScope: 'local', workflow: [], gates: [] },
      policy: { enabled: false, source: 'project', policyDigest: 'digest-project-off', reasons: ['Project profile engineering.mode=off disables new task preparation.'] },
    } as never));
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare } as never },
    }).find((entry) => entry.name === 'engineering_start_task');

    await expect(tool?.execute({ workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { engineeringTask: { policyDigest: 'digest-active', scopedPath: 'src/auth/session.ts' } },
    });
    expect(prepare).toHaveBeenCalledWith('workspace-1', 'Fix auth bug', 'src/auth/session.ts');
    expect(checkpointGoal).not.toHaveBeenCalled();
  });

  it('fails closed when Harness is inactive and reconciles a changed policy on the same durable goal', async () => {
    const runGoal = vi.fn();
    const inactivePrepare = vi.fn(async () => ok({
      objective: 'Fix auth bug',
      assessment: {},
      workflow: {},
      policy: { enabled: false, policyDigest: 'off', reasons: ['Workspace disabled Harness.'] },
    } as never));
    const inactive = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal: vi.fn(async () => err(appError('INVALID_INPUT', 'Goal was not found'))) } as never, engineeringPreparation: { prepare: inactivePrepare } as never },
    }).find((entry) => entry.name === 'engineering_start_task');
    const input = { workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' };
    expect(await inactive?.execute(input, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(runGoal).not.toHaveBeenCalled();

    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: { schemaVersion: 1, policyDigest: 'old-digest', gates: [], reviewFindings: [] } } as never));
    const changedRunGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', leaseGeneration: 3,
      revision: 5, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Run validation', blockers: [], trackedTasks: [],
      engineering: { schemaVersion: 1, policyDigest: 'old-digest', gates: [], reviewFindings: [] },
    } as never));
    const checkpointGoal = vi.fn(async (_actor, request: { engineering?: unknown }) => ok({
      goalId: 'goal-1', status: 'active', revision: 6, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Run validation', blockers: [], trackedTasks: [],
      engineering: request.engineering,
    } as never));
    const changed = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal: changedRunGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare: vi.fn(async () => prepared()) } as never },
    }).find((entry) => entry.name === 'engineering_start_task');
    expect(await changed?.execute(input, new AbortController().signal)).toMatchObject({
      ok: true,
      value: { acquired: true, leaseToken: 'lease-1', revision: 6, engineeringTask: { policyDigest: 'digest-1', goalRevision: 6, userIntentRevision: 2 } },
    });
    expect(checkpointGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      goalId: 'goal-1', expectedRevision: 5,
      engineering: expect.objectContaining({ policyDigest: 'digest-1' }),
    }));
  });

  it('reconciles classification drift from the acquired goal snapshot even when the policy digest is unchanged', async () => {
    const evidence = {
      source: 'host_observed' as const,
      observedAt: '2026-10-12T00:00:00Z',
      workspaceId: 'workspace-1',
      command: 'pnpm test',
      runId: 'latest-task',
      exitCode: 0,
    };
    const oldMetadata = {
      schemaVersion: 1 as const,
      primaryTaskKind: 'unknown' as const,
      riskTier: 'critical' as const,
      policyDigest: 'unchanged-policy',
      deliveryScope: 'deploy' as const,
      scopedPath: 'docs/audit.md',
      gates: [],
      reviewFindings: [{ id: 'latest-finding', title: 'Finding from acquired snapshot', severity: 'blocking' as const, state: 'open' as const, reason: 'Preserve current finding.' }],
    };
    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: oldMetadata } as never));
    const acquiredEngineering = {
      ...oldMetadata,
      gates: [
        { id: 'diff', title: 'Diff/static inspection', applicability: 'required' as const, status: 'passed' as const,
          reason: 'Every mutation must be checked against the requested scope.', basedOnUserIntentRevision: 3, evidence },
        { id: 'exact_sha_ci', title: 'Exact-SHA hosted checks', applicability: 'required' as const, status: 'passed' as const,
          reason: 'Old delivery contract.', basedOnUserIntentRevision: 3, evidence },
        { id: 'package', title: 'Artifact/package verification', applicability: 'required' as const, status: 'passed' as const,
          reason: 'Old delivery contract.', basedOnUserIntentRevision: 3, evidence },
      ],
    };
    const runGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', leaseGeneration: 4,
      revision: 8, userIntentRevision: 3, currentPhase: 'audit', nextAction: 'Inspect the source', blockers: [],
      trackedTasks: [{ taskId: 'task-1', provider: 'legacy_auto', role: 'blocking_job', cancelWithGoal: true }],
      lastCheckpoint: { resumeContext: {
        changedFiles: ['packages/mcp-server/src/tools/engineering-tools.ts'],
        commands: [{ command: 'pnpm test:focused', status: 'passed' as const, exitCode: 0 }],
        decisions: ['Keep the existing goal owner.'],
        failedAttempts: ['Previous review found an obsolete gate.'],
        pendingValidation: [
          'Recheck the updated gate set.',
          'Engineering gate exact_sha_ci remains pending and must be verified before completion.',
          'Engineering gate exact_sha_ci remains failed and must be verified before completion.',
          'Engineering gate package remains pending and must be verified before completion.',
          'Engineering gate package remains running and must be verified before completion.',
          'Engineering gate package remains blocked and must be verified before completion.',
        ],
        resumePrerequisites: ['Retain the acquired lease.'],
        stateFacts: [{ kind: 'note' as const, value: 'Acquired snapshot is authoritative.' }],
        artifacts: [{ kind: 'path' as const, value: 'artifacts/review.json' }],
      } },
      engineering: acquiredEngineering,
    } as never));
    const checkpointGoal = vi.fn(async (_actor, request: { engineering?: unknown; resumeContext?: unknown; evidence?: readonly { kind: string; value: string }[] }) => ok({
      goalId: 'goal-1', status: 'active', revision: 9, userIntentRevision: 3, currentPhase: 'audit', nextAction: 'Inspect the source', blockers: [],
      trackedTasks: [{ taskId: 'task-1', provider: 'legacy_auto', role: 'blocking_job', cancelWithGoal: true }],
      engineering: request.engineering,
      lastCheckpoint: { resumeContext: request.resumeContext, evidence: request.evidence },
    } as never));
    const prepare = vi.fn(async () => ok({
      objective: 'Full Audit of source and existing production deployments', assessment: {},
      policy: { enabled: true, policyDigest: 'unchanged-policy', reasons: [] },
      workflow: {
        primaryTaskKind: 'review', riskTier: 'low', riskReasons: ['Read-only review.'], workflow: [], deliveryScope: 'local',
        gates: [
          { id: 'diff', title: 'Diff/static inspection', applicability: 'required', status: 'pending',
            reason: 'Every mutation must be checked against the requested scope.', basedOnUserIntentRevision: 0 },
          { id: 'docs_impact', title: 'Documentation impact', applicability: 'required', status: 'pending',
            reason: 'Record whether user/configuration/API/release documentation changed or why no update is required.', basedOnUserIntentRevision: 0 },
        ],
      },
    } as never));
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare } as never },
    }).find((entry) => entry.name === 'engineering_start_task');

    await expect(tool?.execute({ workspaceId: 'workspace-1', goalKey: 'engineering.audit', objective: 'Full Audit of source and existing production deployments' }, new AbortController().signal)).resolves.toMatchObject({
      ok: true, value: { revision: 9, engineeringTask: { policyDigest: 'unchanged-policy', goalRevision: 9 } },
    });
    expect(checkpointGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      goalId: 'goal-1', expectedRevision: 8, expectedUserIntentRevision: 3, currentPhase: 'audit', nextAction: 'Inspect the source',
      trackedTasks: [{ taskId: 'task-1', provider: 'legacy_auto', role: 'blocking_job', cancelWithGoal: true }],
      resumeContext: expect.objectContaining({
        changedFiles: ['packages/mcp-server/src/tools/engineering-tools.ts'],
        commands: [{ command: 'pnpm test:focused', status: 'passed', exitCode: 0 }],
        decisions: expect.arrayContaining([
          'Keep the existing goal owner.',
          expect.stringContaining('unknown / critical / deploy'),
          expect.stringContaining('review / low / local'),
        ]),
        failedAttempts: ['Previous review found an obsolete gate.'],
        pendingValidation: expect.arrayContaining(['Recheck the updated gate set.', expect.stringContaining('docs_impact')]),
        resumePrerequisites: ['Retain the acquired lease.'],
        stateFacts: expect.arrayContaining([expect.objectContaining({ kind: 'note', value: expect.stringContaining('exact_sha_ci') })]),
        artifacts: [{ kind: 'path', value: 'artifacts/review.json' }],
      }),
      evidence: [expect.objectContaining({ kind: 'note', value: expect.stringContaining('unknown / critical / deploy') })],
      engineering: expect.objectContaining({
        primaryTaskKind: 'review', riskTier: 'low', deliveryScope: 'local',
        reviewFindings: [{ id: 'latest-finding', title: 'Finding from acquired snapshot', severity: 'blocking', state: 'open', reason: 'Preserve current finding.' }],
        gates: expect.arrayContaining([expect.objectContaining({ id: 'diff', status: 'passed', evidence })]),
      }),
    }));
    const reconciled = checkpointGoal.mock.calls[0]?.[1].engineering as { gates: Array<{ id: string }> };
    expect(reconciled.gates.map((gate) => gate.id)).not.toEqual(expect.arrayContaining(['exact_sha_ci', 'package']));
    const checkpoint = checkpointGoal.mock.calls[0]?.[1];
    expect(checkpoint?.resumeContext).toMatchObject({
      failedAttempts: ['Previous review found an obsolete gate.'],
      artifacts: [{ kind: 'path', value: 'artifacts/review.json' }],
    });
    const resumedPendingValidation = (checkpoint?.resumeContext as { pendingValidation: string[] }).pendingValidation;
    expect(resumedPendingValidation).toContain('Recheck the updated gate set.');
    expect(resumedPendingValidation).not.toEqual(expect.arrayContaining([
      expect.stringContaining('exact_sha_ci'),
      expect.stringContaining('Engineering gate package'),
    ]));
    expect(checkpoint?.evidence?.[0]?.value).toContain('docs_impact');
  });

  it('reconciles metadata when the prior resume context is close to the size limit', async () => {
    const fixedStateFacts = Array.from({ length: 60 }, (_, index) => ({ kind: 'note' as const, value: `${index.toString().padStart(2, '0')}${'x'.repeat(1_022)}` }));
    const emptyResumeContext = {
      changedFiles: [],
      commands: [],
      decisions: [],
      failedAttempts: [],
      pendingValidation: [],
      resumePrerequisites: [],
      stateFacts: [],
      artifacts: [],
    };
    let resumeContext: typeof emptyResumeContext | undefined;
    for (let valueLength = 1_024; valueLength >= 0; valueLength -= 1) {
      const candidate = {
        ...emptyResumeContext,
        stateFacts: [...fixedStateFacts, { kind: 'note' as const, value: 'y'.repeat(valueLength) }],
      };
      const size = JSON.stringify(candidate).length;
      if (size <= 63_900) {
        resumeContext = candidate;
        break;
      }
    }
    expect(resumeContext).toBeDefined();
    expect(JSON.stringify(resumeContext).length).toBeGreaterThan(63_000);

    const existingEngineering = {
      schemaVersion: 1 as const,
      primaryTaskKind: 'unknown' as const,
      riskTier: 'critical' as const,
      policyDigest: 'unchanged-policy',
      deliveryScope: 'deploy' as const,
      gates: [],
    };
    const acquiredEngineering = { ...existingEngineering, gates: [] };
    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: existingEngineering } as never));
    const runGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', revision: 8, userIntentRevision: 3,
      currentPhase: 'audit', nextAction: 'Inspect the source', blockers: [], trackedTasks: [],
      lastCheckpoint: { resumeContext }, engineering: acquiredEngineering,
    } as never));
    const checkpointGoal = vi.fn(async (_calledActor: typeof actor, request: { engineering?: unknown; resumeContext?: unknown; evidence?: readonly { kind: string; value: string }[] }) => ok({
      goalId: 'goal-1', status: 'active', revision: 9, userIntentRevision: 3, currentPhase: 'audit', nextAction: 'Inspect the source', blockers: [], trackedTasks: [],
      engineering: request.engineering,
      lastCheckpoint: { resumeContext: request.resumeContext, evidence: request.evidence },
    } as never));
    const prepare = vi.fn(async () => ok({
      objective: 'Full Audit of source and existing production deployments', assessment: {},
      policy: { enabled: true, policyDigest: 'unchanged-policy', reasons: [] },
      workflow: {
        primaryTaskKind: 'review', riskTier: 'low', riskReasons: ['Read-only review.'], workflow: [], deliveryScope: 'local',
        gates: [{ id: 'docs_impact', title: 'Documentation impact', applicability: 'required', status: 'pending',
          reason: 'Record documentation impact.', basedOnUserIntentRevision: 0 }],
      },
    } as never));
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare } as never },
    }).find((entry) => entry.name === 'engineering_start_task');

    await expect(tool?.execute({ workspaceId: 'workspace-1', goalKey: 'engineering.audit', objective: 'Full Audit of source and existing production deployments' }, new AbortController().signal)).resolves.toMatchObject({
      ok: true, value: { revision: 9, engineeringTask: { policyDigest: 'unchanged-policy', goalRevision: 9 } },
    });
    expect(checkpointGoal).toHaveBeenCalledOnce();
    const checkpoint = checkpointGoal.mock.calls[0]?.[1];
    expect(JSON.stringify(checkpoint?.resumeContext).length).toBeLessThanOrEqual(64_000);
    expect((checkpoint?.resumeContext as { stateFacts: unknown[] }).stateFacts.slice(0, resumeContext!.stateFacts.length)).toEqual(resumeContext!.stateFacts);
    expect(checkpoint?.evidence?.[0]?.value).toContain('unknown / critical / deploy');
    expect(checkpoint?.evidence?.[0]?.value).toContain('docs_impact');
    expect((checkpoint?.engineering as { gates: Array<{ id: string }> }).gates.map((gate) => gate.id)).toContain('docs_impact');
  });

  it('stales passed gate evidence when required platforms change under the same policy digest', async () => {
    const evidence = {
      source: 'host_observed' as const,
      observedAt: '2026-10-12T00:00:00Z',
      workspaceId: 'workspace-1',
      command: 'pnpm test',
      runId: 'platform-task',
      exitCode: 0,
    };
    const existingEngineering = {
      schemaVersion: 1 as const, primaryTaskKind: 'bugfix' as const, riskTier: 'high' as const,
      policyDigest: 'unchanged-policy', deliveryScope: 'local' as const,
      gates: [{ id: 'cross_platform', title: 'Cross-platform evidence', applicability: 'required' as const, status: 'passed' as const,
        reason: 'Cross-platform claims require target-host or CI evidence.', basedOnUserIntentRevision: 2, requiredPlatforms: ['win32'] as const, evidence }],
    };
    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: existingEngineering } as never));
    const runGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', revision: 5, userIntentRevision: 2,
      currentPhase: 'validate', nextAction: 'Run CI', blockers: [], trackedTasks: [], engineering: existingEngineering,
    } as never));
    const checkpointGoal = vi.fn(async (_actor, request: { engineering?: unknown }) => ok({
      goalId: 'goal-1', status: 'active', revision: 6, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Run CI', blockers: [], trackedTasks: [],
      engineering: request.engineering,
    } as never));
    const prepare = vi.fn(async () => ok({
      objective: 'Fix a cross-platform behavior', assessment: {},
      policy: { enabled: true, policyDigest: 'unchanged-policy', reasons: [] },
      workflow: {
        primaryTaskKind: 'bugfix', riskTier: 'high', riskReasons: [], workflow: [], deliveryScope: 'local',
        gates: [{ id: 'cross_platform', title: 'Cross-platform evidence', applicability: 'required', status: 'pending',
          reason: 'Cross-platform claims require target-host or CI evidence.', basedOnUserIntentRevision: 0, requiredPlatforms: ['linux'] }],
      },
    } as never));
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare } as never },
    }).find((entry) => entry.name === 'engineering_start_task');

    await expect(tool?.execute({ workspaceId: 'workspace-1', goalKey: 'engineering.platform', objective: 'Fix a cross-platform behavior' }, new AbortController().signal)).resolves.toMatchObject({ ok: true });
    expect(checkpointGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      engineering: expect.objectContaining({
        gates: [expect.objectContaining({ id: 'cross_platform', status: 'stale', requiredPlatforms: ['linux'] })],
      }),
    }));
    const reconciled = checkpointGoal.mock.calls[0]?.[1].engineering as { gates: Array<{ id: string; evidence?: unknown }> };
    expect(reconciled.gates.find((gate) => gate.id === 'cross_platform')).not.toHaveProperty('evidence');
  });

  it('preserves passed gate evidence when required platform sets are only reordered', async () => {
    const evidence = {
      source: 'host_observed' as const,
      observedAt: '2026-10-12T00:00:00Z',
      workspaceId: 'workspace-1',
      command: 'pnpm test',
      runId: 'platform-order-task',
      exitCode: 0,
    };
    const existingEngineering = {
      schemaVersion: 1 as const, primaryTaskKind: 'bugfix' as const, riskTier: 'high' as const,
      policyDigest: 'unchanged-policy', deliveryScope: 'local' as const,
      gates: [{ id: 'cross_platform', title: 'Cross-platform evidence', applicability: 'required' as const, status: 'passed' as const,
        reason: 'Cross-platform claims require target-host or CI evidence.', basedOnUserIntentRevision: 2, requiredPlatforms: ['win32', 'linux'] as const, evidence }],
    };
    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: existingEngineering } as never));
    const runGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', revision: 5, userIntentRevision: 2,
      currentPhase: 'validate', nextAction: 'Run CI', blockers: [], trackedTasks: [], engineering: existingEngineering,
    } as never));
    const checkpointGoal = vi.fn(async (_actor, request: { engineering?: unknown }) => ok({
      goalId: 'goal-1', status: 'active', revision: 6, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Run CI', blockers: [], trackedTasks: [],
      engineering: request.engineering,
    } as never));
    const prepare = vi.fn(async () => ok({
      objective: 'Fix a cross-platform behavior', assessment: {},
      policy: { enabled: true, policyDigest: 'unchanged-policy', reasons: [] },
      workflow: {
        primaryTaskKind: 'bugfix', riskTier: 'high', riskReasons: [], workflow: [], deliveryScope: 'local',
        gates: [{ id: 'cross_platform', title: 'Cross-platform evidence', applicability: 'required', status: 'pending',
          reason: 'Cross-platform claims require target-host or CI evidence.', basedOnUserIntentRevision: 0, requiredPlatforms: ['linux', 'win32'] }],
      },
    } as never));
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare } as never },
    }).find((entry) => entry.name === 'engineering_start_task');

    await expect(tool?.execute({ workspaceId: 'workspace-1', goalKey: 'engineering.platform', objective: 'Fix a cross-platform behavior' }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { engineering: { gates: [expect.objectContaining({ id: 'cross_platform', status: 'passed', evidence })] } },
    });
    expect(checkpointGoal).not.toHaveBeenCalled();
  });

  it('reprepares with the acquired scope when the implicit scope changes during lease acquisition', async () => {
    const initialEngineering = {
      schemaVersion: 1 as const, primaryTaskKind: 'bugfix' as const, riskTier: 'high' as const,
      policyDigest: 'before-acquisition', deliveryScope: 'local' as const, scopedPath: 'src/old-scope.ts', gates: [],
    };
    const acquiredEngineering = { ...initialEngineering, policyDigest: 'acquired-snapshot', scopedPath: 'src/new-scope.ts' };
    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: initialEngineering } as never));
    const runGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', revision: 7, userIntentRevision: 4,
      currentPhase: 'validate', nextAction: 'Run checks', blockers: [], trackedTasks: [], engineering: acquiredEngineering,
    } as never));
    const checkpointGoal = vi.fn(async (_actor, request: { engineering?: unknown }) => ok({
      goalId: 'goal-1', status: 'active', revision: 8, userIntentRevision: 4, currentPhase: 'validate', nextAction: 'Run checks', blockers: [], trackedTasks: [],
      engineering: request.engineering,
    } as never));
    const prepare = vi.fn(async (_workspaceId: string, _objective: string, scopedPath?: string) => ok({
      objective: 'Fix auth bug', assessment: {},
      policy: { enabled: true, policyDigest: scopedPath === 'src/new-scope.ts' ? 'new-scope-policy' : 'old-scope-policy', reasons: [] },
      workflow: { primaryTaskKind: 'bugfix', riskTier: 'high', riskReasons: [], workflow: [], deliveryScope: 'local', gates: [] },
    } as never));
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare } as never },
    }).find((entry) => entry.name === 'engineering_start_task');

    await expect(tool?.execute({ workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' }, new AbortController().signal)).resolves.toMatchObject({
      ok: true, value: { engineeringTask: { policyDigest: 'new-scope-policy', scopedPath: 'src/new-scope.ts' } },
    });
    expect(prepare.mock.calls).toEqual([
      ['workspace-1', 'Fix auth bug', 'src/old-scope.ts'],
      ['workspace-1', 'Fix auth bug', 'src/new-scope.ts'],
    ]);
    expect(checkpointGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      engineering: expect.objectContaining({ policyDigest: 'new-scope-policy', scopedPath: 'src/new-scope.ts' }),
    }));
  });

  it.each(['preparation error', 'disabled policy', 'payload near limit'] as const)('releases the acquired lease when preparation at the acquired scope has a %s', async (failure) => {
    const initialEngineering = {
      schemaVersion: 1 as const, primaryTaskKind: 'bugfix' as const, riskTier: 'high' as const,
      policyDigest: 'before-acquisition', deliveryScope: 'local' as const, scopedPath: 'src/old-scope.ts', gates: [],
    };
    const acquiredEngineering = { ...initialEngineering, policyDigest: 'acquired-snapshot', scopedPath: 'src/new-scope.ts' };
    const trackedTasks = [{ taskId: 'task-1', provider: 'legacy_auto', role: 'blocking_job', cancelWithGoal: true }];
    const resumeContext = {
      changedFiles: ['src/auth/session.ts'],
      commands: [{ command: 'pnpm test', status: 'failed' as const, exitCode: 1 }],
      decisions: ['Keep the existing task plan.'],
      failedAttempts: ['Prior validation failed.'],
      pendingValidation: failure === 'payload near limit'
        ? Array.from({ length: 62 }, (_, index) => 'p'.repeat(index === 61 ? 938 : 1_024))
        : ['Run the focused validation.'],
      resumePrerequisites: ['Retain the acquired workspace scope.'],
      stateFacts: [{ kind: 'note' as const, value: 'The durable task remains active.' }],
      artifacts: [{ kind: 'path' as const, value: 'docs/plan.md' }],
    };
    const checkpointEvidence = [{ kind: 'path' as const, value: 'docs/plan.md' }];
    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: initialEngineering } as never));
    const runGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', revision: 7, userIntentRevision: 4,
      currentPhase: 'validate', nextAction: 'Run checks', blockers: ['Validation remains'], trackedTasks,
      lastCheckpoint: { evidence: checkpointEvidence, resumeContext }, engineering: acquiredEngineering,
    } as never));
    const checkpointGoal = vi.fn(async (_calledActor: typeof actor, request: { resumeContext?: unknown; summary?: string }) => ok({
      goalId: 'goal-1', lastCheckpoint: { resumeContext: request.resumeContext },
    } as never));
    const prepare = vi.fn(async (_workspaceId: string, _objective: string, scopedPath?: string) => {
      if (scopedPath === 'src/old-scope.ts') return prepared();
      if (failure !== 'disabled policy') return err(appError('INVALID_INPUT', 'Acquired scope cannot be prepared'));
      return ok({
        objective: 'Fix auth bug', assessment: {},
        policy: { enabled: false, source: 'workspace', policyDigest: 'disabled', reasons: ['Workspace Engineering Harness is disabled.'] },
        workflow: { primaryTaskKind: 'bugfix', riskTier: 'high', riskReasons: [], workflow: [], deliveryScope: 'local', gates: [] },
      } as never);
    });
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare } as never },
    }).find((entry) => entry.name === 'engineering_start_task');

    await expect(tool?.execute({ workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' }, new AbortController().signal)).resolves.toMatchObject({ ok: false });
    expect(checkpointGoal).toHaveBeenCalledOnce();
    if (failure === 'payload near limit') {
      const releasedResumeContext = checkpointGoal.mock.calls[0]?.[1].resumeContext;
      const serializedResumeContext = JSON.stringify(releasedResumeContext);
      expect(serializedResumeContext.length).toBeLessThanOrEqual(64_000);
      expect((releasedResumeContext as { failedAttempts: readonly string[] }).failedAttempts.at(-1)).toMatch(/^Acquired-scope Engineer/);
      expect(checkpointGoal.mock.calls[0]?.[1].summary).toContain('Acquired-scope Engineering preparation failed (INVALID_INPUT): Acquired scope cannot be prepared');
      return;
    }
    expect(checkpointGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      goalId: 'goal-1',
      leaseToken: 'lease-1',
      expectedRevision: 7,
      expectedUserIntentRevision: 4,
      currentPhase: 'validate',
      nextAction: 'Run checks',
      blockers: ['Validation remains'],
      trackedTasks,
      evidence: checkpointEvidence,
      resumeContext: {
        ...resumeContext,
        failedAttempts: [
          ...resumeContext.failedAttempts,
          failure === 'preparation error'
            ? 'Acquired-scope Engineering preparation failed (INVALID_INPUT): Acquired scope cannot be prepared'
            : 'Acquired-scope Engineering preparation is disabled: Workspace Engineering Harness is disabled.',
        ],
      },
      releaseLease: true,
    }));
  });

  it('invalidates scope-dependent evidence on scope change and exposes pending checks on readback', async () => {
    const scopeGateIds = ['diff', 'coverage', 'focused_validation', 'architecture', 'integration', 'restart_persistence', 'security_review', 'self_review', 'independent_review', 'docs_impact'];
    const unrelatedGateIds = ['cross_platform', 'exact_sha_ci', 'package'];
    const evidence = { source: 'host_observed' as const, observedAt: '2026-10-13T00:00:00Z', workspaceId: 'workspace-1', command: 'verified command', exitCode: 0 };
    let engineering: EngineeringGoalMetadata = {
      schemaVersion: 1, primaryTaskKind: 'bugfix', riskTier: 'high', policyDigest: 'digest-1', deliveryScope: 'local', scopedPath: 'src/old.ts',
      gates: [...scopeGateIds, ...unrelatedGateIds].map((id) => ({ id, title: id, applicability: 'required', status: 'passed', reason: `Check ${id}`, basedOnUserIntentRevision: 2, evidence })),
    };
    const snapshot = (): object => ({
      goalId: 'goal-1', workspaceId: 'workspace-1', objective: 'Fix auth bug', status: 'active', revision: 5, userIntentRevision: 2,
      currentPhase: 'validate', nextAction: 'Finish', blockers: [], trackedTasks: [], acceptanceCriteria: [], plan: { steps: [] }, engineering,
    });
    const getGoal = vi.fn(async () => ok(snapshot() as never));
    const runGoal = vi.fn(async () => ok({ ...snapshot(), acquired: true, leaseToken: 'lease-1' } as never));
    const checkpointGoal = vi.fn(async (_actor, request: { engineering: EngineeringGoalMetadata }) => {
      engineering = request.engineering;
      return ok({ ...snapshot(), revision: 6 } as never);
    });
    const workflowGates = engineering.gates.map(({ evidence: previousEvidence, ...gate }) => {
      void previousEvidence;
      return { ...gate, status: 'pending' };
    });
    const prepare = vi.fn(async () => ok({
      objective: 'Fix auth bug', policy: { enabled: true, policyDigest: 'digest-1', reasons: ['enabled'] },
      workflow: { primaryTaskKind: 'bugfix', riskTier: 'high', deliveryScope: 'local', workflow: [], gates: workflowGates },
    } as never));
    const tools = engineeringTools({ actor, contextEconomy: {} as never, services: {
      goals: { getGoal, runGoal, checkpointGoal } as never, engineeringPreparation: { prepare } as never,
    } });
    const result = await tools.find((tool) => tool.name === 'engineering_start_task')?.execute({
      workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug', scopedPath: 'src/new.ts',
    }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { engineeringTask: { scopedPath: 'src/new.ts' } } });
    for (const id of scopeGateIds) {
      const gate = engineering.gates.find((candidate) => candidate.id === id);
      expect(gate, id).toMatchObject({ status: 'stale', basedOnUserIntentRevision: 2 });
      expect(gate?.evidence, id).toBeUndefined();
    }
    for (const id of unrelatedGateIds) expect(engineering.gates.find((gate) => gate.id === id), id).toMatchObject({ status: 'passed', evidence });
    const status = await tools.find((tool) => tool.name === 'engineering_get_status')?.execute({ goalId: 'goal-1' }, new AbortController().signal);
    expect(status).toMatchObject({ ok: true, value: { deliveryBoundary: 'checks_pending', unresolvedGateIds: scopeGateIds } });
  });

  it('preserves completed gate evidence when only the policy digest changes but the gate contract is unchanged', async () => {
    const evidence = {
      source: 'host_observed' as const,
      observedAt: '2026-09-29T00:00:00Z',
      workspaceId: 'workspace-1',
      command: 'pnpm test',
      runId: 'task-1',
      exitCode: 0,
    };
    const existingEngineering = {
      schemaVersion: 1 as const,
      primaryTaskKind: 'bugfix' as const,
      riskTier: 'high' as const,
      policyDigest: 'old-digest',
      deliveryScope: 'local' as const,
      gates: [{
        id: 'focused_validation',
        title: 'Focused validation',
        applicability: 'required' as const,
        status: 'passed' as const,
        reason: 'Behavior changed',
        basedOnUserIntentRevision: 2,
        evidence,
      }],
    };
    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: existingEngineering } as never));
    const runGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', leaseGeneration: 3,
      revision: 5, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Finish', blockers: [], trackedTasks: [],
      engineering: existingEngineering,
    } as never));
    const checkpointGoal = vi.fn(async (_actor, request: { engineering?: unknown }) => ok({
      goalId: 'goal-1', status: 'active', revision: 6, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Finish', blockers: [], trackedTasks: [],
      engineering: request.engineering,
    } as never));
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare: vi.fn(async () => prepared()) } as never },
    }).find((entry) => entry.name === 'engineering_start_task');

    await expect(tool?.execute({ workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' }, new AbortController().signal)).resolves.toMatchObject({ ok: true });
    expect(checkpointGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      engineering: expect.objectContaining({
        policyDigest: 'digest-1',
        gates: [expect.objectContaining({
          id: 'focused_validation',
          status: 'passed',
          reason: 'Behavior changed',
          evidence,
        })],
      }),
    }));
  });
});

describe('engineering_get_status', () => {
  it('returns the current gate projection and truthful local boundary without mutating the goal', async () => {
    const getGoal = vi.fn(async () => ok({
      goalId: 'goal-1', workspaceId: 'workspace-1', objective: 'Fix auth bug', status: 'active', revision: 7, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Run focused test', blockers: [],
      acceptanceCriteria: [{ id: 'bug-fixed', title: 'Bug fixed', status: 'completed' }], plan: { steps: [{ id: 'fix', title: 'Fix', status: 'completed' }] }, trackedTasks: [],
      engineering: {
        schemaVersion: 1, primaryTaskKind: 'bugfix', riskTier: 'high', policyDigest: 'digest-1', deliveryScope: 'local', scopedPath: 'src/auth/session.ts',
        gates: [
          { id: 'focused_validation', title: 'Focused validation', applicability: 'required', status: 'passed', reason: 'Passed', basedOnUserIntentRevision: 0, evidence: { source: 'host_observed', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1', command: 'pnpm test', exitCode: 0 } },
          { id: 'docs_impact', title: 'Docs impact', applicability: 'required', status: 'not_applicable', reason: 'No docs impact', basedOnUserIntentRevision: 0 },
        ],
      },
    } as never));
    const prepare = vi.fn(async () => ok({ policy: { enabled: true, policyDigest: 'digest-1' } } as never));
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { getGoal } as never, engineeringPreparation: { prepare } as never },
    }).find((entry) => entry.name === 'engineering_get_status');

    expect(tool).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true } });
    expect(await tool?.execute({ goalId: 'goal-1' }, new AbortController().signal)).toMatchObject({
      ok: true,
      value: {
        deliveryBoundary: 'ready_locally', unresolvedGateIds: [], policyChanged: false, primaryTaskKind: 'bugfix', riskTier: 'high',
        engineeringTask: { goalId: 'goal-1', policyDigest: 'digest-1', goalRevision: 7, userIntentRevision: 2, scopedPath: 'src/auth/session.ts' },
      },
    });
    expect(getGoal).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith('workspace-1', 'Fix auth bug', 'src/auth/session.ts');
  });

  it('keeps policy drift and incomplete acceptance visibly pending', async () => {
    const getGoal = vi.fn(async () => ok({
      goalId: 'goal-1', workspaceId: 'workspace-1', objective: 'Fix auth bug', status: 'active', revision: 7, userIntentRevision: 2,
      currentPhase: 'validate', nextAction: 'Revalidate', blockers: [], trackedTasks: [],
      acceptanceCriteria: [{ id: 'bug-fixed', title: 'Bug fixed', status: 'pending' }], plan: { steps: [] },
      engineering: { schemaVersion: 1, primaryTaskKind: 'bugfix', riskTier: 'high', policyDigest: 'old-digest', deliveryScope: 'local',
        gates: [{ id: 'diff', title: 'Diff', applicability: 'required', status: 'passed', reason: 'Done', basedOnUserIntentRevision: 2,
          evidence: { source: 'host_observed', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1' } }] },
    } as never));
    const prepare = vi.fn(async () => ok({ policy: { enabled: true, policyDigest: 'new-digest' } } as never));
    const tool = engineeringTools({ actor, contextEconomy: {} as never, services: { goals: { getGoal } as never, engineeringPreparation: { prepare } as never } })
      .find((entry) => entry.name === 'engineering_get_status');
    expect(await tool?.execute({ goalId: 'goal-1' }, new AbortController().signal)).toMatchObject({
      ok: true, value: { policyChanged: true, deliveryBoundary: 'checks_pending', acceptanceCriteria: [{ id: 'bug-fixed', status: 'pending' }] },
    });
  });

  it('does not claim local readiness from a passed gate backed only by user attestation', async () => {
    const getGoal = vi.fn(async () => ok({
      goalId: 'goal-1', workspaceId: 'workspace-1', objective: 'Fix auth bug', status: 'active', revision: 3, userIntentRevision: 0,
      currentPhase: 'validate', nextAction: 'Verify diff', blockers: [], trackedTasks: [],
      acceptanceCriteria: [{ id: 'done', title: 'Done', status: 'completed' }], plan: { steps: [{ id: 'fix', title: 'Fix', status: 'completed' }] },
      engineering: { schemaVersion: 1, primaryTaskKind: 'bugfix', riskTier: 'medium', policyDigest: 'digest-1', deliveryScope: 'local',
        gates: [{ id: 'diff', title: 'Diff', applicability: 'required', status: 'passed', reason: 'Checked', basedOnUserIntentRevision: 0,
          evidence: { source: 'user_attested', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1' } }] },
    } as never));
    const tool = engineeringTools({ actor, contextEconomy: {} as never, services: { goals: { getGoal } as never,
      engineeringPreparation: { prepare: vi.fn(async () => ok({ policy: { enabled: true, policyDigest: 'digest-1' } } as never)) } as never } })
      .find((entry) => entry.name === 'engineering_get_status');
    expect(await tool?.execute({ goalId: 'goal-1' }, new AbortController().signal)).toMatchObject({
      ok: true, value: { unresolvedGateIds: ['diff'], deliveryBoundary: 'checks_pending' },
    });
  });
});
