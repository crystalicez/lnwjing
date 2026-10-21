import type { AgentSwarmState, AgentSwarmTaskState } from '@lnwjing/domain';

export type { AgentSwarmState, AgentSwarmTaskState } from '@lnwjing/domain';

export interface AgentSwarmTaskRequest {
  readonly id: string;
  readonly prompt: string;
  readonly dependsOn?: readonly string[];
}

export interface AgentSwarmStartRequest {
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly accessMode: 'read_only';
  readonly tasks: readonly AgentSwarmTaskRequest[];
  readonly maxConcurrency?: number;
}

export interface AgentSwarmTaskSnapshot {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly state: AgentSwarmTaskState;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly resultAvailable: boolean;
  readonly outputTruncated: boolean;
  readonly error?: string;
}

export interface AgentSwarmSnapshot {
  readonly swarmId: string;
  readonly workspaceId: string;
  readonly state: AgentSwarmState;
  readonly maxConcurrency: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tasks: readonly AgentSwarmTaskSnapshot[];
}

export interface AgentSwarmResultPage {
  readonly swarmId: string;
  readonly taskId: string;
  readonly state: AgentSwarmTaskState;
  readonly text: string;
  readonly nextCursor?: string;
  readonly eof: boolean;
  readonly outputTruncated: boolean;
}

export interface AgentSwarmListPage {
  readonly items: readonly AgentSwarmSnapshot[];
  readonly nextCursor?: string;
}
