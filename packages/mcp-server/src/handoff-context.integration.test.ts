import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appError, err, ok, type GoalContextCapsuleRecord } from '@lnwjing/domain';
import { FileService, SearchService, type GoalSnapshot } from '@lnwjing/application';
import type { WorkspaceRepository } from '@lnwjing/workspace';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';

const actor = { clientId: 'handoff-client', clientName: 'Handoff fixture', sessionId: 'handoff-session' };
const workspaceId = 'handoff-workspace';
const directories: string[] = [];
const now = '2026-10-12T00:00:00.000Z';
const goal: GoalSnapshot = {
  goalId: 'goal-handoff', goalKey: 'handoff', workspaceId, objective: 'Keep verified work', status: 'active', revision: 7,
  userIntentRevision: 1, currentPhase: 'verify', plan: { steps: [] }, acceptanceCriteria: [],
  iterationPolicy: { mode: 'outcome', currentIteration: 0, maxIterations: 1, stopOnNoNewEvidence: true },
  completedSteps: [], pendingSteps: [], blockers: [], activeTaskIds: [], trackedTasks: [], ponytailMode: 'inherit',
  nextAction: 'Continue validation', leaseGeneration: 2, leaseActivitySeq: 3, createdAt: now, updatedAt: now,
  lastCheckpoint: { id: 'checkpoint-handoff', goalId: 'goal-handoff', revision: 7, currentPhase: 'verify', summary: 'Retain exact recovery',
    stepUpdates: [], nextAction: 'Continue validation', blockers: [], evidence: [], activeTaskIds: [], createdAt: now,
    resumeContext: { changedFiles: ['src/ไทย.ts'], pendingValidation: ['Package proof'], decisions: ['Keep completed units'], commands: [], failedAttempts: [], resumePrerequisites: [], stateFacts: [], artifacts: [] } },
};
const capsule: GoalContextCapsuleRecord = {
  id: 'capsule-handoff', goalId: goal.goalId, sourceGoalRevision: goal.revision, sourceUserIntentRevision: goal.userIntentRevision,
  payload: { objective: goal.objective, currentPhase: goal.currentPhase, plan: goal.plan, acceptanceCriteria: [], userSteering: [], completedWork: [], remainingWork: [], validation: [], artifacts: [], blockers: [], nextAction: goal.nextAction,
    changedFiles: ['src/ไทย.ts'], decisions: ['Keep the exact saved decision'] }, createdAt: now,
};

function recoveryServices(): McpApplicationServices {
  const unavailable = async (): Promise<ReturnType<typeof err>> => err(appError('INTERNAL_ERROR', 'Unexpected fixture Goal mutation'));
  return {
    goals: {
      runGoal: unavailable, getGoal: unavailable, validateGoalLease: unavailable, updateGoalPlan: unavailable,
      updateGoalAcceptance: unavailable, reviseGoalIntent: unavailable, createContextCapsule: unavailable,
      getContextCapsule: unavailable, recordDeliveryReceipt: unavailable, listDeliveryReceipts: unavailable,
      advanceGoalIteration: unavailable, checkpointGoal: unavailable, finishGoal: unavailable, cancelGoal: unavailable,
      reconcileGoals: unavailable, async listGoals(): Promise<ReturnType<typeof ok<{ goals: GoalSnapshot[] }>>> { return ok({ goals: [goal] }); }, async listContextCapsules(): Promise<ReturnType<typeof ok<GoalContextCapsuleRecord[]>>> { return ok([capsule]); },
    },
    capabilities: { async execute(name, input): Promise<ReturnType<typeof ok>> {
      expect(name).toBe('shell');
      expect(input.metadata).toMatchObject({ 'lnwjing.taskOwner.v1': { clientId: actor.clientId, sessionId: actor.sessionId, workspaceId } });
      if (input.operation === 'list') return ok({ tasks: [{ task_id: 'saved-task', durable: true, state: 'running' }] });
      expect(input.operation).toBe('status');
      expect(input.task_id).toBe('saved-task');
      return ok({ task_id: 'saved-task', durable: true, state: 'completed', exit_code: 0, stdout: '  ไทย 😀\nDONE  ' });
    } },
  };
}

