import { describe, expect, it, vi } from 'vitest';
import { ok } from '@lnwjing/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { capabilityTools } from './capability-tools.js';
import type { McpToolContext } from './tool-types.js';

function fixture(): { actor: { clientId: string; sessionId: string; clientName: string }; execute: ReturnType<typeof vi.fn>; tools: ReturnType<typeof capabilityTools> } {
  const execute = vi.fn().mockResolvedValue(ok({ available: true, ready: true }));
  const actor = { clientId: 'native-client', sessionId: 'native-session', clientName: 'Native fixture' };
  const context: McpToolContext = { actor, services: { capabilities: { execute } }, contextEconomy: new ContextEconomyRuntime() };
  return { actor, execute, tools: capabilityTools(context) };
}

describe('public native tool ownership boundary', () => {
  it.each([
    ['audio', { action: 'status', handle: 'audio-handle' }],
    ['screen_record', { action: 'status', handle: 'screen-handle', session_id: 'portal' }],
    ['input_event', { operation: 'status', session_id: 'portal' }],
    ['vision', { action: 'status', session_id: 'portal' }],
  ] as const)('adds trusted identity to %s resource observations', async (name, input) => {
    const { actor, execute, tools } = fixture();
    const tool = tools.find((entry) => entry.name === name)!;
    const parsed = tool.parse({ ...input, workspaceId: 'workspace' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Public schema did not accept owned status');
    await tool.execute(parsed.value, new AbortController().signal);
    expect(execute).toHaveBeenCalledWith(name, expect.objectContaining({ ...input, metadata: { 'lnwjing.taskOwner.v1': { clientId: actor.clientId, sessionId: actor.sessionId, workspaceId: 'workspace' } } }), expect.any(AbortSignal), undefined);
  });

  it('keeps native computer-use dispatch in the same trusted owner scope', async () => {
    const { actor, execute, tools } = fixture();
    const tool = tools.find((entry) => entry.name === 'computer_use')!;
    const parsed = tool.parse({ action: 'click', workspaceId: 'workspace', target: { x: 12, y: 24 }, userConfirmed: true });
    if (!parsed.ok) throw new Error('Public schema did not accept click');
    await tool.execute(parsed.value, new AbortController().signal);
    expect(execute).toHaveBeenCalledWith('input_event', expect.objectContaining({ metadata: { 'lnwjing.taskOwner.v1': { clientId: actor.clientId, sessionId: actor.sessionId, workspaceId: 'workspace' } } }), expect.any(AbortSignal), undefined);
  });

  it('overwrites public owner spoofing and accepts bounded lifecycle fields', async () => {
    const { actor, execute, tools } = fixture();
    const audio = tools.find((entry) => entry.name === 'audio')!;
    const spoofed = audio.parse({ action: 'status', metadata: { 'lnwjing.taskOwner.v1': { clientId: 'foreign', sessionId: 'foreign' } } });
    if (!spoofed.ok) throw new Error('Metadata fixture did not parse');
    await audio.execute(spoofed.value, new AbortController().signal);
    expect(execute).toHaveBeenCalledWith('audio', expect.objectContaining({ metadata: { 'lnwjing.taskOwner.v1': { clientId: actor.clientId, sessionId: actor.sessionId } } }), expect.any(AbortSignal), undefined);
    expect(audio.parse({ action: 'record', workspaceId: 'workspace', output_path: 'audio.wav', duration_seconds: 0.1, max_bytes: 1024 }).ok).toBe(true);
    expect(audio.parse({ action: 'stop', handle: 'handle', cancel: true }).ok).toBe(true);
    expect(audio.parse({ action: 'record', max_bytes: 67_108_865 }).ok).toBe(false);
    expect(audio.parse({ action: 'record', duration_seconds: 600.1 }).ok).toBe(false);
  });
});
