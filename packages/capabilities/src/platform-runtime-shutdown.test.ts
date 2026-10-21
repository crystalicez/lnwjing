import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@lnwjing/domain';
import type { NativeHostProcessBridge } from './native-host-protocol.js';
import { createPlatformCapabilitySet } from './platform-capability-set.js';

describe('platform capability shutdown', () => {
  it('stops admission before closing both owned providers and shares an in-flight close', async () => {
    const barrier = Promise.withResolvers<void>();
    const nativeClose = vi.fn(async () => { await barrier.promise; return ok(undefined); });
    const execute = vi.fn(async () => ok({ ready: true }));
    const runtime = createPlatformCapabilitySet({ platform: 'linux', dataPath: '/tmp/lnwjing-shutdown-fixture', workspaceRootsProvider: async () => [],
      nativeHost: { execute, close: nativeClose } as unknown as NativeHostProcessBridge });
    const browserClose = vi.spyOn(runtime.domCdp, 'close').mockResolvedValue(undefined);
    const closing = runtime.close();
    const sameClose = runtime.close();
    await expect(runtime.service.execute('audio', { action: 'status' })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(execute).not.toHaveBeenCalled();
    barrier.resolve();
    await expect(closing).resolves.toMatchObject({ ok: true });
    await expect(sameClose).resolves.toMatchObject({ ok: true });
    expect(nativeClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it('retains cleanup failure and permits an explicit cleanup retry without reopening admission', async () => {
    const nativeClose = vi.fn().mockResolvedValueOnce(err(appError('PROCESS_TIMEOUT', 'Native cleanup unverified'))).mockResolvedValue(ok(undefined));
    const runtime = createPlatformCapabilitySet({ platform: 'linux', dataPath: '/tmp/lnwjing-shutdown-fixture', workspaceRootsProvider: async () => [],
      nativeHost: { close: nativeClose } as unknown as NativeHostProcessBridge });
    const browserClose = vi.spyOn(runtime.domCdp, 'close').mockRejectedValueOnce(new Error('private-provider-message')).mockResolvedValue(undefined);
    await expect(runtime.close()).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await expect(runtime.close()).resolves.toMatchObject({ ok: true });
    await expect(runtime.service.execute('dom_cdp', { action: 'status' })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(nativeClose).toHaveBeenCalledTimes(2);
    expect(browserClose).toHaveBeenCalledTimes(2);
  });
});
