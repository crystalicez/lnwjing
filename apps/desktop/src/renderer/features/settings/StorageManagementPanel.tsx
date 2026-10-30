import { useEffect, useState, type ReactElement } from 'react';
import type { CheckpointCleanupPreview, NativeStorageCleanupRequest, StorageOverview, StoragePolicy, UiLocale } from '@lnwjing/ipc-contracts';
import { ActionButton, SettingsCardHeading, StatusMessage } from '../ui/UiPrimitives.js';
import { SettingSwitch } from './SettingSwitch.js';
import { createTranslator } from '../../i18n/index.js';

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
type NativeCategory = NativeStorageCleanupRequest['category'];

function sizeLabel(bytes: number): string {
  return bytes >= MIB ? (bytes / MIB).toFixed(1) + ' MiB' : (bytes / 1024).toFixed(1) + ' KiB';
}

interface Props {
  readonly locale: UiLocale;
  readonly autoBackupEnabled: boolean;
  readonly onChanged?: () => Promise<void>;
}

export function StorageManagementPanel({ locale, autoBackupEnabled, onChanged }: Props): ReactElement {
  const t = createTranslator(locale);
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maxMiB, setMaxMiB] = useState(256);
  const [olderDays, setOlderDays] = useState(3);
  const [preview, setPreview] = useState<CheckpointCleanupPreview | null>(null);
  const [previewRequest, setPreviewRequest] = useState<{ maxBytes: number; deleteBefore: string } | null>(null);
  const [category, setCategory] = useState<NativeCategory>('tasks');
  const [cursors, setCursors] = useState<Partial<Record<NativeCategory, string | null>>>({});

  useEffect(() => {
    let active = true;
    void window.lnwjing.getStorageOverview().then((result) => {
      if (active) setOverview(result);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return (): void => { active = false; };
  }, []);

  async function refresh(): Promise<void> {
    setError(null);
    setPending(true);
    try {
      setOverview(await window.lnwjing.getStorageOverview());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function updatePolicy(changes: Partial<StoragePolicy>): Promise<void> {
    if (pending || overview === null) return;
    const enablingCompression = changes.compressionEnabledOnNextStart === true;
    if (changes.checkpointCreationMode === 'git-aware' && !window.confirm(t('storagePanel.confirmGitAware'))) return;
    const enablingNoBackupAudit = changes.auditPruneWithoutBackup === true;
    const enablingAutomaticRetention = changes.automaticCheckpointRetention === true;
    if (enablingAutomaticRetention && !window.confirm(t('storagePanel.confirmAuto'))) return;
    if (enablingCompression && !window.confirm(t('storagePanel.confirmCompression'))) return;
    if (enablingNoBackupAudit && !window.confirm(t('storagePanel.confirmAuditNoBackup'))) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await window.lnwjing.setStoragePolicy({ userConfirmed: true, ...changes });
      setOverview(result.overview);
      setPreview(null); setPreviewRequest(null);
      setNotice(result.restartRequired
        ? (t('storagePanel.restartRequired'))
        : (t('storagePanel.policySaved')));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function previewCleanup(): Promise<void> {
    if (!Number.isSafeInteger(maxMiB) || maxMiB < 0 || maxMiB > 1024 * 1024
      || !Number.isSafeInteger(olderDays) || olderDays < 1 || olderDays > 3650) {
      setError(t('storagePanel.invalidBudget'));
      return;
    }
    const request = { maxBytes: maxMiB * MIB, deleteBefore: new Date(Date.now() - olderDays * DAY_MS).toISOString() };
    setPending(true); setError(null); setNotice(null); setPreview(null); setPreviewRequest(null);
    try {
      const result = await window.lnwjing.previewCheckpointCleanup(request);
      setPreviewRequest(request); setPreview(result);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function applyCleanup(): Promise<void> {
    if (pending || previewRequest === null || preview === null || preview.checkpointIds.length === 0) return;
    const agreed = window.confirm(t('storagePanel.confirmCheckpointDelete', { count: preview.checkpointIds.length }));
    if (!agreed) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await window.lnwjing.applyCheckpointCleanup({ ...previewRequest, expectedPreviewToken: preview.previewToken, userConfirmed: true });
      setPreview(null); setPreviewRequest(null);
      setOverview(await window.lnwjing.getStorageOverview());
      await onChanged?.();
      setNotice(t('storagePanel.deletedResult', { count: result.deleted, backupId: result.backupId ?? '—' }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function cleanNative(): Promise<void> {
    if (pending || !window.confirm(t('storagePanel.confirmNative'))) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const cursor = cursors[category];
      const result = await window.lnwjing.pruneNativeStorage({
        category, userConfirmed: true, maxDirectories: 32,
        ...(cursor === undefined || cursor === null ? {} : { afterName: cursor }),
      });
      setCursors((current) => ({ ...current, [category]: result.nextCursor }));
      setNotice(t('storagePanel.nativeResult', { count: result.inspected, removed: result.removedFiles }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  return (
    <section className="panel settings-card settings-card-polished" aria-label={t('storagePanel.title')}>
      <SettingsCardHeading icon="▤" title={t('storagePanel.title')}
        subtitle={t('storagePanel.subtitle')} />
      <div className="setting-field">
        <strong>{t('storagePanel.sqliteTitle')}</strong>
        <p>{overview === null ? (t('storagePanel.notLoaded')) :
          `${sizeLabel(overview.sqliteAllocatedBytes)} · ${t('storagePanel.freePages')} ${sizeLabel(overview.sqliteFreeBytes)}`}</p>
        <p className="hint">{t('storagePanel.sqliteNote')}</p>
        {overview?.compactRecommended === true ? <p className="hint">{t('storagePanel.compactionNote')}</p> : null}
      </div>
      {overview?.checkpointMetadataIncomplete === true ? (
        <StatusMessage tone="warning" role="alert" prefix="⚠ ">{t('storagePanel.indexPending')}</StatusMessage>
      ) : null}
      {overview?.hasCompressedV2 === true ? (
        <StatusMessage tone="warning" role="alert" prefix="⚠ ">
          {t('storagePanel.existingV2')}
        </StatusMessage>
      ) : null}
      {overview?.usageCategories?.length ? <div className="setting-field">
        <strong>{t('storagePanel.appdataTitle')}</strong>
        {overview.usageCategories.map((item) => (
          <p key={item.category}>{item.category}: {sizeLabel(item.bytes)}
            {item.truncated ? (t('storagePanel.partialSuffix')) : ''}
          </p>
        ))}
        <p className="hint">{t('storagePanel.appdataNote')}</p>
      </div> : null}
      <div className="inline-actions">
        <ActionButton type="button" disabled={pending} onClick={() => { void refresh(); }}>
          {t('storagePanel.refresh')}
        </ActionButton>
      </div>
      {overview === null ? null : (
        <>
          <SettingSwitch label={t('storagePanel.compression')}
            description={t('storagePanel.compressionNote')}
            checked={false} disabled={true}
            onChange={(value) => { void updatePolicy({ compressionEnabledOnNextStart: value }); }} />
          <div className="setting-field">
            <label htmlFor="storage-checkpoint-mode">{t('storagePanel.checkpointMode')}</label>
            <select id="storage-checkpoint-mode" disabled={pending} value={overview.policy.checkpointCreationMode}
              onChange={(event) => { void updatePolicy({ checkpointCreationMode: event.target.value as StoragePolicy['checkpointCreationMode'] }); }}>
              <option value="always">{t('storagePanel.checkpointAlways')}</option>
              <option value="git-aware">{t('storagePanel.checkpointGitAware')}</option>
            </select>
            <p className="hint">{t('storagePanel.checkpointModeNote')}</p>
          </div>
          <SettingSwitch label={t('storagePanel.autoRetention')}
            description={t('storagePanel.autoRetentionNote')}
            checked={overview.policy.automaticCheckpointRetention} disabled={pending || (!autoBackupEnabled && !overview.policy.automaticCheckpointRetention)}
            onChange={(value) => { void updatePolicy({ automaticCheckpointRetention: value }); }} />
          <SettingSwitch label={t('storagePanel.auditPrune')}
            description={t('storagePanel.auditPruneNote')}
            checked={overview.policy.auditPruneWithoutBackup} disabled={pending}
            onChange={(value) => { void updatePolicy({ auditPruneWithoutBackup: value }); }} />
          <div className="setting-field">
            <label htmlFor="storage-audit-days">{t('storagePanel.auditDays')}</label>
            <select id="storage-audit-days" disabled={pending} value={overview.policy.routineAuditRetentionDays}
              onChange={(event) => { void updatePolicy({ routineAuditRetentionDays: Number(event.target.value) }); }}>
              {[3, 7, 14, 30, 90, 180, 365, 3650].map((days) => <option key={days} value={days}>{days} {t('storagePanel.days')}</option>)}
              {![3, 7, 14, 30, 90, 180, 365, 3650].includes(overview.policy.routineAuditRetentionDays)
                ? <option value={overview.policy.routineAuditRetentionDays}>{overview.policy.routineAuditRetentionDays} {t('storagePanel.days')}</option> : null}
            </select>
          </div>
        </>
      )}
      <div className="settings-mini-heading"><strong>{t('storagePanel.budgetTitle')}</strong></div>
      <p className="hint">{t('storagePanel.budgetNote')}</p>
      <div className="inline-actions">
        <label>{t('storagePanel.budgetMiB')} <input type="number" min={0} max={1048576} step={1}
          value={maxMiB} disabled={pending} onChange={(event) => { setMaxMiB(Number(event.target.value)); setPreview(null); setPreviewRequest(null); }} /></label>
        <label>{t('storagePanel.olderDays')} <input type="number" min={1} max={3650} step={1}
          value={olderDays} disabled={pending} onChange={(event) => { setOlderDays(Number(event.target.value)); setPreview(null); setPreviewRequest(null); }} /></label>
        <ActionButton type="button" disabled={pending || overview === null} onClick={() => { void previewCleanup(); }}>
          {t('storagePanel.preview')}
        </ActionButton>
      </div>
      {preview === null ? null : (
        <div className="setting-field">
          <p>{t('storagePanel.checkpointBytes')}: {sizeLabel(preview.totalBytes)}</p>
          <p>{t('storagePanel.reclaimable')}: {sizeLabel(preview.candidateBytes)} · {preview.checkpointIds.length} {t('storagePanel.snapshots')}</p>
          <p className="hint">{t('storagePanel.spaceWarning')}</p>
          <ActionButton type="button" disabled={pending || preview.checkpointIds.length === 0} onClick={() => { void applyCleanup(); }}>
            {t('storagePanel.confirmCleanup')}
          </ActionButton>
        </div>
      )}
      <div className="settings-mini-heading"><strong>{t('storagePanel.nativeTitle')}</strong></div>
      <div className="inline-actions">
        <select aria-label={t('storagePanel.nativeCategory')} value={category} disabled={pending}
          onChange={(event) => setCategory(event.target.value as NativeCategory)}>
          <option value="tasks">{t('storagePanel.backgroundTasks')}</option>
          <option value="git">Git</option><option value="processes">{t('storagePanel.processes')}</option>
        </select>
        <ActionButton type="button" disabled={pending || cursors[category] === null} onClick={() => { void cleanNative(); }}>
          {t('storagePanel.cleanNative')}
        </ActionButton>
        {cursors[category] === null ? <ActionButton type="button" disabled={pending} onClick={() => setCursors((current) => ({ ...current, [category]: undefined }))}>{t('storagePanel.scanAgain')}</ActionButton> : null}
      </div>
      {error === null ? null : <StatusMessage tone="warning" role="alert" prefix="⚠ ">{error}</StatusMessage>}
      {notice === null ? null : <StatusMessage tone="success" prefix="✓ ">{notice}</StatusMessage>}
    </section>
  );
}
