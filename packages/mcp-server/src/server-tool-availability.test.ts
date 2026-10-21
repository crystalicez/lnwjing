import { createHash } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { FileActor } from '@lnwjing/application';
import { ok } from '@lnwjing/domain';
import { APP_VERSION } from '@lnwjing/shared';
import type { ToolAvailabilitySnapshot } from '@lnwjing/shared';
import { createMcpServer } from './server.js';
import type { McpApplicationServices } from './tool-registry.js';

const actor: FileActor = {
  clientId: 'tool-availability-test-client',
  clientName: 'tool-availability-test',
  sessionId: 'tool-availability-test-session',
};

describe('MCP server live tool availability', () => {
  it('allows direct content-only external MCP results while preserving batch parity', async () => {
    const server = createMcpServer({
      services: { extensions: {
        callMcpTool: async (input: { tool: string }) => ok({
          ...(input.tool === 'failure' ? { isError: true } : {}),
          content: [{ type: 'text', text: input.tool === 'failure' ? 'child failed' : 'child text response' }],
        }),
      } } as unknown as McpApplicationServices,
      actor,
      authorizationModeProvider: () => 'full_bypass',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'content-only-child-test-client', version: '1.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tool = (await client.listTools()).tools.find((item) => item.name === 'mcp_call');
      expect(tool).toBeDefined();
      expect(tool?.outputSchema).toBeUndefined();
      const args = { server: 'mock', tool: 'content', userConfirmed: true };
      const direct = await client.callTool({ name: 'mcp_call', arguments: args });
      expect(direct.isError).not.toBe(true);
      expect(direct.structuredContent).toBeUndefined();
      expect(direct.content).toEqual([{ type: 'text', text: 'child text response' }]);
      const batched = await client.callTool({ name: 'tool_batch', arguments: {
        calls: [{ id: 'content-only', tool: 'mcp_call', arguments: args }],
        userConfirmed: true,
      } });
      expect(batched.structuredContent).toMatchObject({
        summary: { succeeded: 1, failed: 0 },
        results: [{ id: 'content-only', status: 'succeeded', value: { content: [{ text: 'child text response' }] } }],
      });
      const childFailure = await client.callTool({ name: 'mcp_call', arguments: { ...args, tool: 'failure' } });
      expect(childFailure.isError).toBe(true);
      expect(childFailure.content).toEqual([{ type: 'text', text: 'child failed' }]);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  it('serves strict optional Engineering checkpoint metadata through the SDK tools/list response', async () => {
    const checkpointGoal = vi.fn(async () => ok({ goalId: 'goal-1', revision: 2 } as never));
    const server = createMcpServer({
      services: { goals: { checkpointGoal } } as unknown as McpApplicationServices,
      actor,
      authorizationModeProvider: () => 'full_bypass',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'engineering-schema-test-client', version: '1.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const checkpoint = listed.tools.find((tool) => tool.name === 'checkpoint_goal');
      const engineeringCheckpoint = listed.tools.find((tool) => tool.name === 'checkpoint_goal_engineering');
      expect(checkpoint).toBeDefined();
      expect(engineeringCheckpoint).toBeDefined();
      expect(engineeringCheckpoint?.inputSchema).toEqual(checkpoint?.inputSchema);
      const schema = checkpoint?.inputSchema as unknown as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      const required = schema.required as string[];

      expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(properties.engineeringGateUpdates).toMatchObject({
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['gateId', 'status'],
          properties: {
            gateId: { type: 'string', minLength: 1, maxLength: 128 },
            status: { type: 'string', enum: ['pending', 'running', 'passed', 'failed', 'blocked', 'not_applicable', 'stale'] },
          },
        },
      });
      expect(properties.engineeringReviewFindings).toMatchObject({
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'severity', 'state', 'reason'],
          properties: {
            severity: { type: 'string', enum: ['blocking', 'non_blocking'] },
            state: { type: 'string', enum: ['open', 'validated', 'rejected', 'resolved'] },
          },
        },
      });
      expect(required).toEqual(expect.arrayContaining(['goalId', 'leaseToken', 'expectedRevision', 'currentPhase', 'summary', 'stepUpdates', 'blockers', 'evidence']));
      expect(required).not.toEqual(expect.arrayContaining(['engineeringGateUpdates', 'engineeringReviewFindings']));

      const describedResponse = await client.callTool({ name: 'tool_describe', arguments: { name: 'checkpoint_goal' } });
      const described = readStructuredToolResult(describedResponse);
      expect(described.found).toBe(true);
      const diagnostic = described.schemaDiagnostic as Record<string, unknown>;
      expect(diagnostic).toMatchObject({
        status: 'available',
        appVersion: APP_VERSION,
        toolName: 'checkpoint_goal',
        schemaSource: 'lnwjing_tool_registry',
        publicationTarget: 'mcp.tools/list.inputSchema',
        digestAlgorithm: 'SHA-256',
        digestFormatVersion: 1,
        inputMode: 'sdk_input',
        transport: null,
        protocolVersion: null,
        fieldPresence: { engineeringGateUpdates: true, engineeringReviewFindings: true },
        connectorSchema: { status: 'unavailable', digest: null },
      });
      expect(diagnostic.inputSchemaSha256).toBe(createHash('sha256').update(canonicalJson(checkpoint?.inputSchema)).digest('hex'));
      expect(typeof diagnostic.observedAt).toBe('string');
      expect(Number.isNaN(Date.parse(String(diagnostic.observedAt)))).toBe(false);

      const engineeringGateUpdates = [{ gateId: 'diff', status: 'failed', reason: 'Direct SDK invocation reached the checkpoint service.' }];
      const engineeringReviewFindings = [{
        id: 'review-198', title: 'Direct MCP call', severity: 'non_blocking', state: 'open', reason: 'The SDK call preserved both optional fields.',
      }];
      const directCall = await client.callTool({
        name: 'checkpoint_goal',
        arguments: {
          goalId: 'goal-1', leaseToken: 'lease-1', expectedRevision: 1, currentPhase: 'verify', summary: 'Record direct MCP evidence.',
          stepUpdates: [], nextAction: 'Read back the checkpoint.', blockers: [], evidence: [], trackedTasks: [],
          engineeringGateUpdates, engineeringReviewFindings,
        },
      });
      const aliasCall = await client.callTool({
        name: 'checkpoint_goal_engineering',
        arguments: {
          goalId: 'goal-1', leaseToken: 'lease-1', expectedRevision: 2, currentPhase: 'verify', summary: 'Record compatibility evidence.',
          stepUpdates: [], nextAction: 'Read back the checkpoint.', blockers: [], evidence: [], trackedTasks: [],
          engineeringGateUpdates, engineeringReviewFindings,
        },
      });

      expect(directCall.isError).not.toBe(true);
      expect(aliasCall.isError).not.toBe(true);
      expect(checkpointGoal).toHaveBeenNthCalledWith(1, actor, expect.objectContaining({ engineeringGateUpdates, engineeringReviewFindings }));
      expect(checkpointGoal).toHaveBeenNthCalledWith(2, actor, expect.objectContaining({ engineeringGateUpdates, engineeringReviewFindings }));
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('does not describe a ToolRegistry-only schema after host availability disables that tool', async () => {
    const server = createMcpServer({
      services: {} as McpApplicationServices,
      actor,
      toolAvailabilitySnapshotProvider: () => ({
        version: 1,
        generation: 1,
        overrides: { checkpoint_goal: 'disabled' },
      }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'engineering-schema-availability-client', version: '1.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).not.toContain('checkpoint_goal');
      expect(listed.tools.map((tool) => tool.name)).not.toContain('checkpoint_goal_engineering');

      const response = await client.callTool({ name: 'tool_describe', arguments: { name: 'checkpoint_goal' } });
      expect(readStructuredToolResult(response)).toEqual({ found: false, name: 'checkpoint_goal' });
      const aliasResponse = await client.callTool({ name: 'tool_describe', arguments: { name: 'checkpoint_goal_engineering' } });
      expect(readStructuredToolResult(aliasResponse)).toEqual({ found: false, name: 'checkpoint_goal_engineering' });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('hashes the default-bearing run_goal schema exactly as the SDK publishes it', async () => {
    const server = createMcpServer({ services: {} as McpApplicationServices, actor });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'run-goal-schema-test-client', version: '1.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const runGoal = listed.tools.find((tool) => tool.name === 'run_goal');
      expect(runGoal).toBeDefined();
      const schema = runGoal?.inputSchema as unknown as Record<string, unknown>;
      const required = schema.required as string[];
      expect(required).not.toContain('leaseSeconds');
      expect(required).not.toContain('scheduledContinuation');

      const response = await client.callTool({ name: 'tool_describe', arguments: { name: 'run_goal' } });
      const described = readStructuredToolResult(response);
      expect(described.found).toBe(true);
      expect(described.inputSchema).toEqual(runGoal?.inputSchema);
      const diagnostic = described.schemaDiagnostic as Record<string, unknown>;
      expect(diagnostic.inputMode).toBe('sdk_input');
      expect(diagnostic.inputSchemaSha256).toBe(createHash('sha256').update(canonicalJson(runGoal?.inputSchema)).digest('hex'));
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('updates one connected client live and debounces tools/list_changed notifications', async () => {
    let snapshot: ToolAvailabilitySnapshot = { version: 1, generation: 0, overrides: {} };
    const listeners = new Set<(next: ToolAvailabilitySnapshot) => void>();
    let unsubscribeCount = 0;

    const server = createMcpServer({
      services: {} as McpApplicationServices,
      actor,
      toolAvailabilitySnapshotProvider: () => snapshot,
      toolAvailabilitySubscribe(listener): () => void {
        listeners.add(listener);
        return () => {
          if (listeners.delete(listener)) unsubscribeCount += 1;
        };
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tool-availability-test-client', version: '1.0.0' });
    let toolListChangedNotifications = 0;
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      toolListChangedNotifications += 1;
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const initial = await client.listTools();
      expect(initial.tools.map((tool) => tool.name)).toContain('read_file');
      expect(initial.tools.map((tool) => tool.name)).not.toContain('codex_run');

      snapshot = {
        version: 1,
        generation: 1,
        overrides: { read_file: 'disabled' },
      };
      for (const listener of [...listeners]) listener(snapshot);

      snapshot = {
        version: 1,
        generation: 2,
        overrides: { read_file: 'enabled' },
      };
      for (const listener of [...listeners]) listener(snapshot);

      await vi.waitFor(() => {
        expect(toolListChangedNotifications).toBe(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(toolListChangedNotifications).toBe(1);

      const updated = await client.listTools();
      expect(updated.tools.map((tool) => tool.name)).toContain('read_file');
      expect(updated.tools.map((tool) => tool.name)).not.toContain('codex_run');
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }

    expect(unsubscribeCount).toBe(1);
    expect(listeners.size).toBe(0);
  });

  it('releases tool availability when only the underlying protocol server closes', async () => {
    const listeners = new Set<(next: ToolAvailabilitySnapshot) => void>();
    let unsubscribeCount = 0;
    const server = createMcpServer({
      services: {} as McpApplicationServices,
      actor,
      toolAvailabilitySubscribe(listener): () => void {
        listeners.add(listener);
        return () => {
          if (listeners.delete(listener)) unsubscribeCount += 1;
        };
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'protocol-close-client', version: '0.1.0' });

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      expect(listeners.size).toBe(1);

      await server.server.close();

      await vi.waitFor(() => {
        expect(listeners.size).toBe(0);
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }

    expect(unsubscribeCount).toBe(1);
  });
});

function readStructuredToolResult(value: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  if (value.structuredContent !== undefined) return value.structuredContent;
  const text = value.content.find((item) => item.type === 'text')?.text;
  if (text === undefined) return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
