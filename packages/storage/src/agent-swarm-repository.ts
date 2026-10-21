import type {
  AgentSwarmRecord,
  AgentSwarmState,
  AgentSwarmTaskRecord,
  AgentSwarmTaskState,
  AgentSwarmTaskUpdate,
  CreateAgentSwarmRecord,
} from '@lnwjing/domain';
import type { SqliteDatabase } from './database.js';

export type StoredAgentSwarmState = AgentSwarmState;
export type StoredAgentSwarmTaskState = AgentSwarmTaskState;
export type StoredAgentSwarmTask = AgentSwarmTaskRecord;
export type StoredAgentSwarm = AgentSwarmRecord;
export type CreateStoredAgentSwarm = CreateAgentSwarmRecord;

interface SwarmRow {
  id: string; owner_client_id: string; owner_session_id: string; workspace_id: string; idempotency_key: string;
  max_concurrency: number; state: string; created_at: string; updated_at: string;
}
interface TaskRow {
  swarm_id: string; task_id: string; prompt_digest: string; prompt_length: number; depends_on_json: string; state: string;
  codex_task_id: string | null; result_text: string; output_truncated: number; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
}

export class SqliteAgentSwarmRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public create(input: CreateStoredAgentSwarm): StoredAgentSwarm {
    const existing = this.findByIdempotency(input.ownerClientId, input.ownerSessionId, input.workspaceId, input.idempotencyKey);
    if (existing !== undefined) return existing;
    const db = this.database.connection;
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`INSERT INTO agent_swarms (id, owner_client_id, owner_session_id, workspace_id, idempotency_key, max_concurrency, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(input.id, input.ownerClientId, input.ownerSessionId, input.workspaceId, input.idempotencyKey, input.maxConcurrency, input.createdAt, input.createdAt);
      const insert = db.prepare(`INSERT INTO agent_swarm_tasks (swarm_id, task_id, prompt_digest, prompt_length, depends_on_json, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const task of input.tasks) insert.run(input.id, task.id, task.promptDigest, task.promptLength, JSON.stringify(task.dependsOn), task.state, input.createdAt);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      const raced = this.findByIdempotency(input.ownerClientId, input.ownerSessionId, input.workspaceId, input.idempotencyKey);
      if (raced !== undefined) return raced;
      throw error;
    }
    return this.requireOwned(input.id, input.ownerClientId, input.ownerSessionId, input.workspaceId);
  }

  public getOwned(id: string, ownerClientId: string, ownerSessionId: string, workspaceId: string): StoredAgentSwarm | undefined {
    const row = this.database.connection.prepare('SELECT * FROM agent_swarms WHERE id = ? AND owner_client_id = ? AND owner_session_id = ? AND workspace_id = ?')
      .get(id, ownerClientId, ownerSessionId, workspaceId) as SwarmRow | undefined;
    return row === undefined ? undefined : this.fromRow(row);
  }

  public findByIdempotency(ownerClientId: string, ownerSessionId: string, workspaceId: string, idempotencyKey: string): StoredAgentSwarm | undefined {
    const row = this.database.connection.prepare('SELECT * FROM agent_swarms WHERE owner_client_id = ? AND owner_session_id = ? AND workspace_id = ? AND idempotency_key = ?')
      .get(ownerClientId, ownerSessionId, workspaceId, idempotencyKey) as SwarmRow | undefined;
    return row === undefined ? undefined : this.fromRow(row);
  }

  public listOwned(ownerClientId: string, ownerSessionId: string, workspaceId: string, limit: number, offset: number): readonly StoredAgentSwarm[] {
    const rows = this.database.connection.prepare('SELECT * FROM agent_swarms WHERE owner_client_id = ? AND owner_session_id = ? AND workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(ownerClientId, ownerSessionId, workspaceId, limit, offset) as unknown as SwarmRow[];
    return rows.map((row) => this.fromRow(row));
  }

  public updateSwarmState(id: string, state: StoredAgentSwarmState, updatedAt: string): void {
    this.database.connection.prepare('UPDATE agent_swarms SET state = ?, updated_at = ? WHERE id = ?').run(state, updatedAt, id);
  }

  public updateTask(id: string, taskId: string, patch: AgentSwarmTaskUpdate, updatedAt: string): void {
    const current = this.database.connection.prepare('SELECT * FROM agent_swarm_tasks WHERE swarm_id = ? AND task_id = ?').get(id, taskId) as TaskRow | undefined;
    if (current === undefined) return;
    this.database.connection.prepare(`UPDATE agent_swarm_tasks SET state = ?, codex_task_id = ?, result_text = ?, output_truncated = ?, error = ?, started_at = ?, finished_at = ? WHERE swarm_id = ? AND task_id = ?`)
      .run(
        patch.state ?? current.state,
        patch.codexTaskId === undefined ? current.codex_task_id : patch.codexTaskId,
        patch.resultText ?? current.result_text,
        patch.outputTruncated === undefined ? current.output_truncated : patch.outputTruncated ? 1 : 0,
        patch.error === undefined ? current.error : patch.error,
        patch.startedAt === undefined ? current.started_at : patch.startedAt,
        patch.finishedAt === undefined ? current.finished_at : patch.finishedAt,
        id,
        taskId,
      );
    this.database.connection.prepare('UPDATE agent_swarms SET updated_at = ? WHERE id = ?').run(updatedAt, id);
  }

  public markLiveTasksTerminationUnverified(): number {
    const now = new Date().toISOString();
    const result = this.database.connection.prepare(`UPDATE agent_swarm_tasks SET state = 'termination_unverified', error = 'runtime state unavailable after restart', finished_at = ? WHERE state IN ('blocked','queued','running')`).run(now);
    this.database.connection.prepare(`UPDATE agent_swarms SET state = 'termination_unverified', updated_at = ? WHERE state IN ('queued','running') AND EXISTS (SELECT 1 FROM agent_swarm_tasks t WHERE t.swarm_id = agent_swarms.id AND t.state = 'termination_unverified')`).run(now);
    return Number(result.changes);
  }

  private requireOwned(id: string, ownerClientId: string, ownerSessionId: string, workspaceId: string): StoredAgentSwarm {
    const value = this.getOwned(id, ownerClientId, ownerSessionId, workspaceId);
    if (value === undefined) throw new Error('Agent swarm was not found after create');
    return value;
  }

  private fromRow(row: SwarmRow): StoredAgentSwarm {
    const tasks = this.database.connection.prepare('SELECT * FROM agent_swarm_tasks WHERE swarm_id = ? ORDER BY rowid ASC').all(row.id) as unknown as TaskRow[];
    return {
      id: row.id,
      ownerClientId: row.owner_client_id,
      ownerSessionId: row.owner_session_id,
      workspaceId: row.workspace_id,
      idempotencyKey: row.idempotency_key,
      maxConcurrency: row.max_concurrency,
      state: row.state as StoredAgentSwarmState,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tasks: tasks.map((task) => ({
        id: task.task_id,
        promptDigest: task.prompt_digest,
        promptLength: task.prompt_length,
        dependsOn: safeStringArray(task.depends_on_json),
        state: task.state as StoredAgentSwarmTaskState,
        ...(task.codex_task_id === null ? {} : { codexTaskId: task.codex_task_id }),
        resultText: task.result_text,
        outputTruncated: task.output_truncated === 1,
        ...(task.error === null ? {} : { error: task.error }),
        createdAt: task.created_at,
        ...(task.started_at === null ? {} : { startedAt: task.started_at }),
        ...(task.finished_at === null ? {} : { finishedAt: task.finished_at }),
      })),
    };
  }
}

function safeStringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : [];
  } catch {
    return [];
  }
}
