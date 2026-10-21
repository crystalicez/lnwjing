import { Redactor } from '@lnwjing/audit';
import type { GoalRecord } from '@lnwjing/domain';
import type { McpServerListItem } from '@lnwjing/extensions';
import type { WatcherGoalSnapshot, WatcherSnapshot } from './watcher-server.js';

const redactor = new Redactor();

function safeText(value: string, limit: number): string {
  return redactor.redactText(value).slice(0, limit);
}

/** A completed checklist is ready for explicit finalization, not a terminal goal. */
export function watcherGoalFromRecord(goal: GoalRecord, workspaceName: string): WatcherGoalSnapshot {
  const completionReady = goal.plan.steps.length > 0
    && goal.plan.steps.every((step) => step.status === 'completed')
    && goal.acceptanceCriteria.every((criterion) => criterion.status === 'completed')
    && goal.blockers.length === 0
    && goal.activeTaskIds.length === 0;
  return {
    id: goal.id,
    key: safeText(goal.goalKey, 128),
    status: goal.blockers.length > 0 ? 'blocked' : completionReady ? 'idle' : 'waiting',
    currentTask: safeText(goal.nextAction, 500),
    blockers: goal.blockers.map((blocker) => safeText(blocker, 300)),
    milestones: goal.plan.steps.map((step) => ({ id: step.id, title: safeText(step.title, 300), status: step.status })),
    workspaceId: goal.workspaceId,
    workspaceName,
    lifecycle: 'active',
    completionReady,
    objective: safeText(goal.objective, 1_000),
    currentPhase: safeText(goal.currentPhase, 256),
    acceptanceCriteria: goal.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      title: safeText(criterion.title, 300),
      status: criterion.status,
    })),
    activeTaskCount: goal.activeTaskIds.length,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(goal.checkpoints.at(-1) === undefined ? {} : { lastCheckpointAt: goal.checkpoints.at(-1)!.createdAt }),
  };
}

/** The user-configured MCP server name is safe to show; launch details are not. */
export function watcherPluginsFromServers(servers: readonly McpServerListItem[]): NonNullable<WatcherSnapshot['plugins']> {
  return servers.map((server) => ({
    name: safeText(server.name, 128),
    provider: 'mcp',
    enabled: server.enabled,
    connected: server.connected,
    excluded: server.excluded,
    lifecycle: server.lifecycle ?? 'disconnected',
  }));
}
