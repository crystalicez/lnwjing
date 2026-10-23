import { useState, type ReactElement } from 'react';
import type { UiLocale, WorkspaceIndexWatchSummary } from '@lnwjing/ipc-contracts';
import { ActionButton, FormInput } from '../ui/UiPrimitives.js';
import { createTranslator } from '../../i18n/index.js';

interface WorkspaceWatcherControlsProps {
  readonly workspaceId: string;
  readonly locale: UiLocale;
  readonly active: boolean;
}

/**
 * Explicit, project-scoped control: no automatic watcher activation and no
 * background status polling across many registered 20 GiB+ projects.
 */
export function WorkspaceWatcherControls({ workspaceId, locale, active }: WorkspaceWatcherControlsProps): ReactElement {
  const t = createTranslator(locale);
  const [status, setStatus] = useState<WorkspaceIndexWatchSummary | null>(null);
  const [debounceMs, setDebounceMs] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = Number.isInteger(debounceMs) && debounceMs >= 0 && debounceMs <= 60_000;
  const changedSettings = status?.watching === true && status.debounceMs !== debounceMs;
  const degraded = status?.freshness === 'watching_degraded';

  async function run(action: () => Promise<WorkspaceIndexWatchSummary>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      // The response is only bounded index/watch telemetry, never the entries.
      setStatus(next);
      if (next.debounceMs !== null) setDebounceMs(next.debounceMs);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="project-watcher-controls" aria-label={t('watcher.controlAria')}>
      <div className="project-watcher-heading">
        <strong>Index Watcher</strong>
        <span className="project-watcher-hint">
          {t('watcher.hint')}
        </span>
      </div>
      <div className="project-watcher-actions">
        <label htmlFor={`watcher-debounce-${workspaceId}`}>{t('watcher.debounce')}</label>
        <FormInput
          id={`watcher-debounce-${workspaceId}`}
          type="number"
          min={0}
          max={60000}
          step={100}
          value={debounceMs}
          disabled={busy}
          onChange={(event) => setDebounceMs(event.target.value === '' ? -1 : Number(event.target.value))}
          aria-label={t('watcher.debounceAria')}
        />
        <span>ms</span>
        <ActionButton type="button" disabled={busy} onClick={() => { void run(() => window.lnwjing.getWorkspaceIndexStatus({ workspaceId })); }}>
          {t('watcher.refresh')}
        </ActionButton>
        <ActionButton type="button" variant="primary"
          disabled={busy || !active || status === null || !configured || (status.watching && !changedSettings && !degraded)}
          onClick={() => { void run(() => window.lnwjing.startWorkspaceIndexWatch({ workspaceId, debounceMs })); }}>
          {degraded ? t('watcher.restart') : status?.watching ? t('watcher.apply') : t('watcher.start')}
        </ActionButton>
        <ActionButton type="button" disabled={busy || !status?.watching}
          onClick={() => { void run(() => window.lnwjing.stopWorkspaceIndexWatch({ workspaceId })); }}>
          {t('watcher.stop')}
        </ActionButton>
      </div>
      {status === null ? <p className="project-watcher-meta">{active ? t('watcher.beforeStart') : t('watcher.activateFirst')}</p> : (
        <p className="project-watcher-meta" role="status">
          {degraded ? t('watcher.degraded') : active && status.watching ? t('watcher.watching') : t('watcher.stopped')}
          {' · '}{t('watcher.entries')}: {status.entryCount.toLocaleString()}
          {' · '}{t('watcher.freshness')}: {status.freshness}
          {' · '}{t('watcher.pending')}: {status.pendingEvents}
          {' · '}{t('watcher.failures')}: {status.failedEvents}
          {' · '}{t('watcher.overflow')}: {status.overflowRescans}
          {status.error === null ? null : ` · ${status.error}`}
        </p>
      )}
      {configured && debounceMs < 250 ? <p className="project-watcher-error" role="status">{t('watcher.lowDebounce')}</p> : null}
      {!configured ? <p role="alert" className="project-watcher-error">{t('watcher.invalidDebounce')}</p> : null}
      {error === null ? null : <p role="alert" className="project-watcher-error">{error}</p>}
      <p className="project-watcher-note">
        {t('watcher.processScope')}
      </p>
    </div>
  );
}
