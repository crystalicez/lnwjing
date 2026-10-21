import { canonicalWorkspaceScopeId, workspaceScopeMatches, type UiLocale, type WorkspaceSummary } from '@lnwjing/ipc-contracts';
import { formatDisplayDateTime } from '@lnwjing/shared/date-time-display';

export interface ScopeFilterSample {
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
  readonly timestamp: string;
}

export interface ScopeFilterOption {
  readonly id: string;
  readonly label: string;
}

export function collectWorkspaceFilterOptions(
  samples: readonly Pick<ScopeFilterSample, 'workspaceId'>[],
  workspaces: readonly WorkspaceSummary[] | undefined,
): readonly ScopeFilterOption[] {
  const workspaceList = workspaces ?? [];
  const canonicalWorkspaces = workspaceList.filter((workspace, index) =>
    workspace.kind !== 'machine_root'
    && canonicalWorkspaceScopeId(workspaceList, workspace.id) === workspace.id
    && workspaceList.findIndex((candidate) => canonicalWorkspaceScopeId(workspaceList, candidate.id) === workspace.id) === index,
  );
  const labels = new Map<string, string>();
  for (const workspace of canonicalWorkspaces) {
    labels.set(workspace.id, `${workspace.displayName} — ${workspace.realRootPath}`);
  }
  for (const sample of samples) {
    if (sample.workspaceId === null) continue;
    const canonicalId = canonicalWorkspaceScopeId(workspaceList, sample.workspaceId);
    if (!labels.has(canonicalId)) labels.set(canonicalId, canonicalId);
  }
  return [...labels.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function collectSessionFilterOptions(
  samples: readonly ScopeFilterSample[],
  workspaceId: string | null,
  workspaces: readonly WorkspaceSummary[] | undefined,
  locale: UiLocale = 'th',
  sessionPrefix = 'Session',
): readonly ScopeFilterOption[] {
  const starts = new Map<string, { readonly timestamp: string | null; readonly epochMs: number }>();
  for (const sample of samples) {
    if (workspaceId !== null && !workspaceScopeMatches(workspaces ?? [], sample.workspaceId, workspaceId)) continue;
    const id = sample.sessionId;
    if (id === null) continue;
    const epochMs = Date.parse(sample.timestamp);
    const existing = starts.get(id);
    if (!Number.isFinite(epochMs)) {
      if (existing === undefined) starts.set(id, { timestamp: null, epochMs: Number.NEGATIVE_INFINITY });
      continue;
    }
    if (existing === undefined || epochMs < existing.epochMs) {
      starts.set(id, { timestamp: sample.timestamp, epochMs });
    }
  }

  const rawOptions = [...starts.entries()].map(([id, start]) => {
    const minute = start.timestamp === null ? null : formatSessionMinute(start.timestamp, locale);
    return {
      id,
      label: minute === null ? `${sessionPrefix} ${id}` : `${sessionPrefix} ${minute}`,
      epochMs: start.epochMs,
    };
  });
  const labelCounts = new Map<string, number>();
  for (const option of rawOptions) labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1);

  return rawOptions
    .sort((left, right) => right.epochMs - left.epochMs || left.id.localeCompare(right.id))
    .map(({ id, label }) => ({
      id,
      label: (labelCounts.get(label) ?? 0) > 1 ? `${label} — ${shortSessionId(id)}` : label,
    }));
}

function formatSessionMinute(timestamp: string, locale: UiLocale): string | null {
  if (!Number.isFinite(Date.parse(timestamp))) return null;
  return formatDisplayDateTime(timestamp, locale).slice(0, 16);
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : sessionId.slice(0, 8);
}
