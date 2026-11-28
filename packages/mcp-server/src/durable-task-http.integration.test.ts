import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CAPABILITY_TASK_OWNER_METADATA_KEY, ShellCapabilityBackend, readCapabilityTaskOwner, type CapabilityTaskOwner } from '@lnwjing/capabilities';
import { appError, err } from '@lnwjing/domain';
import { createHash, randomBytes } from 'node:crypto';
import { GoalContinuationService } from '@lnwjing/application';
import { SqliteDatabase } from '../../storage/src/database.js';
import { SqliteGoalRepository } from '../../storage/src/goal-repository.js';
import { SqliteWorkspaceRepository } from '../../storage/src/workspace-repository.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startMcpHttp, type McpHttpServerHandle } from './http.js';
import { createProtocolHttpRequestScope } from './request-scope.js';

const metadataSchema = z.object({ owner_client_id: z.string(), owner_session_id: z.string(), owner_workspace_id: z.string() });
const launchRecordSchema = z.object({ taskId: z.string(), ownerClientId: z.string(), ownerSessionId: z.string(), ownerWorkspaceId: z.string() });
const stdout = '  ready ไทย 😀\n  done ไทย 😀  \n';
const stderr = 'warning ไทย\nfinished\n';
const fixtureSource = `
import fs from 'node:fs';
import path from 'node:path';
const [readyPath, releasePath] = process.argv.slice(2);
let finished = false;
const watcher = fs.watch(path.dirname(releasePath), finish);
function finish() {
  if (finished || !fs.existsSync(releasePath)) return;
  finished = true;
  watcher.close();
  process.stdout.write('  done ไทย 😀  \\n');
  process.stderr.write('finished\\n');
}
process.stdout.write('  ready ไทย 😀\\n');
process.stderr.write('warning ไทย\\n');
fs.writeFileSync(readyPath, 'ready');
finish();
`;

const cases: Array<{ protocol: 'modern' | 'legacy'; launchTool: 'shell' | 'task_create' }> = [
  { protocol: 'modern', launchTool: 'shell' },
  { protocol: 'modern', launchTool: 'task_create' },
  { protocol: 'legacy', launchTool: 'shell' },
  { protocol: 'legacy', launchTool: 'task_create' },
];

