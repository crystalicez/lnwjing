import { createServer, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { appError, err, ok, type GoalLeaseProof } from '@lnwjing/domain';
import { WorkspaceInfoService, type FileActor } from '@lnwjing/application';
import { permissionProfiles } from '@lnwjing/permissions';
import type { WorkspaceRepository } from '@lnwjing/workspace';
import { DapSessionService } from './dap-session-service.js';
import { DapFrameDecoder, encodeDapMessage } from './dap-framing.js';
import { ToolRegistry, type McpApplicationServices, type ToolRegistryOptions } from './tool-registry.js';

const actor: FileActor = { clientId: 'dap-client', clientName: 'DAP fixture', sessionId: 'dap-session' };
const workspaceId = 'dap-workspace';
const options: ToolRegistryOptions = { profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full, authorizationModeProvider: () => 'full_bypass' };
const proof: GoalLeaseProof = { goalId: 'dap-goal', leaseToken: 'current-proof', leaseGeneration: 7 };

function workspaceInfo(): WorkspaceInfoService {
  const workspaces = new Map([workspaceId, 'foreign-workspace'].map((id) => [id, { id, displayName: id, rootPath: process.cwd(), realRootPath: process.cwd(), createdAt: new Date().toISOString() }]));
  const repository: WorkspaceRepository = {
    async get(id) { return workspaces.get(id) ?? null; }, async list() { return [...workspaces.values()]; },
    async insert(workspace) { workspaces.set(workspace.id, workspace); }, async delete(id) { workspaces.delete(id); },
  };
  return new WorkspaceInfoService(repository);
}

async function adapter(intercept?: (message: Record<string, unknown>, send: (value: Record<string, unknown>) => void) => boolean): Promise<{ endpoint: string; requests: Record<string, unknown>[]; sockets: Set<Socket>; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    const decoder = new DapFrameDecoder();
    let sequence = 0;
    let attachment: Record<string, unknown> | undefined;
    const send = (value: Record<string, unknown>): boolean => socket.write(encodeDapMessage({ ...value, seq: ++sequence }));
    const respond = (message: Record<string, unknown>, body: unknown = {}): boolean => send({ type: 'response', request_seq: message.seq, command: message.command, success: true, body });
    socket.on('data', (chunk) => {
      for (const message of decoder.feed(chunk)) {
        requests.push(message);
        if (intercept?.(message, send)) continue;
        if (message.command === 'initialize') respond(message, { supportsConfigurationDoneRequest: true });
        else if (message.command === 'attach') { attachment = message; send({ type: 'event', event: 'initialized' }); }
        else if (message.command === 'configurationDone') {
          respond(message);
          if (attachment === undefined) throw new Error('Missing fixture attach request');
          respond(attachment);
          send({ type: 'event', event: 'output', body: { category: 'console', output: '  ผลจริง ไทย 😀\n\t ' } });
        } else respond(message, { fixture: '  exact ไทย 😀  ', command: message.command });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture port is unavailable');
  return { endpoint: `tcp://127.0.0.1:${address.port}`, requests, sockets,
    async close(): Promise<void> { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); } };
}

function attachedSession(response: Awaited<ReturnType<ToolRegistry['invoke']>>): string {
  expect(response.isError).not.toBe(true);
  return z.object({ session: z.object({ sessionId: z.string().uuid(), state: z.literal('ready') }) }).parse(response.structuredContent).session.sessionId;
}

function fence(): NonNullable<McpApplicationServices['goalMutationFence']> {
  return {
    inspectWorkspaceFence: vi.fn(async () => ok({ goalId: proof.goalId, leaseGeneration: proof.leaseGeneration })),
    begin: vi.fn(async (_actor: FileActor, _workspace: string, _call: string, received: GoalLeaseProof) => received.leaseToken === proof.leaseToken
      ? ok({ goalId: received.goalId, leaseGeneration: received.leaseGeneration }) : err(appError('CONFLICT', 'Stale fixture lease'))),
    heartbeat: vi.fn(async () => undefined), end: vi.fn(async () => undefined),
    observe: vi.fn(async () => { throw new Error('Unexpected fixture observe'); }),
  } satisfies NonNullable<McpApplicationServices['goalMutationFence']>;
}

describe('DAP through registered tools', () => {
  it('retains a host-owned session across reconstructed registries and preserves frames, output, cursors and disconnect semantics', async () => {
    const setup = await adapter();
    const debugSessions = new DapSessionService();
    const services = { debugSessions, workspaceInfo: workspaceInfo() };
    try {
      const first = new ToolRegistry(services, actor, options);
      const session = attachedSession(await first.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint, adapterId: 'fixture', configuration: { processId: 42, justMyCode: false }, timeoutMs: 2000 }));
      const next = new ToolRegistry(services, actor, options);
      const response = await next.invoke('debug_step', { workspaceId, session_id: session, action: 'next', arguments: { threadId: 3, singleThread: true, granularity: 'line' } });
      expect(response.structuredContent).toMatchObject({ response: { command: 'next', success: true, request_seq: setup.requests.at(-1)?.seq, body: { fixture: '  exact ไทย 😀  ' } } });
      expect(setup.requests.slice(0, 3).map((request) => request.command)).toEqual(['initialize', 'attach', 'configurationDone']);
      expect(setup.requests[0]).toMatchObject({ arguments: { adapterID: 'fixture', supportsRunInTerminalRequest: false } });
      expect(setup.requests[1]).toMatchObject({ arguments: { processId: 42, justMyCode: false } });
      expect(setup.requests.at(-1)).toMatchObject({ arguments: { threadId: 3, singleThread: true, granularity: 'line' } });
      await vi.waitFor(async () => expect((await next.invoke('debug_step', { workspaceId, session_id: session, action: 'events', limit: 1 })).structuredContent).toMatchObject({ events: { hasMore: true } }));
      const firstPage = await next.invoke('debug_step', { workspaceId, session_id: session, action: 'events', limit: 1 });
      const cursor = z.object({ events: z.object({ nextCursor: z.string() }) }).parse(firstPage.structuredContent).events.nextCursor;
      const page = await next.invoke('debug_step', { workspaceId, session_id: session, action: 'events', cursor, maxBytes: 2048 });
      expect(page.structuredContent).toMatchObject({ events: { gap: false, events: [expect.objectContaining({ value: expect.objectContaining({ event: 'output', body: expect.objectContaining({ output: '  ผลจริง ไทย 😀\n\t ' }) }) })] } });
      expect((await next.invoke('debug_step', { workspaceId, session_id: session, action: 'disconnect' })).structuredContent).toMatchObject({ session: { state: 'disconnected', connectionGap: false, debuggeeState: 'unknown' } });
      expect(setup.requests.at(-1)).toMatchObject({ command: 'disconnect', arguments: { restart: false, terminateDebuggee: false, suspendDebuggee: false } });
      await vi.waitFor(() => expect(setup.sockets.size).toBe(0));
    } finally { debugSessions.close(); await setup.close(); }
  });

  it.each(['clientId', 'sessionId', 'workspaceId'] as const)('denies a foreign %s before any adapter frame', async (field) => {
    const setup = await adapter();
    const debugSessions = new DapSessionService();
    const services = { debugSessions, workspaceInfo: workspaceInfo() };
    try {
      const registry = new ToolRegistry(services, actor, options);
      const session = attachedSession(await registry.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint }));
      const foreignActor = field === 'workspaceId' ? actor : { ...actor, [field]: 'foreign' };
      const foreign = new ToolRegistry(services, foreignActor, options);
      const selectedWorkspace = field === 'workspaceId' ? 'foreign-workspace' : workspaceId;
      const before = setup.requests.length;
      for (const command of [{ action: 'status' }, { action: 'threads' }, { action: 'disconnect' }] as const) {
        expect(await foreign.invoke('debug_step', { workspaceId: selectedWorkspace, session_id: session, ...command })).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      }
      expect(setup.requests).toHaveLength(before);
      expect((await registry.invoke('debug_step', { workspaceId, session_id: session, action: 'threads' })).isError).not.toBe(true);
    } finally { debugSessions.close(); await setup.close(); }
  });

  it('validates dry-run plans without opening a socket or sending a command', async () => {
    const setup = await adapter();
    const debugSessions = new DapSessionService();
    const registry = new ToolRegistry({ debugSessions, workspaceInfo: workspaceInfo() }, actor, options);
    try {
      expect((await registry.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint, dryRun: true })).structuredContent).toMatchObject({ status: 'planned', sideEffectsStarted: false });
      expect(setup.requests).toEqual([]);
      expect(setup.sockets.size).toBe(0);
      const session = attachedSession(await registry.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint }));
      const before = setup.requests.length;
      expect((await registry.invoke('debug_step', { workspaceId, session_id: session, action: 'evaluate', arguments: { expression: '  ไทย 😀  ', context: 'repl' }, dryRun: true })).structuredContent).toMatchObject({ status: 'planned', sideEffectsStarted: false, command: { arguments: { expression: '  ไทย 😀  ' } } });
      expect(setup.requests).toHaveLength(before);
    } finally { debugSessions.close(); await setup.close(); }
  });

  it.each([
    { endpoint: 'tcp://localhost:1234' }, { endpoint: 'tcp://192.0.2.1:1234' },
    { configuration: { program: 'never-launch' } }, { configuration: { preLaunchTask: 'never-run' } },
    { configuration: { connect: { host: '192.0.2.1', port: 1234 } } }, { configuration: { address: 'example.com' } },
    { timeoutMs: 30_001 }, { unconsumed: true },
  ])('rejects invalid or executable attach input before connection %j', async (invalid) => {
    const setup = await adapter();
    const debugSessions = new DapSessionService();
    try {
      const registry = new ToolRegistry({ debugSessions, workspaceInfo: workspaceInfo() }, actor, options);
      expect(await registry.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint, ...invalid, dryRun: true })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
      expect(setup.requests).toEqual([]);
      expect(setup.sockets.size).toBe(0);
    } finally { debugSessions.close(); await setup.close(); }
  });

  it('requires current rolling Goal proof under Full Bypass and denies stale generation/token before a frame', async () => {
    const setup = await adapter();
    const debugSessions = new DapSessionService();
    const goalMutationFence = fence();
    try {
      const registry = new ToolRegistry({ debugSessions, workspaceInfo: workspaceInfo(), goalMutationFence }, actor, options);
      const attach = { workspaceId, endpoint: setup.endpoint };
      for (const goalLease of [undefined, { ...proof, leaseGeneration: 6 }, { ...proof, leaseToken: 'stale-token' }]) {
        expect(await registry.invoke('debug_attach', { ...attach, ...(goalLease === undefined ? {} : { goalLease }) })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
      }
      expect(setup.requests).toEqual([]);
      const session = attachedSession(await registry.invoke('debug_attach', { ...attach, goalLease: proof }));
      const before = setup.requests.length;
      expect(await registry.invoke('debug_step', { workspaceId, session_id: session, action: 'continue', arguments: { threadId: 1 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
      expect(setup.requests).toHaveLength(before);
      expect((await registry.invoke('debug_step', { workspaceId, session_id: session, action: 'continue', arguments: { threadId: 1 }, goalLease: proof })).isError).not.toBe(true);
      expect(goalMutationFence.begin).toHaveBeenCalledTimes(3);
      expect(goalMutationFence.end).toHaveBeenCalledTimes(2);
    } finally { debugSessions.close(); await setup.close(); }
  });

  it('requires Safe profile confirmation and rejects a missing registered workspace before connecting', async () => {
    const setup = await adapter();
    const debugSessions = new DapSessionService();
    try {
      const services = { debugSessions, workspaceInfo: workspaceInfo() };
      const safe = new ToolRegistry(services, actor, { profileProvider: (): typeof permissionProfiles.safe => permissionProfiles.safe });
      expect(await safe.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint })).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
      expect(await new ToolRegistry(services, actor, options).invoke('debug_attach', { workspaceId: 'not-registered', endpoint: setup.endpoint })).toMatchObject({ isError: true, structuredContent: { error: { code: 'WORKSPACE_NOT_FOUND' } } });
      expect(setup.requests).toEqual([]);
    } finally { debugSessions.close(); await setup.close(); }
  });

  it('keeps status and dry-run read-only while the current Safe profile refuses control', async () => {
    const setup = await adapter();
    const debugSessions = new DapSessionService();
    try {
      const services = { debugSessions, workspaceInfo: workspaceInfo() };
      const session = attachedSession(await new ToolRegistry(services, actor, options).invoke('debug_attach', { workspaceId, endpoint: setup.endpoint }));
      const safe = new ToolRegistry(services, actor, { profileProvider: (): typeof permissionProfiles.safe => permissionProfiles.safe });
      const before = setup.requests.length;
      expect((await safe.invoke('debug_step', { workspaceId, session_id: session, action: 'status' })).isError).not.toBe(true);
      expect((await safe.invoke('debug_step', { workspaceId, session_id: session, action: 'next', arguments: { threadId: 1 }, dryRun: true })).structuredContent).toMatchObject({ status: 'planned', sideEffectsStarted: false });
      expect(await safe.invoke('debug_step', { workspaceId, session_id: session, action: 'continue', arguments: { threadId: 1 }, userConfirmed: true })).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      expect(setup.requests).toHaveLength(before);
    } finally { debugSessions.close(); await setup.close(); }
  });

  it('refuses a different Active Project for a standard attach before connection', async () => {
    const setup = await adapter();
    const debugSessions = new DapSessionService();
    try {
      const registry = new ToolRegistry({ debugSessions, workspaceInfo: workspaceInfo() }, actor, {
        profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
        activeWorkspaceScopeProvider: (): { workspaceId: string; rootPath: string } => ({ workspaceId, rootPath: process.cwd() }),
      });
      expect(await registry.invoke('debug_attach', { workspaceId: 'foreign-workspace', endpoint: setup.endpoint, userConfirmed: true })).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      expect(setup.requests).toEqual([]);
    } finally { debugSessions.close(); await setup.close(); }
  });

  it('preserves an explicit Engineering binding for actual central admission before attach', async () => {
    const setup = await adapter();
    const debugSessions = new DapSessionService();
    const unavailable = async (): Promise<ReturnType<typeof err>> => err(appError('INTERNAL_ERROR', 'Unexpected Goal operation'));
    const goals: NonNullable<McpApplicationServices['goals']> = {
      runGoal: unavailable, getGoal: unavailable, validateGoalLease: unavailable, updateGoalPlan: unavailable,
      updateGoalAcceptance: unavailable, reviseGoalIntent: unavailable, createContextCapsule: unavailable,
      getContextCapsule: unavailable, listContextCapsules: unavailable, recordDeliveryReceipt: unavailable,
      listDeliveryReceipts: unavailable, advanceGoalIteration: unavailable, checkpointGoal: unavailable,
      finishGoal: unavailable, cancelGoal: unavailable, reconcileGoals: unavailable, listGoals: unavailable,
    };
    const prepare = vi.fn(async () => err(appError('ENGINEERING_POLICY_CHANGED', 'Fixture policy changed', true)));
    try {
      const registry = new ToolRegistry({ debugSessions, workspaceInfo: workspaceInfo(), goals, engineeringPreparation: { prepare } }, actor, options);
      expect(await registry.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint, engineeringTask: {
        objective: 'Approved debugger fixture', policyDigest: 'old-policy', primaryTaskKind: 'bugfix', riskTier: 'high', deliveryScope: 'local', sessionId: actor.sessionId,
      } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'ENGINEERING_POLICY_CHANGED' } } });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(setup.requests).toEqual([]);
    } finally { debugSessions.close(); await setup.close(); }
  });

  it('returns complete adapter error evidence and rejects unsupported or unconsumed command fields before frames', async () => {
    const setup = await adapter((message, send) => {
      if (message.command !== 'evaluate') return false;
      send({ type: 'response', request_seq: message.seq, command: message.command, success: false, message: '  exact ไทย 😀 error  ', body: { error: { id: 42, format: '  untrimmed error  ' } } });
      return true;
    });
    const debugSessions = new DapSessionService();
    try {
      const registry = new ToolRegistry({ debugSessions, workspaceInfo: workspaceInfo() }, actor, options);
      const session = attachedSession(await registry.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint }));
      const before = setup.requests.length;
      for (const input of [{ action: 'launch', arguments: { program: 'never-launch' } }, { action: 'next', arguments: {} },
        { action: 'next', arguments: { threadId: 1, unrelated: true } }, { action: 'status', arguments: { threadId: 1 } }]) {
        expect(await registry.invoke('debug_step', { workspaceId, session_id: session, ...input })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
      }
      expect(setup.requests).toHaveLength(before);
      const failure = await registry.invoke('debug_step', { workspaceId, session_id: session, action: 'evaluate', arguments: { expression: '  ไทย 😀  ', context: 'watch' } });
      const evidence = z.object({ error: z.object({ code: z.literal('CONFLICT'), details: z.object({ adapterResponse: z.string() }) }) }).parse(failure.structuredContent).error.details.adapterResponse;
      expect(JSON.parse(evidence)).toMatchObject({ message: '  exact ไทย 😀 error  ', body: { error: { id: 42, format: '  untrimmed error  ' } } });
      expect(setup.requests.at(-1)).toMatchObject({ arguments: { expression: '  ไทย 😀  ', context: 'watch' } });
      expect((await registry.invoke('debug_step', { workspaceId, session_id: session, action: 'threads' })).isError).not.toBe(true);
    } finally { debugSessions.close(); await setup.close(); }
  });

  it('reports event overflow as a gap without losing or trimming retained output', async () => {
    const setup = await adapter((message, send) => {
      if (message.command !== 'threads') return false;
      for (let index = 0; index < 1100; index += 1) send({ type: 'event', event: 'output', body: { output: `  ไทย 😀 ${index}\n  ` } });
      send({ type: 'response', request_seq: message.seq, command: message.command, success: true, body: { threads: [] } });
      return true;
    });
    const debugSessions = new DapSessionService();
    try {
      const registry = new ToolRegistry({ debugSessions, workspaceInfo: workspaceInfo() }, actor, options);
      const session = attachedSession(await registry.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint }));
      await registry.invoke('debug_step', { workspaceId, session_id: session, action: 'threads' });
      const response = await registry.invoke('debug_step', { workspaceId, session_id: session, action: 'events', limit: 1000, maxBytes: 500_000 });
      const page = z.object({ events: z.object({ gap: z.literal(true), droppedEvents: z.number().min(100), events: z.array(z.object({ value: z.object({ body: z.object({ output: z.string() }) }) })).length(1000) }) }).parse(response.structuredContent).events;
      expect(page.events.at(-1)?.value.body.output).toBe('  ไทย 😀 1099\n  ');
    } finally { debugSessions.close(); await setup.close(); }
  });

  it('cancels only the interrupted owned channel and closes remaining sockets at host shutdown', async () => {
    const entered = Promise.withResolvers<void>();
    const setup = await adapter((message) => { if (message.command !== 'next') return false; entered.resolve(); return true; });
    const debugSessions = new DapSessionService();
    const services = { debugSessions, workspaceInfo: workspaceInfo() };
    try {
      const registry = new ToolRegistry(services, actor, options);
      const otherActor = { ...actor, sessionId: 'unrelated' };
      const other = new ToolRegistry(services, otherActor, options);
      const session = attachedSession(await registry.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint }));
      const otherSession = attachedSession(await other.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint }));
      const controller = new AbortController();
      const pending = registry.invoke('debug_step', { workspaceId, session_id: session, action: 'next', arguments: { threadId: 1 } }, undefined, controller.signal);
      await entered.promise;
      controller.abort();
      expect(await pending).toMatchObject({ isError: true, structuredContent: { error: { code: 'PROCESS_TIMEOUT' } } });
      await vi.waitFor(() => expect(setup.sockets.size).toBe(1));
      expect((await registry.invoke('debug_step', { workspaceId, session_id: session, action: 'status' })).structuredContent).toMatchObject({ session: { state: 'disconnected', connectionGap: true, debuggeeState: 'unknown' } });
      expect((await other.invoke('debug_step', { workspaceId, session_id: otherSession, action: 'threads' })).isError).not.toBe(true);
      debugSessions.close();
      await vi.waitFor(() => expect(setup.sockets.size).toBe(0));
      expect(await other.invoke('debug_attach', { workspaceId, endpoint: setup.endpoint })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
    } finally { debugSessions.close(); await setup.close(); }
  });

  it('reports provider setup separately from an actual attach result', async () => {
    const registry = new ToolRegistry({}, actor, options);
    expect((await registry.invoke('debug_attach', { workspaceId, endpoint: 'tcp://127.0.0.1:1234' })).structuredContent).toMatchObject({ ready: false, available: false, status: 'needs_setup', executed: false });
  });
});
