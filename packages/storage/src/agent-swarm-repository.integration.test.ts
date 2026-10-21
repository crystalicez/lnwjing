import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteAgentSwarmRepository, type CreateStoredAgentSwarm } from './agent-swarm-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ database: SqliteDatabase; repository: SqliteAgentSwarmRepository }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-agent-swarm-db-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  return { database, repository: new SqliteAgentSwarmRepository(database) };
}

function createInput(id = 'swarm-1'): CreateStoredAgentSwarm {
  return {
    id,
    ownerClientId: 'client-a',
    ownerSessionId: 'session-a',
    workspaceId: 'workspace-a',
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
    maxConcurrency: 2,
    createdAt: '2026-08-31T00:00:00.000Z',
    tasks: [
      {
        id: 'inspect',
        promptDigest: 'a'.repeat(64),
        promptLength: 31,
        dependsOn: [] as readonly string[],
        state: 'queued' as const,
      },
      {
        id: 'summarize',
        promptDigest: 'b'.repeat(64),
        promptLength: 29,
        dependsOn: ['inspect'] as readonly string[],
        state: 'blocked' as const,
      },
    ],
  };
}

describe('SqliteAgentSwarmRepository', () => {
  it('persists owner-scoped metadata without prompt plaintext and preserves task order', async () => {
    const { database, repository } = await fixture();
    try {
      const created = repository.create(createInput());
      expect(created).toMatchObject({
        id: 'swarm-1',
        ownerClientId: 'client-a',
        ownerSessionId: 'session-a',
        workspaceId: 'workspace-a',
        state: 'queued',
        tasks: [
          { id: 'inspect', promptDigest: 'a'.repeat(64), promptLength: 31, state: 'queued' },
          { id: 'summarize', promptDigest: 'b'.repeat(64), promptLength: 29, state: 'blocked', dependsOn: ['inspect'] },
        ],
      });

      expect(repository.getOwned('swarm-1', 'client-a', 'session-a', 'workspace-a')).toEqual(created);
      expect(repository.getOwned('swarm-1', 'client-b', 'session-a', 'workspace-a')).toBeUndefined();
      expect(repository.getOwned('swarm-1', 'client-a', 'session-b', 'workspace-a')).toBeUndefined();
      expect(repository.getOwned('swarm-1', 'client-a', 'session-a', 'workspace-b')).toBeUndefined();

      const schemaDump = JSON.stringify(database.connection.prepare('SELECT * FROM agent_swarm_tasks WHERE swarm_id = ? ORDER BY rowid').all('swarm-1'));
      expect(schemaDump).not.toContain('inspect the secret project');
      expect(schemaDump).not.toContain('prompt_plaintext');
    } finally {
      database.close();
    }
  });

  it('uses owner/workspace/idempotency as the durable uniqueness boundary', async () => {
    const { database, repository } = await fixture();
    try {
      const first = repository.create(createInput('swarm-first'));
      const repeated = repository.create({ ...createInput('swarm-second'), tasks: [createInput().tasks[0]!] });
      expect(repeated.id).toBe(first.id);
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM agent_swarms').get()).toMatchObject({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('marks every nonterminal persisted task termination_unverified after a runtime restart', async () => {
    const { database, repository } = await fixture();
    try {
      repository.create(createInput());
      repository.updateTask('swarm-1', 'inspect', { state: 'running', codexTaskId: 'codex-live', startedAt: '2026-08-31T00:00:01.000Z' }, '2026-08-31T00:00:01.000Z');
      expect(repository.markLiveTasksTerminationUnverified()).toBe(2);
      expect(repository.getOwned('swarm-1', 'client-a', 'session-a', 'workspace-a')).toMatchObject({
        state: 'termination_unverified',
        tasks: [
          { id: 'inspect', state: 'termination_unverified', error: 'runtime state unavailable after restart' },
          { id: 'summarize', state: 'termination_unverified', error: 'runtime state unavailable after restart' },
        ],
      });
    } finally {
      database.close();
    }
  });

  it('round-trips bounded terminal result metadata without changing ownership', async () => {
    const { database, repository } = await fixture();
    try {
      repository.create(createInput());
      repository.updateTask('swarm-1', 'inspect', {
        state: 'completed',
        codexTaskId: 'codex-1',
        resultText: 'done',
        outputTruncated: false,
        startedAt: '2026-08-31T00:00:01.000Z',
        finishedAt: '2026-08-31T00:00:02.000Z',
      }, '2026-08-31T00:00:02.000Z');
      repository.updateSwarmState('swarm-1', 'running', '2026-08-31T00:00:02.000Z');

      expect(repository.listOwned('client-a', 'session-a', 'workspace-a', 20, 0)).toEqual([
        expect.objectContaining({
          id: 'swarm-1',
          tasks: expect.arrayContaining([expect.objectContaining({ id: 'inspect', state: 'completed', resultText: 'done' })]),
        }),
      ]);
      expect(repository.listOwned('client-b', 'session-a', 'workspace-a', 20, 0)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
