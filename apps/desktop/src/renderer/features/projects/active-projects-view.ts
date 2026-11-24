import type { UiLocale } from '@lnwjing/ipc-contracts';
import type { ActiveProjectActivity } from './ActiveProjectsPage.js';

export type RunningProjectSort = 'status' | 'name-asc' | 'name-desc' | 'activity' | 'calls' | 'main';
export type RunningProjectFilter = 'all' | ActiveProjectActivity['state'];

export const DEFAULT_RUNNING_PROJECT_SORT: RunningProjectSort = 'status';
export const RUNNING_PROJECT_SORT_KEY = 'lnwjing:running-projects:sort';
const LOCALE_TAGS: Readonly<Record<UiLocale, string>> = { th: 'th-TH', en: 'en-US' };

export function isRunningProjectSort(value: unknown): value is RunningProjectSort {
  return value === 'status' || value === 'name-asc' || value === 'name-desc'
    || value === 'activity' || value === 'calls' || value === 'main';
}

function lastActivityMs(project: ActiveProjectActivity): number {
  const value = Date.parse(project.lastActivityAt ?? '');
  return Number.isFinite(value) ? value : -Infinity;
}

function stateRank(project: ActiveProjectActivity): number {
  return project.state === 'running' ? 0 : project.state === 'recent' ? 1 : 2;
}

/** Pure in-memory ordering, filtering and name/path search. No IPC or filesystem calls. */
export function selectRunningProjects(
  projects: readonly ActiveProjectActivity[],
  options: { readonly sort: RunningProjectSort; readonly filter: RunningProjectFilter; readonly search: string; readonly locale: UiLocale },
): readonly ActiveProjectActivity[] {
  const query = options.search.trim().toLocaleLowerCase(options.locale);
  const collator = new Intl.Collator(LOCALE_TAGS[options.locale], {
    sensitivity: 'base', numeric: true,
  });
  const nameOrder = (a: ActiveProjectActivity, b: ActiveProjectActivity): number =>
    collator.compare(a.workspace.displayName, b.workspace.displayName)
      || collator.compare(a.workspace.realRootPath, b.workspace.realRootPath)
      || a.workspace.id.localeCompare(b.workspace.id);
  const statusOrder = (a: ActiveProjectActivity, b: ActiveProjectActivity): number =>
    stateRank(a) - stateRank(b) || lastActivityMs(b) - lastActivityMs(a) || nameOrder(a, b);

  return projects.filter((project) =>
    (options.filter === 'all' || project.state === options.filter)
    && (query === '' || project.workspace.displayName.toLocaleLowerCase(options.locale).includes(query)
      || project.workspace.realRootPath.toLocaleLowerCase(options.locale).includes(query)),
  ).sort((a, b) => {
    switch (options.sort) {
      case 'name-asc': return nameOrder(a, b);
      case 'name-desc': return nameOrder(b, a);
      case 'activity': return lastActivityMs(b) - lastActivityMs(a) || statusOrder(a, b);
      case 'calls': return (b.runningCalls + b.runningJobs) - (a.runningCalls + a.runningJobs) || statusOrder(a, b);
      case 'main': return Number(b.primary) - Number(a.primary) || statusOrder(a, b);
      case 'status': return statusOrder(a, b);
    }
  });
}
