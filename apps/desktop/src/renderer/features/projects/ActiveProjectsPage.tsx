import { useMemo, useState, type ReactElement } from 'react';
import { canonicalWorkspaceScopeId, type DashboardSnapshot, type UiLocale, type WorkspaceSummary } from '@lnwjing/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { ActionButton, FormInput, FormSelect } from '../ui/UiPrimitives.js';
import { DEFAULT_RUNNING_PROJECT_SORT, isRunningProjectSort, RUNNING_PROJECT_SORT_KEY, selectRunningProjects,
  type RunningProjectFilter, type RunningProjectSort } from './active-projects-view.js';

const RECENT_ACTIVITY_MS = 5 * 60 * 1_000;
const DATE_LOCALES: Readonly<Record<UiLocale, string>> = { th: 'th-TH', en: 'en-US' };

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
  dashboard: Pick<DashboardSnapshot, 'activeWorkspaces' | 'selectedWorkspace' | 'inFlight' | 'workLog'>
    & { readonly recentActivity?: readonly { readonly workspaceId: string; readonly timestamp: string }[] },
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
  // Recent activity is queried independently of the 500-entry global Work Log.
  // Only the initial legacy dashboard (before lightweight IPC loads) uses workLog.
  if (dashboard.recentActivity === undefined) {
    for (const entry of dashboard.workLog) record(entry.workspaceId, entry.timestamp, false);
  } else {
    for (const entry of dashboard.recentActivity) record(entry.workspaceId, entry.timestamp, false);
  }
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
  readonly activityUpdatedAt?: number | null;
  readonly activityFailed?: boolean;
  readonly onSelectWorkspace: (workspaceId: string) => Promise<void>;
  readonly onOpenProjects: () => void;
}

export function ActiveProjectsPage(props: ActiveProjectsPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<RunningProjectFilter>('all');
  const [sort, setSort] = useState<RunningProjectSort>(() => {
    try {
      if (typeof window === 'undefined') return DEFAULT_RUNNING_PROJECT_SORT;
      const value = window.localStorage.getItem(RUNNING_PROJECT_SORT_KEY);
      return isRunningProjectSort(value) ? value : DEFAULT_RUNNING_PROJECT_SORT;
    } catch { return DEFAULT_RUNNING_PROJECT_SORT; }
  });
  const projects = useMemo(() => deriveActiveProjectActivity(props.workspaces, props.dashboard),
    [props.workspaces, props.dashboard]);
  const visible = useMemo(() => selectRunningProjects(projects, {
    sort, filter, search, locale: props.locale,
  }), [projects, sort, filter, search, props.locale]);
  const running = projects.filter((project) => project.state === 'running').length;
  const recent = projects.filter((project) => project.state === 'recent').length;
  const ready = projects.length - running - recent;
  function changeSort(value: string): void {
    if (!isRunningProjectSort(value)) return;
    setSort(value);
    try { window.localStorage.setItem(RUNNING_PROJECT_SORT_KEY, value); }
    catch { /* UI preference is optional; sorting must still work. */ }
  }
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
        <p className="hint active-projects-status-note">{t('activeProjects.statusNote')}</p>
        <p className="hint" role="status" data-testid="running-activity-freshness">
          {props.activityFailed ? t('activeProjects.activityFailed') : props.activityUpdatedAt == null ? t('activeProjects.activityLoading') : t('activeProjects.activityUpdated', { time: new Date(props.activityUpdatedAt).toLocaleTimeString(DATE_LOCALES[props.locale]) })}
        </p>
        {projects.length === 0 ? (
          <div className="active-projects-empty">
            <p>{t('activeProjects.empty')}</p>
            <ActionButton type="button" onClick={props.onOpenProjects}>{t('activeProjects.manage')}</ActionButton>
          </div>
        ) : (
          <>
            <div className="active-projects-toolbar">
              <div className="active-projects-search">
                <label htmlFor="active-projects-search">{t('activeProjects.search')}</label>
                <FormInput id="active-projects-search" type="search" value={search}
                  placeholder={t('activeProjects.searchHint')} autoComplete="off"
                  onChange={(event) => setSearch(event.currentTarget.value)} />
              </div>
              <div className="active-projects-filter">
                <label htmlFor="active-projects-filter">{t('activeProjects.filter')}</label>
                <FormSelect id="active-projects-filter" value={filter}
                  onChange={(event) => setFilter(event.currentTarget.value as RunningProjectFilter)}>
                  <option value="all">{t('activeProjects.filterAll')}</option>
                  <option value="running">{t('activeProjects.running')}</option>
                  <option value="recent">{t('activeProjects.recent')}</option>
                  <option value="ready">{t('activeProjects.ready')}</option>
                </FormSelect>
              </div>
              <div className="active-projects-sort">
                <label htmlFor="active-projects-sort">{t('activeProjects.sort')}</label>
                <FormSelect id="active-projects-sort" value={sort}
                  onChange={(event) => changeSort(event.currentTarget.value)}>
                  <option value="status">{t('activeProjects.sortStatus')}</option>
                  <option value="name-asc">{t('activeProjects.sortNameAsc')}</option>
                  <option value="name-desc">{t('activeProjects.sortNameDesc')}</option>
                  <option value="activity">{t('activeProjects.sortActivity')}</option>
                  <option value="calls">{t('activeProjects.sortCalls')}</option>
                  <option value="main">{t('activeProjects.sortMain')}</option>
                </FormSelect>
              </div>
            </div>
            <div className="active-projects-summary" aria-live="polite">
              <span>{t('activeProjects.showing', { shown: String(visible.length), total: String(projects.length) })}</span>
              <span>{t('activeProjects.statusTotals', { running: String(running), recent: String(recent), ready: String(ready) })}</span>
            </div>
            <div className="active-projects-scroll" role="region" tabIndex={0} aria-label={t('activeProjects.list')}>
              {visible.length === 0
                ? <p className="active-projects-no-matches" role="status">{t('activeProjects.noMatches')}</p>
                : <ul className="active-projects-list">
            {visible.map((project) => (
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
                        ? t('activeProjects.lastSeen', { time: new Date(project.lastActivityAt).toLocaleString(DATE_LOCALES[props.locale]) })
                        : t('activeProjects.noActivity')}
                  </small>
                </div>
                <ActionButton type="button" disabled={busyId !== null || project.primary}
                  onClick={() => { void select(project.workspace.id); }}>
                  {project.primary ? t('home.primaryBadge') : t('project.setMain')}
                </ActionButton>
              </li>
            ))}
                </ul>}
            </div>
          </>
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
