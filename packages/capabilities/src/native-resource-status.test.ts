import { describe, expect, it, vi } from 'vitest';
import { err, appError, ok } from '@lnwjing/domain';
import { LinuxNativeCapabilityBackend } from './linux-native-backend.js';
import { MacosNativeCapabilityBackend } from './macos-native-backend.js';
import type { NativeHostProcessBridge } from './native-host-protocol.js';

describe.each([LinuxNativeCapabilityBackend, MacosNativeCapabilityBackend])('native resource status', (Backend) => {
  it.each(['audio', 'screen_record', 'input_event', 'vision'] as const)('forwards %s identity and owner without asking for mutation approval', async (capability) => {
    const metadata = { 'lnwjing.taskOwner.v1': { clientId: 'client', sessionId: 'session', workspaceId: 'workspace' } };
    const input = { action: 'status', handle: 'recording-handle', session_id: 'portal-session', metadata };
    const execute = vi.fn().mockResolvedValue(ok({ handle: input.handle, state: 'running', session_id: input.session_id }));
    const backend = new Backend(capability, { bridge: { execute } as unknown as NativeHostProcessBridge });
    await expect(backend.execute(input)).resolves.toMatchObject({ ok: true, value: { handle: input.handle, state: 'running', session_id: input.session_id } });
    expect(execute).toHaveBeenCalledExactlyOnceWith(capability, input, undefined, undefined);
  });

  it('preserves resource ownership denial', async () => {
    const execute = vi.fn().mockResolvedValue(err(appError('PERMISSION_DENIED', 'Resource belongs to another owner')));
    const backend = new Backend('screen_record', { bridge: { execute } as unknown as NativeHostProcessBridge });
    await expect(backend.execute({ action: 'status', handle: 'foreign' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('preserves a portal status receipt with verified identity and readiness', async () => {
    const execute = vi.fn().mockResolvedValue(ok({ session_id: 'portal-session', ready: true, permissionState: 'granted' }));
    const backend = new Backend('vision', { bridge: { execute } as unknown as NativeHostProcessBridge });
    await expect(backend.execute({ action: 'status', session_id: 'portal-session' })).resolves.toMatchObject({ ok: true, value: { session_id: 'portal-session', ready: true } });
  });

  it('does not claim provider readiness from a malformed status response', async () => {
    const execute = vi.fn().mockResolvedValue(ok({ transportConnected: true }));
    const backend = new Backend('audio', { bridge: { execute } as unknown as NativeHostProcessBridge });
    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({ ok: true, value: { ready: false, readinessReason: 'provider_not_implemented' } });
  });

  it.each([{}, { handle: 'wrong-handle', state: 'running' }, { handle: 'recording-handle' }, { handle: 'recording-handle', state: 'invented-state' }])('refuses an unverified resource status reply %j', async (value) => {
    const execute = vi.fn().mockResolvedValue(ok(value));
    const backend = new Backend('audio', { bridge: { execute } as unknown as NativeHostProcessBridge });
    await expect(backend.execute({ action: 'status', handle: 'recording-handle' })).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });
});