async function localProviders(): Promise<{ file: FileService; search: SearchService }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-handoff-context-'));
  directories.push(directory);
  const root = await realpath(directory);
  const workspace = { id: workspaceId, displayName: 'Handoff fixture', rootPath: root, realRootPath: root, createdAt: now };
  const repository: WorkspaceRepository = {
    async get(id) { return id === workspaceId ? workspace : null; }, async list() { return [workspace]; },
    async insert() { throw new Error('Unexpected workspace insertion'); }, async delete() { throw new Error('Unexpected workspace deletion'); },
  };
  await writeFile(path.join(root, 'ไทย.ts'), 'export const fixture = "  ไทย 😀  ";\n');
  return { file: new FileService(repository), search: new SearchService(repository) };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('lnwjing-handoff-context-')) throw new Error('Refusing unexpected fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('handoff_context primary recovery', () => {
  it('returns Goal, checkpoint, capsule and completed owned-task receipt without Git, search or file providers', async () => {
    const registry = new ToolRegistry(recoveryServices(), actor);
    const response = await registry.invoke('handoff_context', { workspaceId, query: 'Saved work' });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ tool: 'handoff_context', goal_state: { goalId: goal.goalId, lastCheckpoint: goal.lastCheckpoint }, context_capsule: capsule,
      source_priority: ['durable_goal', 'checkpoint_resume_context', 'context_capsule', 'git_workspace', 'legacy_tracker'],
      background_tasks: [{ task_id: 'saved-task', state: 'completed', exit_code: 0, stdout_tail: '  ไทย 😀\nDONE  ' }],
      git_state: { status: 'unavailable' }, context: null, context_observation: { status: 'unavailable' } });
  });

  it.each(['missing', 'error', 'throw'])('keeps primary recovery when the optional Git provider is %s', async (mode) => {
    const local = await localProviders();
    const failure = async (): Promise<ReturnType<typeof err>> => { if (mode === 'throw') throw new Error('secret=do-not-publish'); return err(appError('INTERNAL_ERROR', 'secret=do-not-publish')); };
    const services: McpApplicationServices = { ...recoveryServices(), ...local,
      ...(mode === 'missing' ? {} : { git: { status: failure, diff: failure, log: failure, run: failure } }) };
    const response = await new ToolRegistry(services, actor).invoke('handoff_context', { workspaceId, query: 'fixture', limit: 1 });
    expect(response.structuredContent).toMatchObject({ goal_state: { goalId: goal.goalId }, context_capsule: capsule, git_state: { status: 'unavailable' },
      context_observation: { status: 'partial' }, context: { completeness: 'partial', files: [expect.objectContaining({ path: expect.stringMatching(/(?:^|[/\\])ไทย\.ts$/) })] }, background_tasks: [{ state: 'completed' }] });
    expect(JSON.stringify(response.structuredContent)).not.toContain('do-not-publish');
  });

  it.each(['error', 'throw'])('keeps recovery and source evidence when search is %s', async (mode) => {
    const local = await localProviders();
    const failure = async (): Promise<ReturnType<typeof err>> => { if (mode === 'throw') throw new Error('secret=do-not-publish'); return err(appError('INTERNAL_ERROR', 'secret=do-not-publish')); };
    vi.spyOn(local.search, 'searchText').mockImplementation(failure);
    vi.spyOn(local.search, 'searchFiles').mockImplementation(failure);
    const response = await new ToolRegistry({ ...recoveryServices(), ...local }, actor).invoke('handoff_context', { workspaceId, query: 'fixture' });
    expect(response.structuredContent).toMatchObject({ goal_state: { goalId: goal.goalId }, context_capsule: capsule,
      context: { completeness: mode === 'throw' ? 'unknown' : 'unavailable', files: [], observations: expect.arrayContaining([
        expect.objectContaining({ source: 'text_search', state: mode === 'throw' ? 'unknown' : 'unavailable' }),
        expect.objectContaining({ source: 'file_search', state: mode === 'throw' ? 'unknown' : 'unavailable' }),
      ]) }, context_observation: { status: mode === 'throw' ? 'unknown' : 'unavailable', errors: expect.arrayContaining([{ code: 'INTERNAL_ERROR' }]) }, background_tasks: [{ state: 'completed' }] });
    expect(JSON.stringify(response.structuredContent)).not.toContain('do-not-publish');
  });

  it('consumes explicit tracker and diff bounds while reporting unknown sources separately from saved recovery', async () => {
    const local = await localProviders();
    const read = vi.spyOn(local.file, 'readFile');
    const diff = vi.fn(async (): Promise<ReturnType<typeof err>> => err(appError('INTERNAL_ERROR', 'Git unavailable')));
    const unavailable = async (): Promise<ReturnType<typeof err>> => err(appError('INTERNAL_ERROR', 'Git unavailable'));
    const response = await new ToolRegistry({ ...recoveryServices(), ...local, git: { status: unavailable, diff, log: unavailable, run: unavailable } }, actor)
      .invoke('handoff_context', { workspaceId, trackerPath: 'saved-tracker.md', maxDiffBytes: 1000, query: 'fixture', limit: 1 });
    expect(response.structuredContent).toMatchObject({ goal_state: { goalId: goal.goalId }, tracker_path: 'saved-tracker.md', tracker_available: false, git_diff: { unstaged: null, staged: null, truncated: null } });
    expect(read.mock.calls[0]?.[2]).toMatchObject({ path: 'saved-tracker.md' });
    expect(diff.mock.calls).toHaveLength(2);
    expect(diff.mock.calls[0]?.[2]).toMatchObject({ maxBytes: 1000 });
  });

  it('reports failed optional file observations as partial without exposing opaque provider error text', async () => {
    const local = await localProviders();
    vi.spyOn(local.file, 'readFile').mockImplementation(async () => err(appError('INTERNAL_ERROR', 'secret=do-not-publish')));
    const response = await new ToolRegistry({ ...recoveryServices(), ...local }, actor).invoke('handoff_context', { workspaceId, query: 'fixture', limit: 1 });
    expect(response.structuredContent).toMatchObject({ goal_state: { goalId: goal.goalId }, context_observation: { status: 'partial', errors: expect.arrayContaining([{ code: 'INTERNAL_ERROR' }, { code: 'UNSUPPORTED_PLATFORM' }]) } });
    expect(JSON.stringify(response.structuredContent)).not.toContain('do-not-publish');
  });
});
