import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EMPTY_REMOTE_MCP_STATUS, ipcChannels, type LnwjingApi, type ToolCatalogItem, type ToolCatalogSnapshot, type UserSettings } from '@lnwjing/ipc-contracts';

const electron = vi.hoisted(() => ({
  exposed: undefined as LnwjingApi | undefined,
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: LnwjingApi): void => { electron.exposed = api; },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

const checkedAt = '2026-08-30T00:00:00.000Z';
const item: ToolCatalogItem = {
  name: 'git', origin: 'lnwjing', category: 'git', title: 'Git', shortDescription: 'Git', longDescription: 'Git',
  declaredPermission: 'EXECUTE', profileDecision: 'ALLOW', riskMode: 'fixed', readiness: 'ready',
  userPreference: 'default', systemEligible: true, effectiveExposed: true, stale: false,
  checkedAt, supportsCancel: false, supportsDryRun: false, requirements: [], remediationIds: [], inputSchema: null, searchText: ['git'],
};

function response(override: Record<string, unknown>): ToolCatalogSnapshot {
  return { generatedAt: checkedAt, locale: 'en', items: [{ ...item, ...override }], remediations: [] };
}

const userSettingsFixture: UserSettings = {
  customPermission: { read: 'ALLOW', write: 'ASK', execute: 'ASK', dangerous: 'DENY', allowedExecutables: [] },
  desktopFullBypassAll: false,
  stdioFullBypassAll: false,
  mcpCallTimeoutMs: 60_000,
  mcpIdleTimeoutMs: 300_000,
  processTimeoutMs: 3_600_000,
  mcpPollWaitSeconds: 5,
  shellSynchronousWaitSeconds: 60,
  capabilityRoots: [],
  pdfProviderPath: '',
  lspCommands: {},
  mcpHttpPort: 18_765, mcpAllowedHostnames: [],
  codexToolsEnabled: false,
  eccEnabled: false,
  ponytailMode: 'off',
  updateAutoCheck: true,
  updateCheckOnStartup: true,
  updateIntervalMinutes: 30,
  updateAutoDownload: true,
  closeBehavior: 'tray',
  launchAtStartup: false,
  startMinimized: false,
  tunnelAutoReconnect: true,
  tunnelMaxAutoRestarts: 5,
  recoveryRetentionDays: 30,
  extensions: { mode: 'enable_all', disabledServers: [], enabledServers: [], disabledSkillRoots: [], extraSkillRoots: [], extraMcpServers: [] },
};

describe('preload Tool Catalog validation', () => {
  beforeAll(async () => { await import('../src/preload/index.js'); });

  it('validates automatic SQLite backup budget from the IPC bridge', async () => {
    const overview = {
      policy: { checkpointCreationMode: 'git-aware', sqliteHardLimitMiB: 4096,
        compressionEnabledOnNextStart: false, automaticCheckpointRetention: false,
        auditPruneWithoutBackup: false, routineAuditRetentionDays: 90 },
      sqliteAllocatedBytes: 4096, sqliteFreeBytes: 0, sqliteWalBytes: 4096,
      sqliteEffectiveHardLimitBytes: 4096 * 1024 ** 2,
      sqliteOverBudget: false, sqlitePressureHigh: false,
      compactRecommended: false, compactionRequiresOffline: true,
      automaticBackupBudget: { budgetBytes: 12 * 1024 ** 3, usedBytes: 4096,
        projectedNextBytes: 4096, blocked: false },
    };
    electron.invoke.mockResolvedValueOnce(overview);
    await expect(electron.exposed!.getStorageOverview()).resolves.toMatchObject({
      automaticBackupBudget: { budgetBytes: 12 * 1024 ** 3, blocked: false },
    });
    electron.invoke.mockResolvedValueOnce({ ...overview,
      automaticBackupBudget: { ...overview.automaticBackupBudget, usedBytes: -1 } });
    await expect(electron.exposed!.getStorageOverview()).rejects.toThrow(/budget sizes/);
  });

  it('preserves ECC opt-in state through the preload settings parser', async () => {
    const enabled = { ...userSettingsFixture, eccEnabled: true };
    electron.invoke.mockResolvedValueOnce({ settings: enabled, restartRequired: false });
    await expect(electron.exposed!.setUserSettings({ settings: enabled })).resolves.toMatchObject({
      settings: { eccEnabled: true },
      restartRequired: false,
    });
    expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.setUserSettings, { settings: enabled });
  });

  it('preserves Engineering Harness settings through the preload bridge', async () => {
    const enabled = {
      ...userSettingsFixture,
      engineeringHarness: {
        schemaVersion: 1 as const,
        enabled: true,
        profile: 'senior' as const,
        applyTo: 'coding_projects' as const,
        autoProjectAssessment: true,
      },
      engineeringHarnessWorkspaceOverrides: {
        'workspace-enabled': { mode: 'on' as const, profile: 'strict' as const },
      },
      engineeringHarnessDiagnostic: null,
    };
    electron.invoke.mockResolvedValueOnce({ settings: enabled, restartRequired: true });

    await expect(electron.exposed!.setUserSettings({ settings: enabled })).resolves.toMatchObject({
      settings: {
        engineeringHarness: { enabled: true, profile: 'senior' },
        engineeringHarnessWorkspaceOverrides: { 'workspace-enabled': { mode: 'on', profile: 'strict' } },
        engineeringHarnessDiagnostic: null,
      },
      restartRequired: true,
    });
  });

  it('preserves bounded Git image previews through the preload bridge', async () => {
    electron.invoke.mockResolvedValueOnce({
      path: 'assets/logo.png',
      patch: '',
      truncated: false,
      oldImage: { mimeType: 'image/png', dataBase64: 'b2xk', byteLength: 3 },
      newImage: { mimeType: 'image/png', dataBase64: 'bmV3', byteLength: 3 },
    });

    await expect(electron.exposed!.getGitDiff({ workspaceId: 'workspace-1', path: 'assets/logo.png', staged: true })).resolves.toMatchObject({
      oldImage: { mimeType: 'image/png', dataBase64: 'b2xk', byteLength: 3 },
      newImage: { mimeType: 'image/png', dataBase64: 'bmV3', byteLength: 3 },
    });
    expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.getGitDiff, { workspaceId: 'workspace-1', path: 'assets/logo.png', staged: true });
  });

  it('keeps ECC disabled when an older settings response omits eccEnabled', async () => {
    const legacySettings = { ...userSettingsFixture } as Record<string, unknown>;
    delete legacySettings.eccEnabled;
    electron.invoke.mockResolvedValueOnce({ settings: legacySettings, restartRequired: false });
    await expect(electron.exposed!.setUserSettings({ settings: userSettingsFixture })).resolves.toMatchObject({
      settings: { eccEnabled: false },
      restartRequired: false,
    });
  });

  it('preserves valid optional readiness fields from IPC', async () => {
    electron.invoke.mockResolvedValueOnce(response({
      readiness: 'needs_setup', readinessReason: 'runtime_not_ready', deliveryState: 'operational', available: true,
    }));
    await expect(electron.exposed!.getToolCatalog({ locale: 'en' })).resolves.toMatchObject({
      items: [expect.objectContaining({
        readiness: 'needs_setup', readinessReason: 'runtime_not_ready', deliveryState: 'operational', available: true,
      })],
    });
  });

  it('accepts generic diagnostic detail returned by the activity-detail IPC', async () => {
    electron.invoke.mockResolvedValueOnce({ status: 'complete', detail: { kind: 'details', items: ['status=active', 'nested.revision=12'] } });
    await expect(electron.exposed!.resolveActivityTargetDetail({ detailRef: 'call-1:completed' })).resolves.toEqual({
      status: 'complete',
      detail: { kind: 'details', items: ['status=active', 'nested.revision=12'] },
    });
  });

  it('validates and exposes factory reset through the preload bridge', async () => {
    electron.invoke.mockResolvedValueOnce({ accepted: true });
    await expect(electron.exposed!.factoryReset()).resolves.toEqual({ accepted: true });
    expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.factoryReset);
  });

  it('allows an empty tunnel-client path to select the bundled client', async () => {
    electron.invoke.mockResolvedValueOnce({ clientPath: '' });
    await expect(electron.exposed!.setTunnelClientPath({ clientPath: '' })).resolves.toEqual({ clientPath: '' });
    expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.setTunnelClientPath, { clientPath: '' });
  });

  it('allows the ngrok authtoken setup target through the preload bridge', async () => {
    electron.invoke.mockResolvedValueOnce({ opened: true });
    await expect(electron.exposed!.openExternalSetupPage({ target: 'ngrok_authtoken' })).resolves.toEqual({ opened: true });
    expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.openExternalSetupPage, { target: 'ngrok_authtoken' });
  });

  it('routes Remote MCP transport selection through preload and preserves transport-specific status fields', async () => {
    electron.invoke.mockResolvedValueOnce({
      ...EMPTY_REMOTE_MCP_STATUS,
      provider: 'cloudflare',
      transport: 'cloudflare',
      installed: true,
      configuredGatewayUrl: 'http://127.0.0.1:18766',
      configuredPublicOrigin: 'https://mcp.example.com',
    });
    await expect(electron.exposed!.setRemoteMcpTransport({ transport: 'cloudflare' })).resolves.toMatchObject({
      provider: 'cloudflare',
      transport: 'cloudflare',
      configuredGatewayUrl: 'http://127.0.0.1:18766',
    });
    expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.setRemoteMcpTransport, { transport: 'cloudflare' });
  });

  it('accepts the unclean desktop-session incident classification from IPC', async () => {
    electron.invoke.mockResolvedValueOnce({
      exported: true,
      cancelled: false,
      classification: 'desktop_session_ended_uncleanly',
      capturedAt: checkedAt,
    });
    await expect(electron.exposed!.captureIncident()).resolves.toMatchObject({
      exported: true,
      classification: 'desktop_session_ended_uncleanly',
    });
  });

  it.each([
    ['readinessReason', 'invented_reason'],
    ['deliveryState', 'invented_delivery'],
    ['available', 'yes'],
  ] as const)('rejects invalid optional %s values from IPC', async (field, value) => {
    electron.invoke.mockResolvedValueOnce(response({ [field]: value }));
    await expect(electron.exposed!.getToolCatalog({ locale: 'en' })).rejects.toThrow('Invalid IPC response');
  });
});
