import { useMemo, useState, type ReactElement } from 'react';
import { canonicalWorkspaceScopeId, type DashboardSnapshot, type UiLocale, type WorkspaceSummary } from '@lnwjing/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { ActionButton } from '../ui/UiPrimitives.js';

const RECENT_ACTIVITY_MS = 5 * 60 * 1_000;

export interface ActiveProjectActivity {
  readonly workspace: WorkspaceSummary;
  readonly runningCalls: number;
  readonly lastActivityAt: string | null;
  readonly state: 'running' | 'recent' | 'ready';
  readonly primary: boolean;
}

/**
 * "Active" means enabled in the MCP active workspace set, not "busy".
 * Running is based on actual in-flight tool calls, and Recent is observed
 * audit activity within five minutes. No extra watcher or SQLite poll.
 */
export function deriveActiveProjectActivity(
  workspaces: readonly WorkspaceSummary[],
  dashboard: Pick<DashboardSnapshot, 'activeWorkspaces' | 'selectedWorkspace' | 'inFlight' | 'workLog'>,
  nowMs = Date.now(),
): readonly ActiveProjectActivity[] {
  const activeIds = new Set(dashboard.activeWorkspaces.map((workspace) => workspace.id));
  const active = workspaces.filter((workspace) => workspace.kind !== 'machine_root'
    && (workspace.archivedAt === undefined || workspace.archivedAt === null)
    && activeIds.has(workspace.id));
  const observations = new Map<string, { running: number; lastMs: number }>();
  const activeByCanonicalScope = new Map<string, string[]>();
  for (const workspace of active) {
    observations.set(workspace.id, { running: 0, lastMs: -Infinity });
    const canonical = canonicalWorkspaceScopeId(workspaces, workspace.id);
    const ids = activeByCanonicalScope.get(canonical) ?? [];
    ids.push(workspace.id);
    activeByCanonicalScope.set(canonical, ids);
  }
  const record = (workspaceId: string | null, timestamp: string, inFlight: boolean): void => {
    if (workspaceId === null) return;
    const related = activeByCanonicalScope.get(canonicalWorkspaceScopeId(workspaces, workspaceId));
    if (related === undefined) return;
    const time = Date.parse(timestamp);
    for (const id of related) {
      const current = observations.get(id)!;
      if (inFlight) current.running += 1;
      if (Number.isFinite(time)) current.lastMs = Math.max(current.lastMs, time);
    }
  };
  for (const call of dashboard.inFlight) record(call.workspaceId, call.startedAt, true);
  for (const entry of dashboard.workLog) record(entry.workspaceId, entry.timestamp, false);
  return active.map((workspace) => {
    const observation = observations.get(workspace.id)!;
    const state: ActiveProjectActivity['state'] = observation.running > 0 ? 'running'
      : nowMs >= observation.lastMs && nowMs - observation.lastMs <= RECENT_ACTIVITY_MS ? 'recent' : 'ready';
    return {
      workspace, runningCalls: observation.running, state,
      lastActivityAt: Number.isFinite(observation.lastMs) ? new Date(observation.lastMs).toISOString() : null,
      primary: dashboard.selectedWorkspace?.id === workspace.id,
    };
  }).sort((a, b) => {
    const rank = (value: ActiveProjectActivity): number => value.state === 'running' ? 0 : value.state === 'recent' ? 1 : 2;
    return rank(a) - rank(b) || (Date.parse(b.lastActivityAt ?? '') || 0) - (Date.parse(a.lastActivityAt ?? '') || 0)
      || a.workspace.displayName.localeCompare(b.workspace.displayName);
  });
}

interface ActiveProjectsPageProps {
  readonly locale: UiLocale;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly dashboard: DashboardSnapshot;
  readonly onSelectWorkspace: (workspaceId: string) => Promise<void>;
  readonly onOpenProjects: () => void;
}

export function ActiveProjectsPage(props: ActiveProjectsPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const [busyId, setBusyId] = useState<string | null>(null);
  const projects = useMemo(() => deriveActiveProjectActivity(props.workspaces, props.dashboard),
    [props.workspaces, props.dashboard]);
  const running = projects.filter((project) => project.state === 'running').length;
  async function select(workspaceId: string): Promise<void> {
    setBusyId(workspaceId);
    try { await props.onSelectWorkspace(workspaceId); }
    finally { setBusyId(null); }
  }
  return (
    <div className="page-content viewport-list-page active-projects-page">
      <div className="page-heading">
        <div>
          <h1>{t('nav.activeProjects')}</h1>
          <p className="page-subtitle">{t('activeProjects.description')}</p>
        </div>
      </div>
      <section className="panel active-projects-overview">
        <div className="section-heading">
          <h2>{t('activeProjects.enabledCount', { count: String(projects.length) })}</h2>
          <span className="active-projects-running-total" role="status">
            {t('activeProjects.runningCount', { count: String(running) })}
          </span>
        </div>
        <p className="hint">{t('activeProjects.statusNote')}</p>
        {projects.length === 0 ? (
          <div className="active-projects-empty">
            <p>{t('activeProjects.empty')}</p>
            <ActionButton type="button" onClick={props.onOpenProjects}>{t('activeProjects.manage')}</ActionButton>
          </div>
        ) : (
          <ul className="active-projects-list">
            {projects.map((project) => (
              <li className="active-projects-item" key={project.workspace.id}>
                <div className="active-projects-info">
                  <div className="active-projects-name">
                    <strong>{project.workspace.displayName}</strong>
                    {project.primary ? <span className="project-status-badge system">{t('home.primaryBadge')}</span> : null}
                    <span className={`active-projects-state ${project.state}`}>
                      <span className="active-projects-dot" aria-hidden="true" />
                      {t(project.state === 'running' ? 'activeProjects.running'
                        : project.state === 'recent' ? 'activeProjects.recent' : 'activeProjects.ready')}
                    </span>
                  </div>
                  <p title={project.workspace.realRootPath}>{project.workspace.realRootPath}</p>
                  <small>
                    {project.runningCalls > 0
                      ? t('activeProjects.calls', { count: String(project.runningCalls) })
                      : project.lastActivityAt !== null
                        ? t('activeProjects.lastSeen', { time: new Date(project.lastActivityAt).toLocaleString(props.locale === 'th' ? 'th-TH' : 'en-US') })
                        : t('activeProjects.noActivity')}
                  </small>
                </div>
                <ActionButton type="button" disabled={busyId !== null || project.primary}
                  onClick={() => { void select(project.workspace.id); }}>
                  {project.primary ? t('home.primaryBadge') : t('project.setMain')}
                </ActionButton>
              </li>
            ))}
          </ul>
        )}
        {projects.length > 0 ? (
          <div className="active-projects-footer">
            <ActionButton type="button" onClick={props.onOpenProjects}>{t('activeProjects.manage')}</ActionButton>
          </div>
        ) : null}
      </section>
    </div>
  );
}
