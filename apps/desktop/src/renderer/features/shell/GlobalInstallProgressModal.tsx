import { useEffect, useRef, type ReactElement } from 'react';
import type {
  InstallActivitySnapshot,
  InstallOperationKind,
  InstallOperationPhase,
  UiLocale,
} from '@lnwjing/ipc-contracts';
import { createTranslator, type Translator } from '../../i18n/index.js';

interface GlobalInstallProgressModalProps {
  readonly locale: UiLocale;
  readonly activity: InstallActivitySnapshot;
}

export function GlobalInstallProgressModal({ locale, activity }: GlobalInstallProgressModalProps): ReactElement | null {
  const dialogRef = useRef<HTMLElement>(null);
  const t = createTranslator(locale);
  const operation = activity.operations[0];

  useEffect(() => {
    if (operation !== undefined) dialogRef.current?.focus();
  }, [operation?.kind, operation?.startedAt]);

  if (operation === undefined) return null;

  const determinate = operation.progressPercent !== null;
  const percent = determinate ? Math.round(operation.progressPercent ?? 0) : null;
  return (
    <div className="install-progress-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="install-progress-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-progress-title"
        aria-describedby="install-progress-description"
        tabIndex={-1}
      >
        <div className="install-progress-spinner" aria-hidden="true" />
        <div className="install-progress-copy">
          <p className="eyebrow">{t('installProgress.eyebrow')}</p>
          <h2 id="install-progress-title">{operationTitle(t, operation.kind)}</h2>
          <p id="install-progress-description">{operation.kind === 'app_update' && operation.message !== null ? operation.message : phaseLabel(t, operation.phase)}</p>
          {activity.operations.length > 1
            ? <p className="hint">{t('installProgress.multiple', { count: activity.operations.length })}</p>
            : null}
        </div>
        <div
          className="install-progress-track"
          role="progressbar"
          aria-label={phaseLabel(t, operation.phase)}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent === null ? {} : { 'aria-valuenow': percent })}
        >
          <div
            className={`install-progress-bar${determinate ? '' : ' is-indeterminate'}`}
            {...(percent === null ? {} : { style: { width: `${percent}%` } })}
          />
        </div>
        <div className="install-progress-meta">
          <strong>{phaseLabel(t, operation.phase)}</strong>
          <span>{percent === null ? t('installProgress.pleaseWait') : `${percent}%`}</span>
        </div>
        <p className="install-progress-lock-hint">{t('installProgress.blockingHint')}</p>
      </section>
    </div>
  );
}

function operationTitle(t: Translator, kind: InstallOperationKind): string {
  if (kind === 'app_update') return t('installProgress.appUpdate');
  if (kind === 'ngrok') return t('installProgress.ngrok');
  return t('installProgress.pdfProvider');
}

function phaseLabel(t: Translator, phase: InstallOperationPhase): string {
  if (phase === 'preparing') return t('installProgress.phasePreparing');
  if (phase === 'downloading') return t('installProgress.phaseDownloading');
  if (phase === 'verifying') return t('installProgress.phaseVerifying');
  if (phase === 'finalizing') return t('installProgress.phaseFinalizing');
  return t('installProgress.phaseInstalling');
}
