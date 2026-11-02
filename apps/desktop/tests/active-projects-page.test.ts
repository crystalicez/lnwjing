import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot, InFlightWorkItem, WorkLogEntry, WorkspaceSummary } from '@lnwjing/ipc-contracts';
import { ActiveProjectsPage, deriveActiveProjectActivity } from '../src/renderer/features/projects/ActiveProjectsPage.js';
import { AppShell } from '../src/renderer/features/shell/AppShell.js';

function workspace(id: string, extras: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return { id, displayName: id, rootPath: `E:\\Projects\\${id}`,
    realRootPath: `E:\\Projects\\${id}`, kind: 'project', archivedAt: null, ...extras } as WorkspaceSummary;
}

const workspaces = [
  workspace('running'),
  workspace('recent'),
  workspace('ready'),
  workspace('inactive'),
  workspace('archived', { archivedAt: '2026-11-01T00:00:00.000Z' }),
];
const at = '2026-11-02T04:20:00.000Z';
function dashboard(): Pick<DashboardSnapshot, 'activeWorkspaces' | 'selectedWorkspace' | 'inFlight' | 'workLog'> {
  return {
    activeWorkspaces: [workspaces[0]!, workspaces[1]!, workspaces[2]!, workspaces[4]!],
    selectedWorkspace: workspaces[1]!,
    inFlight: [{
      callId: 'running-1', toolName: 'shell', workspaceId: 'running', sessionId: 'session-a',
      startedAt: '2026-11-02T04:19:50.000Z', targetSummary: null,
      targetDetail: { detailRef: null, itemCount: 0, preview: [], legacyIncomplete: false },
    } satisfies InFlightWorkItem],
    workLog: [{
      id: 'recent-1', kind: 'result', level: 'info', toolName: 'read_file',
      timestamp: '2026-11-02T04:18:00.000Z', resultCode: 'SUCCESS',
      errorMessage: null, targetSummary: 'file.ts',
      targetDetail: { detailRef: null, itemCount: 1, preview: ['file.ts'], legacyIncomplete: false },
      durationMs: 1, workspaceId: 'recent', sessionId: 'session-b',
    } as WorkLogEntry],
  };
}

describe('Active Projects dashboard', () => {
  it('separates in-flight, recent and ready from the configured active workspace set without polling', () => {
    const projects = deriveActiveProjectActivity(workspaces, dashboard(), Date.parse(at));
    expect(projects.map((project) => [project.workspace.id, project.state, project.runningCalls]))
      .toEqual([['running', 'running', 1], ['recent', 'recent', 0], ['ready', 'ready', 0]]);
    expect(projects[1]?.primary).toBe(true);
    expect(projects[1]?.lastActivityAt).toBe('2026-11-02T04:18:00.000Z');
    expect(deriveActiveProjectActivity(workspaces, dashboard(), Date.parse(at) + 20 * 60_000)
      .find((project) => project.workspace.id === 'recent')?.state).toBe('ready');
  });

  it('renders a dedicated sidebar tab and project status without displaying inactive or archived projects', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    const snapshot = dashboard();
    const page = renderToStaticMarkup(createElement(ActiveProjectsPage, {
      locale: 'en', dashboard: snapshot as DashboardSnapshot, workspaces,
      onSelectWorkspace: async () => {}, onOpenProjects: () => {},
    }));
    expect(page).toContain('Running');
    expect(page).toContain('Recent');
    expect(page).toContain('Ready');
    expect(page).not.toContain('E:\\Projects\\inactive');
    expect(page).not.toContain('E:\\Projects\\archived');
    const shell = renderToStaticMarkup(createElement(AppShell, {
      locale: 'en', appVersion: '5.8.7', hostPlatform: 'win32',
      mcpRunning: true, desktopFullBypassOn: false, stdioFullBypassOn: false,
      updateStatus: null, screen: 'active-projects', onNavigate: () => {},
      onLocaleChange: () => {}, onUpdateAction: () => {},
      children: createElement('div', null, page),
    }));
    expect(shell).toContain('Active Projects');
    expect(shell).toContain('nav-item active');
    vi.useRealTimers();
  });
});
