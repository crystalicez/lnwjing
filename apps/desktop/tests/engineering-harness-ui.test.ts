import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UserSettings } from '@lnwjing/ipc-contracts';
import { UserConfigPanel } from '../src/renderer/features/settings/UserConfigPanel.js';

const settings: UserSettings = {
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
  mcpHttpPort: 0,
  mcpAllowedHostnames: [],
  codexToolsEnabled: false,
  ponytailMode: 'off',
  engineeringHarness: { schemaVersion: 1, enabled: true, profile: 'senior', applyTo: 'coding_projects', autoProjectAssessment: true },
  engineeringHarnessWorkspaceOverrides: {},
  engineeringHarnessDiagnostic: null,
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

function render(locale: 'th' | 'en'): string {
  return renderToStaticMarkup(createElement(UserConfigPanel, {
    locale,
    hostPlatform: 'win32',
    hostArch: 'x64',
    permissionProfile: 'full',
    stdioPermissionProfile: 'full',
    settings,
    selectedWorkspace: { id: 'workspace-1', displayName: 'Fixture project' },
    engineeringStatus: {
      workspaceId: 'workspace-1',
      enabled: true,
      source: 'global',
      profile: 'senior',
      policyDigest: 'digest-1',
      reasons: ['Engineering Harness is enabled.'],
      diagnostic: null,
      task: {
        goalId: 'goal-1',
        goalKey: 'fixture-goal',
        currentPhase: 'validation',
        nextAction: 'Run focused tests.',
        primaryTaskKind: 'bugfix',
        riskTier: 'high',
        deliveryScope: 'local',
        gates: [
          { id: 'focused', title: 'Focused tests', applicability: 'required', status: 'running', reason: 'Behavior changed.' },
          { id: 'review', title: 'Review', applicability: 'required', status: 'passed', reason: 'High-risk change.', evidenceSource: 'host_observed' },
        ],
      },
    },
    section: 'engineering',
    unrestricted: false,
    onUnrestrictedChange: async () => false,
    onSave: async () => false,
    onInstallPdfProvider: async () => ({ installed: true, reused: false, providerPath: 'pdftotext.exe', version: '1' }),
  }));
}

describe('Engineering Harness settings UI', () => {
  it('renders an accessible English opt-in configuration and truthful pending task state', () => {
    const markup = render('en');
    expect(markup).toContain('Engineering Harness');
    expect(markup).toContain('Senior — recommended');
    expect(markup).toContain('Coding projects/tasks only');
    expect(markup).toContain('Workspace status');
    expect(markup).toContain('bugfix · high · validation');
    expect(markup).toContain('Running');
    expect(markup).toContain('Passed');
    expect(markup).toContain('host_observed');
    expect(markup).not.toContain('Pending');
  });

  it('renders Thai labels and keeps the global security profile separate from Harness controls', () => {
    const markup = render('th');
    expect(markup).toContain('เปิด Engineering Harness');
    expect(markup).toContain('เฉพาะโปรเจกต์/งานเขียนโค้ด');
    expect(markup).not.toContain('รอตรวจ');
    expect(markup).toContain('กำลังตรวจ');
    expect(markup).not.toContain('Full Access (Unrestricted)');
  });
});
