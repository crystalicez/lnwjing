import { describe, expect, it } from 'vitest';
import type { GoalRecord } from '@lnwjing/domain';
import type { McpServerListItem } from '@lnwjing/extensions';
import { watcherGoalFromRecord, watcherPluginsFromServers } from '../src/main/watcher-projection.js';

const goal = {
  id: 'goal-1', goalKey: 'release', workspaceId: 'workspace-1', objective: 'Ship the release',
  currentPhase: 'verification', nextAction: '', blockers: [], activeTaskIds: [],
  plan: { steps: [{ id: 'build', title: 'Build', status: 'completed' }] },
  acceptanceCriteria: [{ id: 'ci', title: 'CI green', status: 'completed' }],
  createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:10:00.000Z',
  checkpoints: [{ createdAt: '2026-09-27T00:09:00.000Z' }],
} as GoalRecord;

describe('Watcher goal projection', () => {
  it('marks completed durable work as ready for explicit finalization without reporting active execution', () => {
    expect(watcherGoalFromRecord(goal, 'Project')).toMatchObject({
      status: 'idle', lifecycle: 'active', completionReady: true,
      acceptanceCriteria: [{ id: 'ci', status: 'completed' }],
      lastCheckpointAt: '2026-09-27T00:09:00.000Z',
    });
  });

  it('does not mark a goal ready while criteria, blockers, or blocking tasks remain', () => {
    expect(watcherGoalFromRecord({ ...goal, acceptanceCriteria: [{ id: 'ci', title: 'CI green', status: 'pending' }] }, 'Project').completionReady).toBe(false);
    expect(watcherGoalFromRecord({ ...goal, activeTaskIds: ['task-1'] }, 'Project').completionReady).toBe(false);
    expect(watcherGoalFromRecord({ ...goal, blockers: ['waiting for review'] }, 'Project').status).toBe('blocked');
  });
});

describe('Watcher plugin projection', () => {
  it('publishes configured MCP names and connection state without launch commands or config paths', () => {
    const server = {
      name: 'My Research Plugin', source: 'C:\\private\\mcp.json', command: 'secret-command --token secret',
      enabled: true, connected: true, excluded: false, lifecycle: 'connected',
    } satisfies McpServerListItem;
    expect(watcherPluginsFromServers([server])).toEqual([{
      name: 'My Research Plugin', provider: 'mcp', enabled: true, connected: true,
      excluded: false, lifecycle: 'connected',
    }]);
  });
});
