import { describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@lnwjing/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { createOcrPackageIdentityProbe, VisionCapabilityBackend, WindowsOcrCapabilityBackend } from './windows-ocr-backend.js';

describe('WindowsOcrCapabilityBackend', () => {
  it('returns a truthful unavailable state when WinRT package identity is absent', async () => {
    const backend = new WindowsOcrCapabilityBackend({ platform: 'win32' });

    await expect(backend.execute({ action: 'ocr', text: 'hello' })).resolves.toMatchObject({ ok: true, value: {
      available: false,
      ready: false,
      backend: 'Windows.Media.Ocr',
      reason: 'package_identity_required',
    } });
  });

  it('delegates OCR only after identity is verified and keeps vision capture on the existing backend', async () => {
    const calls: unknown[] = [];
    const helper = {
      execute: async (input: unknown): Promise<Result<unknown>> => { calls.push(input); return ok({ text: 'สวัสดี hello', lines: [] }); },
    };
    const native: CapabilityBackend = { execute: async (input): Promise<Result<unknown>> => ok({ native: input }) };
    const ocr = new WindowsOcrCapabilityBackend({
      platform: 'win32',
      packageIdentity: async (): Promise<Result<boolean>> => ok(true),
      helper,
    });
    const vision = new VisionCapabilityBackend(native, ocr);

    await expect(vision.execute({ action: 'ocr', image_base64: 'cG5n' })).resolves.toMatchObject({ ok: true, value: { text: 'สวัสดี hello' } });
    await expect(vision.execute({ action: 'capture_display' })).resolves.toMatchObject({ ok: true, value: { native: { action: 'capture_display' } } });
    expect(calls).toEqual([{ action: 'ocr', image_base64: 'cG5n' }]);
  });

  it('reports helper readiness separately from package identity', async () => {
    const backend = new WindowsOcrCapabilityBackend({
      platform: 'win32',
      packageIdentity: async (): Promise<Result<boolean>> => ok(true),
    });

    await expect(backend.execute({ action: 'ocr' })).resolves.toMatchObject({ ok: true, value: {
      available: false,
      reason: 'native_helper_not_configured',
    } });
  });

  it('does not dispatch OCR after caller cancellation wins during identity verification', async () => {
    let releaseIdentity!: () => void;
    const identityBlocked = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    let helperCalled = false;
    const backend = new WindowsOcrCapabilityBackend({
      platform: 'win32',
      packageIdentity: async (): Promise<Result<boolean>> => { await identityBlocked; return ok(true); },
      helper: { execute: async (): Promise<Result<unknown>> => { helperCalled = true; return ok({}); } },
    });
    const controller = new AbortController();

    const pending = backend.execute({ action: 'ocr' }, controller.signal);
    controller.abort();
    releaseIdentity();

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(helperCalled).toBe(false);
  });
});

describe('createOcrPackageIdentityProbe', () => {
  it('probes the helper once and caches a successful identity result', async () => {
    const calls: unknown[] = [];
    const helper = {
      execute: async (input: unknown): Promise<Result<unknown>> => {
        calls.push(input);
        return ok({ available: true, package_identity: true });
      },
    };
    const probe = createOcrPackageIdentityProbe(helper);

    await expect(probe()).resolves.toEqual({ ok: true, value: true });
    await expect(probe()).resolves.toEqual({ ok: true, value: true });
    expect(calls).toEqual([{ op: 'probe' }]);
  });

  it('maps a probe without identity to false without failing', async () => {
    const probe = createOcrPackageIdentityProbe({
      execute: async (): Promise<Result<unknown>> => ok({ available: false, package_identity: false, reason: 'package_identity_required' }),
    });
    await expect(probe()).resolves.toEqual({ ok: true, value: false });
  });

  it('does not cache helper failures so transient errors cannot disable OCR permanently', async () => {
    let failures = 0;
    const probe = createOcrPackageIdentityProbe({
      execute: async (): Promise<Result<unknown>> => {
        failures += 1;
        return failures === 1
          ? err(appError('INTERNAL_ERROR', 'helper not ready', true))
          : ok({ package_identity: true });
      },
    });
    await expect(probe()).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await expect(probe()).resolves.toEqual({ ok: true, value: true });
  });
});