describe('durable task ownership over HTTP', () => {
  it.each(cases)('$protocol $launchTool preserves outputs and ownership across provider replacement', async ({ protocol, launchTool }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-owned-http-'));
    const rootA = path.join(directory, 'a');
    const rootB = path.join(directory, 'b');
    const taskDirectory = path.join(directory, 'tasks');
    await Promise.all([mkdir(rootA), mkdir(rootB)]);
    const readyPath = path.join(rootA, 'ready.flag');
    const releasePath = path.join(rootA, 'release.flag');
    const fixturePath = path.join(rootA, 'fixture.mjs');
    await writeFile(fixturePath, fixtureSource, 'utf8');
    const makeBackend = (): ShellCapabilityBackend => new ShellCapabilityBackend({ allowedRoots: [rootA, rootB], taskStateDirectory: taskDirectory, autoWaitSeconds: 0 });
    let backend = makeBackend();
    const owners: CapabilityTaskOwner[] = [];
    let approveLegacyRecovery = false;
    const approvals: string[] = [];
    const options = {
      port: 0,
      services: {
        capabilities: {
          async execute(tool: string, input: unknown, signal?: AbortSignal, authorization?: Parameters<ShellCapabilityBackend['execute']>[2]): ReturnType<ShellCapabilityBackend['execute']> {
            if (tool !== 'shell') return err(appError('INVALID_INPUT', 'Unsupported fixture capability'));
            owners.push(readCapabilityTaskOwner(input));
            return backend.execute(input, signal, authorization);
          },
        },
      },
      actor: { clientId: 'durable-http-owner', clientName: 'durable-http-owner' },
      activeWorkspaceScopesProvider: async (): Promise<Array<{ workspaceId: string; rootPath: string }>> => [{ workspaceId: 'workspace-a', rootPath: rootA }, { workspaceId: 'workspace-b', rootPath: rootB }],
      hostMutationApprovalProvider: async (request: { summary: string }): Promise<boolean> => { approvals.push(request.summary); return approveLegacyRecovery; },
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    };
    const handle = await startMcpHttp(options);
    let foreignHandle: McpHttpServerHandle | undefined;
    const makeClient = (): Client => new Client({ name: 'durable-http-fixture', version: '1.0.0' }, {
      versionNegotiation: { mode: protocol === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
    });
    const client = makeClient();
    const foreignClient = makeClient();
    const transport = new StreamableHTTPClientTransport(handle.endpoint);
    let taskId: string | undefined;
    let launchOwner: CapabilityTaskOwner | undefined;
    try {
      await client.connect(transport);
      const conflict = await client.callTool({ name: launchTool, arguments: {
        workspaceId: 'workspace-a', executable: process.execPath, arguments: ['--version'], cwd: rootB,
        ...(launchTool === 'shell' ? { operation: 'run' } : {}),
      } });
      expect(conflict, JSON.stringify(conflict)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
      expect(owners).toEqual([]);

      const launched = await client.callTool({ name: launchTool, arguments: {
        workspaceId: 'workspace-a', executable: process.execPath, arguments: [fixturePath, readyPath, releasePath], cwd: rootA,
        timeout_seconds: 30, ...(launchTool === 'shell' ? { operation: 'run', execution: 'background', request_id: 'http-recovery-key' } : {}),
      } });
      expect(launched.isError, JSON.stringify(launched)).not.toBe(true);
      taskId = z.string().min(1).parse(launched.structuredContent?.task_id);
      launchOwner = owners[0];
      if (launchOwner === undefined) throw new Error('Trusted launch owner was not captured');
      expect(launchOwner).toMatchObject({ clientId: options.actor.clientId, workspaceId: 'workspace-a' });
      expect(launchOwner.sessionId).not.toBe('legacy');
      if (protocol === 'legacy') {
        expect(transport.sessionId).toEqual(expect.any(String));
        expect(launchOwner.sessionId).toBe(createProtocolHttpRequestScope(z.string().parse(transport.sessionId)).sessionId);
      }
      const ownerFields = { owner_client_id: launchOwner.clientId, owner_session_id: launchOwner.sessionId, owner_workspace_id: 'workspace-a' };
      const metadataPath = path.join(taskDirectory, taskId, 'task.json');
      expect(metadataSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')))).toEqual(ownerFields);
      await vi.waitFor(async () => { await access(readyPath); }, { timeout: 5000 });
      await vi.waitFor(async () => {
        const logs = await client.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'logs', task_id: taskId } });
        expect(logs.structuredContent).toMatchObject({ state: 'running', stdout: '  ready ไทย 😀\n', stderr: 'warning ไทย\n' });
      }, { timeout: 5000 });
      backend = makeBackend();
      if (launchTool === 'shell') {
        const recovered = await client.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'status', request_id: 'http-recovery-key' } });
        expect(recovered.structuredContent).toMatchObject({ task_id: taskId, state: 'running' });
      }
      for (const operation of ['status', 'logs', 'result', 'wait']) {
        const observed = await client.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation, task_id: taskId, timeout_seconds: 0.1 } });
        expect(observed.isError, JSON.stringify(observed)).not.toBe(true);
        expect(observed.structuredContent, JSON.stringify(observed)).toMatchObject({ task_id: taskId, state: 'running' });
      }
      for (const name of ['task_status', 'task_result']) {
        const observed = await client.callTool({ name, arguments: { workspaceId: 'workspace-a', taskId } });
        expect(observed.structuredContent, JSON.stringify(observed)).toMatchObject({ task_id: taskId, state: 'running' });
      }
      for (const name of ['shell', 'task_list']) {
        const listed = await client.callTool({ name, arguments: { workspaceId: 'workspace-a', ...(name === 'shell' ? { operation: 'list', limit: 10 } : {}) } });
        expect(listed.structuredContent).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ task_id: taskId })]) });
      }
      expect(owners.every((owner) => owner.clientId === launchOwner?.clientId && owner.sessionId === launchOwner.sessionId && owner.workspaceId === 'workspace-a')).toBe(true);

      for (const operation of ['status', 'logs', 'result', 'wait', 'cancel']) {
        const denied = await client.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-b', operation, task_id: taskId, userConfirmed: true } });
        expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
        expect(JSON.stringify(denied)).not.toContain('ready ไทย');
      }
      for (const name of ['task_status', 'task_result', 'task_cancel']) {
        const denied = await client.callTool({ name, arguments: { workspaceId: 'workspace-b', taskId, ...(name === 'task_cancel' ? { userConfirmed: true } : {}) } });
        expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      }
      const foreignWorkspaceList = await client.callTool({ name: 'task_list', arguments: { workspaceId: 'workspace-b' } });
      expect(foreignWorkspaceList.structuredContent).toMatchObject({ tasks: [] });
      if (protocol === 'modern') foreignHandle = await startMcpHttp(options);
      const foreignTransport = new StreamableHTTPClientTransport(foreignHandle?.endpoint ?? handle.endpoint);
      await foreignClient.connect(foreignTransport);
      if (protocol === 'legacy') expect(foreignTransport.sessionId).not.toBe(transport.sessionId);
      for (const operation of ['status', 'result', 'cancel']) {
        const denied = await foreignClient.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation, task_id: taskId, userConfirmed: true } });
        expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      }
      const stillRunning = await client.callTool({ name: 'task_status', arguments: { workspaceId: 'workspace-a', taskId } });
      expect(stillRunning.structuredContent).toMatchObject({ state: 'running' });
      await writeFile(releasePath, 'release');
      const terminal = await client.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'wait', task_id: taskId, timeout_seconds: 5 } });
      expect(terminal.structuredContent).toMatchObject({ state: 'completed', exit_code: 0, stdout, stderr });
      backend = makeBackend();
      const result = await client.callTool({ name: 'task_result', arguments: { workspaceId: 'workspace-a', taskId } });
      expect(result.structuredContent).toMatchObject({ state: 'completed', exit_code: 0, stdout, stderr });
      const recovery = { operation: 'recover_legacy_result', workspaceId: 'workspace-a', task_id: taskId };
      const withoutConfirmation = await foreignClient.callTool({ name: 'shell', arguments: recovery });
      expect(withoutConfirmation).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
      expect(approvals).toEqual([]);
      const refused = await foreignClient.callTool({ name: 'shell', arguments: { ...recovery, userConfirmed: true } });
      expect(refused).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      expect(JSON.stringify(refused)).not.toContain('ready ไทย');
      expect(approvals[0]).toContain(taskId);
      expect(approvals[0]).toContain('workspace-a');
      approveLegacyRecovery = true;
      const wrongScope = await foreignClient.callTool({ name: 'shell', arguments: { ...recovery, workspaceId: 'workspace-b', userConfirmed: true } });
      expect(wrongScope).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      expect(JSON.stringify(wrongScope)).not.toContain('ready ไทย');
      const approved = await foreignClient.callTool({ name: 'shell', arguments: { ...recovery, userConfirmed: true } });
      expect(approved.structuredContent).toMatchObject({ task_id: taskId, state: 'completed', exit_code: 0, stdout, stderr, recovery: 'one_shot_host_approved_legacy_result' });
      const ordinary = await foreignClient.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'result', task_id: taskId } });
      expect(ordinary).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      expect(metadataSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')))).toEqual(ownerFields);
      const journalPath = path.join(taskDirectory, '.index', 'v1', 'launches.jsonl');
      const expectedRecord = { taskId, ownerClientId: launchOwner.clientId, ownerSessionId: launchOwner.sessionId, ownerWorkspaceId: 'workspace-a' };
      const readRecords = async (): Promise<z.infer<typeof launchRecordSchema>[]> => (await readFile(journalPath, 'utf8')).trim().split('\n').map((line) => launchRecordSchema.parse(JSON.parse(line)));
      expect(await readRecords()).toContainEqual(expectedRecord);
      await rm(journalPath);
      backend = makeBackend();
      const rebuilt = await client.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'list', limit: 10 } });
      expect(rebuilt.structuredContent).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ task_id: taskId })]) });
      expect(await readRecords()).toContainEqual(expectedRecord);
    } finally {
      await writeFile(releasePath, 'release');
      if (taskId !== undefined && launchOwner !== undefined) {
        const request = { task_id: taskId, metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: launchOwner } };
        const settled = await backend.execute({ ...request, operation: 'wait', timeout_seconds: 5 });
        if (!settled.ok || z.object({ state: z.string() }).parse(settled.value).state === 'running') {
          await backend.execute({ ...request, operation: 'cancel', userConfirmed: true });
        }
      }
      await Promise.all([client.close().catch(() => undefined), foreignClient.close().catch(() => undefined)]);
      await foreignHandle?.close();
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([
    { protocol: 'modern' as const, scope: 'goal' as const },
    { protocol: 'legacy' as const, scope: 'goal' as const },
    { protocol: 'modern' as const, scope: 'token' as const },
    { protocol: 'legacy' as const, scope: 'token' as const },
  ])('$protocol $scope recovery survives a fresh endpoint and store without spawning again', async ({ protocol, scope }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-recovery-http-'));
    const rootA = path.join(directory, 'a');
    const rootB = path.join(directory, 'b');
    const taskDirectory = path.join(directory, 'tasks');
    const readyPath = path.join(rootA, 'ready.flag');
    const releasePath = path.join(rootA, 'release.flag');
    const fixturePath = path.join(rootA, 'fixture.mjs');
    await Promise.all([mkdir(rootA), mkdir(rootB)]);
    await writeFile(fixturePath, fixtureSource);
    const database = new SqliteDatabase(path.join(directory, 'goals.sqlite'));
    const workspaces = new SqliteWorkspaceRepository(database);
    let now = new Date('2026-11-28T00:00:00Z');
    await workspaces.insert({ id: 'workspace-a', displayName: 'A', rootPath: rootA, realRootPath: rootA, createdAt: now.toISOString() });
    await workspaces.insert({ id: 'workspace-b', displayName: 'B', rootPath: rootB, realRootPath: rootB, createdAt: now.toISOString() });
    const repository = new SqliteGoalRepository(database);
    const goals = new GoalContinuationService(workspaces, repository, { now: (): Date => now });
    const makeBackend = (): ShellCapabilityBackend => new ShellCapabilityBackend({ allowedRoots: [rootA, rootB], taskStateDirectory: taskDirectory });
    let backend = makeBackend();
    let launchOwner: CapabilityTaskOwner | undefined;
    let taskId: string | undefined;
    const token = 'lnwrt_' + randomBytes(32).toString('hex');
    const options = {
      port: 0,
      actor: { clientId: 'recovery-http-owner', clientName: 'fixture' },
      services: {
        goals,
        capabilities: {
          async execute(tool: string, input: unknown, signal?: AbortSignal, authorization?: Parameters<ShellCapabilityBackend['execute']>[2]): ReturnType<ShellCapabilityBackend['execute']> {
            if (tool !== 'shell') return err(appError('INVALID_INPUT', 'Unsupported fixture capability'));
            const owner = readCapabilityTaskOwner(input);
            if (typeof input === 'object' && input !== null && 'operation' in input && input.operation === 'run' && launchOwner === undefined) launchOwner = owner;
            expect(JSON.stringify(input)).not.toContain(token);
            return backend.execute(input, signal, authorization);
          },
        },
      },
      activeWorkspaceScopesProvider: async (): Promise<Array<{ workspaceId: string; rootPath: string }>> => [{ workspaceId: 'workspace-a', rootPath: rootA }, { workspaceId: 'workspace-b', rootPath: rootB }],
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    };
    const makeClient = (): Client => new Client({ name: 'recovery-http-fixture', version: '1.0.0' }, {
      versionNegotiation: { mode: protocol === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
    });
    const first = makeClient();
    const second = makeClient();
    const initial = await startMcpHttp(options);
    let restarted: McpHttpServerHandle | undefined;
    let initialClosed = false;
    const leaseSchema = z.object({ goalId: z.string(), leaseToken: z.string(), leaseGeneration: z.number() });
    const acquire = async (client: Client, goalKey: string): Promise<z.infer<typeof leaseSchema>> => {
      const result = await client.callTool({ name: 'run_goal', arguments: { workspaceId: 'workspace-a', goalKey, objective: 'Fixture recovery', scheduledContinuation: 'off', leaseSeconds: 60 } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return leaseSchema.parse(result.structuredContent);
    };
    try {
      await first.connect(new StreamableHTTPClientTransport(initial.endpoint));
      const initialProof = scope === 'goal' ? { goalLease: await acquire(first, 'reconnect-goal') } : { recovery_token: token };
      const run = { workspaceId: 'workspace-a', executable: process.execPath, arguments: [fixturePath, readyPath, releasePath],
        cwd: rootA, timeout_seconds: 90, request_id: 'one-intended-execution', ...initialProof };
      const launchTool = scope === 'goal' ? 'shell' : 'task_create';
      const launched = await first.callTool({ name: launchTool, arguments: run });
      expect(launched.isError, JSON.stringify(launched)).not.toBe(true);
      const receipt = z.object({ task_id: z.string(), started_at: z.string() }).parse(launched.structuredContent);
      taskId = receipt.task_id;
      if (launchOwner === undefined) throw new Error('Missing launch ownership');
      const originalOwner = launchOwner;
      const metadataPath = path.join(taskDirectory, taskId, 'task.json');
      const metadataText = await readFile(metadataPath, 'utf8');
      expect(metadataText).not.toContain(token);
      if (scope === 'token') {
        expect(JSON.parse(metadataText)).toMatchObject({ owner_recovery_hash: createHash('sha256').update(token).digest('hex') });
        const noProof = await first.callTool({ name: 'task_result', arguments: { workspaceId: 'workspace-a', taskId } });
        expect(noProof, JSON.stringify(noProof)).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      } else {
        expect(originalOwner.goalId).toBe(initialProof.goalLease?.goalId);
        expect(JSON.parse(metadataText)).toMatchObject({ owner_goal_id: originalOwner.goalId });
      }
      await vi.waitFor(async () => { await access(readyPath); }, { timeout: 15000 });
      await first.close();
      await initial.close();
      initialClosed = true;
      // Endpoint identity and backend instance change while the real child stays alive.
      backend = makeBackend();
      restarted = await startMcpHttp(options);
      await second.connect(new StreamableHTTPClientTransport(restarted.endpoint));
      const denied = await second.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'result', task_id: taskId,
        metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: originalOwner } } });
      expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      expect(JSON.stringify(denied)).not.toContain('ready ไทย');
      const legacyRecovery = await second.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'recover_legacy_result', task_id: taskId, userConfirmed: true } });
      expect(legacyRecovery).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      expect(JSON.stringify(legacyRecovery)).not.toContain('ready ไทย');
      let proof: typeof initialProof;
      if (scope === 'goal') {
        const old = await second.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'status', task_id: taskId, ...initialProof } });
        expect(old).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
        now = new Date(now.getTime() + 3600_000);
        const wrong = await acquire(second, 'unrelated-goal');
        expect(await second.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'result', task_id: taskId, goalLease: wrong } }))
          .toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
        await expect(backend.cancelForGoal(options.actor.clientId, 'workspace-a', taskId, wrong.goalId))
          .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
        const recovered = await acquire(second, 'reconnect-goal');
        expect(recovered.goalId).toBe(originalOwner.goalId);
        expect(recovered.leaseGeneration).toBeGreaterThan(initialProof.goalLease!.leaseGeneration);
        proof = { goalLease: recovered };
      } else {
        proof = { recovery_token: token };
        expect(await second.callTool({ name: 'task_result', arguments: { workspaceId: 'workspace-a', taskId, recovery_token: 'lnwrt_' + randomBytes(32).toString('hex') } }))
          .toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
        await expect(backend.cancelForGoal(options.actor.clientId, 'workspace-a', taskId, 'unrelated-goal'))
          .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      }
      expect(await second.callTool({ name: 'task_result', arguments: { workspaceId: 'workspace-b', taskId, ...proof } })).toMatchObject({ isError: true });
      for (const operation of ['status', 'logs', 'result', 'wait']) {
        const observed = await second.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation, task_id: taskId, timeout_seconds: 0.1, ...proof } });
        expect(observed.structuredContent, JSON.stringify(observed)).toMatchObject({ task_id: taskId, state: 'running' });
      }
      const byRequest = await second.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'status', request_id: 'one-intended-execution', ...proof } });
      expect(byRequest.structuredContent).toMatchObject({ task_id: taskId, state: 'running' });
      const alias = await second.callTool({ name: 'task_status', arguments: { workspaceId: 'workspace-a', taskId, ...proof } });
      expect(alias.structuredContent, JSON.stringify(alias)).toMatchObject({ task_id: taskId, state: 'running' });
      const listed = await second.callTool({ name: 'task_list', arguments: { workspaceId: 'workspace-a', ...proof } });
      expect(listed.structuredContent).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ task_id: taskId })]) });
      const replay = await second.callTool({ name: launchTool, arguments: { ...run, ...proof } });
      expect(replay.structuredContent).toMatchObject({ task_id: taskId, started_at: receipt.started_at });
      const changed = await second.callTool({ name: launchTool, arguments: { ...run, ...proof, arguments: ['--version'] } });
      expect(changed).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
      await writeFile(releasePath, 'release');
      await vi.waitFor(async () => {
        const result = await second.callTool({ name: 'task_result', arguments: { workspaceId: 'workspace-a', taskId, ...proof } });
        expect(result.structuredContent).toMatchObject({ task_id: taskId, state: 'completed', exit_code: 0, stdout, stderr });
      }, { timeout: 15000, interval: 200 });
      await rm(path.join(taskDirectory, '.index', 'v1', 'launches.jsonl'));
      backend = makeBackend();
      const rebuilt = await second.callTool({ name: 'task_list', arguments: { workspaceId: 'workspace-a', ...proof } });
      expect(rebuilt.structuredContent).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ task_id: taskId, state: 'completed' })]) });
      expect(await readFile(metadataPath, 'utf8')).not.toContain(token);
      expect(await readFile(path.join(taskDirectory, '.index', 'v1', 'launches.jsonl'), 'utf8')).not.toContain(token);
    } finally {
      await writeFile(releasePath, 'release');
      if (taskId !== undefined && launchOwner !== undefined) {
        const request = { task_id: taskId, metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: launchOwner } };
        const settled = await backend.execute({ ...request, operation: 'wait', timeout_seconds: 10 });
        if (!settled.ok || z.object({ state: z.string() }).parse(settled.value).state === 'running') {
          await backend.execute({ ...request, operation: 'cancel', userConfirmed: true });
        }
      }
      await Promise.all([first.close().catch(() => undefined), second.close().catch(() => undefined)]);
      await restarted?.close();
      if (!initialClosed) await initial.close();
      database.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);
});
