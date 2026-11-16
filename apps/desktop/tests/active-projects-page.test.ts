import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot, InFlightWorkItem, WorkLogEntry, WorkspaceSummary } from '@lnwjing/ipc-contracts';
import { ActiveProjectsPage, deriveActiveProjectActivity } from '../src/renderer/features/projects/ActiveProjectsPage.js';
import { isRunningProjectSort, selectRunningProjects } from '../src/renderer/features/projects/active-projects-view.js';
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

  it('uses authoritative per-workspace recent activity instead of the truncated global Work Log', () => {
    const snapshot = {
      ...dashboard(),
      workLog: [],
      recentActivity: [{ workspaceId: 'recent', timestamp: '2026-11-02T04:18:00.000Z' }],
    };
    const projects = deriveActiveProjectActivity(workspaces, snapshot, Date.parse(at));
    expect(projects.find((project) => project.workspace.id === 'recent')?.state).toBe('recent');
    expect(projects.find((project) => project.workspace.id === 'ready')?.state).toBe('ready');
  });

  it('sorts by name, recent activity, active call count and main project without extra queries', () => {
    const items = deriveActiveProjectActivity(workspaces, dashboard(), Date.parse(at));
    const options = { sort: 'status' as const, filter: 'all' as const, search: '', locale: 'en' as const };
    const select = (sort: Parameters<typeof selectRunningProjects>[1]['sort']): string[] =>
      selectRunningProjects(items, { ...options, sort }).map((project) => project.workspace.id);
    expect(select('status')).toEqual(['running', 'recent', 'ready']);
    expect(select('name-asc')).toEqual(['ready', 'recent', 'running']);
    expect(select('name-desc')).toEqual(['running', 'recent', 'ready']);
    expect(select('activity')).toEqual(['running', 'recent', 'ready']);
    expect(select('calls')).toEqual(['running', 'recent', 'ready']);
    expect(select('main')).toEqual(['recent', 'running', 'ready']);
    expect(selectRunningProjects(items, { ...options, filter: 'recent' }).map((item) => item.workspace.id))
      .toEqual(['recent']);
    expect(selectRunningProjects(items, { ...options, search: items.find((item) => item.workspace.id === 'ready')!.workspace.realRootPath.toUpperCase() })
      .map((item) => item.workspace.id)).toEqual(['ready']);
    expect(selectRunningProjects(items, { ...options, search: 'no-matching-project' })).toEqual([]);
    expect(isRunningProjectSort('bad-option')).toBe(false);
    expect(isRunningProjectSort('name-desc')).toBe(true);
  });

  it('sorts natural numeric names and uses a stable ID tie-breaker', () => {
    const spaces = [
      workspace('id-10', { displayName: 'Project 10' }),
      workspace('id-2', { displayName: 'Project 2' }),
      workspace('id-3', { displayName: 'Project 2' }),
      workspace('thai', { displayName: 'โปรเจกต์ ก' }),
    ];
    const snapshot = { ...dashboard(), activeWorkspaces: spaces, selectedWorkspace: spaces[0]!, inFlight: [], workLog: [] };
    const items = deriveActiveProjectActivity(spaces, snapshot, Date.parse(at));
    const list = selectRunningProjects(items, { sort: 'name-asc', filter: 'all', search: '', locale: 'th' });
    expect(list.filter((item) => item.workspace.displayName.startsWith('Project')).map((item) => item.workspace.id))
      .toEqual(['id-2', 'id-3', 'id-10']);
    expect(selectRunningProjects(items, { sort: 'main', filter: 'all', search: '', locale: 'th' })[0]?.workspace.id)
      .toBe('id-10');
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
    expect(shell).toContain('Running Projects');
    expect(shell).toContain('nav-item active');
    vi.useRealTimers();
  });
});
