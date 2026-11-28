import { describe, expect, it } from 'vitest';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from '@lnwjing/capabilities';
import { actorForRequestScope, createHttpRequestScope, createProtocolHttpRequestScope, createStdioRequestScope, withCapabilityOwnerMetadata } from './request-scope.js';

describe('MCP request scope', () => {
  it('keeps protocol HTTP sessions stable and distinct', () => {
    const first = createProtocolHttpRequestScope('protocol-a');
    const reconnect = createProtocolHttpRequestScope('protocol-a');
    const other = createProtocolHttpRequestScope('protocol-b');
    expect(reconnect.sessionId).toBe(first.sessionId);
    expect(other.sessionId).not.toBe(first.sessionId);
  });

  it('uses one explicit synthetic STDIO identity for a serving lifetime', () => {
    expect(createStdioRequestScope('stdio-a')).toMatchObject({ sessionId: 'stdio-a', transport: 'stdio' });
  });

  it('uses a stable endpoint fallback only when HTTP has no protocol session', () => {
    const request = new Request('http://127.0.0.1/mcp');
    expect(createHttpRequestScope({ request, fallbackSessionId: 'endpoint-a' }).sessionId).toBe('endpoint-a');
  });

  it('captures bounded W3C trace headers and redacts sensitive baggage members', () => {
    const request = new Request('http://127.0.0.1/mcp', { headers: {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=opaque',
      baggage: 'tenant=acme,api_key=super-secret,region=apac',
    } });
    expect(createHttpRequestScope({ request, fallbackSessionId: 'endpoint-a' })).toMatchObject({
      traceParent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      traceState: 'vendor=opaque',
      baggage: 'tenant=acme,api_key=[redacted],region=apac',
    });
  });

  it('binds only the verified goal and strips raw recovery tokens', () => {
    const actor = actorForRequestScope({ clientId: 'client-1', clientName: 'test' }, createStdioRequestScope('session-a'));
    const token = 'lnwrt_' + 'a'.repeat(64);
    const input = { workspaceId: 'ws-1', recovery_token: token,
      metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { goalId: 'forged', recoveryHash: 'b'.repeat(64) } } };
    const scoped = withCapabilityOwnerMetadata(input, actor, { goal: { goalId: 'goal-1', workspaceId: 'ws-1' } });
    expect(scoped).toMatchObject({ metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: {
      clientId: 'client-1', sessionId: 'session-a', workspaceId: 'ws-1', goalId: 'goal-1', recoveryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    } } });
    expect(JSON.stringify(scoped)).not.toContain(token);
    expect(JSON.stringify(scoped)).not.toContain('forged');
    expect(JSON.stringify(scoped)).not.toContain('b'.repeat(64));
    const mismatched = withCapabilityOwnerMetadata(input, actor, { goal: { goalId: 'goal-2', workspaceId: 'ws-2' } });
    expect(JSON.stringify(mismatched)).not.toContain('goal-2');
  });

  it('overwrites spoofed task ownership metadata with the trusted scoped actor', () => {
    const actor = actorForRequestScope({ clientId: 'client-1', clientName: 'test' }, createStdioRequestScope('session-a'));
    const input = withCapabilityOwnerMetadata({ workspaceId: 'ws-1', metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'attacker', sessionId: 'spoofed' } } }, actor);
    expect(input).toMatchObject({ metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'client-1', sessionId: 'session-a', workspaceId: 'ws-1' } } });
  });
});
