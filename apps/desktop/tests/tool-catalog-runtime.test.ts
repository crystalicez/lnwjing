import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime, toolAvailabilityHostSyncDisposition } from '../src/main/desktop-services.js';
import { catalogDefinitions } from '../src/main/tool-catalog/catalog-definitions.js';

const temporaryRoots: string[] = [];

beforeEach(() => {
  vi.stubEnv('LNWJING_UNRESTRICTED', '1');
  vi.stubEnv('LNWJING_E2E_FIXTURE', '1');
  vi.stubEnv('LNWJING_MCP_PORT', '0');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

describe('Desktop Tool Catalog runtime', () => {
  it('returns the real first-party catalog promptly after Desktop MCP startup', async () => {
    const raw = await mkdtemp(path.join(os.tmpdir(), 'lnwjing-tool-catalog-runtime-'));
    temporaryRoots.push(raw);
    const root = await realpath(raw);
    const dataRoot = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    const fakeChrome = path.join(root, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
    await Promise.all([mkdir(dataRoot, { recursive: true }), mkdir(workspaceRoot, { recursive: true }), writeFile(fakeChrome, '')]);
    vi.stubEnv('APPDATA', dataRoot);
    vi.stubEnv('LNWJING_BROWSER_EXECUTABLE', fakeChrome);
    vi.stubEnv('LNWJING_BROWSER_CDP_PORT', '65534');

    const runtime = createDesktopRuntime(dataRoot);
    try {
      await runtime.ensureDefaultWorkspace(workspaceRoot);
      await runtime.autoStartMcp();
      const catalog = await Promise.race([
        runtime.services.getToolCatalog({ locale: 'en' }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Tool Catalog runtime read timed out')), 5_000)),
      ]);

      expect(catalog.items.filter((item) => item.origin === 'lnwjing')).toHaveLength(Object.keys(catalogDefinitions).length);
      expect(catalog.remediations.length).toBeGreaterThan(0);
      expect(() => structuredClone(catalog)).not.toThrow();
      expect(catalog.items.find((item) => item.name === 'run_goal')?.inputSchema).toMatchObject({ type: 'object' });
      expect(catalog.items.find((item) => item.name === 'browser_debug_context')).toMatchObject({
        readiness: 'ready', deliveryState: 'operational', available: true,
      });

      const disabled = await runtime.services.setToolAvailability({ locale: 'en', name: 'read_file', enabled: false });
      expect(disabled.item).toMatchObject({ name: 'read_file', userPreference: 'disabled', effectiveExposed: false });
      expect(disabled.localRuntimeApplied).toBe(true);
      expect(disabled.clientReconnectRequired).toBe(false);
      expect(disabled.chatgptActionRefreshMayBeRequired).toBe(false);
      expect(disabled.hostSyncMessage).toBeNull();
      const restored = await runtime.services.resetToolAvailability({ locale: 'en', name: 'read_file' });
      expect(restored.item).toMatchObject({ name: 'read_file', userPreference: 'default', effectiveExposed: true });

      const doctor = await Promise.race([
        runtime.services.runDoctor(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Doctor runtime read timed out')), 5_000)),
      ]);
      for (const id of ['browser_cdp', 'network_access', 'office_desktop']) {
        const check = doctor.checks.find((candidate) => candidate.id === id);
        expect(check, `${id} should be present`).toBeDefined();
        expect(check?.detail).not.toBe('Probe timed out');
        expect(check?.durationMs).toBeLessThan(2_000);
      }
      expect(doctor.checks.find((candidate) => candidate.id === 'browser_cdp')).toMatchObject({ status: 'pass' });
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it('returns ChatGPT host-sync guidance only for a real exposure transition on an active trusted remote client', () => {
    const inactive = { state: 'stopped' as const, publicMcpUrl: null, oauthConnected: false };
    expect(toolAvailabilityHostSyncDisposition('en', true, inactive)).toEqual({
      chatgptActionRefreshMayBeRequired: false,
      hostSyncMessage: null,
    });
    expect(toolAvailabilityHostSyncDisposition('en', false, { state: 'running', publicMcpUrl: 'https://example.invalid/mcp', oauthConnected: true })).toEqual({
      chatgptActionRefreshMayBeRequired: false,
      hostSyncMessage: null,
    });

    const disposition = toolAvailabilityHostSyncDisposition('en', true, {
      state: 'running',
      publicMcpUrl: 'https://example.invalid/mcp',
      oauthConnected: true,
    });
    expect(disposition.chatgptActionRefreshMayBeRequired).toBe(true);
    expect(disposition.hostSyncMessage).toContain('F5');
    expect(disposition.hostSyncMessage).toContain('Action Refresh / Scan Tools');
    expect(disposition.hostSyncMessage).toContain('recreate + republish');
    expect(disposition.hostSyncMessage).not.toMatch(/observed|confirmed.*refresh/i);
  });
});
